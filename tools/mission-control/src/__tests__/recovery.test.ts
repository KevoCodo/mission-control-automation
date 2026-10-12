import { access, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../config.js';
import { appendDiscovery, readState, writeStateAtomic } from '../state.js';
import { getDefaultControllerLockPath, withControllerOwnership, withStateLock } from '../locks.js';
import {
  acquireControllerLock,
  createOperationKey,
  markOperationAttempt,
  reconcilePendingOperations,
  recordOperationIntent,
  recordOperationOutcome,
  releaseControllerLock
} from '../recovery.js';
import type { DependencyGraph } from '../types.js';

let tempDirectory: string;
const fixturePath = path.resolve('tools/mission-control/src/__tests__/fixtures/win32-lock-owner.mjs');

beforeEach(async () => {
  tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'mission-control-recovery-'));
});

afterEach(async () => {
  await rm(tempDirectory, { recursive: true, force: true });
});

describe('recovery and idempotency foundations', () => {
  it('allows only one active writer lock', async () => {
    const lockPath = path.join(tempDirectory, 'controller.lock');
    const first = await acquireControllerLock(lockPath, 'writer-a');

    await expect(acquireControllerLock(lockPath, 'writer-b')).rejects.toMatchObject({ code: 'ELOCKED' });
    await releaseControllerLock(lockPath, first);
  });

  it('keeps a live owner active regardless of age options', async () => {
    const lockPath = path.join(tempDirectory, 'controller.lock');
    const first = await acquireControllerLock(lockPath, 'writer-a', { staleAfterMs: 1 });

    await new Promise((resolve) => setTimeout(resolve, 20));

    await expect(acquireControllerLock(lockPath, 'writer-b', { staleAfterMs: 1 })).rejects.toMatchObject({ code: 'ELOCKED' });
    await releaseControllerLock(lockPath, first);
  });

  it('releases by private receipt and keeps the persistent lock file', async () => {
    const lockPath = path.join(tempDirectory, 'controller.lock');
    const first = await acquireControllerLock(lockPath, 'writer-a');

    await releaseControllerLock(lockPath, first);
    await expect(access(lockPath)).resolves.toBeUndefined();
    const second = await acquireControllerLock(lockPath, 'writer-b');

    expect(second.owner).toBe('writer-b');
    await releaseControllerLock(lockPath, second);
  });

  it('rejects forged or mismatched release receipts', async () => {
    const lockPath = path.join(tempDirectory, 'controller.lock');
    const lock = await acquireControllerLock(lockPath, 'writer-a');

    await expect(releaseControllerLock(lockPath, { ...lock })).rejects.toMatchObject({ code: 'ELOCKED' });
    await expect(releaseControllerLock(path.join(tempDirectory, 'other.lock'), lock)).rejects.toMatchObject({
      code: 'ELOCKED'
    });
    await releaseControllerLock(lockPath, lock);
  });

  it('excludes a real live owner process and releases after forced process death', async () => {
    const lockPath = path.join(tempDirectory, 'controller.lock');
    const owner = spawn(process.execPath, [fixturePath, 'owner', lockPath], { stdio: ['pipe', 'pipe', 'inherit'] });

    const ready = await readChildJson(owner);
    expect(ready).toMatchObject({ role: 'owner', event: 'ready' });
    await expect(acquireControllerLock(lockPath, 'writer-b')).rejects.toMatchObject({ code: 'ELOCKED' });
    owner.kill();
    await waitForExit(owner);
    const recovered = await acquireControllerLock(lockPath, 'writer-c');

    expect(recovered.owner).toBe('writer-c');
    await releaseControllerLock(lockPath, recovered);
  });

  it('blocks a real contender process while application ownership is active', async () => {
    const lockPath = path.join(tempDirectory, 'controller.lock');
    const lock = await acquireControllerLock(lockPath, 'writer-a');

    const contender = await runChildTry(lockPath);

    expect(contender).toMatchObject({ role: 'try', ok: false, invalidHandle: true, errorCode: 32 });
    await releaseControllerLock(lockPath, lock);
  });

  it('uses one canonical default lock path across working directories', async () => {
    const lockPath = getDefaultControllerLockPath();
    const otherCwd = path.join(tempDirectory, 'other-cwd');
    await mkdir(otherCwd);
    const lock = await acquireControllerLock(lockPath, 'repo-controller');

    const child = spawn(process.execPath, [fixturePath, 'try-default'], { cwd: otherCwd, stdio: ['ignore', 'pipe', 'inherit'] });
    const contender = await readChildJson(child);
    await waitForExit(child);

    expect(contender).toMatchObject({ role: 'try-default', ok: false, invalidHandle: true, errorCode: 32 });
    expect(contender.lockPath).toBe(lockPath);
    await releaseControllerLock(lockPath, lock);
  });

  it('fails closed when async context survives past controller handle release', async () => {
    const lockPath = path.join(tempDirectory, 'controller.lock');
    let delayed!: Promise<void>;

    await withControllerOwnership({ owner: 'outer', lockPath }, async () => {
      delayed = new Promise((resolve, reject) => {
        setTimeout(() => {
          withControllerOwnership({ owner: 'late-nested', lockPath }, async () => undefined).then(resolve, reject);
        }, 0);
      });
    });

    await expect(delayed).rejects.toMatchObject({ code: 'ELOCKED' });
  });

  it('reuses nested ownership and serializes unrelated same-process transactions', async () => {
    const events: string[] = [];

    await withStateLock('state-a.json', 'outer', 0, async () => {
      events.push('outer-start');
      await withStateLock('state-a.json', 'inner', 0, async () => {
        events.push('inner');
      });
      events.push('outer-end');
    });

    const first = withStateLock('state-a.json', 'first', 0, async () => {
      events.push('first-start');
      await new Promise((resolve) => setTimeout(resolve, 20));
      events.push('first-end');
    });
    const second = withStateLock('state-a.json', 'second', 0, async () => {
      events.push('second');
    });

    await Promise.all([first, second]);
    expect(events).toEqual(['outer-start', 'inner', 'outer-end', 'first-start', 'first-end', 'second']);
  });

  it('persists intent before a crashed effect is retried', async () => {
    const statePath = path.join(tempDirectory, 'state.json');
    const key = createOperationKey({
      action: 'assign-issue',
      targetType: 'issue',
      targetId: 6,
      payload: { session: 'builder-b' }
    });

    await recordOperationIntent(statePath, defaultConfig, {
      key,
      action: 'assign-issue',
      targetType: 'issue',
      targetId: 6,
      payload: { session: 'builder-b' }
    });

    const state = await readState(statePath);
    expect(state.operations).toMatchObject([{ intent: { key }, status: 'pending', attempts: 0 }]);
  });

  it('recovers an uncertain post-effect operation from provider truth', async () => {
    const statePath = path.join(tempDirectory, 'state.json');
    const key = createOperationKey({
      action: 'create-pr',
      targetType: 'pullRequest',
      targetId: 'ao/issue-6-recovery-state',
      payload: { base: 'main' }
    });

    await recordOperationIntent(statePath, defaultConfig, {
      key,
      action: 'create-pr',
      targetType: 'pullRequest',
      targetId: 'ao/issue-6-recovery-state',
      payload: { base: 'main' }
    });
    await recordOperationOutcome(statePath, key, 'uncertain', undefined);

    const result = await reconcilePendingOperations(statePath, async (record) => ({
      status: 'succeeded',
      outcome: {
        provider: 'github',
        externalId: 14,
        data: { key: record.intent.key }
      }
    }));

    expect(result.recovered).toHaveLength(1);
    expect((await readState(statePath)).operations[0]).toMatchObject({
      status: 'succeeded',
      outcome: { provider: 'github', externalId: 14 }
    });
  });

  it('does not infer completion from missing provider truth during restart reconciliation', async () => {
    const statePath = path.join(tempDirectory, 'state.json');
    const key = createOperationKey({ action: 'merge-pr', targetType: 'pullRequest', targetId: 14 });

    await recordOperationIntent(statePath, defaultConfig, {
      key,
      action: 'merge-pr',
      targetType: 'pullRequest',
      targetId: 14
    });

    const result = await reconcilePendingOperations(statePath, async () => ({ status: 'pending' }));

    expect(result.stillPending).toHaveLength(1);
    expect((await readState(statePath)).operations[0].status).toBe('pending');
  });

  it('deduplicates replayed intents by stable operation key', async () => {
    const statePath = path.join(tempDirectory, 'state.json');
    const firstKey = createOperationKey({
      action: 'assign-issue',
      targetType: 'issue',
      targetId: 6,
      payload: { assignee: 'builder-b', labels: ['foundation', 'recovery'] }
    });
    const secondKey = createOperationKey({
      action: 'assign-issue',
      targetType: 'issue',
      targetId: 6,
      payload: { labels: ['foundation', 'recovery'], assignee: 'builder-b' }
    });

    expect(secondKey).toBe(firstKey);
    await recordOperationIntent(statePath, defaultConfig, {
      key: firstKey,
      action: 'assign-issue',
      targetType: 'issue',
      targetId: 6
    });
    await recordOperationIntent(statePath, defaultConfig, {
      key: secondKey,
      action: 'assign-issue',
      targetType: 'issue',
      targetId: 6
    });

    expect((await readState(statePath)).operations).toHaveLength(1);
  });

  it('enforces a bounded retry policy', async () => {
    const statePath = path.join(tempDirectory, 'state.json');
    const key = createOperationKey({ action: 'discover', targetType: 'repository', targetId: 'ai-delivery-lab' });
    await recordOperationIntent(statePath, defaultConfig, {
      key,
      action: 'discover',
      targetType: 'repository',
      targetId: 'ai-delivery-lab'
    });

    await expect(markOperationAttempt(statePath, key, 1)).resolves.toMatchObject({ attempts: 1 });
    await expect(markOperationAttempt(statePath, key, 1)).rejects.toThrow(/Retry limit/);
  });

  it('surfaces atomic rename failures without leaving temp state files behind', async () => {
    const statePath = path.join(tempDirectory, 'state-as-directory');
    await mkdir(statePath);

    await expect(writeStateAtomic(statePath, await readStateOrInitial(statePath))).rejects.toThrow(
      /Unable to write state atomically/
    );

    const entries = await readdir(tempDirectory);
    expect(entries.some((entry) => entry.startsWith('.state-as-directory.'))).toBe(false);
  });

  it('does not lose discoveries or operations when discovery and intent writes race', async () => {
    const statePath = path.join(tempDirectory, 'state.json');
    const key = createOperationKey({ action: 'assign-issue', targetType: 'issue', targetId: 6 });

    await Promise.all([
      appendDiscovery(statePath, defaultConfig, {
        mode: 'dry-run',
        repository: 'KevoCodo/ai-delivery-lab',
        project: 'ai-delivery-lab',
        issues: [],
        sessions: [],
        pullRequests: [],
        dependencyGraph: fixtureGraph()
      }),
      recordOperationIntent(statePath, defaultConfig, {
        key,
        action: 'assign-issue',
        targetType: 'issue',
        targetId: 6
      })
    ]);

    const state = await readState(statePath);
    expect(state.discoveries).toHaveLength(1);
    expect(state.discoveries[0].dependencyGraph).toEqual(fixtureGraph());
    expect(state.operations).toMatchObject([{ intent: { key } }]);
  });

  it('reconciles pending operations without rewriting persisted dependency graphs', async () => {
    const statePath = path.join(tempDirectory, 'state.json');
    const key = createOperationKey({ action: 'discover', targetType: 'repository', targetId: 'ai-delivery-lab' });

    await appendDiscovery(statePath, defaultConfig, {
      mode: 'dry-run',
      repository: 'KevoCodo/ai-delivery-lab',
      project: 'ai-delivery-lab',
      issues: [],
      sessions: [],
      pullRequests: [],
      dependencyGraph: fixtureGraph()
    });
    await recordOperationIntent(statePath, defaultConfig, {
      key,
      action: 'discover',
      targetType: 'repository',
      targetId: 'ai-delivery-lab'
    });

    await reconcilePendingOperations(statePath, async () => ({
      status: 'succeeded',
      outcome: { provider: 'controller', data: { graphOrder: fixtureGraph().order } }
    }));

    const state = await readState(statePath);
    expect(state.discoveries[0].dependencyGraph).toEqual(fixtureGraph());
    expect(state.operations[0]).toMatchObject({
      status: 'succeeded',
      outcome: { provider: 'controller' }
    });
  });

  it('does not hold the state lock while slow reconciliation probes run', async () => {
    const statePath = path.join(tempDirectory, 'state.json');
    const originalKey = createOperationKey({ action: 'create-pr', targetType: 'pullRequest', targetId: 'original' });
    const competingKey = createOperationKey({ action: 'assign-issue', targetType: 'issue', targetId: 6 });
    const probeGate = createDeferred<void>();
    const probeStarted = createDeferred<void>();

    await recordOperationIntent(statePath, defaultConfig, {
      key: originalKey,
      action: 'create-pr',
      targetType: 'pullRequest',
      targetId: 'original'
    });

    const reconciliation = reconcilePendingOperations(statePath, async () => {
      probeStarted.resolve();
      await probeGate.promise;
      return {
        status: 'succeeded',
        outcome: { provider: 'github', externalId: 16 }
      };
    });

    await probeStarted.promise;
    const competingController = await acquireControllerLock(getDefaultControllerLockPath(), 'competing-controller', {
      staleAfterMs: 60000
    });
    await releaseControllerLock(getDefaultControllerLockPath(), competingController);
    await recordOperationIntent(statePath, defaultConfig, {
      key: competingKey,
      action: 'assign-issue',
      targetType: 'issue',
      targetId: 6
    });
    probeGate.resolve();
    await reconciliation;

    const state = await readState(statePath);
    expect(state.operations).toHaveLength(2);
    expect(state.operations.find((operation) => operation.intent.key === originalKey)).toMatchObject({
      status: 'succeeded'
    });
    expect(state.operations.find((operation) => operation.intent.key === competingKey)).toMatchObject({
      status: 'pending'
    });
  });

  it('releases operation ownership after reconciliation probe errors', async () => {
    const statePath = path.join(tempDirectory, 'state.json');
    const key = createOperationKey({ action: 'merge-pr', targetType: 'pullRequest', targetId: 16 });
    await recordOperationIntent(statePath, defaultConfig, {
      key,
      action: 'merge-pr',
      targetType: 'pullRequest',
      targetId: 16
    });

    await expect(
      reconcilePendingOperations(statePath, async () => {
        throw new Error('provider unavailable');
      })
    ).rejects.toThrow(/provider unavailable/);

    await expect(markOperationAttempt(statePath, key, 2)).resolves.toMatchObject({ attempts: 1 });
  });
});

