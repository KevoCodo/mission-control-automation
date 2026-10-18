import { parseExecutionEnvelope, type ExecutionEnvelope } from './executionProtocol.js';
import { assessWindowsPath } from './workerIsolation.js';

export const WORKER_IDENTITY_VERSION = 1 as const;
export interface WorkerIdentity {
  version: 1;
  workerExecutionId: string;
  dispatchId: string;
  repository: ExecutionEnvelope['repository'];
  issueNumber: number;
  agentRole: ExecutionEnvelope['agentRole'];
  targetId: string;
  generation: number;
  branch: string;
  worktreeId: string;
  workspaceRoot: string;
  expectedBaseCommit: string;
  grantId: string;
  fencingEpoch: number;
  correlationId: string;
  issuedAt: string;
  expiresAt: string;
}

const keys = ['version', 'workerExecutionId', 'dispatchId', 'repository', 'issueNumber', 'agentRole',
  'targetId', 'generation', 'branch', 'worktreeId', 'workspaceRoot', 'expectedBaseCommit', 'grantId',
  'fencingEpoch', 'correlationId', 'issuedAt', 'expiresAt'];
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(v);
const plain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' &&
  !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype &&
  Object.getOwnPropertySymbols(v).length === 0 && Object.getOwnPropertyNames(v).length === Object.keys(v).length &&
  Object.keys(v).every((k) => 'value' in (Object.getOwnPropertyDescriptor(v, k) ?? {}));

/** Structural binding only: neither the identity nor its envelope confers execution authority. */
export function parseWorkerIdentity(value: unknown, envelopeInput: unknown, now: Date): WorkerIdentity {
  const envelope = parseExecutionEnvelope(envelopeInput);
  if (!plain(value) || Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key)) || !Number.isFinite(now.getTime()) ||
    value.version !== WORKER_IDENTITY_VERSION || !id(value.workerExecutionId) ||
    assessWindowsPath(value.workspaceRoot, value.workspaceRoot).length !== 0 ||
    !/^[a-f0-9]{40}$/.test(String(value.expectedBaseCommit)) || !envelope.worktreeId ||
    value.dispatchId !== envelope.dispatchId || !plain(value.repository) ||
    Object.keys(value.repository).length !== 2 || value.repository.owner !== envelope.repository.owner ||
    value.repository.name !== envelope.repository.name || value.issueNumber !== envelope.issueNumber ||
    value.agentRole !== envelope.agentRole || value.targetId !== envelope.targetId ||
    value.generation !== envelope.generation || value.branch !== envelope.branch ||
    value.worktreeId !== envelope.worktreeId || value.grantId !== envelope.grantId ||
    value.fencingEpoch !== envelope.fencingEpoch || value.correlationId !== envelope.correlationId ||
    value.issuedAt !== envelope.issuedAt || value.expiresAt !== envelope.expiresAt ||
    now.getTime() < Date.parse(envelope.issuedAt) || now.getTime() >= Date.parse(envelope.expiresAt))
    throw new Error('Invalid, expired, or conflicting worker identity.');
  return value as unknown as WorkerIdentity;
}
