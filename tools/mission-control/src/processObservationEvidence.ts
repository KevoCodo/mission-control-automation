/** Portable, caller-supplied evidence format. Version 1 does not authenticate ETW. */
export interface ProcessIdentity {
  pid: number;
  creationId: string;
}

export interface ProcessObservationEvent {
  sequence: number;
  timestampMs: number;
  rawEventId: string;
  type: 'PROCESS_START' | 'PROCESS_END';
  process: ProcessIdentity;
  parent: ProcessIdentity;
}

export interface ProcessObservationRecord {
  version: 1;
  session: {
    sessionId: string;
    collectorId: string;
    providerId: string;
    providerConfigurationSha256: string;
    rawTraceSha256: string;
    provenance: 'UNAUTHENTICATED';
    coverage: 'CLAIMED_COMPLETE' | 'UNKNOWN';
    lifecycle: 'COMPLETED' | 'INTERRUPTED' | 'RESTARTED';
    interruptionCount: number;
  };
  window: {
    startedAtMs: number;
    launchAtMs: number;
    harnessExitAtMs: number;
    endedAtMs: number;
    firstSequence: number;
    lastSequence: number;
  };
  harness: { process: ProcessIdentity; parent: ProcessIdentity };
  events: ProcessObservationEvent[];
  loss: { eventsLost: number | null; logBuffersLost: number | null; realTimeBuffersLost: number | null };
  cleanup: { observedAtMs: number; complete: boolean; outstanding: ProcessIdentity[] };
}

export interface ProcessObservationVerdict {
  status: 'MALFORMED' | 'REJECTED' | 'UNVERIFIED';
  reasons: string[];
  locallyConsistent: boolean;
  childObserved: boolean;
  noChild: 'UNVERIFIED';
  independentlyAuthenticated: false;
  executionAuthorized: false;
}

type Data = Record<string, unknown>;

// Use descriptors throughout: even inspection must not read a caller's accessor.
function ownData(value: unknown, keys: readonly string[]): Data {
  if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0) throw new Error('INVALID_OBJECT');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Object.keys(descriptors);
  if (names.length !== keys.length || names.some(name => !keys.includes(name))) throw new Error('INVALID_KEYS');
  const result: Data = Object.create(null) as Data;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new Error('INVALID_PROPERTY');
    result[key] = descriptor.value;
  }
  return result;
}

function denseArray(value: unknown): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0) throw new Error('INVALID_ARRAY');
  const descriptors: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || Object.keys(descriptors).length !== length + 1) {
    throw new Error('INVALID_ARRAY_LENGTH');
  }
  const copy: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new Error('INVALID_ARRAY_ITEM');
    copy.push(descriptor.value);
  }
  return copy;
}

function integer(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error('INVALID_INTEGER');
  return value as number;
}

function label(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024) throw new Error('INVALID_LABEL');
  return value;
}

function sha256(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value)) throw new Error('INVALID_SHA256');
  return value.toLowerCase();
}

function identity(value: unknown): ProcessIdentity {
  const data = ownData(value, ['pid', 'creationId']);
  return { pid: integer(data.pid, 1), creationId: label(data.creationId) };
}

