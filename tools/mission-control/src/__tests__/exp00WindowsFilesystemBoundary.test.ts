import { describe, expect, it } from 'vitest';
import { win32 } from 'node:path';
import { captureExp00FileSnapshot } from '../exp00BuildProvenance.js';
import { EXP00_PATHS, inspectExp00PathWithApi, type NativeFileApi,
  type NativeFileObservation } from '../exp00WindowsFilesystemBoundary.js';

const target = EXP00_PATHS.SOURCE_SCRIPT;
const parts = (() => {
  const root = win32.parse(target).root;
  const chain = [root];
  let current = root;
  for (const part of target.slice(root.length).split('\\')) {
    current = win32.join(current, part);
    chain.push(current);
  }
  return chain;
})();

type Handle = { path: string; ordinal: number };
function fixtureApi(change?: (value: NativeFileObservation, handle: Handle, inspections: number) =>
  NativeFileObservation): { api: NativeFileApi; opened: string[]; closed: Handle[] } {
  const opened: string[] = [];
  const closed: Handle[] = [];
  const inspections = new Map<Handle, number>();
  const api: NativeFileApi = {
    openNoFollow(path) {
      opened.push(path);
      return { path, ordinal: opened.length } satisfies Handle;
    },
    inspect(value) {
      const handle = value as Handle;
      const n = (inspections.get(handle) ?? 0) + 1;
      inspections.set(handle, n);
      const index = parts.indexOf(handle.path);
      const observation: NativeFileObservation = {
        attributes: index === parts.length - 1 ? 0x80 : 0x10,
        reparseTag: 0,
        volumeSerial: '1111111111111111',
        fileId: (index + 1).toString(16).padStart(32, '0'),
        finalPath: `\\\\?\\${handle.path}`,
        effectiveAccess: 'UNVERIFIED'
      };
      return change ? change(observation, handle, n) : observation;
    },
    close(handle) { closed.push(handle as Handle); return true; }
  };
  return { api, opened, closed };
}

describe('Experiment 00 Windows-native filesystem boundary', () => {
  it('retains all component handles through reread and final reopen, without authorizing capture', async () => {
    const { api, opened, closed } = fixtureApi();
    const result = inspectExp00PathWithApi('SOURCE_SCRIPT', api);
    expect(opened).toEqual([...parts, target]);
    expect(closed).toHaveLength(opened.length);
    expect(result).toMatchObject({ status: 'UNVERIFIED', pathConsistent: true,
      effectiveAcl: 'UNVERIFIED', contentBoundToHandle: false,
      independentlyAuthenticated: false, experiment00: 'NO_GO',
      productionAuthorized: false, executable: false });
    await expect(captureExp00FileSnapshot('PRE_BUILD')).rejects
      .toThrow('TRUSTED_PATH_HANDLE_BOUNDARY_UNAVAILABLE');
  });

  it('rejects a reparse-point ancestor before opening a descendant', () => {
    const affected = parts[2]!;
    const { api, opened, closed } = fixtureApi((item, handle) => handle.path === affected ?
      { ...item, attributes: item.attributes | 0x400, reparseTag: 0xa0000003 } : item);
    const result = inspectExp00PathWithApi('SOURCE_SCRIPT', api);
    expect(result.reasons).toContain('REPARSE_POINT_DETECTED');
    expect(result.status).toBe('REJECTED');
    expect(opened).toEqual(parts.slice(0, 3));
    expect(closed).toHaveLength(opened.length);
  });

  it('rejects changed identity on a held ancestor and a replaced final path', () => {
    const held = fixtureApi((item, handle, count) => handle.path === parts[1] && count === 2 ?
      { ...item, fileId: 'f'.repeat(32) } : item);
    expect(inspectExp00PathWithApi('SOURCE_SCRIPT', held.api).reasons)
      .toContain('HELD_HANDLE_IDENTITY_CHANGED');
    expect(held.closed).toHaveLength(held.opened.length);

    const replaced = fixtureApi((item, handle) => handle.path === target &&
      handle.ordinal === parts.length + 1 ? { ...item, fileId: 'f'.repeat(32) } : item);
    expect(inspectExp00PathWithApi('SOURCE_SCRIPT', replaced.api).reasons)
      .toContain('PATH_REPLACED_DURING_INSPECTION');
    expect(replaced.closed).toHaveLength(replaced.opened.length);
  });

  it('rejects observed replacement access and never upgrades unknown ACLs', () => {
    const { api } = fixtureApi((item, handle) => handle.path === parts[1] ?
      { ...item, effectiveAccess: 'REPLACEMENT_ALLOWED' } : item);
    expect(inspectExp00PathWithApi('SOURCE_SCRIPT', api).reasons)
      .toContain('REPLACEMENT_PROTECTION_INSUFFICIENT');
    const changed = fixtureApi((item, handle, count) => handle.path === parts[1] && count === 2 ?
      { ...item, effectiveAccess: 'REPLACEMENT_ALLOWED' } : item);
    expect(inspectExp00PathWithApi('SOURCE_SCRIPT', changed.api).reasons)
      .toContain('REPLACEMENT_PROTECTION_INSUFFICIENT');
    const unresolved = inspectExp00PathWithApi('SOURCE_SCRIPT', fixtureApi().api);
    expect(unresolved.reasons).toContain('EFFECTIVE_ACL_UNVERIFIED');
    expect(unresolved.status).toBe('UNVERIFIED');
  });

  it('rejects unavailable handles and missing native identity evidence', () => {
    const noHandle = fixtureApi();
    noHandle.api.openNoFollow = () => null;
    expect(inspectExp00PathWithApi('SOURCE_SCRIPT', noHandle.api).reasons)
      .toContain('NATIVE_HANDLE_UNAVAILABLE');
    const missing = fixtureApi();
    missing.api.inspect = () => null as never;
    expect(inspectExp00PathWithApi('SOURCE_SCRIPT', missing.api).reasons)
      .toContain('NATIVE_IDENTITY_UNVERIFIED');
    expect(missing.closed).toHaveLength(1);
  });

  it('rejects altered final paths, forged ACL success, and incomplete handle cleanup', () => {
    const path = fixtureApi((item, handle) => handle.path === parts[1] ?
      { ...item, finalPath: '\\\\?\\E:\\other' } : item);
    expect(inspectExp00PathWithApi('SOURCE_SCRIPT', path.api).reasons).toContain('FINAL_PATH_MISMATCH');
    const forged = fixtureApi((item, handle) => handle.path === parts[1] ?
      { ...item, effectiveAccess: 'VERIFIED' as never } : item);
    expect(inspectExp00PathWithApi('SOURCE_SCRIPT', forged.api).reasons)
      .toContain('NATIVE_IDENTITY_UNVERIFIED');
    const close = fixtureApi();
    close.api.close = () => false;
    expect(inspectExp00PathWithApi('SOURCE_SCRIPT', close.api).reasons)
      .toContain('HANDLE_CLOSE_UNVERIFIED');
  });

  it('rejects unknown targets without opening paths or bypassing default deny', () => {
    const { api, opened } = fixtureApi();
    expect(inspectExp00PathWithApi('C:\\other.exe', api)).toMatchObject({
      status: 'REJECTED', reasons: ['UNSUPPORTED_TARGET'], experiment00: 'NO_GO',
      productionAuthorized: false, executable: false });
    expect(opened).toEqual([]);
  });
});
