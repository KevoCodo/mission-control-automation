import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  MIN_SUPPORTED_STATE_VERSION,
  STATE_VERSION,
  type ControllerConfig,
  type ControllerState,
  type DiscoveryResult,
  type DispatchRecord,
  type IdentityMap,
  type NativeReviewObservation,
  type OperationRecord,
  type PullRequestTrackingObservation
} from './types.js';
import { withStateLock } from './locks.js';
import { parseAuthorizationState } from './authorization.js';

export class StateError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'StateError';
    this.code = code;
  }
}

const DEFAULT_STATE_LOCK_STALE_AFTER_MS = 60000;

export function createInitialState(config: ControllerConfig, now = new Date()): ControllerState {
  return {
    version: STATE_VERSION,
    schema: {
      createdVersion: STATE_VERSION
    },
    repository: config.repository,
    project: config.project,
    identities: config.identities,
    operations: [],
    dispatches: [],
    authorization: { grants: [], revocations: [], consumedGrantIds: [], revocationEpoch: 0 },
    discoveries: [],
    pullRequestTracking: [],
    nativeReviewTracking: [],
    nativeReviewControl: { stopActive: true, reason: 'Trusted correction authorization is unavailable.' },
    updatedAt: now.toISOString()
  };
}

export async function readState(filePath: string): Promise<ControllerState> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    const code = isNodeError(error) ? error.code : undefined;
    throw new StateError(`Unable to read state: ${error instanceof Error ? error.message : String(error)}`, code);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new StateError('State file contains corrupt JSON.');
  }

  return parseState(parsed);
}

export async function writeStateAtomic(filePath: string, state: ControllerState): Promise<void> {
  return withStateLock(filePath, 'write-state', DEFAULT_STATE_LOCK_STALE_AFTER_MS, async () =>
    writeStateAtomicUnlocked(filePath, state)
  );
}

async function writeStateAtomicUnlocked(filePath: string, state: ControllerState): Promise<void> {
  parseAuthorizationState(state.authorization);
  if (state.authorization.grants.some((grant) => grant.status === 'VERIFIED' || grant.issuerProvenance === 'test-fixture')) {
    throw new StateError('Verified or fixture authorization cannot be persisted by the controller.', 'EAUTHORIZATION_UNTRUSTED');
  }
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    const code = isNodeError(error) ? error.code : undefined;
    throw new StateError(`Unable to write state atomically: ${error instanceof Error ? error.message : String(error)}`, code);
  }
}

export async function initializeState(filePath: string, config: ControllerConfig): Promise<ControllerState> {
  const state = createInitialState(config);
  await writeStateAtomic(filePath, state);
  return state;
}

export async function appendDiscovery(
  filePath: string,
  config: ControllerConfig,
  discovery: DiscoveryResult,
  now = new Date()
): Promise<ControllerState> {
  return withStateLock(filePath, 'append-discovery', DEFAULT_STATE_LOCK_STALE_AFTER_MS, async () => {
    let state: ControllerState;
    try {
      state = await readState(filePath);
    } catch (error) {
      if (error instanceof StateError && error.code === 'ENOENT') {
        state = createInitialState(config, now);
      } else {
        throw error;
      }
    }

    const nextState: ControllerState = {
      ...state,
      repository: state.repository,
      project: state.project,
      identities: state.identities,
      schema: state.schema,
      operations: state.operations,
      discoveries: [...state.discoveries, discovery],
      updatedAt: now.toISOString()
    };
    await writeStateAtomicUnlocked(filePath, nextState);
    return nextState;
  });
}