function parse(value: unknown): ProcessObservationRecord {
  const data = ownData(value, ['version', 'session', 'window', 'harness', 'events', 'loss', 'cleanup']);
  if (data.version !== 1) throw new Error('INVALID_VERSION');
  const session = ownData(data.session, ['sessionId', 'collectorId', 'providerId', 'providerConfigurationSha256', 'rawTraceSha256', 'provenance', 'coverage', 'lifecycle', 'interruptionCount']);
  if (session.provenance !== 'UNAUTHENTICATED' || !['CLAIMED_COMPLETE', 'UNKNOWN'].includes(session.coverage as string) ||
      !['COMPLETED', 'INTERRUPTED', 'RESTARTED'].includes(session.lifecycle as string)) throw new Error('INVALID_SESSION');
  const window = ownData(data.window, ['startedAtMs', 'launchAtMs', 'harnessExitAtMs', 'endedAtMs', 'firstSequence', 'lastSequence']);
  const harness = ownData(data.harness, ['process', 'parent']);
  const loss = ownData(data.loss, ['eventsLost', 'logBuffersLost', 'realTimeBuffersLost']);
  const cleanup = ownData(data.cleanup, ['observedAtMs', 'complete', 'outstanding']);
  if (typeof cleanup.complete !== 'boolean') throw new Error('INVALID_CLEANUP');
  const lossCount = (n: unknown): number | null => n === null ? null : integer(n);
  const events = denseArray(data.events).map(item => {
    const event = ownData(item, ['sequence', 'timestampMs', 'rawEventId', 'type', 'process', 'parent']);
    if (event.type !== 'PROCESS_START' && event.type !== 'PROCESS_END') throw new Error('INVALID_EVENT_TYPE');
    return {
      sequence: integer(event.sequence, 1), timestampMs: integer(event.timestampMs), rawEventId: label(event.rawEventId),
      type: event.type as ProcessObservationEvent['type'], process: identity(event.process), parent: identity(event.parent),
    };
  });
  return {
    version: 1,
    session: {
      sessionId: label(session.sessionId), collectorId: label(session.collectorId), providerId: label(session.providerId),
      providerConfigurationSha256: sha256(session.providerConfigurationSha256), rawTraceSha256: sha256(session.rawTraceSha256),
      provenance: 'UNAUTHENTICATED', coverage: session.coverage as 'CLAIMED_COMPLETE' | 'UNKNOWN',
      lifecycle: session.lifecycle as 'COMPLETED' | 'INTERRUPTED' | 'RESTARTED',
      interruptionCount: integer(session.interruptionCount),
    },
    window: {
      startedAtMs: integer(window.startedAtMs), launchAtMs: integer(window.launchAtMs),
      harnessExitAtMs: integer(window.harnessExitAtMs), endedAtMs: integer(window.endedAtMs),
      firstSequence: integer(window.firstSequence, 1), lastSequence: integer(window.lastSequence, 1),
    },
    harness: { process: identity(harness.process), parent: identity(harness.parent) },
    events,
    loss: { eventsLost: lossCount(loss.eventsLost), logBuffersLost: lossCount(loss.logBuffersLost), realTimeBuffersLost: lossCount(loss.realTimeBuffersLost) },
    cleanup: { observedAtMs: integer(cleanup.observedAtMs), complete: cleanup.complete,
      outstanding: denseArray(cleanup.outstanding).map(identity) },
  };
}

function key(process: ProcessIdentity): string { return `${process.pid}:${process.creationId}`; }

function createsAncestryCycle(id: string, parent: string, parentOf: Map<string, string>): boolean {
  const visited = new Set<string>();
  let current: string | undefined = parent;
  while (current !== undefined) {
    if (current === id || visited.has(current)) return true;
    visited.add(current);
    current = parentOf.get(current);
  }
  return false;
}

