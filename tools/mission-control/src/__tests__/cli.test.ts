import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../cli.js';

let tempDirectory: string;

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
    await expect(readFile(auditPath, 'utf8')).resolves.toContain('discovery.completed');
  });

  it('returns a clean error for malformed arguments', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(runCli(['discover', '--config'])).resolves.toBe(1);

    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('--config requires a value'));
  });
});
