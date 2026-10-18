import { win32 } from 'node:path';
import type { AgentRole } from './executionProtocol.js';

export type FileOperation = 'READ' | 'WRITE';
export interface WorkspaceScope { root: string; operations: FileOperation[] }
export interface WorkerCapabilities {
  role: AgentRole;
  workspaces: WorkspaceScope[];
  executable: { absolutePath: string; sha256: string };
  network: { mode: 'DENY' | 'ALLOWLIST'; destinations: string[] };
  environmentAllowlist: string[];
  github: { mode: 'NONE' | 'READ_ONLY'; repository?: { owner: string; name: string } };
  limits: { cpuMillis: number; memoryBytes: number; maxProcesses: number; runtimeMillis: number; outputBytes: number };
}

/** Names reserved for inert S2A fixtures. A future runner must build its own environment from trusted policy. */
export const S2A_FIXTURE_ENVIRONMENT_ALLOWLIST = ['S2A_FIXTURE_MARKER'] as const;

const plain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' &&
  !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype &&
  Object.getOwnPropertySymbols(v).length === 0 && Object.getOwnPropertyNames(v).length === Object.keys(v).length &&
  Object.keys(v).every((key) => 'value' in (Object.getOwnPropertyDescriptor(v, key) ?? {}));
const exact = (v: unknown, keys: string[], optional: string[] = []): v is Record<string, unknown> =>
  plain(v) && keys.every((k) => Object.hasOwn(v, k)) && Object.keys(v).every((k) => keys.includes(k) || optional.includes(k));
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v);
const dense = (value: unknown): value is unknown[] => Array.isArray(value) &&
  Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index)).every(Boolean);

/** Lexical Windows check only. A trusted runner must resolve every component using safe OS handles. */
export function assessWindowsPath(root: unknown, candidate: unknown): string[] {
  const reasons: string[] = [];
  const valid = (v: unknown): v is string => typeof v === 'string' && /^[A-Z]:\\[^/\\]+(?:\\[^/\\]+)*$/.test(v) &&
    !/[<>:"|?*\u0000-\u001f]/.test(v.slice(2)) && !v.split('\\').slice(1).some((part) =>
      part === '.' || part === '..' || /[. ]$/.test(part) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part));
  if (!valid(root) || !valid(candidate)) return ['UNSUPPORTED_OR_AMBIGUOUS_PATH'];
  if (win32.parse(root).root === root || win32.parse(candidate).root === candidate) reasons.push('DRIVE_ROOT');
  if (candidate !== root && !candidate.toLowerCase().startsWith(`${root.toLowerCase()}\\`)) reasons.push('OUTSIDE_WORKSPACE');
  if (candidate.toLowerCase().startsWith(root.toLowerCase()) && !candidate.startsWith(root)) reasons.push('CASE_BINDING_MISMATCH');
  return reasons;
}

export function assessFilesystemAccess(scope: WorkspaceScope, candidate: unknown, operation: FileOperation,
  componentEvidence: 'VERIFIED_NO_REPARSE' | 'MISSING' = 'MISSING'): string[] {
  if (!exact(scope, ['root', 'operations']) || !dense(scope.operations) ||
    !scope.operations.every((item: unknown) => item === 'READ' || item === 'WRITE'))
    return ['MALFORMED_SCOPE'];
  const reasons = assessWindowsPath(scope.root, candidate);
  if (!scope.operations.includes(operation)) reasons.push('OPERATION_DENIED');
  if (componentEvidence !== 'VERIFIED_NO_REPARSE') reasons.push('REPARSE_POINT_UNVERIFIED');
  // Evidence is a caller claim; this function never asserts OS-level containment.
  return reasons;
}

/** Contract structure, never a grant or sandbox. Each role receives separately scoped roots. */
export function parseWorkerCapabilities(value: unknown): WorkerCapabilities {
  if (!exact(value, ['role', 'workspaces', 'executable', 'network', 'environmentAllowlist', 'github', 'limits']) ||
    !['BUILDER', 'TESTER', 'REVIEWER', 'CORRECTOR'].includes(String(value.role)) ||
    !dense(value.workspaces) || value.workspaces.length !== 1 ||
    !value.workspaces.every((s: unknown) => exact(s, ['root', 'operations']) &&
      assessWindowsPath(s.root, s.root).length === 0 && dense(s.operations) &&
      s.operations.length > 0 && new Set(s.operations).size === s.operations.length &&
      s.operations.every((op: unknown) => op === 'READ' || op === 'WRITE')) ||
    !exact(value.executable, ['absolutePath', 'sha256']) ||
    assessWindowsPath(value.executable.absolutePath, value.executable.absolutePath).length !== 0 ||
    !/^[a-f0-9]{64}$/.test(String(value.executable.sha256)) ||
    !exact(value.network, ['mode', 'destinations']) ||
    !['DENY', 'ALLOWLIST'].includes(String(value.network.mode)) || !dense(value.network.destinations) ||
    (value.network.mode === 'DENY' && value.network.destinations.length !== 0) ||
    value.network.destinations.some((d: unknown) => typeof d !== 'string' ||
      !/^[a-z0-9.-]+:\d{1,5}$/.test(d) || d.includes('*') || d.startsWith('.') || d.endsWith('.')) ||
    !dense(value.environmentAllowlist) ||
    new Set(value.environmentAllowlist).size !== value.environmentAllowlist.length ||
    value.environmentAllowlist.some((e: unknown) =>
      !S2A_FIXTURE_ENVIRONMENT_ALLOWLIST.includes(e as typeof S2A_FIXTURE_ENVIRONMENT_ALLOWLIST[number])) ||
    !exact(value.github, ['mode'], ['repository']) || !['NONE', 'READ_ONLY'].includes(String(value.github.mode)) ||
    (value.github.mode === 'NONE' && value.github.repository !== undefined) ||
    (value.github.mode === 'READ_ONLY' && (!exact(value.github.repository, ['owner', 'name']) ||
      !id(value.github.repository.owner) || !id(value.github.repository.name))) ||
    !exact(value.limits, ['cpuMillis', 'memoryBytes', 'maxProcesses', 'runtimeMillis', 'outputBytes']) ||
    !Object.values(value.limits).every(positive) ||
    ((value.role === 'REVIEWER' || value.role === 'TESTER') &&
      (value.workspaces as WorkspaceScope[]).some((s) => s.operations.includes('WRITE'))))
    throw new Error('Invalid or excessive worker capability claim.');
  return value as unknown as WorkerCapabilities;
}
