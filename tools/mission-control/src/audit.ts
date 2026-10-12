import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFile, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withStateLock } from './locks.js';

const SECRET_KEY_PATTERN = /(token|password|secret|credential|privateKey|authorization|apiKey)/i;
const SECRET_VALUE_PATTERN = /(ghp_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|Bearer\s+[A-Za-z0-9._-]+)/g;

export interface AuditEvent {
  type: string;
  timestamp: string;
  data: unknown;
}

export interface AuditRecoveryResult {
  events: AuditEvent[];
  quarantinedPath?: string;
  recoveredPath?: string;
}

export interface AuditTransactionOptions {
  timeoutMs?: number;
  onBeforePublish?: () => Promise<void>;
}

const DEFAULT_AUDIT_TRANSACTION_TIMEOUT_MS = 60000;
let auditQueue = Promise.resolve();
const auditTransactionStorage = new AsyncLocalStorage<boolean>();

export async function appendAuditEvent(filePath: string, event: AuditEvent): Promise<void> {
  await withAuditFileTransaction(filePath, 'append-audit', async () => {
    await mkdir(path.dirname(filePath), { recursive: true });
    await appendFile(filePath, `${JSON.stringify(redactSecrets(event))}\n`, 'utf8');
  });
}

export async function withAuditFileTransaction<T>(
  filePath: string,
  owner: string,
  action: () => Promise<T>,
  options: AuditTransactionOptions = {}
): Promise<T> {
  return withStateLock(filePath, owner, 0, () => {
    if (auditTransactionStorage.getStore()) {
      return action();
    }
    return enqueueAuditTransaction(options.timeoutMs ?? DEFAULT_AUDIT_TRANSACTION_TIMEOUT_MS, () =>
      auditTransactionStorage.run(true, action)
    );
  });
}

export function redactSecrets<T>(value: T): T {
  return redact(value) as T;
}

export async function recoverAuditLog(
  filePath: string,
  now = new Date(),
  options: AuditTransactionOptions = {}
): Promise<AuditRecoveryResult> {
  return withAuditFileTransaction(filePath, 'recover-audit', async () => {
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return { events: [] };
      }
      throw error;
    }

    const lines = raw.split('\n');
    const completeLines = lines.at(-1) === '' ? lines.slice(0, -1) : lines;
    const events: AuditEvent[] = [];
    let corruptIndex = -1;

    for (const [index, line] of completeLines.entries()) {
      if (line.trim() === '') {
        continue;
      }
      try {
        events.push(parseAuditEvent(JSON.parse(line) as unknown));
      } catch {
        corruptIndex = index;
        break;
      }
    }

    if (corruptIndex === -1 && raw.endsWith('\n')) {
      return { events };
    }

    const validLines = corruptIndex === -1 ? completeLines : completeLines.slice(0, corruptIndex);
    const quarantinedPath = `${filePath}.quarantine-${formatTimestamp(now)}.jsonl`;
    const recoveredPath = `${filePath}.recovered-${formatTimestamp(now)}.jsonl`;
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(recoveredPath, validLines.length > 0 ? `${validLines.join('\n')}\n` : '', 'utf8');
    await copyFile(filePath, quarantinedPath);
    await options.onBeforePublish?.();
    await rename(recoveredPath, filePath);

    return {
      events: validLines
        .filter((line) => line.trim() !== '')
        .map((line) => parseAuditEvent(JSON.parse(line) as unknown)),
      quarantinedPath,
      recoveredPath: filePath
    };
  }, options);
}

function enqueueAuditTransaction<T>(timeoutMs: number, action: () => Promise<T>): Promise<T> {
  let canceled = false;
  let started = false;
  let timeout: NodeJS.Timeout | undefined;
  const previous = auditQueue.catch(() => undefined);
  const run = previous.then(async () => {
    if (canceled) {
      throw new Error('Timed out waiting for audit transaction.');
    }
    started = true;
    if (timeout) {
      clearTimeout(timeout);
    }
    return action();
  });
  const tail = run.then(
    () => undefined,
    () => undefined
  );
  auditQueue = tail;

  const boundedWait = new Promise<T>((_, reject) => {
    timeout = setTimeout(() => {
      if (!started) {
        canceled = true;
        reject(new Error('Timed out waiting for audit transaction.'));
      }
    }, timeoutMs);
  });

  return Promise.race([run, boundedWait]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, SECRET_KEY_PATTERN.test(key) ? '[REDACTED]' : redact(child)])
    );
  }
  if (typeof value === 'string') {
    return value.replace(SECRET_VALUE_PATTERN, '[REDACTED]');
  }
  return value;
}

function parseAuditEvent(value: unknown): AuditEvent {
  if (!isRecord(value) || typeof value.type !== 'string' || typeof value.timestamp !== 'string' || !('data' in value)) {
    throw new Error('Invalid audit event.');
  }
  return {
    type: value.type,
    timestamp: value.timestamp,
    data: value.data
  };
}

function formatTimestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
