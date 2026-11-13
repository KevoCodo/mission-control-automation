import { win32 } from 'node:path';
import { EXP00_DISPOSABLE_ROOT } from './windowsHostReadiness.js';

/** Fixed Experiment 00 paths only. This module never enables snapshot capture. */
export const EXP00_PATHS = {
  SOURCE_SCRIPT: win32.join(EXP00_DISPOSABLE_ROOT, 'src', 'tools', 'mission-control', 'native', 'build-disposable.ps1'),
  SOURCE_HARNESS: win32.join(EXP00_DISPOSABLE_ROOT, 'src', 'tools', 'mission-control', 'native', 'disposable_job_harness.cpp'),
  SOURCE_PROBE: win32.join(EXP00_DISPOSABLE_ROOT, 'src', 'tools', 'mission-control', 'native', 'disposable_job_probe.cpp'),
  SOURCE_FIXTURE: win32.join(EXP00_DISPOSABLE_ROOT, 'src', 'tools', 'mission-control', 'native', 'disposable_fixture.cpp'),
  BUILT_HARNESS: win32.join(EXP00_DISPOSABLE_ROOT, 'src', 'tools', 'mission-control', 'native', 'build', 'disposable_job_harness.exe'),
  BUILT_FIXTURE: win32.join(EXP00_DISPOSABLE_ROOT, 'src', 'tools', 'mission-control', 'native', 'build', 'disposable_fixture.exe'),
  SEALED_HARNESS: win32.join(EXP00_DISPOSABLE_ROOT, 'run', 'sealed', 'default-deny', 'disposable_job_harness.exe'),
  SEALED_FIXTURE: win32.join(EXP00_DISPOSABLE_ROOT, 'run', 'sealed', 'default-deny', 'disposable_fixture.exe')
} as const;
export type Exp00PathTarget = keyof typeof EXP00_PATHS;

export interface NativeFileObservation {
  attributes: number;
  reparseTag: number;
  volumeSerial: string;
  fileId: string;
  finalPath: string;
  effectiveAccess: 'UNVERIFIED' | 'REPLACEMENT_ALLOWED';
}
export interface NativeFileApi {
  openNoFollow(path: string): unknown;
  inspect(handle: unknown): NativeFileObservation;
  close(handle: unknown): boolean;
}
export interface Exp00NativePathAssessment {
  target: Exp00PathTarget | null;
  status: 'REJECTED' | 'UNVERIFIED';
  reasons: string[];
  pathConsistent: boolean;
  effectiveAcl: 'UNVERIFIED';
  contentBoundToHandle: false;
  independentlyAuthenticated: false;
  experiment00: 'NO_GO';
  productionAuthorized: false;
  executable: false;
}

const FILE_ATTRIBUTE_DIRECTORY = 0x10;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
const FILE_READ_ATTRIBUTES = 0x80;
const FILE_SHARE_READ = 1;
const FILE_SHARE_WRITE = 2;
const OPEN_EXISTING = 3;
const FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
const FILE_ATTRIBUTE_TAG_INFO = 9;
const FILE_ID_INFO = 18;

function chain(path: string): string[] {
  const root = win32.parse(path).root;
  const result = [root];
  let current = root;
  for (const part of path.slice(root.length).split('\\')) {
    current = win32.join(current, part);
    result.push(current);
  }
  return result;
}

function observation(value: unknown): NativeFileObservation | null {
  if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0) return null;
  const fields = Object.getOwnPropertyDescriptors(value);
  const keys = ['attributes', 'reparseTag', 'volumeSerial', 'fileId', 'finalPath', 'effectiveAccess'];
  if (Object.keys(fields).length !== keys.length || keys.some(key =>
    !fields[key] || !fields[key].enumerable || !('value' in fields[key]))) return null;
  const get = (key: string): unknown => fields[key].value;
  const attributes = get('attributes');
  const reparseTag = get('reparseTag');
  const volumeSerial = get('volumeSerial');
  const fileId = get('fileId');
  const finalPath = get('finalPath');
  const effectiveAccess = get('effectiveAccess');
  if (!Number.isInteger(attributes) || (attributes as number) < 0 || (attributes as number) > 0xffffffff ||
      !Number.isInteger(reparseTag) || (reparseTag as number) < 0 || (reparseTag as number) > 0xffffffff ||
      typeof volumeSerial !== 'string' || !/^[0-9a-f]{16}$/i.test(volumeSerial) || /^0+$/.test(volumeSerial) ||
      typeof fileId !== 'string' || !/^[0-9a-f]{32}$/i.test(fileId) || /^0+$/.test(fileId) ||
      typeof finalPath !== 'string' || !finalPath.startsWith('\\\\?\\') ||
      (effectiveAccess !== 'UNVERIFIED' && effectiveAccess !== 'REPLACEMENT_ALLOWED')) return null;
  return { attributes: attributes as number, reparseTag: reparseTag as number,
    volumeSerial, fileId, finalPath, effectiveAccess };
}

