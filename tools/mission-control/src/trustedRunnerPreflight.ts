import { parseExecutionEnvelope, type ExecutionEnvelope } from './executionProtocol.js';
import { parseWorkerIdentity, type WorkerIdentity } from './workerIdentity.js';
import { parseWorkerCapabilities, type WorkerCapabilities } from './workerIsolation.js';
import { assessWorkerFence, type WorkerFenceInput } from './workerLifecycle.js';
import { assessWindowsFilesystemIdentity, type WindowsFilesystemIdentityClaim } from './windowsFilesystemPreflight.js';

export const RUNNER_CONTROLS = ['OS_ENFORCEMENT', 'FILESYSTEM', 'EXECUTABLE', 'NETWORK',
  'CREDENTIALS', 'PROCESS_TREE', 'RESOURCE_LIMITS', 'STOP_BARRIER', 'DURABLE_STATE'] as const;
export type RunnerControl = typeof RUNNER_CONTROLS[number];

/** A future native provider must return handle- and policy-backed observations, never a readiness flag. */
export interface TrustedWindowsEnforcementProvider {
  inspectOsEnforcement(executionId: string): Promise<unknown>;
  inspectWorkerFilesystem(executionId: string): Promise<WindowsFilesystemIdentityClaim>;
  inspectExecutable(executionId: string): Promise<{ path: string; sha256: string }>;
  inspectNetworkRestriction(executionId: string): Promise<unknown>;
  inspectCredentialIsolation(executionId: string): Promise<unknown>;
  inspectProcessTreeContainment(executionId: string): Promise<unknown>;
  inspectResourceLimits(executionId: string): Promise<unknown>;
  inspectStopBarrier(executionId: string): Promise<unknown>;
  inspectDurableExecutionState(executionId: string): Promise<unknown>;
}

export interface RunnerControlClaim {
  control: RunnerControl;
  status: 'READY' | 'UNAVAILABLE';
  workerExecutionId: string;
  dispatchId: string;
  repository: { owner: string; name: string };
  generation: number;
  fencingEpoch: number;
  evidenceRef: string;
}

export interface RunnerPreflightInput {
  envelope: ExecutionEnvelope;
  identity: WorkerIdentity;
  capabilities: WorkerCapabilities;
  fence: WorkerFenceInput;
  filesystem: WindowsFilesystemIdentityClaim;
  provider: { version: number; origin: 'FIXTURE' | 'LOCAL_CLAIM' | 'TRUSTED_COMPONENT'; evidenceRef: string } | null;
  claims: RunnerControlClaim[];
  /** These are claims too. An independent verifier and an atomic gate are not implemented in S2B-1. */
  verifierEvidenceRef?: string;
  atomicGateEvidenceRef?: string;
}

export interface RunnerPreflightAssessment {
  structurallyValid: boolean;
  locallyClaimedReady: boolean;
  independentlyAuthenticated: false;
  productionAuthorized: false;
  executable: false;
  reasons: string[];
}

const plain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' &&
  !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype &&
  Object.getOwnPropertySymbols(v).length === 0 &&
  Object.getOwnPropertyNames(v).length === Object.keys(v).length &&
  Object.keys(v).every((key) => 'value' in (Object.getOwnPropertyDescriptor(v, key) ?? {}));
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> => plain(v) &&
  Object.keys(v).length === keys.length && keys.every((key) => Object.hasOwn(v, key));
const ref = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(v);
const dense = (v: unknown): v is unknown[] => Array.isArray(v) &&
  Array.from({ length: v.length }, (_, i) => Object.hasOwn(v, i)).every(Boolean);
const result = (structurallyValid: boolean, locallyClaimedReady: boolean, reasons: string[]): RunnerPreflightAssessment =>
  ({ structurallyValid, locallyClaimedReady, independentlyAuthenticated: false,
    productionAuthorized: false, executable: false, reasons: [...new Set(reasons)] });

