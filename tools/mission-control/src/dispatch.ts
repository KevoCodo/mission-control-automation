import { createHash, randomUUID } from 'node:crypto';
import { appendAuditEvent } from './audit.js';
import { withStateLock } from './locks.js';
import { createInitialState, readState, StateError, writeStateAtomic } from './state.js';
import type { ControllerConfig, ControllerState, DispatchRecord } from './types.js';

export class DispatchError extends Error {
  constructor(message: string, readonly code: string) { super(message); this.name = 'DispatchError'; }
}

export interface DispatchIntentInput {
  operationKey: string;
  issueNumber: number;
  branch: string;
  target?: { targetId?: string; sessionId?: string };
  payload: unknown;
  dispatchId?: string;
  correlationId?: string;
}

const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
function validIdentity(value: string | undefined): boolean { return value === undefined || IDENTITY.test(value); }

function canonical(value: unknown, ancestors = new Set<object>()): string {
  const invalid = () => new DispatchError('Payload must contain only JSON values.', 'EDISPATCH_PAYLOAD');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalid();
    return JSON.stringify(value);
  }
  if (typeof value !== 'object' || ancestors.has(value)) throw invalid();
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value) ? prototype !== Array.prototype : prototype !== Object.prototype)
    throw invalid();
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const parts: string[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !('value' in descriptor)) throw invalid();
        parts.push(canonical(descriptor.value, ancestors));
      }
      if (Reflect.ownKeys(value).some((key) => key !== 'length' &&
        !(typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length))) throw invalid();
      return `[${parts.join(',')}]`;
    }
    if (Object.getOwnPropertySymbols(value).length) throw invalid();
    const object = value as Record<string, unknown>;
    if (Object.getOwnPropertyNames(object).length !== Object.keys(object).length) throw invalid();
    return `{${Object.keys(object).sort().map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (!descriptor || !('value' in descriptor)) throw invalid();
      return `${JSON.stringify(key)}:${canonical(descriptor.value, ancestors)}`;
    }).join(',')}}`;
  } finally { ancestors.delete(value); }
}

export function fingerprintDispatchPayload(payload: unknown): string {
  try { return createHash('sha256').update(canonical(payload), 'utf8').digest('hex'); }
  catch { throw new DispatchError('Payload must contain only JSON values.', 'EDISPATCH_PAYLOAD'); }
}

async function stateOrInitial(filePath: string, config: ControllerConfig, now: Date): Promise<ControllerState> {
  try { return await readState(filePath); }
  catch (error) {
    if (error instanceof StateError && error.code === 'ENOENT') return createInitialState(config, now);
    throw error;
  }
}

