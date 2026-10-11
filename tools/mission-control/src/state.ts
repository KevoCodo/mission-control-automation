import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { STATE_VERSION, type ControllerConfig, type ControllerState, type DiscoveryResult } from './types.js';

export class StateError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'StateError';
    this.code = code;
  }
}

export function createInitialState(config: ControllerConfig, now = new Date()): ControllerState {
  return {
    version: STATE_VERSION,
    repository: config.repository,
    project: config.project,
    identities: config.identities,
    discoveries: [],
    updatedAt: now.toISOString()
  };
}

export async function readState(filePath: string): Promise<ControllerState> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    const code = isNodeError(error) ? error.code : undefined;
    throw new StateError(`Unable to read state: ${error instanceof Error ? error.message : String(error)}`, code);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new StateError('State file contains corrupt JSON.');
  }

  return parseState(parsed);
}

export async function writeStateAtomic(filePath: string, state: ControllerState): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, filePath);
}

export async function initializeState(filePath: string, config: ControllerConfig): Promise<ControllerState> {
  const state = createInitialState(config);
  await writeStateAtomic(filePath, state);
  return state;
}

export async function appendDiscovery(
  filePath: string,
  config: ControllerConfig,
  discovery: DiscoveryResult,
  now = new Date()
): Promise<ControllerState> {
  let state: ControllerState;
  try {
    state = await readState(filePath);
  } catch (error) {
    if (error instanceof StateError && error.code === 'ENOENT') {
      state = createInitialState(config, now);
    } else {
      throw error;
    }
  }

  const nextState: ControllerState = {
    ...state,
    repository: state.repository,
    project: state.project,
    identities: state.identities,
    discoveries: [...state.discoveries, discovery],
    updatedAt: now.toISOString()
  };
  await writeStateAtomic(filePath, nextState);
  return nextState;
}

export function parseState(value: unknown): ControllerState {
  if (!isRecord(value)) {
    throw new StateError('State must be a JSON object.');
  }
  if (value.version !== STATE_VERSION) {
    throw new StateError(`Unsupported state version: ${String(value.version)}.`);
  }
  if (!isRecord(value.repository) || !isRecord(value.project) || !isRecord(value.identities)) {
    throw new StateError('State is missing required identity sections.');
  }
  if (
    typeof value.repository.owner !== 'string' ||
    typeof value.repository.name !== 'string' ||
    typeof value.repository.defaultBranch !== 'string'
  ) {
    throw new StateError('State repository identity is invalid.');
  }
  if (typeof value.project.id !== 'string') {
    throw new StateError('State project identity is invalid.');
  }
  if (
    !Array.isArray(value.identities.issues) ||
    !Array.isArray(value.identities.sessions) ||
    !Array.isArray(value.identities.pullRequests)
  ) {
    throw new StateError('State identities are invalid.');
  }
  if (!Array.isArray(value.discoveries)) {
    throw new StateError('State discoveries must be an array.');
  }
  if (typeof value.updatedAt !== 'string') {
    throw new StateError('State updatedAt must be a string.');
  }
  return {
    version: STATE_VERSION,
    repository: {
      owner: value.repository.owner,
      name: value.repository.name,
      defaultBranch: value.repository.defaultBranch
    },
    project: {
      id: value.project.id
    },
    identities: {
      issues: value.identities.issues as ControllerState['identities']['issues'],
      sessions: value.identities.sessions as ControllerState['identities']['sessions'],
      pullRequests: value.identities.pullRequests as ControllerState['identities']['pullRequests']
    },
    discoveries: value.discoveries as ControllerState['discoveries'],
    updatedAt: value.updatedAt
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
