import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../cli.js';
import { defaultConfig } from '../config.js';
import { acquireControllerLock, getDefaultControllerLockPath, releaseControllerLock } from '../locks.js';
import { createInitialState, writeStateAtomic } from '../state.js';

let tempDirectory: string;
const fixturePath = path.resolve('tools/mission-control/src/__tests__/fixtures/win32-lock-owner.mjs');

beforeEach(async () => {
  tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'mission-control-cli-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tempDirectory, { recursive: true, force: true });
});

describe('mission-control cli', () => {
  it('prints help', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(runCli(['--help'])).resolves.toBe(0);

    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('mission-control discover'));
  });

  it('runs dry-run discovery smoke test', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const statePath = path.join(tempDirectory, 'state.json');
    const auditPath = path.join(tempDirectory, 'audit.jsonl');

    await expect(runCli(['discover', '--state', statePath, '--audit', auditPath])).resolves.toBe(0);

    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('"mode": "dry-run"'));
    await expect(readFile(statePath, 'utf8')).resolves.toContain('"discoveries"');
    await expect(readFile(statePath, 'utf8')).resolves.toContain('"dependencyGraph"');
    await expect(readFile(auditPath, 'utf8')).resolves.toContain('discovery.completed');
  });

  it('runs read-only PR and CI tracking summary', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const statePath = path.join(tempDirectory, 'state.json');
    const auditPath = path.join(tempDirectory, 'audit.jsonl');
    await writeStateAtomic(statePath, defaultStateWithAssignment());

    await expect(runCli(['track-pr', '--state', statePath, '--audit', auditPath])).resolves.toBe(0);

    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('"status": "successful"'));
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('"dataSource": "fixture-data"'));
    await expect(readFile(statePath, 'utf8')).resolves.toContain('"pullRequestTracking"');
    await expect(readFile(auditPath, 'utf8')).resolves.toContain('prTracking.completed');
  });

  it('fails closed on stale track-pr expected head before persisting audit', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const statePath = path.join(tempDirectory, 'state.json');
    const auditPath = path.join(tempDirectory, 'audit.jsonl');
    await writeStateAtomic(statePath, defaultStateWithAssignment());

    await expect(runCli(['track-pr', '--state', statePath, '--audit', auditPath, '--head', 'stale-head'])).resolves.toBe(1);

    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('head SHA is stale'));
    await expect(readFile(auditPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed before discovery or audit mutation when controller ownership is unavailable', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const statePath = path.join(tempDirectory, 'state.json');
    const auditPath = path.join(tempDirectory, 'audit.jsonl');
    const lock = await acquireControllerLock(getDefaultControllerLockPath(), 'external-controller');

    try {
      await expect(runCli(['discover', '--state', statePath, '--audit', auditPath])).resolves.toBe(1);
    } finally {
      await releaseControllerLock(getDefaultControllerLockPath(), lock);
    }

    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Controller lock is already held'));
    await expect(readFile(statePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(auditPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed when another cwd owns the same controller identity for the same state', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const statePath = path.join(tempDirectory, 'state.json');
    const auditPath = path.join(tempDirectory, 'audit.jsonl');
    const otherCwd = path.join(tempDirectory, 'other-cwd');
    await mkdir(otherCwd);
    const owner = spawn(process.execPath, [fixturePath, 'owner-default'], { cwd: otherCwd, stdio: ['pipe', 'pipe', 'inherit'] });

    try {
      const ready = await readChildJson(owner);
      expect(ready).toMatchObject({ role: 'owner-default', event: 'ready', lockPath: getDefaultControllerLockPath() });

      await expect(runCli(['discover', '--state', statePath, '--audit', auditPath])).resolves.toBe(1);
    } finally {
      owner.kill();
      await waitForExit(owner);
    }

    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Controller lock is already held'));
    await expect(readFile(statePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(auditPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns a clean error for malformed arguments', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(runCli(['discover', '--config'])).resolves.toBe(1);

    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('--config requires a value'));
  });
});

function defaultStateWithAssignment() {
  return {
    ...createInitialState(defaultConfig),
    operations: [
      {
        intent: {
          key: 'ao-spawn-worker:issue:4:fixture-session:ao/issue-4-controller-skeleton',
          action: 'ao-spawn-worker',
          targetType: 'issue',
          targetId: 4,
          payload: {
            sessionId: 'fixture-session',
            branch: 'ao/issue-4-controller-skeleton',
            worktreePath: 'E:\\AI-Development\\ao-data\\data\\worktrees\\ai-delivery-lab\\fixture-session'
          }
        },
        status: 'succeeded' as const,
        attempts: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        outcome: {
          provider: 'ao',
          externalId: 'fixture-session'
        }
      }
    ]
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

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => resolve());
  });
}