async function readStateOrInitial(_statePath: string) {
  return {
    version: 2 as const,
    schema: { createdVersion: 2 },
    repository: defaultConfig.repository,
    project: defaultConfig.project,
    identities: defaultConfig.identities,
    operations: [],
    discoveries: [],
    updatedAt: '2026-01-01T00:00:00.000Z'
  };
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
        title: 'Issue 4',
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

async function readChildJson(child: ChildProcessWithoutNullStreams): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Timed out waiting for child output. Partial output: ${output}`));
    }, 5000);

    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      const newlineIndex = output.indexOf('\n');
      if (newlineIndex === -1) {
        return;
      }
      clearTimeout(timeout);
      try {
        resolve(JSON.parse(output.slice(0, newlineIndex)));
      } catch (error) {
        reject(error);
      }
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      if (output.trim().length === 0) {
        clearTimeout(timeout);
        reject(new Error(`Child exited before writing JSON: ${code}`));
      }
    });
  });
}

async function runChildTry(lockPath: string): Promise<Record<string, unknown>> {
  const child = spawn(process.execPath, [fixturePath, 'try', lockPath], { stdio: ['ignore', 'pipe', 'inherit'] });
  const result = await readChildJson(child);
  await waitForExit(child);
  return result;
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => resolve());
  });
}

