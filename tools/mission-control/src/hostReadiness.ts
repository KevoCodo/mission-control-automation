import { win32 } from 'node:path';

/** Read-only host diagnostics. These records never grant execution authority. */
export type HostReadinessStatus = 'READY' | 'MISSING' | 'UNVERIFIED' | 'UNSUPPORTED';
export type HostReadinessCheckId = 'OS_ARCHITECTURE' | 'MSVC_WINDOWS_SDK' |
  'COMPILER_LINKER_IDENTITY' | 'DISPOSABLE_ROOT' | 'ACL_REPLACEMENT_PROTECTION' |
  'PROCESS_OBSERVER' | 'OBSERVER_COVERAGE_LOSS' | 'CLEANUP_CAPABILITY';

export interface HostFileFact {
  path: string;
  exists: boolean;
  kind: 'FILE' | 'DIRECTORY' | 'SYMLINK' | 'OTHER' | 'UNKNOWN';
  error: string | null;
}

export interface HostReadinessFacts {
  os: { platform: string; architecture: string; release: string };
  toolchain: {
    vcvars: HostFileFact;
    compiler: HostFileFact;
    linker: HostFileFact;
    sdkHeader: HostFileFact;
    sdkProcessThreadsHeader: HostFileFact;
    sdkJobApiHeader: HostFileFact;
    sdkLibrary: HostFileFact;
    ambientCompilerPath: string | null;
    ambientLinkerPath: string | null;
  };
  root: {
    target: HostFileFact;
    ancestors: HostFileFact[];
    lexicallyOutsideCheckout: boolean;
  };
  protection: 'UNKNOWN' | 'OBSERVED_UNPROTECTED';
  observer: { sysmonLog: HostFileFact; securityLog: HostFileFact };
}

export interface HostReadinessCheck {
  id: HostReadinessCheckId;
  status: HostReadinessStatus;
  reasons: string[];
}

export interface HostReadinessReport {
  version: 1;
  source: 'UNAUTHENTICATED_FACTS' | 'LOCAL_READ_ONLY_INSPECTION';
  observedAt: string;
  checks: HostReadinessCheck[];
  experiment00: 'NO_GO';
  productionAuthorized: false;
  executable: false;
}

const ids: HostReadinessCheckId[] = ['OS_ARCHITECTURE', 'MSVC_WINDOWS_SDK',
  'COMPILER_LINKER_IDENTITY', 'DISPOSABLE_ROOT', 'ACL_REPLACEMENT_PROTECTION',
  'PROCESS_OBSERVER', 'OBSERVER_COVERAGE_LOSS', 'CLEANUP_CAPABILITY'];
const check = (id: HostReadinessCheckId, status: HostReadinessStatus,
  ...reasons: string[]): HostReadinessCheck => ({ id, status, reasons });

/** Never read an untrusted property via value[key], nor call untrusted array methods. */
function record(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some(key =>
    typeof key !== 'string' || !keys.includes(key))) return null;
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
    result[key] = descriptor.value;
  }
  return result;
}

function denseArray(value: unknown): unknown[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
  const descriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
  const length = descriptor.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > 256) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1) return null;
  const copied: unknown[] = [];
  for (let i = 0; i < length; i++) {
    const element = Object.getOwnPropertyDescriptor(value, String(i));
    if (!element || !Object.hasOwn(element, 'value')) return null;
    copied.push(element.value);
  }
  return copied;
}

function file(value: unknown): HostFileFact | null {
  const v = record(value, ['path', 'exists', 'kind', 'error']);
  if (!v || typeof v.path !== 'string' || typeof v.exists !== 'boolean' ||
    (v.kind !== 'FILE' && v.kind !== 'DIRECTORY' && v.kind !== 'SYMLINK' &&
      v.kind !== 'OTHER' && v.kind !== 'UNKNOWN') ||
    !(v.error === null || typeof v.error === 'string') ||
    (v.exists ? v.kind === 'UNKNOWN' || v.error !== null :
      v.kind !== 'UNKNOWN' || typeof v.error !== 'string')) return null;
  return { path: v.path, exists: v.exists, kind: v.kind, error: v.error as string | null };
}

