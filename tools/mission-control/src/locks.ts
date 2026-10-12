import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export interface ControllerLock {
  owner: string;
  token: string;
  acquiredAt: string;
  expiresAt: string;
  lockPath: string;
}

export interface LockOptions {
  now?: Date;
  staleAfterMs?: number;
}

export interface ControllerOwnershipOptions {
  owner?: string;
  lockPath?: string;
  timeoutMs?: number;
}

interface Win32LockApi {
  createFile(lockPath: string): unknown;
  closeHandle(handle: unknown): boolean;
  getLastError(): number;
  invalidHandleValues: Set<unknown>;
}

interface ControllerLockReceipt {
  handle: unknown;
  released: boolean;
}

type OwnedControllerLock = ControllerLock;

export class LockError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'LockError';
    this.code = code;
  }
}

const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const OPEN_ALWAYS = 4;
const FILE_ATTRIBUTE_NORMAL = 0x80;
const ERROR_SHARING_VIOLATION = 32;
const ERROR_ACCESS_DENIED = 5;
const DEFAULT_LOCK_OWNER = 'mission-control';
const DEFAULT_SAME_PROCESS_WAIT_TIMEOUT_MS = 60000;
const OS_HANDLE_EXPIRY_METADATA = '9999-12-31T23:59:59.999Z';
const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_LOCK_PATH = path.resolve(MODULE_DIRECTORY, '..', '..', '..', '.mission-control', 'controller.lock');

let sameProcessQueue = Promise.resolve();
let win32LockApi: Promise<Win32LockApi> | undefined;

const ownershipStorage = new AsyncLocalStorage<OwnedControllerLock>();
const lockReceipts = new WeakMap<ControllerLock, ControllerLockReceipt>();

export function getDefaultControllerLockPath(): string {
  return path.resolve(DEFAULT_LOCK_PATH);
}

export async function acquireControllerLock(
  lockPath: string,
  owner = DEFAULT_LOCK_OWNER,
  options: LockOptions = {}
): Promise<ControllerLock> {
  if (process.platform !== 'win32') {
    throw new LockError(`Controller ownership requires Windows CreateFileW; ${process.platform} is unsupported.`, 'EUNSUPPORTED');
  }

  const canonicalLockPath = path.resolve(lockPath);
  await mkdir(path.dirname(canonicalLockPath), { recursive: true });
  const api = await getWin32LockApi();
  const handle = api.createFile(canonicalLockPath);
  if (api.invalidHandleValues.has(handle)) {
    const errorCode = api.getLastError();
    if (errorCode === ERROR_SHARING_VIOLATION || errorCode === ERROR_ACCESS_DENIED) {
      throw new LockError(`Controller lock is already held: ${canonicalLockPath}.`, 'ELOCKED');
    }
    throw new LockError(`Unable to acquire controller lock ${canonicalLockPath}: Win32 error ${errorCode}.`, 'ELOCK');
  }

  const lock: OwnedControllerLock = {
    owner,
    token: randomUUID(),
    acquiredAt: (options.now ?? new Date()).toISOString(),
    expiresAt: OS_HANDLE_EXPIRY_METADATA,
    lockPath: canonicalLockPath
  };
  lockReceipts.set(lock, { handle, released: false });
  return lock;
}

export async function releaseControllerLock(lockPath: string, lock: ControllerLock): Promise<void> {
  const ownedLock = asOwnedLock(lock);
  const canonicalLockPath = path.resolve(lockPath);
  if (ownedLock.lockPath !== canonicalLockPath) {
    throw new LockError('Controller lock path mismatch; refusing to release another controller lock.', 'ELOCKED');
  }
  const receipt = lockReceipts.get(ownedLock);
  if (!receipt) {
    throw new LockError('Controller lock receipt is missing or forged.', 'ELOCKED');
  }
  if (receipt.released) {
    throw new LockError('Controller lock has already been released.', 'ELOCKED');
  }

  const api = await getWin32LockApi();
  const closed = api.closeHandle(receipt.handle);
  if (!closed) {
    const errorCode = api.getLastError();
    throw new LockError(`Unable to close controller lock handle: Win32 error ${errorCode}.`, 'ELOCK');
  }
  receipt.released = true;
}

