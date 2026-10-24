import { lstat } from 'node:fs/promises';
import { arch, platform, release } from 'node:os';
import { win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessHostReadiness, type HostFileFact, type HostReadinessFacts,
  type HostReadinessReport } from './hostReadiness.js';

/** Only reviewed fixed candidates are inspected. Environment variables are not path authority. */
const vsRoot = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\2019\\BuildTools';
const msvcRoot = win32.join(vsRoot, 'VC', 'Tools', 'MSVC', '14.29.30133', 'bin', 'Hostx64', 'x64');
const sdkRoot = 'C:\\Program Files (x86)\\Windows Kits\\10';
const sdkVersion = '10.0.19041.0';
const trustedSystemRootCandidate = 'C:\\Windows';
/** A mismatching environment value never becomes an inspection path. */
export function pinnedSystemRoot(environmentValue: string | undefined): string | null {
  return environmentValue === undefined || environmentValue.toLowerCase() ===
    trustedSystemRootCandidate.toLowerCase() ? trustedSystemRootCandidate : null;
}
export const EXP00_DISPOSABLE_ROOT = 'E:\\AI-Development\\isolated\\mission-control-gate2b-disposable';

function safePath(path: string): boolean {
  return /^[A-Za-z]:\\/.test(path) && win32.normalize(path) === path &&
    !path.startsWith('\\\\') && !path.includes('..\\') && !path.includes('\\..') &&
    !path.includes(':', 2);
}

const unavailable = (path: string, error: string): HostFileFact =>
  ({ path, exists: false, kind: 'UNKNOWN', error });

type Metadata = { isSymbolicLink(): boolean; isFile(): boolean; isDirectory(): boolean };
type MetadataReader = (path: string) => Promise<Metadata>;

async function inspectComponent(path: string, read: MetadataReader): Promise<HostFileFact> {
  try {
    const info = await read(path);
    return { path, exists: true, kind: info.isSymbolicLink() ? 'SYMLINK' :
      info.isFile() ? 'FILE' : info.isDirectory() ? 'DIRECTORY' : 'OTHER', error: null };
  } catch (error) {
    const code = error !== null && typeof error === 'object' && 'code' in error &&
      typeof error.code === 'string' ? error.code : 'INSPECTION_FAILED';
    return unavailable(path, code);
  }
}

/**
 * Strictly bounded ancestor walk. Node lstat cannot prove absence of all Windows
 * reparse tags, even if it reports DIRECTORY. Refuse to traverse beneath such
 * an unverified ancestor, rather than checking a final target through it.
 */
export async function inspectBoundedWindowsCandidate(path: string,
  read: MetadataReader = lstat): Promise<HostFileFact> {
  if (!safePath(path)) return unavailable(path, 'UNSAFE_PATH');
  const parsed = win32.parse(path);
  const root = await inspectComponent(parsed.root, read);
  if (root.kind !== 'DIRECTORY') return unavailable(path, 'ANCESTOR_UNSAFE_OR_UNKNOWN');
  // A directory observation is not a native reparse-tag check. The root of the
  // volume itself is not authenticated here, so no descendant is inspected.
  return unavailable(path, 'ANCESTOR_REPARSE_UNVERIFIED');
}

async function inspectRootAncestors(path: string,
  read: MetadataReader = lstat): Promise<HostFileFact[]> {
  if (!safePath(path)) return [unavailable(win32.parse(path).root, 'UNSAFE_PATH')];
  const parsed = win32.parse(path);
  const parts = path.slice(parsed.root.length).split('\\');
  const root = await inspectComponent(parsed.root, read);
  const result: HostFileFact[] = [root.kind === 'DIRECTORY' ?
    unavailable(parsed.root, 'REPARSE_STATUS_UNVERIFIED') : root];
  let current = parsed.root;
  for (const part of parts.slice(0, -1)) {
    current = win32.join(current, part);
    result.push(unavailable(current, 'ANCESTOR_NOT_INSPECTED'));
  }
  return result;
}

/** Metadata only: no native process, observer session, ACL change or event-record read. */
export async function inspectWindowsHostReadiness(): Promise<HostReadinessReport> {
  if (platform() !== 'win32') {
    const ids = ['OS_ARCHITECTURE', 'MSVC_WINDOWS_SDK', 'COMPILER_LINKER_IDENTITY',
      'DISPOSABLE_ROOT', 'ACL_REPLACEMENT_PROTECTION', 'PROCESS_OBSERVER',
      'OBSERVER_COVERAGE_LOSS', 'CLEANUP_CAPABILITY'] as const;
    return { version: 1, source: 'LOCAL_READ_ONLY_INSPECTION',
      observedAt: new Date().toISOString(),
      checks: ids.map(id => ({ id, status: 'UNSUPPORTED' as const,
        reasons: ['UNSUPPORTED_OS'] })), experiment00: 'NO_GO',
      productionAuthorized: false, executable: false };
  }
  const root = EXP00_DISPOSABLE_ROOT;
  const checkoutRoot = win32.resolve(win32.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const relativeRoot = win32.relative(checkoutRoot, root);
  const lexicallyOutsideCheckout = relativeRoot === '..' || relativeRoot.startsWith('..\\') ||
    win32.isAbsolute(relativeRoot);
  const ancestors = await inspectRootAncestors(root);
  const target = unavailable(root, 'ANCESTOR_REPARSE_UNVERIFIED');
  // Environment strings are not trusted. In particular, never follow an
  // arbitrary SystemRoot path to read event-log or other file metadata.
  const systemRoot = trustedSystemRootCandidate;
  const systemRootMatches = pinnedSystemRoot(process.env.SystemRoot) !== null;
  const inspectLog = (name: string) => systemRootMatches ?
    inspectBoundedWindowsCandidate(win32.join(systemRoot, 'System32', 'winevt', 'Logs', name)) :
    Promise.resolve(unavailable(win32.join(systemRoot, 'System32', 'winevt', 'Logs', name),
      'UNTRUSTED_SYSTEM_ROOT'));
  const facts: HostReadinessFacts = {
    os: { platform: platform(), architecture: arch(), release: release() },
    toolchain: {
      vcvars: await inspectBoundedWindowsCandidate(win32.join(vsRoot, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat')),
      compiler: await inspectBoundedWindowsCandidate(win32.join(msvcRoot, 'cl.exe')),
      linker: await inspectBoundedWindowsCandidate(win32.join(msvcRoot, 'link.exe')),
      sdkHeader: await inspectBoundedWindowsCandidate(win32.join(sdkRoot, 'Include', sdkVersion, 'um', 'Windows.h')),
      sdkProcessThreadsHeader: await inspectBoundedWindowsCandidate(win32.join(sdkRoot, 'Include', sdkVersion, 'um', 'processthreadsapi.h')),
      sdkJobApiHeader: await inspectBoundedWindowsCandidate(win32.join(sdkRoot, 'Include', sdkVersion, 'um', 'jobapi2.h')),
      sdkLibrary: await inspectBoundedWindowsCandidate(win32.join(sdkRoot, 'Lib', sdkVersion, 'um', 'x64', 'kernel32.lib')),
      ambientCompilerPath: null, ambientLinkerPath: null
    },
    root: { target, ancestors, lexicallyOutsideCheckout },
    protection: 'UNKNOWN',
    observer: {
      sysmonLog: await inspectLog('Microsoft-Windows-Sysmon%4Operational.evtx'),
      securityLog: await inspectLog('Security.evtx')
    }
  };
  return { ...assessHostReadiness(facts), source: 'LOCAL_READ_ONLY_INSPECTION' };
}