function parseFacts(value: unknown): HostReadinessFacts | null {
  const top = record(value, ['os', 'toolchain', 'root', 'protection', 'observer']);
  if (!top) return null;
  const os = record(top.os, ['platform', 'architecture', 'release']);
  const toolchain = record(top.toolchain, ['vcvars', 'compiler', 'linker', 'sdkHeader',
    'sdkProcessThreadsHeader', 'sdkJobApiHeader', 'sdkLibrary', 'ambientCompilerPath',
    'ambientLinkerPath']);
  const root = record(top.root, ['target', 'ancestors', 'lexicallyOutsideCheckout']);
  const observer = record(top.observer, ['sysmonLog', 'securityLog']);
  if (!os || !toolchain || !root || !observer ||
    typeof os.platform !== 'string' || typeof os.architecture !== 'string' ||
    typeof os.release !== 'string' ||
    (top.protection !== 'UNKNOWN' && top.protection !== 'OBSERVED_UNPROTECTED') ||
    typeof root.lexicallyOutsideCheckout !== 'boolean') return null;
  const fileNames = ['vcvars', 'compiler', 'linker', 'sdkHeader',
    'sdkProcessThreadsHeader', 'sdkJobApiHeader', 'sdkLibrary'] as const;
  const parsedFiles = fileNames.map(name => file(toolchain[name]));
  const target = file(root.target);
  const sysmonLog = file(observer.sysmonLog);
  const securityLog = file(observer.securityLog);
  const ancestors = denseArray(root.ancestors);
  if (parsedFiles.some(item => item === null) || !target || !sysmonLog ||
    !securityLog || !ancestors ||
    (toolchain.ambientCompilerPath !== null && typeof toolchain.ambientCompilerPath !== 'string') ||
    (toolchain.ambientLinkerPath !== null && typeof toolchain.ambientLinkerPath !== 'string')) return null;
  const parsedAncestors = ancestors.map(item => file(item));
  if (parsedAncestors.some(item => item === null)) return null;
  const validAncestors = parsedAncestors as HostFileFact[];
  if (target.exists && validAncestors.some(a => !a.exists)) return null;
  // Ancestors must form one ordered Windows path chain, and target must be its direct child.
  const path = (value: string): string => value.replaceAll('/', '\\').toLowerCase();
  if (!win32.isAbsolute(target.path) || validAncestors.length === 0) return null;
  if (validAncestors.length > 0) {
    for (let i = 0; i < validAncestors.length; i++) {
      const current = validAncestors[i].path;
      if (i === 0 ? win32.parse(current).root.toLowerCase() !== current.toLowerCase() :
        path(win32.dirname(current)) !== path(validAncestors[i - 1].path)) return null;
    }
    if (path(win32.dirname(target.path)) !== path(validAncestors[validAncestors.length - 1].path)) return null;
  }
  return {
    os: { platform: os.platform, architecture: os.architecture, release: os.release },
    toolchain: {
      vcvars: parsedFiles[0]!, compiler: parsedFiles[1]!, linker: parsedFiles[2]!,
      sdkHeader: parsedFiles[3]!, sdkProcessThreadsHeader: parsedFiles[4]!,
      sdkJobApiHeader: parsedFiles[5]!, sdkLibrary: parsedFiles[6]!,
      ambientCompilerPath: toolchain.ambientCompilerPath as string | null,
      ambientLinkerPath: toolchain.ambientLinkerPath as string | null
    },
    root: { target, ancestors: validAncestors,
      lexicallyOutsideCheckout: root.lexicallyOutsideCheckout },
    protection: top.protection,
    observer: { sysmonLog, securityLog }
  };
}

const presentFile = (value: HostFileFact): boolean => value.exists && value.kind === 'FILE' && value.error === null;
const missingFile = (value: HostFileFact): boolean => !value.exists && value.error === 'ENOENT';