/** Persists an identity only. This function has no transport handoff. */
export async function recordDispatchIntent(
  statePath: string, config: ControllerConfig, input: DispatchIntentInput, now = new Date(), auditPath?: string
): Promise<DispatchRecord> {
  if (!validIdentity(input.operationKey) || !validIdentity(input.branch) ||
    !validIdentity(input.dispatchId) || !validIdentity(input.correlationId) ||
    !validIdentity(input.target?.targetId) || !validIdentity(input.target?.sessionId) ||
    !Number.isInteger(input.issueNumber) || input.issueNumber <= 0)
    throw new DispatchError('Invalid dispatch operation identity.', 'EDISPATCH_INPUT');
  const payloadSha256 = fingerprintDispatchPayload(input.payload);
  return withStateLock(statePath, 'dispatch-intent', 60000, async () => {
    const state = await stateOrInitial(statePath, config, now);
    if (state.repository.owner !== config.repository.owner || state.repository.name !== config.repository.name)
      throw new DispatchError('State repository does not match dispatch target.', 'EDISPATCH_REPOSITORY');
    const existing = state.dispatches.find((item) => item.operationKey === input.operationKey);
    if (existing) {
      if (existing.payloadSha256 !== payloadSha256 || existing.issueNumber !== input.issueNumber || existing.branch !== input.branch ||
        canonical(existing.target ?? null) !== canonical(input.target ?? null))
        throw new DispatchError('Operation key already has a different dispatch payload or target.', 'EDISPATCH_CONFLICT');
      if (input.dispatchId && input.dispatchId !== existing.dispatchId)
        throw new DispatchError('Operation key already has another dispatch ID.', 'EDISPATCH_CONFLICT');
      return existing;
    }
    if (state.dispatches.some((item) => item.dispatchId === input.dispatchId))
      throw new DispatchError('Dispatch ID is already recorded.', 'EDISPATCH_ID_CONFLICT');
    if (state.dispatches.some((item) => item.issueNumber === input.issueNumber || item.branch === input.branch))
      throw new DispatchError('Issue or branch already has an unresolved dispatch identity.', 'EDISPATCH_ACTIVE');
    const dispatchId = input.dispatchId ?? randomUUID();
    const record: DispatchRecord = {
      version: 1, dispatchId, operationKey: input.operationKey,
      repository: { owner: config.repository.owner, name: config.repository.name },
      issueNumber: input.issueNumber, branch: input.branch, ...(input.target ? { target: input.target } : {}),
      payloadSha256, correlationId: input.correlationId ?? randomUUID(),
      createdAt: now.toISOString(), updatedAt: now.toISOString(), state: 'INTENT_RECORDED',
      quarantineReason: 'Provider receipt protocol unavailable; transport prohibited.'
    };
    await writeStateAtomic(statePath, { ...state, dispatches: [...state.dispatches, record], updatedAt: now.toISOString() });
    if (auditPath) await appendDispatchAudit(auditPath, record, now);
    return record;
  });
}

/** Quarantines a local intent or interrupted attempt without asserting any provider result. */
export async function quarantineDispatch(statePath: string, dispatchId: string,
  reason: 'acknowledgment-lost' | 'reconciliation-blocked' | 'attempt-interrupted', now = new Date()): Promise<DispatchRecord> {
  return withStateLock(statePath, 'dispatch-quarantine', 60000, async () => {
    const state = await readState(statePath);
    const index = state.dispatches.findIndex((item) => item.dispatchId === dispatchId);
    if (index < 0) throw new DispatchError('Dispatch identity is missing.', 'EDISPATCH_MISSING');
    const previous = state.dispatches[index];
    if (!['INTENT_RECORDED', 'SUBMITTING', 'UNCERTAIN'].includes(previous.state))
      throw new DispatchError('Dispatch cannot be quarantined from this state.', 'EDISPATCH_TRANSITION');
    const updated: DispatchRecord = { ...previous, state: 'UNCERTAIN', updatedAt: now.toISOString(),
      quarantineReason: reason };
    const dispatches = [...state.dispatches]; dispatches[index] = updated;
    await writeStateAtomic(statePath, { ...state, dispatches, updatedAt: now.toISOString() });
    return updated;
  });
}

export function reconcileDispatchSnapshot(record: DispatchRecord, observation?: { sessionId?: string; branch?: string }):
  { dispatchId: string; status: 'blocked'; reason: string; observation: 'unverified' | 'unavailable' } {
  return { dispatchId: record.dispatchId, status: 'blocked',
    reason: 'Authoritative dispatch-ID provider reconciliation is unavailable; local state is unchanged.',
    observation: observation ? 'unverified' : 'unavailable' };
}

async function appendDispatchAudit(auditPath: string, record: DispatchRecord, now: Date): Promise<void> {
  await appendAuditEvent(auditPath, { type: 'dispatch.intent.recorded', timestamp: now.toISOString(),
    correlationId: record.correlationId, operationKey: record.operationKey, issueNumber: record.issueNumber,
    category: 'intent', outcome: 'pending', provenance: { source: 'controller' },
    data: { dispatchId: record.dispatchId, localState: record.state, payloadSha256: record.payloadSha256,
      providerReceiptStatus: 'unverified', quarantineReason: record.quarantineReason } });
}
