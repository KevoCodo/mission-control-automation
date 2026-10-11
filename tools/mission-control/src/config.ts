import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ControllerConfig, ControllerLimits, IdentityMap } from './types.js';

const CREDENTIAL_KEY_PATTERN = /(token|password|secret|credential|privateKey|authorization|apiKey)/i;
const DEFAULT_LIMITS: ControllerLimits = {
  maxBuilders: 1,
  correctionAttempts: 1,
  maxRetries: 1,
  maxAiUsage: 50000
};

export const defaultConfig: ControllerConfig = {
  repository: {
    owner: 'KevoCodo',
    name: 'ai-delivery-lab',
    defaultBranch: 'main'
  },
  project: {
    id: 'ai-delivery-lab'
  },
  worktreeRoot: 'E:\\AI-Development\\ao-data\\data\\worktrees\\ai-delivery-lab',
  executionMode: 'dry-run',
  deploy: false,
  limits: DEFAULT_LIMITS,
  identities: {
    issues: [
      {
        id: 4,
        number: 4,
        title: 'Controller Project Skeleton'
      }
    ],
    sessions: [
      {
        id: 'fixture-session',
        branch: 'ao/issue-4-controller-skeleton',
        worktreePath: 'E:\\AI-Development\\ao-data\\data\\worktrees\\ai-delivery-lab\\fixture-session'
      }
    ],
    pullRequests: [
      {
        id: 'fixture-pr',
        number: 4,
        branch: 'ao/issue-4-controller-skeleton'
      }
    ]
  }
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export async function loadConfig(configPath?: string): Promise<ControllerConfig> {
  if (!configPath) {
    return validateConfig(defaultConfig);
  }

  const raw = await readFile(configPath, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  return validateConfig(mergeConfig(defaultConfig, parsed));
}

export function validateConfig(input: unknown): ControllerConfig {
  if (!isRecord(input)) {
    throw new ConfigError('Configuration must be a JSON object.');
  }

  rejectCredentialKeys(input);

  const repository = readRecord(input.repository, 'repository');
  const project = readRecord(input.project, 'project');
  const limits = readRecord(input.limits, 'limits');
  const identities = readRecord(input.identities, 'identities');

  const config: ControllerConfig = {
    repository: {
      owner: readNonEmptyString(repository.owner, 'repository.owner'),
      name: readNonEmptyString(repository.name, 'repository.name'),
      defaultBranch: readNonEmptyString(repository.defaultBranch, 'repository.defaultBranch')
    },
    project: {
      id: readNonEmptyString(project.id, 'project.id')
    },
    worktreeRoot: normalizeWindowsPath(readNonEmptyString(input.worktreeRoot, 'worktreeRoot')),
    executionMode: readExecutionMode(input.executionMode),
    deploy: readDeploy(input.deploy),
    limits: {
      maxBuilders: readPositiveInteger(limits.maxBuilders, 'limits.maxBuilders'),
      correctionAttempts: readPositiveInteger(limits.correctionAttempts, 'limits.correctionAttempts'),
      maxRetries: readPositiveInteger(limits.maxRetries, 'limits.maxRetries'),
      maxAiUsage: readPositiveInteger(limits.maxAiUsage, 'limits.maxAiUsage')
    },
    identities: readIdentities(identities)
  };

  if (config.limits.maxBuilders > 2) {
    throw new ConfigError('limits.maxBuilders must be 2 or less.');
  }
  if (config.limits.correctionAttempts > 2) {
    throw new ConfigError('limits.correctionAttempts must be 2 or less.');
  }
  if (!isEdrivePath(config.worktreeRoot)) {
    throw new ConfigError('worktreeRoot must be on the Windows E: drive.');
  }
  for (const session of config.identities.sessions) {
    if (!isEdrivePath(session.worktreePath)) {
      throw new ConfigError(`Session ${session.id} worktreePath must be on the Windows E: drive.`);
    }
    rejectDefaultBranch(session.branch, config.repository.defaultBranch, `Session ${session.id}`);
  }
  for (const pullRequest of config.identities.pullRequests) {
    rejectDefaultBranch(pullRequest.branch, config.repository.defaultBranch, `Pull request ${pullRequest.id}`);
  }

  return config;
}

function mergeConfig(base: ControllerConfig, override: unknown): unknown {
  if (!isRecord(override)) {
    return override;
  }

  return {
    ...base,
    ...override,
    repository: { ...base.repository, ...(isRecord(override.repository) ? override.repository : {}) },
    project: { ...base.project, ...(isRecord(override.project) ? override.project : {}) },
    limits: { ...base.limits, ...(isRecord(override.limits) ? override.limits : {}) },
    identities: { ...base.identities, ...(isRecord(override.identities) ? override.identities : {}) }
  };
}

function readIdentities(input: Record<string, unknown>): IdentityMap {
  const issues = readArray(input.issues, 'identities.issues').map((issue, index) => {
    const record = readRecord(issue, `identities.issues[${index}]`);
    return {
      id: readIdentityId(record.id, `identities.issues[${index}].id`),
      number: readPositiveInteger(record.number, `identities.issues[${index}].number`),
      title: typeof record.title === 'string' ? record.title : undefined
    };
  });

  const sessions = readArray(input.sessions, 'identities.sessions').map((session, index) => {
    const record = readRecord(session, `identities.sessions[${index}]`);
    return {
      id: readNonEmptyString(record.id, `identities.sessions[${index}].id`),
      branch: readNonEmptyString(record.branch, `identities.sessions[${index}].branch`),
      worktreePath: normalizeWindowsPath(
        readNonEmptyString(record.worktreePath, `identities.sessions[${index}].worktreePath`)
      )
    };
  });

  const pullRequests = readArray(input.pullRequests, 'identities.pullRequests').map((pullRequest, index) => {
    const record = readRecord(pullRequest, `identities.pullRequests[${index}]`);
    return {
      id: readIdentityId(record.id, `identities.pullRequests[${index}].id`),
      number: readNonNegativeInteger(record.number, `identities.pullRequests[${index}].number`),
      branch: readNonEmptyString(record.branch, `identities.pullRequests[${index}].branch`)
    };
  });

  if (issues.length === 0 || sessions.length === 0 || pullRequests.length === 0) {
    throw new ConfigError('Explicit issue, session, and pull request identities are required.');
  }

  return { issues, sessions, pullRequests };
}

function rejectCredentialKeys(value: unknown, trail = 'config'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectCredentialKeys(item, `${trail}[${index}]`));
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (CREDENTIAL_KEY_PATTERN.test(key)) {
      throw new ConfigError(`Credential-bearing config key is not allowed: ${trail}.${key}`);
    }
    rejectCredentialKeys(child, `${trail}.${key}`);
  }
}