export async function withControllerOwnership<T>(
  options: ControllerOwnershipOptions,
  action: () => Promise<T>
): Promise<T> {
  const lockPath = path.resolve(options.lockPath ?? getDefaultControllerLockPath());
  const activeLock = ownershipStorage.getStore();
  if (activeLock) {
    if (activeLock.lockPath !== lockPath) {
      throw new LockError('Nested controller ownership requested a different canonical lock path.', 'ELOCKED');
    }
    const receipt = lockReceipts.get(activeLock);
    if (!receipt || receipt.released) {
      throw new LockError('Nested controller ownership is no longer active.', 'ELOCKED');
    }
    return action();
  }

  return enqueueSameProcess(options.timeoutMs ?? DEFAULT_SAME_PROCESS_WAIT_TIMEOUT_MS, async () => {
    const lock = (await acquireControllerLock(lockPath, options.owner ?? DEFAULT_LOCK_OWNER)) as OwnedControllerLock;
    try {
      return await ownershipStorage.run(lock, action);
    } finally {
      const receipt = lockReceipts.get(lock);
      if (receipt && !receipt.released) {
        await releaseControllerLock(lockPath, lock);
      }
    }
  });
}

export async function withStateLock<T>(
  _filePath: string,
  owner: string,
  _staleAfterMs: number,
  action: () => Promise<T>
): Promise<T> {
  return withControllerOwnership({ owner }, action);
}

function enqueueSameProcess<T>(timeoutMs: number, action: () => Promise<T>): Promise<T> {
  let canceled = false;
  let started = false;
  let timeout: NodeJS.Timeout | undefined;
  const previous = sameProcessQueue.catch(() => undefined);
  const run = previous.then(async () => {
    if (canceled) {
      throw new LockError('Timed out waiting for same-process controller ownership.', 'ELOCKED');
    }
    started = true;
    if (timeout) {
      clearTimeout(timeout);
    }
    return action();
  });
  sameProcessQueue = run.then(
    () => undefined,
    () => undefined
  );

  const boundedWait = new Promise<T>((_, reject) => {
    timeout = setTimeout(() => {
      if (!started) {
        canceled = true;
        reject(new LockError('Timed out waiting for same-process controller ownership.', 'ELOCKED'));
      }
    }, timeoutMs);
  });

  return Promise.race([run, boundedWait]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
}

function asOwnedLock(lock: ControllerLock): OwnedControllerLock {
  if (!isRecord(lock) || !lockReceipts.has(lock)) {
    throw new LockError('Controller lock receipt is missing or forged.', 'ELOCKED');
  }
  return lock as OwnedControllerLock;
}

async function getWin32LockApi(): Promise<Win32LockApi> {
  win32LockApi ??= loadWin32LockApi();
  return win32LockApi;
}

async function loadWin32LockApi(): Promise<Win32LockApi> {
  if (process.platform !== 'win32') {
    throw new LockError(`Controller ownership requires Windows CreateFileW; ${process.platform} is unsupported.`, 'EUNSUPPORTED');
  }
  if (process.arch !== 'x64' && process.arch !== 'arm64') {
    throw new LockError(`Controller ownership requires a Windows x64 or arm64 runtime; ${process.arch} is unsupported.`, 'EUNSUPPORTED');
  }

  let koffi: any;
  try {
    const koffiModule = await import('koffi');
    koffi = koffiModule.default ?? koffiModule;
  } catch (error) {
    throw new LockError(`Unable to load Koffi for controller ownership: ${error instanceof Error ? error.message : String(error)}`, 'ENATIVE');
  }

  const HANDLE = koffi.pointer('HANDLE', koffi.opaque());
  const kernel32 = koffi.load('kernel32.dll');
  const CreateFileW = kernel32.func(
    'HANDLE __stdcall CreateFileW(str16 lpFileName, uint32_t dwDesiredAccess, uint32_t dwShareMode, void *lpSecurityAttributes, uint32_t dwCreationDisposition, uint32_t dwFlagsAndAttributes, HANDLE hTemplateFile)'
  );
  const GetLastError = kernel32.func('uint32_t __stdcall GetLastError(void)');
  const CloseHandle = kernel32.func('bool __stdcall CloseHandle(HANDLE hObject)');

  return {
    createFile(lockPath) {
      return CreateFileW(
        lockPath,
        (GENERIC_READ | GENERIC_WRITE) >>> 0,
        0,
        null,
        OPEN_ALWAYS,
        FILE_ATTRIBUTE_NORMAL,
        null
      );
    },
    closeHandle(handle) {
      return CloseHandle(handle);
    },
    getLastError() {
      return GetLastError();
    },
    invalidHandleValues: new Set([-1n, 0xffffffffffffffffn])
  };
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
