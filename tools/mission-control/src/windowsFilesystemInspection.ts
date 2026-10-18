import { lstat, realpath, stat } from 'node:fs/promises';
import { win32 } from 'node:path';
import { assessWindowsPath } from './workerIsolation.js';
import { assessTrustedRunnerPreflight, type RunnerPreflightAssessment } from './trustedRunnerPreflight.js';

/** Values here are local observations, never authenticated native receipts or authority. */
export interface WindowsFilesystemObservation {
  version: 1;
  source: 'NODE_OS_OBSERVATION';
  requestedPath: string;
  canonicalPath: string | null;
  observedAt: string;
  generation: number;
  workerExecutionId: string;
  nodeDevice: string | null;
  nodeInode: string | null;
  componentKinds: Array<'DIRECTORY' | 'SYMLINK_OR_JUNCTION' | 'OTHER' | 'UNKNOWN_REPARSE_STATUS'>;
  acl: 'UNVERIFIED';
  authenticity: 'UNVERIFIED';
  reasons: string[];
}

/** Native boundary required in S2B-2B. No implementation or caller receipt is accepted here. */
export interface NativeWindowsAclInspection {
  inspectWorkspaceAcl(input: {
    workspaceHandleIdentity: string;
    workerSid: string;
    allowedAccess: 'READ' | 'READ_WRITE';
  }): Promise<{
    volumeSerial: string;
    fileId: string;
    workerAccess: 'ALLOWED' | 'DENIED' | 'UNKNOWN';
    outsideWorkspaceAccess: 'DENIED' | 'UNKNOWN';
    authenticatedReceipt: Uint8Array;
  }>;
}

export interface WindowsInspectionRequest {
  workspaceRoot: string;
  claimedCanonicalRoot?: string;
  workerExecutionId: string;
  generation: number;
}

const own = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' &&
  !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype &&
  Object.getOwnPropertySymbols(v).length === 0 &&
  Object.getOwnPropertyNames(v).length === Object.keys(v).length &&
  Object.keys(v).every(k => 'value' in (Object.getOwnPropertyDescriptor(v, k) ?? {}));
const validClock = (v: unknown): v is Date => v instanceof Date && Number.isFinite(v.getTime());
const workerId = (v: unknown): v is string => typeof v === 'string' &&
  /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(v);
const positiveDecimal = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]*$/.test(v);
const componentKinds = ['DIRECTORY', 'SYMLINK_OR_JUNCTION', 'OTHER', 'UNKNOWN_REPARSE_STATUS'];
const dataArray = (v: unknown): v is unknown[] => Array.isArray(v) &&
  Object.getPrototypeOf(v) === Array.prototype && Object.getOwnPropertySymbols(v).length === 0 &&
  Object.keys(v).length === v.length && Object.getOwnPropertyNames(v).length === v.length + 1 &&
  Array.from({ length: v.length }, (_, i) => Object.getOwnPropertyDescriptor(v, String(i)))
    .every(d => d !== undefined && 'value' in d);

function validRequest(v: unknown): v is WindowsInspectionRequest {
  return own(v) && Object.keys(v).every(k => ['workspaceRoot', 'claimedCanonicalRoot',
    'workerExecutionId', 'generation'].includes(k)) &&
    typeof v.workspaceRoot === 'string' && workerId(v.workerExecutionId) &&
    Number.isSafeInteger(v.generation) && Number(v.generation) > 0 &&
    (v.claimedCanonicalRoot === undefined || typeof v.claimedCanonicalRoot === 'string');
}

function pathReason(path: string): string[] {
  if (path.startsWith('\\\\?\\') || path.startsWith('\\\\.\\')) return ['UNSUPPORTED_DEVICE_PATH'];
  if (path.startsWith('\\\\')) return ['UNSUPPORTED_UNC_PATH'];
  if (!win32.isAbsolute(path)) return ['INVALID_RELATIVE_PATH'];
  return assessWindowsPath(path, path).map(() => 'UNSAFE_WINDOWS_PATH');
}

function errorReason(error: unknown): string {
  const code = error !== null && typeof error === 'object' && 'code' in error &&
    typeof error.code === 'string' ? error.code : '';
  if (code === 'ENOENT') return 'WORKSPACE_MISSING';
  if (code === 'EACCES' || code === 'EPERM') return 'WORKSPACE_INACCESSIBLE';
  return 'FILESYSTEM_OBSERVATION_FAILED';
}