function rejectDefaultBranch(branch: string, defaultBranch: string, label: string): void {
  const normalized = branch.toLowerCase();
  if (normalized === 'main' || normalized === 'master' || normalized === defaultBranch.toLowerCase()) {
    throw new ConfigError(`${label} branch must be a feature branch, not ${branch}.`);
  }
}

function readExecutionMode(value: unknown): 'dry-run' {
  if (value !== 'dry-run') {
    throw new ConfigError('executionMode must be dry-run; mutation modes are unsupported.');
  }
  return 'dry-run';
}

function readDeploy(value: unknown): false {
  if (value !== false) {
    throw new ConfigError('deploy must be false.');
  }
  return false;
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ConfigError(`${label} must be an object.`);
  }
  return value;
}

function readArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ConfigError(`${label} must be an array.`);
  }
  return value;
}

function readNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(`${label} must be a non-empty string.`);
  }
  return value;
}

function readIdentityId(value: unknown, label: string): string | number {
  if ((typeof value === 'string' && value.trim() !== '') || (typeof value === 'number' && Number.isInteger(value))) {
    return value;
  }
  throw new ConfigError(`${label} must be a non-empty string or integer.`);
}

function readPositiveInteger(value: unknown, label: string): number {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }
  throw new ConfigError(`${label} must be a positive integer.`);
}

function readNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value;
  }
  throw new ConfigError(`${label} must be a non-negative integer.`);
}

function normalizeWindowsPath(value: string): string {
  return path.win32.normalize(value);
}

function isEdrivePath(value: string): boolean {
  return /^[eE]:\\/.test(path.win32.normalize(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
