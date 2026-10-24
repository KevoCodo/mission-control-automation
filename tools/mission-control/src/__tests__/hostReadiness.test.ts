import { describe, expect, it } from 'vitest';
import { inspectBoundedWindowsCandidate, pinnedSystemRoot } from '../windowsHostReadiness.js';
import { assessHostReadiness, type HostFileFact, type HostReadinessCheckId,
  type HostReadinessFacts } from '../hostReadiness.js';

const present = (path: string): HostFileFact => ({ path, exists: true, kind: 'FILE', error: null });
const directory = (path: string): HostFileFact => ({ path, exists: true, kind: 'DIRECTORY', error: null });
const absent = (path: string): HostFileFact => ({ path, exists: false, kind: 'UNKNOWN', error: 'ENOENT' });
const facts = (): HostReadinessFacts => ({
  os: { platform: 'win32', architecture: 'x64', release: '10.0.26200' },
  toolchain: {
    vcvars: present('C:\\VS\\vcvars64.bat'), compiler: present('C:\\VS\\cl.exe'),
    linker: present('C:\\VS\\link.exe'), sdkHeader: present('C:\\SDK\\Windows.h'),
    sdkProcessThreadsHeader: present('C:\\SDK\\processthreadsapi.h'),
    sdkJobApiHeader: present('C:\\SDK\\jobapi2.h'),
    sdkLibrary: present('C:\\SDK\\kernel32.lib'), ambientCompilerPath: null,
    ambientLinkerPath: null
  },
  root: { target: directory('E:\\disposable'), ancestors: [directory('E:\\')],
    lexicallyOutsideCheckout: true },
  protection: 'UNKNOWN',
  observer: { sysmonLog: present('C:\\Windows\\Sysmon.evtx'),
    securityLog: present('C:\\Windows\\Security.evtx') }
});
const get = (input: unknown, id: HostReadinessCheckId) =>
  assessHostReadiness(input).checks.find(c => c.id === id);