/** Reads directory metadata only. It neither opens a worker handle nor enforces access. */
export async function inspectWindowsWorkspace(value: unknown, now: Date = new Date()): Promise<WindowsFilesystemObservation> {
  const request = validRequest(value) ? value : null;
  const path = request?.workspaceRoot ?? '';
  const observation: WindowsFilesystemObservation = {
    version: 1, source: 'NODE_OS_OBSERVATION', requestedPath: path, canonicalPath: null,
    observedAt: validClock(now) ? now.toISOString() : '',
    generation: request?.generation ?? 0, workerExecutionId: request?.workerExecutionId ?? '',
    nodeDevice: null, nodeInode: null, componentKinds: [], acl: 'UNVERIFIED',
    authenticity: 'UNVERIFIED', reasons: []
  };
  if (!request || !validClock(now)) return { ...observation, reasons: ['MALFORMED_INSPECTION_REQUEST'] };
  const unsafe = pathReason(path);
  if (request.claimedCanonicalRoot !== undefined) unsafe.push(...pathReason(request.claimedCanonicalRoot));
  if (unsafe.length) return { ...observation, reasons: [...new Set(unsafe)] };

  try {
    // Inspect every lexical ancestor. lstat detects links and junctions exposed by Node,
    // but cannot establish that an ordinary-looking entry lacks every reparse tag.
    const parsed = win32.parse(path);
    let component = parsed.root;
    for (const part of path.slice(parsed.root.length).split('\\')) {
      component = win32.join(component, part);
      const info = await lstat(component, { bigint: true });
      observation.componentKinds.push(info.isSymbolicLink() ? 'SYMLINK_OR_JUNCTION' :
        info.isDirectory() ? 'UNKNOWN_REPARSE_STATUS' : 'OTHER');
    }
    const info = await stat(path, { bigint: true });
    if (!info.isDirectory()) observation.reasons.push('WORKSPACE_NOT_DIRECTORY');
    if (observation.componentKinds.includes('SYMLINK_OR_JUNCTION')) observation.reasons.push('REPARSE_POINT_DETECTED');
    if (observation.componentKinds.includes('OTHER')) observation.reasons.push('NON_DIRECTORY_COMPONENT');
    const canonical = await realpath(path);
    observation.canonicalPath = canonical;
    if (pathReason(canonical).length) observation.reasons.push('UNSUPPORTED_CANONICAL_PATH');
    if (canonical !== path || request.claimedCanonicalRoot !== undefined && request.claimedCanonicalRoot !== canonical)
      observation.reasons.push('CANONICAL_PATH_MISMATCH');
    if (info.dev !== 0n) observation.nodeDevice = info.dev.toString();
    if (info.ino !== 0n) observation.nodeInode = info.ino.toString();
    if (!observation.nodeDevice || !observation.nodeInode) observation.reasons.push('FILESYSTEM_IDENTITY_AMBIGUOUS');
    // Node dev/ino are observations, not verified Windows volume serial/file ID pairs.
    observation.reasons.push('NATIVE_FILE_IDENTITY_UNVERIFIED', 'REPARSE_STATUS_UNVERIFIED');
  } catch (error) { observation.reasons.push(errorReason(error)); }
  return observation;
}

export interface WindowsReadinessAssessment {
  observation: WindowsFilesystemObservation;
  claimPreflight: RunnerPreflightAssessment;
  filesystemIdentity: 'NODE_METADATA_OBSERVED' | 'AMBIGUOUS' | 'INVALID';
  reasons: string[];
  independentlyAuthenticated: false;
  productionAuthorized: false;
  executable: false;
}

