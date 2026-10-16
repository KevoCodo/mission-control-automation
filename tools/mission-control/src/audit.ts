import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { appendFile, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withStateLock } from './locks.js';

const SECRET_KEY_PATTERN = /(?:token|password|passwd|secret|credential|private[_-]?key|authorization|api[_-]?key|client[_-]?secret|access[_-]?key|session[_-]?key)/i;
const SECRET_VALUE_PATTERN = /\b(?:gh[opsur]_[A-Za-z0-9_]{4,}|github_pat_[A-Za-z0-9_]{4,}|Bearer\s+[^\s<>"']+|(?:token|password|passwd|secret|credential|api[_-]?key|authorization)\s*[:=]\s*[^\s,;"']+)/gi;

export interface AuditEvent {
  version?: 1 | 2;
  eventId?: string;
  correlationId?: string;
  operationKey?: string;
  actor?: { id: string; provenance?: string };
  evidenceRef?: string;
  issueNumber?: number;
  sessionId?: string;
  pullRequestNumber?: number;
  headSha?: string;
  authorization?: 'unknown' | 'caller-claimed' | 'verified' | 'denied';
  category?: 'observation' | 'intent' | 'action' | 'recovery' | 'outcome';
  outcome?: 'unknown' | 'pending' | 'succeeded' | 'failed' | 'uncertain';
  retryOf?: string;
  type: string;
  timestamp: string;
  data: unknown;
  provenance?: AuditProvenance;
}

export interface AuditProvenance {
  source: 'controller' | 'fixture' | 'github' | 'ao' | 'caller' | 'unknown';
  evidenceId?: string;
  observedAt?: string;
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
    const validated = parseAuditEvent({ ...event, version: 2, eventId: event.eventId ?? randomUUID() });
    await mkdir(path.dirname(filePath), { recursive: true });
    await appendFile(filePath, `${JSON.stringify(redactSecrets(validated))}\n`, 'utf8');
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
      Object.entries(value).map(([key, child]) => [key,
        key === 'authorization' && ['unknown', 'caller-claimed', 'verified', 'denied', 'claimed-verified; unauthenticated', 'unavailable', 'missing', 'caller-flag', 'verified-human'].includes(String(child))
          ? child : SECRET_KEY_PATTERN.test(key) ? '[REDACTED]' : redact(child)])
    );
  }
  if (typeof value === 'string') {
    return value.replace(SECRET_VALUE_PATTERN, '[REDACTED]');
  }
  return value;
}

function parseAuditEvent(value: unknown): AuditEvent {
  if (!isRecord(value) || typeof value.type !== 'string' || typeof value.timestamp !== 'string' || !('data' in value) || value.data === undefined) {
    throw new Error('Invalid audit event.');
  }
  if (value.version !== undefined && value.version !== 1 && value.version !== 2) {
    throw new Error('Unsupported audit event version.');
  }
  if (!value.type.trim() || !Number.isFinite(Date.parse(value.timestamp)) || new Date(value.timestamp).toISOString() !== value.timestamp) {
    throw new Error('Invalid audit event identity or timestamp.');
  }
  if (value.provenance !== undefined && (!isRecord(value.provenance) ||
    !['controller', 'fixture', 'github', 'ao', 'caller', 'unknown'].includes(String(value.provenance.source)) ||
    (value.provenance.evidenceId !== undefined && typeof value.provenance.evidenceId !== 'string') ||
    (value.provenance.observedAt !== undefined && (typeof value.provenance.observedAt !== 'string' || !Number.isFinite(Date.parse(value.provenance.observedAt)))))) {
    throw new Error('Invalid audit event provenance.');
  }
  const stringFields = ['eventId', 'correlationId', 'operationKey', 'evidenceRef', 'sessionId', 'headSha', 'retryOf'];
  if (stringFields.some((field) => value[field] !== undefined && (typeof value[field] !== 'string' || !String(value[field]).trim())) ||
    ['issueNumber', 'pullRequestNumber'].some((field) => value[field] !== undefined && (!Number.isInteger(value[field]) || Number(value[field]) <= 0)) ||
    (value.actor !== undefined && (!isRecord(value.actor) || typeof value.actor.id !== 'string' || !value.actor.id.trim() ||
      (value.actor.provenance !== undefined && typeof value.actor.provenance !== 'string'))) ||
    (value.authorization !== undefined && !['unknown', 'caller-claimed', 'verified', 'denied'].includes(String(value.authorization))) ||
    (value.category !== undefined && !['observation', 'intent', 'action', 'recovery', 'outcome'].includes(String(value.category))) ||
    (value.outcome !== undefined && !['unknown', 'pending', 'succeeded', 'failed', 'uncertain'].includes(String(value.outcome))) ||
    (value.version === 2 && value.eventId === undefined)) {
    throw new Error('Invalid audit event envelope.');
  }
  return {
    ...(value.version === 1 || value.version === 2 ? { version: value.version } : {}),
    type: value.type,
    timestamp: value.timestamp,
    data: value.data,
    ...Object.fromEntries([...stringFields, 'issueNumber', 'pullRequestNumber', 'actor', 'authorization', 'category', 'outcome']
      .filter((field) => value[field] !== undefined).map((field) => [field, value[field]])),
    ...(value.provenance === undefined ? {} : { provenance: value.provenance as unknown as AuditProvenance })
  };
}

export function parseAuditLog(raw: string): AuditEvent[] {
  if (raw !== '' && !raw.endsWith('\n')) {
    throw new Error('Audit log has an incomplete final line.');
  }
  return raw.split('\n').slice(0, -1).map((line, index) => {
    if (!line.trim()) throw new Error(`Audit log has an empty line at ${index + 1}.`);
    try {
      return parseAuditEvent(JSON.parse(line) as unknown);
    } catch {
      throw new Error(`Audit log has an invalid event at line ${index + 1}.`);
    }
  });
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