/** Pure claim assessment. A caller cannot submit proof of its own trust or obtain launch permission. */
export function assessTrustedRunnerPreflight(value: unknown, now: Date): RunnerPreflightAssessment {
  if (!plain(value) || !(now instanceof Date) || !Number.isFinite(now.getTime()))
    return result(false, false, ['MALFORMED_INPUT']);
  const v = value as Record<string, unknown>;
  const required = ['envelope', 'identity', 'capabilities', 'fence', 'filesystem', 'provider', 'claims'];
  if (Object.keys(v).some((key) => ![...required, 'verifierEvidenceRef', 'atomicGateEvidenceRef'].includes(key)) ||
    required.some((key) => !Object.hasOwn(v, key)) || !dense(v.claims))
    return result(false, false, ['MALFORMED_INPUT']);
  let envelope: ExecutionEnvelope;
  let identity: WorkerIdentity;
  let capabilities: WorkerCapabilities;
  try {
    envelope = parseExecutionEnvelope(v.envelope);
    identity = parseWorkerIdentity(v.identity, envelope, now);
    capabilities = parseWorkerCapabilities(v.capabilities);
  } catch { return result(false, false, ['MALFORMED_OR_CONFLICTING_WORKER_CONTRACT']); }
  if (!exact(v.fence, ['stop', 'grant', 'dispatchGeneration']) ||
    !exact(v.fence.stop, ['active', 'durableEpoch', 'generation', 'barrierReceiptId', 'durableEvidenceRef']) ||
    !exact(v.fence.grant, ['grantId', 'expiresAt', 'revoked'])) return result(false, false, ['MALFORMED_FENCE']);
  if (v.provider !== null && (!exact(v.provider, ['version', 'origin', 'evidenceRef']) ||
    !Number.isSafeInteger(v.provider.version) ||
    !['FIXTURE', 'LOCAL_CLAIM', 'TRUSTED_COMPONENT'].includes(String(v.provider.origin)) ||
    !ref(v.provider.evidenceRef))) return result(false, false, ['MALFORMED_PROVIDER']);
  if (v.verifierEvidenceRef !== undefined && !ref(v.verifierEvidenceRef) ||
    v.atomicGateEvidenceRef !== undefined && !ref(v.atomicGateEvidenceRef))
    return result(false, false, ['MALFORMED_INPUT']);
  const claims = v.claims as unknown[];
  if (claims.some((claim) => !exact(claim, ['control', 'status', 'workerExecutionId', 'dispatchId',
    'repository', 'generation', 'fencingEpoch', 'evidenceRef']) ||
    !RUNNER_CONTROLS.includes(claim.control as RunnerControl) ||
    !['READY', 'UNAVAILABLE'].includes(String(claim.status)) ||
    !exact(claim.repository, ['owner', 'name']) || !ref(claim.evidenceRef) ||
    typeof claim.workerExecutionId !== 'string' || typeof claim.dispatchId !== 'string' ||
    typeof claim.repository.owner !== 'string' || typeof claim.repository.name !== 'string' ||
    !Number.isSafeInteger(claim.generation) || !Number.isSafeInteger(claim.fencingEpoch)))
    return result(false, false, ['MALFORMED_CONTROL_EVIDENCE']);
  const evidence = claims as RunnerControlClaim[];
  const reasons: string[] = [];
  const fence = assessWorkerFence(identity, envelope, v.fence as unknown as WorkerFenceInput, now);
  reasons.push(...fence.reasons);
  if (capabilities.role !== identity.agentRole || capabilities.workspaces[0].root !== identity.workspaceRoot)
    reasons.push('WRONG_WORKER_SCOPE');
  const filesystemReasons = assessWindowsFilesystemIdentity(v.filesystem);
  if (filesystemReasons.includes('MALFORMED_FILESYSTEM_IDENTITY'))
    return result(false, false, filesystemReasons);
  reasons.push(...filesystemReasons);
  if (plain(v.filesystem) && (v.filesystem.workspaceRoot !== identity.workspaceRoot ||
    v.filesystem.candidate !== identity.workspaceRoot)) reasons.push('INVALID_PATH_CONTAINMENT');
  if (v.provider === null) reasons.push('TRUSTED_PROVIDER_MISSING');
  else {
    const provider = v.provider as RunnerPreflightInput['provider'];
    if (provider?.version !== 1) reasons.push('UNSUPPORTED_PROVIDER_VERSION');
    if (provider?.origin !== 'TRUSTED_COMPONENT') reasons.push('PROVIDER_ONLY_LOCALLY_CLAIMED');
    // Even TRUSTED_COMPONENT is a caller-supplied string, not authenticated provenance.
  }
  const seen = new Set<RunnerControl>();
  const refs = new Set<string>();
  for (const claim of evidence) {
    if (seen.has(claim.control)) reasons.push('DUPLICATE_OR_CONTRADICTORY_EVIDENCE');
    seen.add(claim.control);
    if (refs.has(claim.evidenceRef)) reasons.push('DUPLICATE_OR_CONTRADICTORY_EVIDENCE');
    refs.add(claim.evidenceRef);
    if (claim.workerExecutionId !== identity.workerExecutionId) reasons.push('WRONG_WORKER_IDENTITY');
    if (claim.dispatchId !== identity.dispatchId) reasons.push('WRONG_DISPATCH_BINDING');
    if (claim.repository.owner !== identity.repository.owner || claim.repository.name !== identity.repository.name)
      reasons.push('WRONG_REPOSITORY');
    if (claim.generation !== identity.generation) reasons.push('STALE_GENERATION');
    if (claim.fencingEpoch !== identity.fencingEpoch) reasons.push('STALE_FENCING_EPOCH');
    if (claim.status !== 'READY') reasons.push(`CONTROL_UNAVAILABLE_${claim.control}`);
  }
  for (const control of RUNNER_CONTROLS) if (!seen.has(control)) reasons.push(`CONTROL_MISSING_${control}`);
  if (!seen.has('PROCESS_TREE')) reasons.push('UNKNOWN_PROCESS_TREE_OWNERSHIP');
  if (!seen.has('STOP_BARRIER')) reasons.push('MISSING_LAUNCH_SYNCHRONIZATION_BARRIER');
  if (!seen.has('DURABLE_STATE')) reasons.push('MISSING_DURABLE_EXECUTION_STATE');
  const locallyClaimedReady = reasons.length === 0;
  if (!ref(v.verifierEvidenceRef)) reasons.push('TRUSTED_VERIFIER_MISSING');
  if (!ref(v.atomicGateEvidenceRef)) reasons.push('ATOMIC_AUTHORIZATION_GATE_MISSING');
  reasons.push('INDEPENDENT_AUTHENTICATION_UNAVAILABLE', 'PRODUCTION_EXECUTION_DISABLED');
  return result(true, locallyClaimedReady, reasons);
}