export async function appendPullRequestTrackingObservation(
  filePath: string,
  config: ControllerConfig,
  observation: PullRequestTrackingObservation,
  now = new Date()
): Promise<PullRequestTrackingObservation> {
  return withStateLock(filePath, 'append-pr-tracking', DEFAULT_STATE_LOCK_STALE_AFTER_MS, async () => {
    let state: ControllerState;
    try {
      state = await readState(filePath);
    } catch (error) {
      if (error instanceof StateError && error.code === 'ENOENT') {
        state = createInitialState(config, now);
      } else {
        throw error;
      }
    }

    const priorForPullRequest = state.pullRequestTracking.filter(
      (entry) => entry.pullRequestNumber === observation.pullRequestNumber
    );
    const latest = priorForPullRequest.at(-1);
    if (latest && latest.headSha !== observation.headSha) {
      const latestTime = Date.parse(latest.observedAt);
      const nextTime = Date.parse(observation.observedAt);
      if (Number.isFinite(latestTime) && Number.isFinite(nextTime) && latestTime > nextTime) {
        throw new StateError('Refusing to persist a superseded pull request head observation.', 'ESTALE_HEAD');
      }
    }

    const sameHead = priorForPullRequest.find((entry) => entry.headSha === observation.headSha);
    if (sameHead) {
      const sameHeadTime = Date.parse(sameHead.observedAt);
      const nextTime = Date.parse(observation.observedAt);
      if (Number.isFinite(sameHeadTime) && Number.isFinite(nextTime) && sameHeadTime >= nextTime) {
        return sameHead;
      }
    }

    const generation =
      sameHead?.generation ??
      (priorForPullRequest.length === 0 ? 1 : Math.max(...priorForPullRequest.map((entry) => entry.generation ?? 1)) + 1);
    const persisted: PullRequestTrackingObservation = {
      ...observation,
      generation
    };
    const withoutSameHead = state.pullRequestTracking.filter(
      (entry) => !(entry.pullRequestNumber === observation.pullRequestNumber && entry.headSha === observation.headSha)
    );
    const nextState: ControllerState = {
      ...state,
      pullRequestTracking: [...withoutSameHead, persisted],
      updatedAt: now.toISOString()
    };
    await writeStateAtomicUnlocked(filePath, nextState);
    return persisted;
  });
}

export async function appendNativeReviewObservation(
  filePath: string,
  config: ControllerConfig,
  observation: NativeReviewObservation,
  now = new Date()
): Promise<NativeReviewObservation> {
  return withStateLock(filePath, 'append-native-review', DEFAULT_STATE_LOCK_STALE_AFTER_MS, async () => {
    let state: ControllerState;
    try {
      state = await readState(filePath);
    } catch (error) {
      if (error instanceof StateError && error.code === 'ENOENT') {
        state = createInitialState(config, now);
      } else {
        throw error;
      }
    }

    const priorForPullRequest = state.nativeReviewTracking.filter(
      (entry) => entry.pullRequestNumber === observation.pullRequestNumber
    );
    const latest = priorForPullRequest.at(-1);
    if (latest && latest.headSha !== observation.headSha) {
      const latestTime = Date.parse(latest.observedAt);
      const nextTime = Date.parse(observation.observedAt);
      if (Number.isFinite(latestTime) && Number.isFinite(nextTime) && latestTime > nextTime) {
        throw new StateError('Refusing to persist a superseded native review observation.', 'ESTALE_HEAD');
      }
    }

    const sameHead = priorForPullRequest.find((entry) => entry.headSha === observation.headSha);
    if (sameHead) {
      const sameHeadTime = Date.parse(sameHead.observedAt);
      const nextTime = Date.parse(observation.observedAt);
      if (Number.isFinite(sameHeadTime) && Number.isFinite(nextTime) && sameHeadTime >= nextTime) {
        return sameHead;
      }
    }

    const withoutSameHead = state.nativeReviewTracking.filter(
      (entry) => !(entry.pullRequestNumber === observation.pullRequestNumber && entry.headSha === observation.headSha)
    );
    const nextState: ControllerState = {
      ...state,
      nativeReviewTracking: [...withoutSameHead, observation],
      updatedAt: now.toISOString()
    };
    await writeStateAtomicUnlocked(filePath, nextState);
    return observation;
  });
}

