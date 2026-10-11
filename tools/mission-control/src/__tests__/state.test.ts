import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendAuditEvent } from '../audit.js';
import { defaultConfig } from '../config.js';
import { discover } from '../discovery.js';
import { createFixtureClients } from '../clients.js';
import {
  appendDiscovery,
  createInitialState,
  initializeState,
  parseState,
  readState,
  writeStateAtomic
} from '../state.js';

let tempDirectory: string;

beforeEach(async () => {
  tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'mission-control-'));
});

afterEach(async () => {
  await rm(tempDirectory, { recursive: true, force: true });
});

describe('controller state', () => {
  it('initializes state with preserved identities', async () => {
    const filePath = path.join(tempDirectory, 'state.json');
    const state = await initializeState(filePath, defaultConfig);

    expect(state.identities).toEqual(defaultConfig.identities);
    await expect(readState(filePath)).resolves.toEqual(state);
  });

  it('writes state atomically and round trips', async () => {
    const filePath = path.join(tempDirectory, 'nested', 'state.json');
    const state = createInitialState(defaultConfig, new Date('2026-01-01T00:00:00.000Z'));

    await writeStateAtomic(filePath, state);

    expect(await readState(filePath)).toEqual(state);
  });

  it('appends discovery without replacing configured identities', async () => {
    const filePath = path.join(tempDirectory, 'state.json');
    const discovery = await discover(defaultConfig, createFixtureClients(defaultConfig));

    const state = await appendDiscovery(filePath, defaultConfig, discovery, new Date('2026-01-01T00:00:00.000Z'));

    expect(state.identities).toEqual(defaultConfig.identities);
    expect(state.discoveries).toHaveLength(1);
  });

  it('rejects corrupt state', async () => {
    const filePath = path.join(tempDirectory, 'state.json');
    await writeStateAtomic(filePath, createInitialState(defaultConfig));
    await import('node:fs/promises').then(({ writeFile }) => writeFile(filePath, '{bad json', 'utf8'));

    await expect(readState(filePath)).rejects.toThrow(/corrupt JSON/);
  });

  it('rejects unsupported state versions', () => {
    expect(() => parseState({ ...createInitialState(defaultConfig), version: 999 })).toThrow(/Unsupported/);
  });
});

describe('audit log', () => {
  it('appends redacted JSONL events', async () => {
    const auditPath = path.join(tempDirectory, 'audit.jsonl');
    await appendAuditEvent(auditPath, {
      type: 'test',
      timestamp: '2026-01-01T00:00:00.000Z',
      data: {
        token: 'ghp_supersecret',
        nested: {
          message: 'Authorization Bearer abc.def.ghi'
        }
      }
    });

    const raw = await readFile(auditPath, 'utf8');
    expect(raw.trim().split('\n')).toHaveLength(1);
    expect(raw).toContain('"token":"[REDACTED]"');
    expect(raw).not.toContain('ghp_supersecret');
    expect(raw).not.toContain('Bearer abc.def.ghi');
  });
});