describe('Gate 2B Windows host readiness fixture assessment', () => {
  it('reports missing observer without treating Security log presence as a substitute', () => {
    const input = facts(); input.observer.sysmonLog = absent(input.observer.sysmonLog.path);
    expect(get(input, 'PROCESS_OBSERVER')).toMatchObject({ status: 'MISSING',
      reasons: ['SYSMON_LOG_ABSENT'] });
    expect(get(input, 'OBSERVER_COVERAGE_LOSS')?.status).toBe('UNVERIFIED');
  });

  it('rejects unsupported operating systems and architectures', () => {
    for (const os of [{ platform: 'linux', architecture: 'x64', release: '6.0' },
      { platform: 'win32', architecture: 'arm64', release: '10.0.26200' },
      { platform: 'win32', architecture: 'x64', release: '6.1.7601' }]) {
      const input = facts(); input.os = os;
      expect(get(input, 'OS_ARCHITECTURE')?.status).toBe('UNSUPPORTED');
      expect(assessHostReadiness(input).experiment00).toBe('NO_GO');
    }
  });

  it('flags a wrong ambient linker and never assumes actual build resolution', () => {
    const input = facts(); input.toolchain.ambientLinkerPath = 'C:\\Git\\link.exe';
    expect(get(input, 'COMPILER_LINKER_IDENTITY')).toMatchObject({ status: 'UNVERIFIED',
      reasons: ['AMBIENT_LINKER_MISMATCH', 'ACTUAL_BUILD_RESOLUTION_AND_HASHES_UNVERIFIED'] });
    expect(get(input, 'MSVC_WINDOWS_SDK')?.status).toBe('READY');
  });

  it('reports missing toolchain files and unprotected staging', () => {
    const input = facts(); input.toolchain.sdkLibrary = absent(input.toolchain.sdkLibrary.path);
    input.protection = 'OBSERVED_UNPROTECTED';
    expect(get(input, 'MSVC_WINDOWS_SDK')?.status).toBe('MISSING');
    expect(get(input, 'ACL_REPLACEMENT_PROTECTION')?.status).toBe('MISSING');
  });

  it('keeps unknown ACL and reparse evidence unverified', () => {
    const input = facts();
    expect(get(input, 'ACL_REPLACEMENT_PROTECTION')?.status).toBe('UNVERIFIED');
    expect(get(input, 'DISPOSABLE_ROOT')?.status).toBe('UNVERIFIED');
    input.root.ancestors[0] = { ...input.root.ancestors[0], kind: 'SYMLINK' };
    expect(get(input, 'DISPOSABLE_ROOT')?.status).toBe('UNSUPPORTED');
  });

  it('fails closed on contradictory observations', () => {
    const input = facts();
    input.root.target = { path: 'E:\\disposable', exists: false, kind: 'DIRECTORY', error: 'ENOENT' };
    expect(assessHostReadiness(input).checks.every(c => c.status === 'UNVERIFIED')).toBe(true);
    expect(get(input, 'DISPOSABLE_ROOT')?.reasons).toContain('MALFORMED_OR_CONTRADICTORY_FACTS');
  });

  it('rejects unknown caller assertions rather than treating them as evidence', () => {
    const input = { ...facts(), cleanupComplete: true, allDescendantsGone: true };
    input.root.target = absent(input.root.target.path);
    expect(get(input, 'DISPOSABLE_ROOT')?.reasons).toContain('MALFORMED_OR_CONTRADICTORY_FACTS');
    expect(get(input, 'CLEANUP_CAPABILITY')?.status).toBe('UNVERIFIED');
  });

  it('does not let forged positive claims enable execution', () => {
    const input = { ...facts(), trusted: true, authorized: true, executable: true,
      productionAuthorized: true, observerCoverageVerified: true, cleanupComplete: true };
    const result = assessHostReadiness(input);
    expect(result).toMatchObject({ source: 'UNAUTHENTICATED_FACTS', experiment00: 'NO_GO',
      productionAuthorized: false, executable: false });
    expect(result.checks.every(c => c.reasons.includes('MALFORMED_OR_CONTRADICTORY_FACTS'))).toBe(true);
    expect(result.checks.find(c => c.id === 'CLEANUP_CAPABILITY')?.status).toBe('UNVERIFIED');
  });
  it('rejects overridden array methods without executing them', () => {
    let calls = 0;
    for (const method of ['some', 'every', 'map', 'includes']) {
      const input = facts();
      Object.defineProperty(input.root.ancestors, method, { value: () => { calls++; return false; } });
      expect(get(input, 'DISPOSABLE_ROOT')?.reasons).toContain('MALFORMED_OR_CONTRADICTORY_FACTS');
    }
    expect(calls).toBe(0);
  });

  it('rejects accessors without executing getters', () => {
    let calls = 0;
    const input = facts();
    Object.defineProperty(input.toolchain, 'compiler', {
      get: () => { calls++; throw new Error('hostile getter'); }, enumerable: true
    });
    expect(get(input, 'MSVC_WINDOWS_SDK')?.reasons).toContain('MALFORMED_OR_CONTRADICTORY_FACTS');
    const other = facts();
    Object.defineProperty(other.root.ancestors, '0', {
      get: () => { calls++; return directory('E:\\'); }, enumerable: true
    });
    expect(get(other, 'DISPOSABLE_ROOT')?.reasons).toContain('MALFORMED_OR_CONTRADICTORY_FACTS');
    expect(calls).toBe(0);
  });

  it('rejects sparse, extra-property, symbol and foreign-prototype values', () => {
    const cases: unknown[] = [];
    const sparse = facts(); sparse.root.ancestors = Array(2) as HostFileFact[];
    cases.push(sparse);
    const extra = facts(); Object.assign(extra.root.ancestors, { extra: true }); cases.push(extra);
    const symbolic = facts(); Object.defineProperty(symbolic.root, Symbol('override'), { value: true });
    cases.push(symbolic);
    const nested = facts(); Object.assign(nested.toolchain.compiler, { signed: true }); cases.push(nested);
    const inherited = facts(); Object.setPrototypeOf(inherited.observer, { spoof: true }); cases.push(inherited);
    for (const input of cases)
      expect(get(input, 'DISPOSABLE_ROOT')?.reasons).toContain('MALFORMED_OR_CONTRADICTORY_FACTS');
  });

  it('rejects contradictory ancestor or target paths', () => {
    const parent = facts(); parent.root.ancestors[0].path = 'C:\\';
    const child = facts(); child.root.target.path = 'E:\\another\\disposable';
    for (const input of [parent, child])
      expect(get(input, 'DISPOSABLE_ROOT')?.reasons).toContain('MALFORMED_OR_CONTRADICTORY_FACTS');
  });

  it('rejects a redirected SystemRoot without accepting it as a candidate', () => {
    expect(pinnedSystemRoot('E:\\AI-Development\\ao-data')).toBeNull();
    expect(pinnedSystemRoot('C:\\Windows')).toBe('C:\\Windows');
  });

  it('never traverses beneath an unverified or redirected ancestor', async () => {
    const visited: string[] = [];
    const directory = { isSymbolicLink: () => false, isFile: () => false, isDirectory: () => true };
    const reader = async (path: string) => { visited.push(path); return directory; };
    const result = await inspectBoundedWindowsCandidate('C:\\Windows\\System32\\winevt\\Logs\\Security.evtx', reader);
    expect(result.error).toBe('ANCESTOR_REPARSE_UNVERIFIED');
    expect(visited).toEqual(['C:\\']);
    visited.length = 0;
    const invalid = await inspectBoundedWindowsCandidate('E:\\AO\\..\\private.txt', reader);
    expect(invalid.error).toBe('UNSAFE_PATH');
    expect(visited).toEqual([]);
  });

});
