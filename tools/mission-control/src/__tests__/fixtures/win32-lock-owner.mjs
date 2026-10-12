import koffi from 'koffi';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const OPEN_ALWAYS = 4;
const FILE_ATTRIBUTE_NORMAL = 0x80;
const INVALID_HANDLE_VALUES = new Set([-1n, 0xffffffffffffffffn]);

const HANDLE = koffi.pointer('HANDLE', koffi.opaque());
const kernel32 = koffi.load('kernel32.dll');
const CreateFileW = kernel32.func(
  'HANDLE __stdcall CreateFileW(str16 lpFileName, uint32_t dwDesiredAccess, uint32_t dwShareMode, void *lpSecurityAttributes, uint32_t dwCreationDisposition, uint32_t dwFlagsAndAttributes, HANDLE hTemplateFile)'
);
const GetLastError = kernel32.func('uint32_t __stdcall GetLastError(void)');
const CloseHandle = kernel32.func('bool __stdcall CloseHandle(HANDLE hObject)');

const mode = process.argv[2];
const lockPath = process.argv[3] ?? getDefaultLockPath();

const result = acquire(lockPath);
if (mode === 'owner' || mode === 'owner-default') {
  if (!result.ok) {
    console.log(JSON.stringify({ role: mode, ...result }));
    process.exit(1);
  }
  console.log(JSON.stringify({ role: mode, event: 'ready', lockPath, handle: result.handleText }));
  process.stdin.resume();
} else if (mode === 'try' || mode === 'try-default') {
  if (result.ok) {
    const closeOk = CloseHandle(result.handle);
    console.log(
      JSON.stringify({
        role: mode,
        ok: true,
        lockPath,
        handle: result.handleText,
        closeOk,
        closeError: closeOk ? 0 : GetLastError()
      })
    );
  } else {
    console.log(JSON.stringify({ role: mode, lockPath, ...result }));
  }
} else {
  console.error(`Unsupported mode: ${mode}`);
  process.exit(2);
}

function acquire(filePath) {
  const handle = CreateFileW(
    filePath,
    (GENERIC_READ | GENERIC_WRITE) >>> 0,
    0,
    null,
    OPEN_ALWAYS,
    FILE_ATTRIBUTE_NORMAL,
    null
  );
  if (INVALID_HANDLE_VALUES.has(handle)) {
    return {
      ok: false,
      invalidHandle: true,
      handle: String(handle),
      errorCode: GetLastError()
    };
  }
  return {
    ok: true,
    handle,
    handleText: String(handle)
  };
}

function getDefaultLockPath() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', '.mission-control', 'controller.lock');
}