/** Invalidates snapshots only; a supplied record is never proof of enforcement. */
export function assessObservationFreshness(value: unknown, expected: unknown,
  now: Date, maxAgeMillis = 60_000): string[] {
  const keys = ['version', 'source', 'requestedPath', 'canonicalPath', 'observedAt', 'generation',
    'workerExecutionId', 'nodeDevice', 'nodeInode', 'componentKinds', 'acl', 'authenticity', 'reasons'];
  if (!own(value) || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k)) ||
    value.version !== 1 || value.source !== 'NODE_OS_OBSERVATION' ||
    value.acl !== 'UNVERIFIED' || value.authenticity !== 'UNVERIFIED' ||
    typeof value.observedAt !== 'string' || !Number.isFinite(Date.parse(value.observedAt)) ||
    typeof value.requestedPath !== 'string' ||
    value.canonicalPath !== null && typeof value.canonicalPath !== 'string' ||
    value.nodeDevice !== null && !positiveDecimal(value.nodeDevice) ||
    value.nodeInode !== null && !positiveDecimal(value.nodeInode) ||
    !workerId(value.workerExecutionId) || !Number.isSafeInteger(value.generation) || Number(value.generation) <= 0 ||
    !dataArray(value.componentKinds) ||
    value.componentKinds.some(kind => !componentKinds.includes(kind as string)) ||
    !dataArray(value.reasons) ||
    value.reasons.some(reason => typeof reason !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(reason)) ||
    !validRequest(expected) || !validClock(now) ||
    !Number.isSafeInteger(maxAgeMillis) || maxAgeMillis < 0)
    return ['MALFORMED_OR_UNSUPPORTED_OBSERVATION'];
  const reasons: string[] = [];
  if (value.requestedPath !== expected.workspaceRoot ||
    value.workerExecutionId !== expected.workerExecutionId || value.generation !== expected.generation)
    reasons.push('WORKSPACE_IDENTITY_OR_GENERATION_CHANGED');
  if (now.getTime() - Date.parse(value.observedAt) > maxAgeMillis ||
    Date.parse(value.observedAt) > now.getTime() + 5_000) reasons.push('STALE_FILESYSTEM_OBSERVATION');
  if (!value.nodeDevice || !value.nodeInode) reasons.push('FILESYSTEM_IDENTITY_AMBIGUOUS');
  return reasons;
}

/** Collects its own observation. A caller cannot pass an evidence object into this assessor. */
export async function assessWindowsWorkspaceReadiness(input: unknown,
  now: Date = new Date()): Promise<WindowsReadinessAssessment> {
  const request = own(input) ? input.request : undefined;
  const preflight = own(input) ? input.preflight : undefined;
  const observation = await inspectWindowsWorkspace(request, now);
  const claimPreflight = assessTrustedRunnerPreflight(preflight, now);
  const reasons = [...observation.reasons, ...claimPreflight.reasons];
  const identity = own(preflight) && own(preflight.identity) ? preflight.identity : null;
  if (!identity || identity.workspaceRoot !== observation.requestedPath ||
    identity.workerExecutionId !== observation.workerExecutionId || identity.generation !== observation.generation)
    reasons.push('CLAIMED_WORKER_IDENTITY_MISMATCH');
  reasons.push(...assessObservationFreshness(observation, request, now));
  reasons.push('ACL_ENFORCEMENT_UNVERIFIED', 'TRUSTED_NATIVE_PROVIDER_MISSING',
    'NETWORK_ISOLATION_UNVERIFIED', 'PROCESS_CONTAINMENT_UNVERIFIED',
    'STOP_SYNCHRONIZATION_UNVERIFIED', 'TOCTOU_HANDLE_BINDING_MISSING');
  const invalid = observation.reasons.some(r => ['WORKSPACE_MISSING', 'WORKSPACE_INACCESSIBLE',
    'WORKSPACE_NOT_DIRECTORY', 'NON_DIRECTORY_COMPONENT', 'CANONICAL_PATH_MISMATCH',
    'REPARSE_POINT_DETECTED', 'MALFORMED_INSPECTION_REQUEST', 'UNSAFE_WINDOWS_PATH',
    'INVALID_RELATIVE_PATH', 'UNSUPPORTED_UNC_PATH', 'UNSUPPORTED_DEVICE_PATH',
    'UNSUPPORTED_CANONICAL_PATH', 'FILESYSTEM_OBSERVATION_FAILED'].includes(r));
  return { observation, claimPreflight,
    filesystemIdentity: invalid ? 'INVALID' : observation.nodeDevice && observation.nodeInode ?
      'NODE_METADATA_OBSERVED' : 'AMBIGUOUS', reasons: [...new Set(reasons)],
    independentlyAuthenticated: false, productionAuthorized: false, executable: false };
}
