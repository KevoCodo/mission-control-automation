import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { assessObservationFreshness, assessWindowsWorkspaceReadiness,
  inspectWindowsWorkspace } from '../windowsFilesystemInspection.js';

const fixtureBase = win32.resolve(tmpdir());
const fixtures: string[] = [];
const now = new Date();
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(fixtureBase, 's2b2a-'));
  fixtures.push(root);
  return root;
}
const request = (workspaceRoot: string) => ({ workspaceRoot, workerExecutionId: 'fixture-worker', generation: 1 });
afterEach(async () => {
  for (const path of fixtures.splice(0)) {
    expect(win32.dirname(win32.resolve(path))).toBe(fixtureBase);
    expect(win32.basename(path).startsWith('s2b2a-')).toBe(true);
    await rm(path, { recursive: true, force: true });
  }
});

describe('read-only Windows workspace inspection', () => {
  it('observes a disposable regular directory without claiming native enforcement', async () => {
    const root = await fixture();
    const result = await inspectWindowsWorkspace(request(root), now);
    // Windows may expand an 8.3 short path when resolving the canonical path.
    const canonicalRoot = await realpath(root);
    expect(result).toMatchObject({ requestedPath: root, canonicalPath: canonicalRoot,
      source: 'NODE_OS_OBSERVATION', authenticity: 'UNVERIFIED', acl: 'UNVERIFIED' });
    expect(result.componentKinds.at(-1)).toBe('UNKNOWN_REPARSE_STATUS');
    expect(result.reasons).toContain('REPARSE_STATUS_UNVERIFIED');
    const assessed = await assessWindowsWorkspaceReadiness({ request: request(root), preflight: {} }, now);
    expect(assessed).toMatchObject({ independentlyAuthenticated: false,
      productionAuthorized: false, executable: false });
    expect(assessed.reasons).toEqual(expect.arrayContaining(['ACL_ENFORCEMENT_UNVERIFIED',
      'TRUSTED_NATIVE_PROVIDER_MISSING', 'NETWORK_ISOLATION_UNVERIFIED',
      'PROCESS_CONTAINMENT_UNVERIFIED', 'STOP_SYNCHRONIZATION_UNVERIFIED']));
  });

  it('distinguishes missing directory and regular file', async () => {
    const root = await fixture();
    expect((await inspectWindowsWorkspace(request(join(root, 'missing')))).reasons).toContain('WORKSPACE_MISSING');
    const file = join(root, 'file.txt');
    await writeFile(file, 'fixture');
    expect((await inspectWindowsWorkspace(request(file))).reasons).toContain('WORKSPACE_NOT_DIRECTORY');
  });

  it.each([
    ['relative', 'relative\\worker', 'INVALID_RELATIVE_PATH'],
    ['traversal', 'E:\\AI-Development\\temp\\..\\other', 'UNSAFE_WINDOWS_PATH'],
    ['UNC', '\\\\server\\share\\worker', 'UNSUPPORTED_UNC_PATH'],
    ['device', '\\\\?\\E:\\worker', 'UNSUPPORTED_DEVICE_PATH'],
    ['ADS', 'E:\\AI-Development\\temp\\file:stream', 'UNSAFE_WINDOWS_PATH'],
    ['trailing dot', 'E:\\AI-Development\\temp\\worker.', 'UNSAFE_WINDOWS_PATH'],
    ['trailing space', 'E:\\AI-Development\\temp\\worker ', 'UNSAFE_WINDOWS_PATH']
  ])('rejects %s path before filesystem access', async (_name, path, expected) => {
    expect((await inspectWindowsWorkspace(request(path))).reasons).toContain(expected);
  });

  it('detects substituted roots, canonical mismatch, and claimed identity mismatch', async () => {
    const root = await fixture();
    const other = await fixture();
    const mismatch = await inspectWindowsWorkspace({ ...request(root), claimedCanonicalRoot: other });
    expect(mismatch.reasons).toContain('CANONICAL_PATH_MISMATCH');
    const assessed = await assessWindowsWorkspaceReadiness({ request: request(other),
      preflight: { identity: { workspaceRoot: root, workerExecutionId: 'other', generation: 2 } } }, now);
    expect(assessed.reasons).toContain('CLAIMED_WORKER_IDENTITY_MISMATCH');
    expect(assessed.executable).toBe(false);
  });

  it('invalidates stale or changed observations, and rejects forged or malformed records as proof', async () => {
    const root = await fixture();
    const observation = await inspectWindowsWorkspace(request(root), now);
    expect(assessObservationFreshness({ ...observation, observedAt: new Date(now.getTime() - 120_000).toISOString() },
      request(root), now)).toContain('STALE_FILESYSTEM_OBSERVATION');
    expect(assessObservationFreshness(observation, request(join(root, 'replacement')), now))
      .toContain('WORKSPACE_IDENTITY_OR_GENERATION_CHANGED');
    expect(assessObservationFreshness({ ...observation, version: 2, trusted: true, verified: true,
      sandboxReady: true, issuer: 'native-provider' }, request(root), now))
      .toContain('MALFORMED_OR_UNSUPPORTED_OBSERVATION');
    expect(assessObservationFreshness({ ...observation, observedAt: {} }, request(root), now))
      .toContain('MALFORMED_OR_UNSUPPORTED_OBSERVATION');
    expect(assessObservationFreshness({ ...observation, nodeDevice: null }, request(root), now))
      .toContain('FILESYSTEM_IDENTITY_AMBIGUOUS');
    expect(assessObservationFreshness({ ...observation, componentKinds: {} }, request(root), now))
      .toContain('MALFORMED_OR_UNSUPPORTED_OBSERVATION');
    const assessed = await assessWindowsWorkspaceReadiness({ request: request(root),
      preflight: { trusted: true, verified: true, sandboxReady: true, issuer: 'native-provider' } }, now);
    expect(assessed).toMatchObject({ productionAuthorized: false, executable: false });
  });

  it('reports unavailable identity where Node metadata does not supply it', async () => {
    const root = await fixture();
    const observation = await inspectWindowsWorkspace(request(root), now);
    // The platform may report zero dev/ino. Either way native file and volume IDs remain unverified.
    expect(observation.reasons).toContain('NATIVE_FILE_IDENTITY_UNVERIFIED');
    if (observation.nodeDevice === null || observation.nodeInode === null)
      expect(observation.reasons).toContain('FILESYSTEM_IDENTITY_AMBIGUOUS');
  });

  it.each([null, undefined, {}, { request: undefined }, { request: null },
    { request: {} }, { request: { workspaceRoot: 'E:\\AI-Development\\temp' } }])
  ('fails closed for malformed readiness input %#', async input => {
    const result = await assessWindowsWorkspaceReadiness(input as never, now);
    expect(result).toMatchObject({ filesystemIdentity: 'INVALID', independentlyAuthenticated: false,
      productionAuthorized: false, executable: false });
    expect(result.reasons).toContain('MALFORMED_INSPECTION_REQUEST');
  });

  it('fails closed on invalid clocks and caller-forged readiness claims', async () => {
    const root = await fixture();
    for (const badNow of [new Date(Number.NaN), null]) {
      const result = await assessWindowsWorkspaceReadiness({ request: request(root), preflight: {
        trusted: true, verified: true, sandboxReady: true, issuer: 'native-provider'
      } }, badNow as Date);
      expect(result).toMatchObject({ filesystemIdentity: 'INVALID', independentlyAuthenticated: false,
        productionAuthorized: false, executable: false });
    }
    const valid = await assessWindowsWorkspaceReadiness({ request: request(root), preflight: {
      trusted: true, verified: true, sandboxReady: true, issuer: 'native-provider'
    } }, now);
    expect(valid).toMatchObject({ productionAuthorized: false, executable: false });
    expect(valid.reasons).toContain('TRUSTED_NATIVE_PROVIDER_MISSING');
  });

  it('rejects malformed freshness limits, array members, generation and worker ID', async () => {
    const root = await fixture();
    const observation = await inspectWindowsWorkspace(request(root), now);
    for (const limit of [Number.NaN, Infinity, -1, 0.5])
      expect(assessObservationFreshness(observation, request(root), now, limit))
        .toContain('MALFORMED_OR_UNSUPPORTED_OBSERVATION');
    const badRecords = [
      { ...observation, componentKinds: ['UNKNOWN_REPARSE_STATUS', ,] },
      { ...observation, reasons: ['REPARSE_STATUS_UNVERIFIED', ,] },
      { ...observation, componentKinds: ['VERIFIED_NO_REPARSE'] },
      { ...observation, reasons: ['GOOD', { code: 'BAD' }] },
      { ...observation, reasons: ['bad-reason'] },
      { ...observation, generation: 0 },
      { ...observation, generation: 1.5 },
      { ...observation, workerExecutionId: '../worker' },
      { ...observation, nodeDevice: 'not-a-device' },
      { ...observation, componentKinds: Object.defineProperty(['UNKNOWN_REPARSE_STATUS'], '0', {
        get: () => 'UNKNOWN_REPARSE_STATUS'
      }) }
    ];
    for (const record of badRecords)
      expect(assessObservationFreshness(record, request(root), now))
        .toContain('MALFORMED_OR_UNSUPPORTED_OBSERVATION');
    expect(assessObservationFreshness(observation, request(root), new Date(Number.NaN)))
      .toContain('MALFORMED_OR_UNSUPPORTED_OBSERVATION');
  });
});