export function parseState(value: unknown): ControllerState {
  if (!isRecord(value)) {
    throw new StateError('State must be a JSON object.');
  }
  if (value.version === MIN_SUPPORTED_STATE_VERSION) {
    return migrateVersionOneState(value);
  }
  if (value.version === 2) {
    return parseState({ ...value, version: 3, dispatches: [], schema: { createdVersion: STATE_VERSION, previousVersion: 2 } });
  }
  if (value.version === 3) {
    if (value.authorization !== undefined) {
      const legacyAuthorization = parseAuthorizationState(value.authorization);
      if (legacyAuthorization.grants.length || legacyAuthorization.revocations.length ||
        legacyAuthorization.consumedGrantIds.length || legacyAuthorization.revocationEpoch !== 0)
        throw new StateError('Legacy state contains unexpected authorization evidence.', 'EAUTHORIZATION_STATE');
    }
    return parseState({ ...value, version: STATE_VERSION,
      authorization: { grants: [], revocations: [], consumedGrantIds: [], revocationEpoch: 0 },
      schema: { createdVersion: STATE_VERSION, previousVersion:
        isRecord(value.schema) && typeof value.schema.previousVersion === 'number' ? value.schema.previousVersion : 3 } });
  }
  if (value.version !== STATE_VERSION) {
    throw new StateError(`Unsupported state version: ${String(value.version)}.`);
  }
  if (!isRecord(value.repository) || !isRecord(value.project) || !isRecord(value.identities)) {
    throw new StateError('State is missing required identity sections.');
  }
  if (
    typeof value.repository.owner !== 'string' ||
    typeof value.repository.name !== 'string' ||
    typeof value.repository.defaultBranch !== 'string'
  ) {
    throw new StateError('State repository identity is invalid.');
  }
  if (typeof value.project.id !== 'string') {
    throw new StateError('State project identity is invalid.');
  }
  if (
    !Array.isArray(value.identities.issues) ||
    !Array.isArray(value.identities.sessions) ||
    !Array.isArray(value.identities.pullRequests)
  ) {
    throw new StateError('State identities are invalid.');
  }
  if (!Array.isArray(value.discoveries)) {
    throw new StateError('State discoveries must be an array.');
  }
  if (!isRecord(value.schema) || typeof value.schema.createdVersion !== 'number') {
    throw new StateError('State schema metadata is invalid.');
  }
  if (!Array.isArray(value.operations)) {
    throw new StateError('State operations must be an array.');
  }
  if (!Array.isArray(value.dispatches)) {
    throw new StateError('State dispatches must be an array.');
  }
  validateDispatches(value.dispatches);
  const authorization = parseAuthorizationState(value.authorization);
  if (typeof value.updatedAt !== 'string') {
    throw new StateError('State updatedAt must be a string.');
  }
  return {
    version: STATE_VERSION,
    schema: {
      createdVersion: value.schema.createdVersion,
      previousVersion: typeof value.schema.previousVersion === 'number' ? value.schema.previousVersion : undefined
    },
    repository: {
      owner: value.repository.owner,
      name: value.repository.name,
      defaultBranch: value.repository.defaultBranch
    },
    project: {
      id: value.project.id
    },
    identities: {
      issues: value.identities.issues as IdentityMap['issues'],
      sessions: value.identities.sessions as IdentityMap['sessions'],
      pullRequests: value.identities.pullRequests as IdentityMap['pullRequests']
    },
    operations: value.operations as OperationRecord[],
    dispatches: value.dispatches as DispatchRecord[],
    authorization,
    discoveries: value.discoveries as ControllerState['discoveries'],
    pullRequestTracking: Array.isArray(value.pullRequestTracking)
      ? (value.pullRequestTracking as PullRequestTrackingObservation[])
      : [],
    nativeReviewTracking: Array.isArray(value.nativeReviewTracking)
      ? (value.nativeReviewTracking as NativeReviewObservation[])
      : [],
    nativeReviewControl: isRecord(value.nativeReviewControl) && typeof value.nativeReviewControl.stopActive === 'boolean'
      ? {
          stopActive: value.nativeReviewControl.stopActive,
          reason: typeof value.nativeReviewControl.reason === 'string'
            ? value.nativeReviewControl.reason
            : 'Trusted correction authorization is unavailable.'
        }
      : { stopActive: true, reason: 'Trusted correction authorization is unavailable.' },
    updatedAt: value.updatedAt
  };
}

export async function quarantineCorruptState(filePath: string, reason: string, now = new Date()): Promise<string> {
  return withStateLock(filePath, 'quarantine-state', DEFAULT_STATE_LOCK_STALE_AFTER_MS, async () => {
    const quarantinePath = `${filePath}.corrupt-${formatTimestamp(now)}.json`;
    try {
      await rename(filePath, quarantinePath);
    } catch (error) {
      const code = isNodeError(error) ? error.code : undefined;
      throw new StateError(
        `Unable to quarantine corrupt state after ${reason}: ${error instanceof Error ? error.message : String(error)}`,
        code
      );
    }
    return quarantinePath;
  });
}