/** Pure consistency check. No caller-supplied record can authorize execution or prove absence of a child. */
export function assessProcessObservation(input: unknown): ProcessObservationVerdict {
  const reasons: string[] = [];
  let childObserved = false;
  try {
    const record = parse(input);
    const { window, session, events, harness, loss, cleanup } = record;
    if (!(window.startedAtMs < window.launchAtMs && window.launchAtMs <= window.harnessExitAtMs &&
          window.harnessExitAtMs < window.endedAtMs && cleanup.observedAtMs >= window.endedAtMs)) reasons.push('INCOMPLETE_WINDOW');
    if (session.coverage !== 'CLAIMED_COMPLETE') reasons.push('UNKNOWN_COVERAGE');
    if (session.lifecycle !== 'COMPLETED' || session.interruptionCount !== 0) reasons.push('INTERRUPTED_OBSERVER');
    if (Object.values(loss).some(value => value === null)) reasons.push('UNKNOWN_EVENT_LOSS');
    if (Object.values(loss).some(value => value !== null && value !== 0)) reasons.push('EVENT_LOSS');
    if (!cleanup.complete || cleanup.outstanding.length !== 0) reasons.push('INCOMPLETE_CLEANUP');
    if (events.length === 0 || window.firstSequence !== 1 || window.lastSequence !== events.length) reasons.push('INCOMPLETE_SEQUENCE');
    const root = harness.parent;
    const rootId = key(root);
    const harnessId = key(harness.process);
    if (harness.process.pid === root.pid || harness.process.creationId === root.creationId) {
      reasons.push('SELF_PARENTED_HARNESS');
    }
    // A creation ID names exactly one process instance throughout this record.
    // Check references as well as starts, since ancestry uses the full identity.
    const pidByCreationId = new Map<string, number>();
    const observeIdentity = (process: ProcessIdentity): void => {
      const priorPid = pidByCreationId.get(process.creationId);
      if (priorPid !== undefined && priorPid !== process.pid) reasons.push('CREATION_ID_ALIAS');
      else pidByCreationId.set(process.creationId, process.pid);
    };
    observeIdentity(root);
    observeIdentity(harness.process);
    for (const event of events) {
      observeIdentity(event.process);
      observeIdentity(event.parent);
    }
    for (const process of cleanup.outstanding) observeIdentity(process);
    const active = new Map<string, ProcessObservationEvent>();
    const seen = new Set<string>();
    const activePid = new Map<number, string>();
    const parentOf = new Map<string, string>([[harnessId, rootId]]);
    const rawIds = new Set<string>();
    let harnessStarted = false;
    let harnessEnded = false;
    let previousTime = window.startedAtMs;
    for (let index = 0; index < events.length; index++) {
      const event = events[index];
      if (event.sequence !== index + 1 || rawIds.has(event.rawEventId)) reasons.push('EVENT_SEQUENCE_OR_ID');
      rawIds.add(event.rawEventId);
      if (event.timestampMs < previousTime || event.timestampMs > window.endedAtMs) reasons.push('EVENT_ORDER');
      previousTime = event.timestampMs;
      const id = key(event.process);
      const parent = key(event.parent);
      // The harness parent predates the window. Neither an event nor an unproved
      // lifecycle claim may retire its reserved PID or creation identity here.
      if (event.process.pid === root.pid) reasons.push(id === rootId ? 'RESERVED_PARENT_IDENTITY' : 'UNRESOLVED_PARENT_PID_REUSE');
      if (event.process.creationId === root.creationId && id !== rootId) reasons.push('RESERVED_PARENT_CREATION_ID');
      if (event.parent.pid === root.pid && parent !== rootId) reasons.push('UNRESOLVED_PARENT_PID_REUSE');
      if (event.parent.creationId === root.creationId && parent !== rootId) reasons.push('RESERVED_PARENT_CREATION_ID');
      if (id === harnessId) {
        if (parent !== rootId) reasons.push('PARENT_MISMATCH');
        if (event.type === 'PROCESS_START') {
          harnessStarted = true;
          if (event.timestampMs < window.launchAtMs) reasons.push('HARNESS_BEFORE_LAUNCH');
        } else {
          harnessEnded = true;
          if (event.timestampMs > window.harnessExitAtMs) reasons.push('HARNESS_EXIT_ORDER');
        }
      } else {
        childObserved = true;
        if (!active.has(parent)) reasons.push('PARENT_MISMATCH');
      }
      if (event.type === 'PROCESS_START') {
        if (createsAncestryCycle(id, parent, parentOf)) reasons.push('ANCESTRY_CYCLE');
        parentOf.set(id, parent);
        if (seen.has(id) || activePid.has(event.process.pid)) reasons.push('DUPLICATE_OR_CONFLICTING_START');
        seen.add(id);
        active.set(id, event);
        activePid.set(event.process.pid, id);
      } else {
        const start = active.get(id);
        if (!start || key(start.parent) !== parent) reasons.push('MISSING_START_OR_PARENT_MISMATCH');
        else { active.delete(id); activePid.delete(event.process.pid); }
      }
    }
    if (!harnessStarted || !harnessEnded || active.size !== 0) reasons.push('MISSING_PROCESS_EXIT');
    if (reasons.length) return { status: 'REJECTED', reasons: [...new Set(reasons)], locallyConsistent: false,
      childObserved, noChild: 'UNVERIFIED', independentlyAuthenticated: false, executionAuthorized: false };
    return { status: 'UNVERIFIED', reasons: ['UNAUTHENTICATED_PROVENANCE_AND_COVERAGE'], locallyConsistent: true,
      childObserved, noChild: 'UNVERIFIED', independentlyAuthenticated: false, executionAuthorized: false };
  } catch {
    return { status: 'MALFORMED', reasons: ['MALFORMED_RECORD'], locallyConsistent: false,
      childObserved: false, noChild: 'UNVERIFIED', independentlyAuthenticated: false, executionAuthorized: false };
  }
}
