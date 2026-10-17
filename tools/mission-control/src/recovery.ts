import type {
  ControllerConfig,
  ControllerState,
  OperationIntent,
  OperationOutcome,
  OperationRecord,
  OperationStatus
} from './types.js';
import { createInitialState, readState, StateError, writeStateAtomic } from './state.js';
import { withStateLock } from './locks.js';
export {
  acquireControllerLock,
  LockError,
  releaseControllerLock,
  type ControllerLock,
  type LockOptions
} from './locks.js';

export interface ReconciliationProbeResult {
  status: Exclude<OperationStatus, 'uncertain'>;
  outcome?: OperationOutcome;
  error?: string;
}

export type ReconciliationProbe = (record: OperationRecord) => Promise<ReconciliationProbeResult>;

export interface ReconciliationResult {
  recovered: OperationRecord[];
  stillPending: OperationRecord[];
  failed: OperationRecord[];
  blocked: OperationRecord[];
}

interface ProbedOperation {
  operation: OperationRecord;
  truth: ReconciliationProbeResult;
}

export class RecoveryError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'RecoveryError';
    this.code = code;
  }
}

const DEFAULT_OPERATION_LOCK_STALE_AFTER_MS = 60000;

export function createOperationKey(intent: Omit<OperationIntent, 'key'>): string {
  return `${intent.action}:${intent.targetType}:${String(intent.targetId)}:${stableStringify(intent.payload ?? null)}`;
}

export async function recordOperationIntent(
  filePath: string,
  config: ControllerConfig,
  intent: OperationIntent,
  now = new Date()
): Promise<OperationRecord> {
  return withOperationStateLock(filePath, 'operation-intent', async () => {
    const state = await readStateOrCreate(filePath, config, now);
    const existing = state.operations.find((operation) => operation.intent.key === intent.key);
    if (existing) {
      return existing;
    }

    const record: OperationRecord = {
      intent,
      status: 'pending',
      attempts: 0,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    };
    await writeStateAtomic(filePath, {
      ...state,
      operations: [...state.operations, record],
      updatedAt: now.toISOString()
    });
    return record;
  });
}

export async function recordOperationOutcome(
  filePath: string,
  key: string,
  status: Exclude<OperationStatus, 'pending'>,
  outcome: OperationOutcome | undefined,
  now = new Date(),
  lastError?: string
): Promise<OperationRecord> {
  return withOperationStateLock(filePath, 'operation-outcome', async () => {
    const state = await readState(filePath);
    const index = state.operations.findIndex((operation) => operation.intent.key === key);
    if (index === -1) {
      throw new RecoveryError(`Operation intent is missing for key ${key}.`);
    }

    const previous = state.operations[index];
    if (previous.intent.action === 'ao-spawn-worker' && status !== 'uncertain') {
      throw new RecoveryError('AO spawn outcome requires unavailable dispatch-ID provider evidence.', 'EAO_RECONCILIATION_BLOCKED');
    }
    const nextRecord: OperationRecord = {
      ...previous,
      status,
      outcome,
      lastError,
      updatedAt: now.toISOString()
    };
    const operations = [...state.operations];
    operations[index] = nextRecord;
    await writeStateAtomic(filePath, { ...state, operations, updatedAt: now.toISOString() });
    return nextRecord;
  });
}

export async function markOperationAttempt(
  filePath: string,
  key: string,
  maxRetries: number,
  now = new Date()
): Promise<OperationRecord> {
  return withOperationStateLock(filePath, 'operation-attempt', async () => {
    const state = await readState(filePath);
    const index = state.operations.findIndex((operation) => operation.intent.key === key);
    if (index === -1) {
      throw new RecoveryError(`Operation intent is missing for key ${key}.`);
    }

    const previous = state.operations[index];
    if (previous.attempts >= maxRetries) {
      throw new RecoveryError(`Retry limit reached for operation ${key}.`, 'ERETRY_LIMIT');
    }

    const nextRecord: OperationRecord = {
      ...previous,
      attempts: previous.attempts + 1,
      updatedAt: now.toISOString()
    };
    const operations = [...state.operations];
    operations[index] = nextRecord;
    await writeStateAtomic(filePath, { ...state, operations, updatedAt: now.toISOString() });
    return nextRecord;
  });
}

export async function reconcilePendingOperations(
  filePath: string,
  probe: ReconciliationProbe,
  now = new Date()
): Promise<ReconciliationResult> {
  const candidates = await withOperationStateLock(filePath, 'operation-reconcile-snapshot', async () => {
    const state = await readState(filePath);
    return state.operations.filter((operation) => operation.intent.action !== 'ao-spawn-worker' &&
      (operation.status === 'pending' || operation.status === 'uncertain'));
  });

  const probed = await probeWithoutStateLock(candidates, probe);

  return withOperationStateLock(filePath, 'operation-reconcile', async () => {
    const state = await readState(filePath);
    const operations = [...state.operations];
    const recovered: OperationRecord[] = [];
    const stillPending: OperationRecord[] = [];
    const failed: OperationRecord[] = [];
    const blocked = operations.filter((operation) => operation.intent.action === 'ao-spawn-worker' &&
      (operation.status === 'pending' || operation.status === 'uncertain'));

    for (const { operation, truth } of probed) {
      const index = operations.findIndex((current) => current.intent.key === operation.intent.key);
      if (index === -1) {
        continue;
      }

      const current = operations[index];
      if (current.status !== 'pending' && current.status !== 'uncertain') {
        continue;
      }

      const next: OperationRecord = {
        ...current,
        status: truth.status,
        outcome: truth.outcome,
        lastError: truth.error,
        updatedAt: now.toISOString()
      };
      operations[index] = next;
      if (truth.status === 'succeeded') {
        recovered.push(next);
      } else if (truth.status === 'failed') {
        failed.push(next);
      } else {
        stillPending.push(next);
      }
    }

    if (probed.length) await writeStateAtomic(filePath, { ...state, operations, updatedAt: now.toISOString() });
    return { recovered, stillPending, failed, blocked };
  });
}

async function probeWithoutStateLock(
  candidates: OperationRecord[],
  probe: ReconciliationProbe
): Promise<ProbedOperation[]> {
  return Promise.all(
    candidates.map(async (operation) => ({
      operation,
      truth: await probe(operation)
    }))
  );
}

async function readStateOrCreate(filePath: string, config: ControllerConfig, now: Date): Promise<ControllerState> {
  try {
    return await readState(filePath);
  } catch (error) {
    if (error instanceof StateError && error.code === 'ENOENT') {
      return createInitialState(config, now);
    }
    throw error;
  }
}

async function withOperationStateLock<T>(filePath: string, owner: string, action: () => Promise<T>): Promise<T> {
  return withStateLock(filePath, owner, DEFAULT_OPERATION_LOCK_STALE_AFTER_MS, action);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((child) => stableStringify(child)).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
