/** Disposable fixture model only. It has no process creation or production adapter. */
export type NativeStage = 'CREATED' | 'CONTAINED' | 'RUNNING' | 'EXITED' |
  'TERMINATION_REQUESTED' | 'TERMINATED' | 'CONTAINMENT_UNCERTAIN';
export type NativeEvent = 'JOB_ASSIGNED' | 'STARTED' | 'PROCESS_EXITED' |
  'REQUEST_TERMINATION' | 'TERMINATION_OBSERVED' | 'EVIDENCE_MISSING' | 'SETUP_FAILED';
export interface NativeObservation {
  version: 1;
  source: 'LOCAL_NATIVE_CLAIM';
  receiptId: string;
  generation: number;
  observedAt: string;
  processId: number | null;
  jobOwned: boolean;
  containmentQueried: boolean;
  controllingHandleInherited: boolean;
  identity: 'VERIFIED' | 'UNAVAILABLE';
  restrictions: 'APPLIED' | 'UNAVAILABLE';
  termination: 'OBSERVED' | 'UNVERIFIED';
  osError: { api: string; code: number } | null;
}
export interface NativePrototypeResult {
  stage: NativeStage;
  reason: string;
  authenticity: 'UNVERIFIED';
  retryAllowed: false;
  productionAuthorized: false;
  executable: false;
}
const result = (stage: NativeStage, reason: string): NativePrototypeResult => ({
  stage, reason, authenticity: 'UNVERIFIED', retryAllowed: false,
  productionAuthorized: false, executable: false
});
const observationKeys = ['version', 'source', 'receiptId', 'generation', 'observedAt', 'processId',
  'jobOwned', 'containmentQueried', 'controllingHandleInherited', 'identity', 'restrictions',
  'termination', 'osError'];
const receiptId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;

/** Copies only exact own data properties; later reads cannot invoke caller getters. */
function data(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0)
    return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length !== keys.length ||
    Object.keys(descriptors).some(key => !keys.includes(key)) ||
    keys.some(key => !Object.hasOwn(descriptors, key) || !('value' in descriptors[key]) ||
      !descriptors[key].enumerable)) return null;
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}

function parseObservation(value: unknown): NativeObservation | null {
  const v = data(value, observationKeys);
  if (!v || v.version !== 1 || v.source !== 'LOCAL_NATIVE_CLAIM' || !receiptId(v.receiptId) ||
    !positive(v.generation) || typeof v.observedAt !== 'string' ||
    !Number.isFinite(Date.parse(v.observedAt)) || new Date(v.observedAt).toISOString() !== v.observedAt ||
    v.processId !== null && !positive(v.processId) ||
    typeof v.jobOwned !== 'boolean' || typeof v.containmentQueried !== 'boolean' ||
    typeof v.controllingHandleInherited !== 'boolean' ||
    !['VERIFIED', 'UNAVAILABLE'].includes(v.identity as string) ||
    !['APPLIED', 'UNAVAILABLE'].includes(v.restrictions as string) ||
    !['OBSERVED', 'UNVERIFIED'].includes(v.termination as string)) return null;
  if (v.osError !== null) {
    const error = data(v.osError, ['api', 'code']);
    if (!error || typeof error.api !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.api) ||
      !Number.isSafeInteger(error.code) || Number(error.code) < 0) return null;
    v.osError = error;
  }
  return v as unknown as NativeObservation;
}

function validReceipts(value: unknown): value is ReadonlySet<string> {
  if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Set.prototype ||
    Object.getOwnPropertyNames(value).length !== 0 || Object.getOwnPropertySymbols(value).length !== 0)
    return false;
  for (const id of Set.prototype.values.call(value) as SetIterator<unknown>) if (!receiptId(id)) return false;
  return true;
}

/** Caller records can invalidate a transition, never authenticate one. */
export function advanceNativePrototype(stage: unknown, event: unknown,
  observationInput: unknown, gateInput: unknown, usedReceipts: unknown): NativePrototypeResult {
  try {
  if (!['CREATED', 'CONTAINED', 'RUNNING', 'EXITED', 'TERMINATION_REQUESTED',
    'TERMINATED', 'CONTAINMENT_UNCERTAIN'].includes(stage as string))
    return result('CONTAINMENT_UNCERTAIN', 'INVALID_STAGE');
  if (!['JOB_ASSIGNED', 'STARTED', 'PROCESS_EXITED', 'REQUEST_TERMINATION',
    'TERMINATION_OBSERVED', 'EVIDENCE_MISSING', 'SETUP_FAILED'].includes(event as string))
    return result('CONTAINMENT_UNCERTAIN', 'INVALID_EVENT');
  const gate = data(gateInput, ['active', 'generation']);
  if (!gate || typeof gate.active !== 'boolean' || !positive(gate.generation))
    return result('CONTAINMENT_UNCERTAIN', 'INVALID_GATE');
  if (!validReceipts(usedReceipts)) return result('CONTAINMENT_UNCERTAIN', 'INVALID_RECEIPT_TRACKER');
  const observation = parseObservation(observationInput);
  if (!observation) return result('CONTAINMENT_UNCERTAIN', 'INVALID_NATIVE_RESULT');
  if (Set.prototype.has.call(usedReceipts, observation.receiptId))
    return result('CONTAINMENT_UNCERTAIN', 'REPLAYED_RECEIPT');
  if (observation.generation !== gate.generation)
    return result('CONTAINMENT_UNCERTAIN', 'STALE_GENERATION');
  if (gate.active && (event === 'JOB_ASSIGNED' || event === 'STARTED'))
    return result('CONTAINMENT_UNCERTAIN', 'STOP_ACTIVE');
  if (event === 'SETUP_FAILED' || event === 'EVIDENCE_MISSING')
    return result('CONTAINMENT_UNCERTAIN', event);
  if (event === 'JOB_ASSIGNED' && stage === 'CREATED' && observation.processId !== null &&
    observation.jobOwned && observation.containmentQueried && !observation.controllingHandleInherited && observation.osError === null)
    return result('CONTAINED', 'LOCAL_JOB_CLAIM_ONLY');
  if (event === 'STARTED' && stage === 'CONTAINED' && observation.jobOwned &&
    observation.containmentQueried && !observation.controllingHandleInherited)
    return result('RUNNING', 'LOCAL_START_CLAIM_ONLY');
  if (event === 'PROCESS_EXITED' && stage === 'RUNNING' && observation.termination === 'OBSERVED')
    return result('EXITED', 'LOCAL_EXIT_CLAIM_ONLY');
  if (event === 'REQUEST_TERMINATION' && ['CONTAINED', 'RUNNING', 'EXITED'].includes(stage as string))
    return result('TERMINATION_REQUESTED', 'LOCAL_TERMINATION_REQUEST');
  if (event === 'TERMINATION_OBSERVED' && stage === 'TERMINATION_REQUESTED' &&
    observation.termination === 'OBSERVED' && observation.containmentQueried && observation.jobOwned)
    return result('TERMINATED', 'LOCAL_TERMINATION_CLAIM_ONLY');
  return result('CONTAINMENT_UNCERTAIN', 'UNSUPPORTED_OR_UNPROVEN_TRANSITION');
  } catch {
    // Hostile proxies and malformed native-facing objects cannot escape the fail-closed boundary.
    return result('CONTAINMENT_UNCERTAIN', 'INVALID_INPUT');
  }
}