function migrateVersionOneState(value: Record<string, unknown>): ControllerState {
  if (!isRecord(value.repository) || !isRecord(value.project) || !isRecord(value.identities)) {
    throw new StateError('State is missing required identity sections.');
  }
  if (
    typeof value.repository.owner !== 'string' ||
    typeof value.repository.name !== 'string' ||
    typeof value.repository.defaultBranch !== 'string'
  ) {
    throw new StateError('State repository identity is invalid.');
  }
  if (typeof value.project.id !== 'string') {
    throw new StateError('State project identity is invalid.');
  }
  if (
    !Array.isArray(value.identities.issues) ||
    !Array.isArray(value.identities.sessions) ||
    !Array.isArray(value.identities.pullRequests)
  ) {
    throw new StateError('State identities are invalid.');
  }
  if (!Array.isArray(value.discoveries)) {
    throw new StateError('State discoveries must be an array.');
  }
  if (typeof value.updatedAt !== 'string') {
    throw new StateError('State updatedAt must be a string.');
  }

  return {
    version: STATE_VERSION,
    schema: {
      createdVersion: STATE_VERSION,
      previousVersion: MIN_SUPPORTED_STATE_VERSION
    },
    repository: {
      owner: value.repository.owner,
      name: value.repository.name,
      defaultBranch: value.repository.defaultBranch
    },
    project: {
      id: value.project.id
    },
    identities: {
      issues: value.identities.issues as IdentityMap['issues'],
      sessions: value.identities.sessions as IdentityMap['sessions'],
      pullRequests: value.identities.pullRequests as IdentityMap['pullRequests']
    },
    operations: [],
    dispatches: [],
    authorization: { grants: [], revocations: [], consumedGrantIds: [], revocationEpoch: 0 },
    discoveries: value.discoveries as ControllerState['discoveries'],
    pullRequestTracking: [],
    nativeReviewTracking: [],
    nativeReviewControl: { stopActive: true, reason: 'Trusted correction authorization is unavailable.' },
    updatedAt: value.updatedAt
  };
}

function formatTimestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

function validateDispatches(value: unknown[]): void {
  const ids = new Set<string>();
  const keys = new Set<string>();
  const activeIssues = new Set<number>();
  const activeBranches = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || item.version !== 1 || typeof item.dispatchId !== 'string' ||
      typeof item.operationKey !== 'string' || typeof item.payloadSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(item.payloadSha256) || typeof item.correlationId !== 'string' ||
      !isRecord(item.repository) || typeof item.repository.owner !== 'string' || typeof item.repository.name !== 'string' ||
      !Number.isInteger(item.issueNumber) || Number(item.issueNumber) <= 0 || typeof item.branch !== 'string' ||
      typeof item.createdAt !== 'string' || typeof item.updatedAt !== 'string' ||
      !['INTENT_RECORDED', 'SUBMITTING', 'ACCEPTED', 'REJECTED', 'UNCERTAIN', 'RETIRED', 'COMPLETED'].includes(String(item.state)) ||
      ids.has(item.dispatchId) || keys.has(item.operationKey) ||
      (item.providerReceiptRef !== undefined && typeof item.providerReceiptRef !== 'string') ||
      (item.evidence !== undefined && (!isRecord(item.evidence) || item.evidence.provenance !== 'fixture' ||
        item.evidence.verified !== true || item.evidence.dispatchId !== item.dispatchId ||
        typeof item.evidence.providerReceiptRef !== 'string' ||
        !['acceptance', 'rejection', 'retirement', 'outcome'].includes(String(item.evidence.kind)))) ||
      (item.providerReceiptRef !== undefined) ||
      (['ACCEPTED', 'REJECTED', 'RETIRED', 'COMPLETED'].includes(String(item.state)) && item.evidence === undefined) ||
      (item.state === 'ACCEPTED' && (!isRecord(item.evidence) || item.evidence.kind !== 'acceptance')) ||
      (item.state === 'REJECTED' && (!isRecord(item.evidence) || item.evidence.kind !== 'rejection')) ||
      (item.state === 'COMPLETED' && (!isRecord(item.evidence) || item.evidence.kind !== 'outcome')) ||
      (item.state === 'RETIRED' && (!isRecord(item.evidence) || item.evidence.kind !== 'retirement' || item.evidence.durable !== true))) {
      throw new StateError('State dispatch identity is invalid or duplicated.', 'EDISPATCH_STATE');
    }
    if (!['REJECTED', 'RETIRED', 'COMPLETED'].includes(String(item.state))) {
      if (activeIssues.has(item.issueNumber as number) || activeBranches.has(item.branch as string))
        throw new StateError('State has conflicting active dispatch identities.', 'EDISPATCH_STATE');
      activeIssues.add(item.issueNumber as number);
      activeBranches.add(item.branch as string);
    }
    ids.add(item.dispatchId);
    keys.add(item.operationKey);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