function result(target: Exp00PathTarget | null, reasons: string[], pathConsistent: boolean): Exp00NativePathAssessment {
  return { target, status: reasons.some(reason => reason !== 'EFFECTIVE_ACL_UNVERIFIED' &&
    reason !== 'CONTENT_HANDLE_BINDING_MISSING' && reason !== 'INDEPENDENT_PROVENANCE_UNVERIFIED') ?
    'REJECTED' : 'UNVERIFIED', reasons, pathConsistent,
    effectiveAcl: 'UNVERIFIED', contentBoundToHandle: false, independentlyAuthenticated: false,
    experiment00: 'NO_GO', productionAuthorized: false, executable: false };
}

/** Fixture seam: injected observations can only yield UNVERIFIED, never trusted evidence. */
export function inspectExp00PathWithApi(target: unknown, api: NativeFileApi): Exp00NativePathAssessment {
  if (typeof target !== 'string' || !Object.hasOwn(EXP00_PATHS, target))
    return result(null, ['UNSUPPORTED_TARGET'], false);
  const fixedTarget = target as Exp00PathTarget;
  const components = chain(EXP00_PATHS[fixedTarget]);
  const handles: unknown[] = [];
  const first: NativeFileObservation[] = [];
  const reasons: string[] = [];
  try {
    for (let index = 0; index < components.length; index++) {
      const handle = api.openNoFollow(components[index]!);
      if (handle === null || handle === undefined || handle === -1n || handle === 0xffffffffffffffffn)
        throw new Error('NATIVE_HANDLE_UNAVAILABLE');
      handles.push(handle);
      const item = observation(api.inspect(handle));
      if (!item) throw new Error('NATIVE_IDENTITY_UNVERIFIED');
      first.push(item);
      const actualPath = item.finalPath.slice(4);
      if (actualPath.toLowerCase() !== components[index]!.toLowerCase())
        throw new Error('FINAL_PATH_MISMATCH');
      if ((item.attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0 || item.reparseTag !== 0)
        throw new Error('REPARSE_POINT_DETECTED');
      const shouldBeDirectory = index < components.length - 1;
      if (((item.attributes & FILE_ATTRIBUTE_DIRECTORY) !== 0) !== shouldBeDirectory)
        throw new Error('COMPONENT_KIND_MISMATCH');
      if (item.effectiveAccess === 'REPLACEMENT_ALLOWED')
        throw new Error('REPLACEMENT_PROTECTION_INSUFFICIENT');
    }
    // Handles stay open without FILE_SHARE_DELETE. Recheck every identity and the
    // path's final component while the ancestors are still held.
    for (let index = 0; index < handles.length; index++) {
      const after = observation(api.inspect(handles[index]));
      const before = first[index]!;
      if (!after || after.volumeSerial !== before.volumeSerial || after.fileId !== before.fileId ||
          after.finalPath.toLowerCase() !== before.finalPath.toLowerCase() ||
          after.attributes !== before.attributes || after.reparseTag !== before.reparseTag)
        throw new Error('HELD_HANDLE_IDENTITY_CHANGED');
      if (after.effectiveAccess === 'REPLACEMENT_ALLOWED')
        throw new Error('REPLACEMENT_PROTECTION_INSUFFICIENT');
    }
    const reopened = api.openNoFollow(components[components.length - 1]!);
    if (reopened === null || reopened === undefined || reopened === -1n || reopened === 0xffffffffffffffffn)
      throw new Error('FINAL_PATH_REOPEN_FAILED');
    handles.push(reopened);
    const final = observation(api.inspect(reopened));
    const original = first[first.length - 1]!;
    if (!final || final.volumeSerial !== original.volumeSerial || final.fileId !== original.fileId ||
        final.finalPath.toLowerCase() !== original.finalPath.toLowerCase() ||
        final.attributes !== original.attributes || final.reparseTag !== original.reparseTag)
      throw new Error('PATH_REPLACED_DURING_INSPECTION');
    if (final.effectiveAccess === 'REPLACEMENT_ALLOWED')
      throw new Error('REPLACEMENT_PROTECTION_INSUFFICIENT');
    reasons.push('EFFECTIVE_ACL_UNVERIFIED', 'CONTENT_HANDLE_BINDING_MISSING',
      'INDEPENDENT_PROVENANCE_UNVERIFIED');
  } catch (error) {
    reasons.push(error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message :
      'NATIVE_INSPECTION_FAILED');
  } finally {
    for (const handle of handles.reverse()) {
      try { if (!api.close(handle)) reasons.push('HANDLE_CLOSE_UNVERIFIED'); }
      catch { reasons.push('HANDLE_CLOSE_UNVERIFIED'); }
    }
  }
  return result(fixedTarget, [...new Set(reasons)], reasons.length === 3 &&
    reasons.includes('CONTENT_HANDLE_BINDING_MISSING'));
}

/** Read-only Windows API adapter. Never called by snapshot capture or a controller launch path. */
export async function inspectExp00NativePath(target: unknown): Promise<Exp00NativePathAssessment> {
  if (process.platform !== 'win32' || (process.arch !== 'x64' && process.arch !== 'arm64'))
    return result(null, ['UNSUPPORTED_HOST'], false);
  if (typeof target !== 'string' || !Object.hasOwn(EXP00_PATHS, target))
    return result(null, ['UNSUPPORTED_TARGET'], false);
  try {
    const module = await import('koffi');
    const koffi: any = module.default ?? module;
    koffi.pointer('HANDLE', koffi.opaque());
    const kernel32 = koffi.load('kernel32.dll');
    const CreateFileW = kernel32.func('HANDLE __stdcall CreateFileW(str16, uint32_t, uint32_t, void *, uint32_t, uint32_t, HANDLE)');
    const GetFileInformationByHandleEx = kernel32.func('bool __stdcall GetFileInformationByHandleEx(HANDLE, uint32_t, void *, uint32_t)');
    const GetFinalPathNameByHandleW = kernel32.func('uint32_t __stdcall GetFinalPathNameByHandleW(HANDLE, void *, uint32_t, uint32_t)');
    const CloseHandle = kernel32.func('bool __stdcall CloseHandle(HANDLE)');
    const api: NativeFileApi = {
      openNoFollow(path) {
        return CreateFileW(path, FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE, null,
          OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, null);
      },
      inspect(handle) {
        const tag = Buffer.alloc(8);
        const id = Buffer.alloc(24);
        const finalPath = Buffer.alloc(32768 * 2);
        if (!GetFileInformationByHandleEx(handle, FILE_ATTRIBUTE_TAG_INFO, tag, tag.length) ||
            !GetFileInformationByHandleEx(handle, FILE_ID_INFO, id, id.length))
          throw new Error('NATIVE_FILE_INFORMATION_UNAVAILABLE');
        const chars = GetFinalPathNameByHandleW(handle, finalPath, 32768, 0);
        if (!Number.isInteger(chars) || chars <= 0 || chars >= 32768)
          throw new Error('NATIVE_FINAL_PATH_UNAVAILABLE');
        return { attributes: tag.readUInt32LE(0), reparseTag: tag.readUInt32LE(4),
          volumeSerial: id.subarray(0, 8).toString('hex'), fileId: id.subarray(8, 24).toString('hex'),
          finalPath: finalPath.toString('utf16le', 0, chars * 2),
          effectiveAccess: 'UNVERIFIED' };
      },
      close(handle) { return CloseHandle(handle); }
    };
    return inspectExp00PathWithApi(target, api);
  } catch {
    return result(target as Exp00PathTarget, ['NATIVE_API_UNAVAILABLE'], false);
  }
}
