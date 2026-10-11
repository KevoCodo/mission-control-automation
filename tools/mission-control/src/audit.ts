import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const SECRET_KEY_PATTERN = /(token|password|secret|credential|privateKey|authorization|apiKey)/i;
const SECRET_VALUE_PATTERN = /(ghp_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|Bearer\s+[A-Za-z0-9._-]+)/g;

export interface AuditEvent {
  type: string;
  timestamp: string;
  data: unknown;
}

export async function appendAuditEvent(filePath: string, event: AuditEvent): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(redactSecrets(event))}\n`, 'utf8');
}

export function redactSecrets<T>(value: T): T {
  return redact(value) as T;
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