/** Pure assessment for deterministic fixtures; even complete facts cannot authorize a build or run. */
export function assessHostReadiness(value: unknown, now: Date = new Date()): HostReadinessReport {
  const observedAt = now instanceof Date && Number.isFinite(now.getTime()) ? now.toISOString() : '';
  const result = (checks: HostReadinessCheck[]): HostReadinessReport => ({
    version: 1, source: 'UNAUTHENTICATED_FACTS', observedAt, checks,
    experiment00: 'NO_GO', productionAuthorized: false, executable: false
  });
  try {
    const facts = parseFacts(value);
    if (!observedAt || !facts)
      return result(ids.map(id => check(id, 'UNVERIFIED', 'MALFORMED_OR_CONTRADICTORY_FACTS')));
    const checks: HostReadinessCheck[] = [];
    const supported = facts.os.platform === 'win32' && facts.os.architecture === 'x64' &&
      /^10\.0\.[0-9]+$/.test(facts.os.release);
    checks.push(check('OS_ARCHITECTURE', supported ? 'READY' : 'UNSUPPORTED',
      supported ? 'WINDOWS_X64_VERSION_OBSERVED' : 'UNSUPPORTED_OS_OR_ARCHITECTURE'));
    const files = [facts.toolchain.vcvars, facts.toolchain.compiler, facts.toolchain.linker,
      facts.toolchain.sdkHeader, facts.toolchain.sdkProcessThreadsHeader,
      facts.toolchain.sdkJobApiHeader, facts.toolchain.sdkLibrary];
    const allPresent = files.every(presentFile);
    checks.push(check('MSVC_WINDOWS_SDK', allPresent ? 'READY' :
      files.some(missingFile) ? 'MISSING' : 'UNVERIFIED',
      allPresent ? 'CANDIDATE_FILES_PRESENT' : 'TOOLCHAIN_FILES_MISSING_OR_UNREADABLE'));
    const normalized = (path: string) => path.replaceAll('/', '\\').toLowerCase();
    const wrongCompiler = facts.toolchain.ambientCompilerPath !== null &&
      normalized(facts.toolchain.ambientCompilerPath) !== normalized(facts.toolchain.compiler.path);
    const wrongLinker = facts.toolchain.ambientLinkerPath !== null &&
      normalized(facts.toolchain.ambientLinkerPath) !== normalized(facts.toolchain.linker.path);
    checks.push(check('COMPILER_LINKER_IDENTITY', 'UNVERIFIED',
      ...(wrongCompiler ? ['AMBIENT_COMPILER_MISMATCH'] : []),
      ...(wrongLinker ? ['AMBIENT_LINKER_MISMATCH'] : []),
      'ACTUAL_BUILD_RESOLUTION_AND_HASHES_UNVERIFIED'));
    const root = facts.root;
    const badAncestor = root.ancestors.some(a => a.kind === 'SYMLINK' || a.kind === 'OTHER');
    const rootStatus: HostReadinessStatus = !root.lexicallyOutsideCheckout || badAncestor ||
      root.target.kind === 'SYMLINK' || root.target.kind === 'OTHER' ? 'UNSUPPORTED' :
      missingFile(root.target) ? 'MISSING' : 'UNVERIFIED';
    checks.push(check('DISPOSABLE_ROOT', rootStatus,
      rootStatus === 'MISSING' ? 'DISPOSABLE_ROOT_ABSENT' :
        rootStatus === 'UNSUPPORTED' ? 'UNSAFE_OR_OVERLAPPING_ROOT' :
          'NATIVE_PATH_IDENTITY_AND_REPOSITORY_SEPARATION_UNVERIFIED'));
    checks.push(check('ACL_REPLACEMENT_PROTECTION',
      facts.protection === 'OBSERVED_UNPROTECTED' ? 'MISSING' : 'UNVERIFIED',
      facts.protection === 'OBSERVED_UNPROTECTED' ? 'STAGING_PROTECTION_ABSENT' :
        'EFFECTIVE_ACL_AND_PARENT_DELETE_RIGHTS_UNVERIFIED'));
    checks.push(check('PROCESS_OBSERVER', missingFile(facts.observer.sysmonLog) ? 'MISSING' : 'UNVERIFIED',
      missingFile(facts.observer.sysmonLog) ? 'SYSMON_LOG_ABSENT' :
        'SERVICE_CONFIGURATION_AND_LOG_ACCESS_UNVERIFIED'));
    checks.push(check('OBSERVER_COVERAGE_LOSS', 'UNVERIFIED', 'CONTINUOUS_COVERAGE_AND_LOSS_BOUNDS_UNVERIFIED'));
    checks.push(check('CLEANUP_CAPABILITY', 'UNVERIFIED', 'INDEPENDENT_PROCESS_AND_ROOT_CLEANUP_UNVERIFIED'));
    return result(checks);
  } catch {
    return result(ids.map(id => check(id, 'UNVERIFIED', 'MALFORMED_OR_CONTRADICTORY_FACTS')));
  }
}
