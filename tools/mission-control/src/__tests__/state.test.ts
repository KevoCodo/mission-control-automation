import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendAuditEvent, recoverAuditLog, withAuditFileTransaction } from '../audit.js';
import { defaultConfig } from '../config.js';
import { discover } from '../discovery.js';
import { createFixtureClients } from '../clients.js';
import { withControllerOwnership } from '../locks.js';
import {
  appendDiscovery,
  createInitialState,
  initializeState,
  parseState,
  quarantineCorruptState,
  readState,
  writeStateAtomic
} from '../state.js';
import type { DependencyGraph } from '../types.js';

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

  it('persists typed dependency graphs through state append and readback', async () => {
    const filePath = path.join(tempDirectory, 'state.json');
    const discovery = await discover(defaultConfig, createFixtureClients(defaultConfig));

    const state = await appendDiscovery(filePath, defaultConfig, discovery, new Date('2026-01-01T00:00:00.000Z'));
    const persisted = await readState(filePath);

    expect(state.discoveries[0].dependencyGraph).toEqual(fixtureGraph());
    expect(persisted.discoveries[0].dependencyGraph).toEqual(fixtureGraph());
  });

  it('rejects corrupt state', async () => {
    const filePath = path.join(tempDirectory, 'state.json');
    await writeStateAtomic(filePath, createInitialState(defaultConfig));
    await import('node:fs/promises').then(({ writeFile }) => writeFile(filePath, '{bad json', 'utf8'));

    await expect(readState(filePath)).rejects.toThrow(/corrupt JSON/);
  });

  it('quarantines corrupt state explicitly', async () => {
    const filePath = path.join(tempDirectory, 'state.json');
    await writeFile(filePath, '{bad json', 'utf8');

    const quarantinePath = await quarantineCorruptState(filePath, 'test', new Date('2026-01-01T00:00:00.000Z'));

    await expect(readFile(quarantinePath, 'utf8')).resolves.toBe('{bad json');
    await expect(readState(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects unsupported state versions', () => {
    expect(() => parseState({ ...createInitialState(defaultConfig), version: 999 })).toThrow(/Unsupported/);
  });

  it('migrates version two state without inventing dispatch receipts', () => {
    const current = createInitialState(defaultConfig);
    const { dispatches: _unused, ...legacy } = current;
    const migrated = parseState({ ...legacy, version: 2, schema: { createdVersion: 2 } });
    expect(migrated.version).toBe(4);
    expect(migrated.schema.previousVersion).toBe(2);
    expect(migrated.dispatches).toEqual([]);
  });

  it('migrates version one state with recovery fields and graph discoveries preserved', () => {
    const versionOneState = {
      version: 1,
      repository: defaultConfig.repository,
      project: defaultConfig.project,
      identities: defaultConfig.identities,
      discoveries: [
        {
          mode: 'dry-run',
          repository: 'KevoCodo/ai-delivery-lab',
          project: 'ai-delivery-lab',
          issues: [],
          sessions: [],
          pullRequests: [],
          dependencyGraph: fixtureGraph()
        }
      ],
      updatedAt: '2026-01-01T00:00:00.000Z'
    };

    const migrated = parseState(versionOneState);

    expect(migrated.version).toBe(4);
    expect(migrated.schema.previousVersion).toBe(1);
    expect(migrated.operations).toEqual([]);
    expect(migrated.discoveries[0].dependencyGraph).toEqual(fixtureGraph());
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

  it('recovers a partial audit tail without discarding valid history', async () => {
    const auditPath = path.join(tempDirectory, 'audit.jsonl');
    await writeFile(
      auditPath,
      `${JSON.stringify({ type: 'first', timestamp: '2026-01-01T00:00:00.000Z', data: { ok: true } })}\n{"type":`,
      'utf8'
    );

    const result = await recoverAuditLog(auditPath, new Date('2026-01-01T00:00:00.000Z'));

    expect(result.events).toHaveLength(1);
    expect(result.quarantinedPath).toBeDefined();
    await expect(readFile(auditPath, 'utf8')).resolves.toContain('"type":"first"');
    const entries = await readdir(tempDirectory);
    expect(entries.some((entry) => entry.includes('quarantine'))).toBe(true);
  });

  it('serializes recovery and append operations without losing completed events', async () => {
    const auditPath = path.join(tempDirectory, 'audit.jsonl');
    await writeFile(
      auditPath,
      `${JSON.stringify({ type: 'first', timestamp: '2026-01-01T00:00:00.000Z', data: { ok: true } })}\n{"type":`,
      'utf8'
    );
    const gate = createDeferred<void>();

    await withControllerOwnership({ owner: 'audit-test' }, async () => {
      const hold = withAuditFileTransaction(auditPath, 'hold-audit-test', () => gate.promise);
      const recovery = recoverAuditLog(auditPath, new Date('2026-01-01T00:00:00.000Z'));
      const append = appendAuditEvent(auditPath, {
        type: 'second',
        timestamp: '2026-01-01T00:00:01.000Z',
        data: { ok: true }
      });

      gate.resolve();
      await Promise.all([hold, recovery, append]);
    });

    const events = parseAuditLines(await readFile(auditPath, 'utf8'));
    expect(events.map((event) => event.type)).toEqual(['first', 'second']);
  });

  it('takes the recovery snapshot after queued appends acquire the audit transaction', async () => {
    const auditPath = path.join(tempDirectory, 'audit.jsonl');
    await writeFile(
      auditPath,
      `${JSON.stringify({ type: 'first', timestamp: '2026-01-01T00:00:00.000Z', data: { ok: true } })}\n`,
      'utf8'
    );
    const gate = createDeferred<void>();

    const result = await withControllerOwnership({ owner: 'audit-test' }, async () => {
      const hold = withAuditFileTransaction(auditPath, 'hold-audit-test', () => gate.promise);
      const append = appendAuditEvent(auditPath, {
        type: 'second',
        timestamp: '2026-01-01T00:00:01.000Z',
        data: { ok: true }
      });
      const recovery = recoverAuditLog(auditPath, new Date('2026-01-01T00:00:00.000Z'));

      gate.resolve();
      const [, , recovered] = await Promise.all([hold, append, recovery]);
      return recovered;
    });

    expect(result.events.map((event) => event.type)).toEqual(['first', 'second']);
    expect(result.quarantinedPath).toBeUndefined();
    expect(parseAuditLines(await readFile(auditPath, 'utf8')).map((event) => event.type)).toEqual(['first', 'second']);
  });

  it('preserves racing append bytes in quarantine when repairing a corrupt tail', async () => {
    const auditPath = path.join(tempDirectory, 'audit.jsonl');
    await writeFile(
      auditPath,
      `${JSON.stringify({ type: 'first', timestamp: '2026-01-01T00:00:00.000Z', data: { ok: true } })}\n{"type":`,
      'utf8'
    );
    const gate = createDeferred<void>();

    const result = await withControllerOwnership({ owner: 'audit-test' }, async () => {
      const hold = withAuditFileTransaction(auditPath, 'hold-audit-test', () => gate.promise);
      const append = appendAuditEvent(auditPath, {
        type: 'second',
        timestamp: '2026-01-01T00:00:01.000Z',
        data: { ok: true }
      });
      const recovery = recoverAuditLog(auditPath, new Date('2026-01-01T00:00:00.000Z'));

      gate.resolve();
      const [, , recovered] = await Promise.all([hold, append, recovery]);
      return recovered;
    });

    expect(result.quarantinedPath).toBeDefined();
    await expect(readFile(result.quarantinedPath!, 'utf8')).resolves.toContain('"type":"second"');
    expect(parseAuditLines(await readFile(auditPath, 'utf8')).map((event) => event.type)).toEqual(['first']);
  });

  it('publishes all sibling appends issued inside an already-held controller ownership', async () => {
    const auditPath = path.join(tempDirectory, 'audit.jsonl');

    await withControllerOwnership({ owner: 'audit-test' }, async () => {
      await Promise.all(
        ['first', 'second', 'third'].map((type, index) =>
          appendAuditEvent(auditPath, {
            type,
            timestamp: `2026-01-01T00:00:0${index}.000Z`,
            data: { index }
          })
        )
      );
    });

    expect(parseAuditLines(await readFile(auditPath, 'utf8')).map((event) => event.type)).toEqual([
      'first',
      'second',
      'third'
    ]);
  });

  it('lets public audit helpers reuse an already-held audit transaction without self-deadlock', async () => {
    const auditPath = path.join(tempDirectory, 'audit.jsonl');

    await withControllerOwnership({ owner: 'audit-test' }, async () => {
      await withAuditFileTransaction(auditPath, 'outer-audit-test', async () => {
        await appendAuditEvent(auditPath, {
          type: 'nested-append',
          timestamp: '2026-01-01T00:00:00.000Z',
          data: {}
        });
        const result = await recoverAuditLog(auditPath, new Date('2026-01-01T00:00:00.000Z'));
        expect(result.events.map((event) => event.type)).toEqual(['nested-append']);
      });
    });

    expect(parseAuditLines(await readFile(auditPath, 'utf8')).map((event) => event.type)).toEqual(['nested-append']);
  });

  it('leaves canonical audit bytes unchanged when validated repair publication cannot start', async () => {
    const auditPath = path.join(tempDirectory, 'audit.jsonl');
    const now = new Date('2026-01-01T00:00:00.000Z');
    const recoveredPath = `${auditPath}.recovered-2026-01-01T00-00-00-000Z.jsonl`;
    const original = `${JSON.stringify({ type: 'first', timestamp: now.toISOString(), data: { ok: true } })}\n{"type":`;
    await writeFile(auditPath, original, 'utf8');
    await mkdir(recoveredPath);

    await expect(recoverAuditLog(auditPath, now)).rejects.toThrow();

    await expect(readFile(auditPath, 'utf8')).resolves.toBe(original);
    const entries = await readdir(tempDirectory);
    expect(entries.some((entry) => entry.includes('quarantine'))).toBe(false);
  });

  it('preserves canonical bytes and quarantine evidence if repair is interrupted before publish', async () => {
    const auditPath = path.join(tempDirectory, 'audit.jsonl');
    const now = new Date('2026-01-01T00:00:00.000Z');
    const original = `${JSON.stringify({ type: 'first', timestamp: now.toISOString(), data: { ok: true } })}\n{"type":`;
    await writeFile(auditPath, original, 'utf8');

    await expect(
      recoverAuditLog(auditPath, now, {
        async onBeforePublish() {
          throw new Error('crash before publish');
        }
      })
    ).rejects.toThrow(/crash before publish/);

    await expect(readFile(auditPath, 'utf8')).resolves.toBe(original);
    await expect(readFile(`${auditPath}.quarantine-2026-01-01T00-00-00-000Z.jsonl`, 'utf8')).resolves.toBe(original);
  });

  it('bounds audit transaction contention and leaves data unchanged on timeout', async () => {
    const auditPath = path.join(tempDirectory, 'audit.jsonl');
    const original = `${JSON.stringify({ type: 'first', timestamp: '2026-01-01T00:00:00.000Z', data: { ok: true } })}\n`;
    await writeFile(auditPath, original, 'utf8');

    await withControllerOwnership({ owner: 'audit-test' }, async () => {
      const hold = withAuditFileTransaction(auditPath, 'hold-audit-test', () => new Promise<void>(() => undefined));
      hold.catch(() => undefined);

      await expect(
        withAuditFileTransaction(
          auditPath,
          'timed-out-audit-test',
          async () => {
            await appendAuditEvent(auditPath, {
              type: 'should-not-run',
              timestamp: '2026-01-01T00:00:01.000Z',
              data: {}
            });
          },
          { timeoutMs: 5 }
        )
      ).rejects.toThrow(/Timed out waiting for audit transaction/);
    });

    await expect(readFile(auditPath, 'utf8')).resolves.toBe(original);
  });
});

function parseAuditLines(raw: string): Array<{ type: string }> {
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string });
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function fixtureGraph(): DependencyGraph {
  return {
    repository: 'KevoCodo/ai-delivery-lab',
    epicIssueNumber: 4,
    nodes: [
      {
        id: 4,
        owner: 'KevoCodo',
        name: 'ai-delivery-lab',
        number: 4,
        title: 'Controller Project Skeleton',
        state: 'closed',
        completionStatus: 'complete',
        dependencies: [],
        blocked: false,
        eligible: true
      }
    ],
    order: [4],
    open: [],
    blocked: [],
    unverified: []
  };
}
