import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssignmentError, assignIssueWithAo, validateAssignmentWorktree } from '../assignment.js';
import { parseAuditLog } from '../audit.js';
import { createFixtureClients } from '../clients.js';
import type { ControllerClients } from '../clients.js';
import { defaultConfig } from '../config.js';
import { planAssignments } from '../planner.js';
import { generateAuditReport } from '../report.js';
import { createInitialState, readState, writeStateAtomic } from '../state.js';
import type { ControllerConfig, DiscoveryIssue, OperationRecord } from '../types.js';

let tempDirectory: string;
const worktreeRoot = 'E:\\AI-Development\\ao-data\\data\\worktrees\\ai-delivery-lab';
const worktreePath = path.win32.join(worktreeRoot, 'issue-7');
const denialCode = 'EAO_EXECUTION_BOUNDARY_UNAVAILABLE';

beforeEach(async () => {
  tempDirectory = await mkdtemp(path.join(process.cwd(), '.tmp-mission-control-assignment-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tempDirectory, { recursive: true, force: true });
});

describe('default-deny AO assignment boundary', () => {
  it.each([
    { name: 'no authorization', authorization: undefined, adapterName: 'fixture-ao-client' },
    { name: 'caller authorization', authorization: authorization('2026-10-16T00:00:00.000Z'), adapterName: 'fixture-ao-client' },
    { name: 'stale authorization', authorization: authorization('2020-01-01T00:00:00.000Z'), adapterName: 'fixture-ao-client' },
    { name: 'trusted-looking adapter', authorization: authorization('2026-10-16T00:00:00.000Z'), adapterName: 'ao-cli-client' }
  ])('denies live dispatch with $name before any AO client call', async ({ authorization: grant, adapterName }) => {
    const clients = injectedClients(adapterName);
    const result = assignIssueWithAo(
      statePath(), auditPath(), config(), clients, request({ mode: 'live', authorization: grant }), inspector()
    );

    await expect(result).rejects.toMatchObject({
      name: 'AssignmentError',
      code: denialCode
    });
    expect(clients.ao.getCapabilities).not.toHaveBeenCalled();
    expect(clients.ao.listSessions).not.toHaveBeenCalled();
    expect(clients.ao.spawnWorker).not.toHaveBeenCalled();
    expect(existsSync(statePath())).toBe(false);

    const audit = parseAuditLog(await readFile(auditPath(), 'utf8'));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      type: 'assignment.dispatch.denied',
      issueNumber: 7,
      category: 'outcome',
      authorization: 'denied',
      outcome: 'failed',
      provenance: { source: 'controller' },
      data: { reason: 'TRUSTED_EXECUTION_BOUNDARY_UNAVAILABLE' }
    });
    expect(audit[0]).not.toHaveProperty('sessionId');
    expect(audit[0]).not.toHaveProperty('operationKey');
    expect(audit[0]?.provenance?.source).not.toBe('ao');
  });

  it('returns a typed containment error even with a trusted-looking injected client', async () => {
    const clients = injectedClients('ao-cli-client');
    try {
      await assignIssueWithAo(statePath(), auditPath(), config(), clients, request({
        mode: 'live', authorization: authorization('2026-10-16T00:00:00.000Z')
      }), inspector());
      throw new Error('Expected the assignment gate to deny live work.');
    } catch (error) {
      expect(error).toBeInstanceOf(AssignmentError);
      expect(error).toMatchObject({ code: denialCode });
    }
    expect(clients.ao.spawnWorker).not.toHaveBeenCalled();
  });

  it('preserves an existing uncertain operation and all state identities byte for byte', async () => {
    const cfg = config();
    const uncertain: OperationRecord = {
      intent: { key: 'issue12-phase2h-supervised-assignment', action: 'ao-spawn-worker', targetType: 'issue', targetId: 12 },
      status: 'uncertain',
      attempts: 1,
      createdAt: '2026-10-12T00:00:00.000Z',
      updatedAt: '2026-10-12T00:00:00.000Z'
    };
    await writeStateAtomic(statePath(), { ...createInitialState(cfg), operations: [uncertain] });
    const before = await readFile(statePath(), 'utf8');
    const clients = injectedClients('ao-cli-client');

    await expect(assignIssueWithAo(
      statePath(), auditPath(), cfg, clients,
      request({ mode: 'live', authorization: authorization('2026-10-16T00:00:00.000Z') }), inspector()
    )).rejects.toMatchObject({ code: denialCode });

    expect(await readFile(statePath(), 'utf8')).toBe(before);
    expect((await readState(statePath())).operations).toEqual([uncertain]);
    expect((await readState(statePath())).identities.sessions).toEqual([]);
    expect(clients.ao.spawnWorker).not.toHaveBeenCalled();
  });

  it('reports a failed denial audit as an audit error and never calls AO or changes state', async () => {
    const cfg = config();
    const uncertain: OperationRecord = {
      intent: { key: 'existing-uncertain', action: 'ao-spawn-worker', targetType: 'issue', targetId: 12 },
      status: 'uncertain', attempts: 1,
      createdAt: '2026-10-12T00:00:00.000Z', updatedAt: '2026-10-12T00:00:00.000Z'
    };
    await writeStateAtomic(statePath(), { ...createInitialState(cfg), operations: [uncertain] });
    const before = await readFile(statePath(), 'utf8');
    const unwritableAuditPath = path.join(tempDirectory, 'audit-directory');
    await mkdir(unwritableAuditPath);
    const clients = injectedClients('ao-cli-client');

    await expect(assignIssueWithAo(
      statePath(), unwritableAuditPath, cfg, clients, request({ mode: 'live' }), inspector()
    )).rejects.toMatchObject({
      name: 'AssignmentError', code: 'EAO_DENIAL_AUDIT_WRITE',
      message: expect.stringMatching(/denied.*audit event could not be written/i)
    });
    expect(await readFile(statePath(), 'utf8')).toBe(before);
    expect(clients.ao.getCapabilities).not.toHaveBeenCalled();
    expect(clients.ao.listSessions).not.toHaveBeenCalled();
    expect(clients.ao.spawnWorker).not.toHaveBeenCalled();
  });

  it('denies concurrent live requests without creating any reservation', async () => {
    const clients = injectedClients('ao-cli-client');
    const results = await Promise.allSettled(Array.from({ length: 2 }, () =>
      assignIssueWithAo(statePath(), auditPath(), config(), clients, request({ mode: 'live' }), inspector())
    ));
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: denialCode });
    }
    expect(existsSync(statePath())).toBe(false);
    expect(clients.ao.spawnWorker).not.toHaveBeenCalled();
    expect(parseAuditLog(await readFile(auditPath(), 'utf8'))).toHaveLength(2);
  });

  it('shows the denial as controller evidence, without claiming an AO outcome', async () => {
    const clients = injectedClients('ao-cli-client');
    await expect(assignIssueWithAo(
      statePath(), auditPath(), config(), clients, request({ mode: 'live' }), inspector()
    )).rejects.toMatchObject({ code: denialCode });

    const report = await generateAuditReport(auditPath(), statePath());
    expect(report.events).toMatchObject([{
      source: 'controller',
      type: 'assignment.dispatch.denied',
      authorization: 'denied',
      outcome: 'failed',
      authority: 'unverified'
    }]);
    expect(report.history[0]).toMatchObject({ verifiedOutcome: 'unavailable', completion: 'unverified' });
  });

  it('keeps dry-run preview and local admission available without spawning', async () => {
    const cfg = config();
    const spawnWorker = vi.fn();
    const clients = createFixtureClients(cfg);
    clients.ao.spawnWorker = spawnWorker;

    const result = await assignIssueWithAo(statePath(), auditPath(), cfg, clients, request(), inspector());

    expect(result).toMatchObject({ mode: 'dry-run', status: 'preview' });
    expect(spawnWorker).not.toHaveBeenCalled();
    expect(existsSync(statePath())).toBe(false);
    expect(parseAuditLog(await readFile(auditPath(), 'utf8'))[0]).toMatchObject({
      type: 'assignment.previewed', category: 'intent', outcome: 'pending'
    });
  });

  it('still checks AO capabilities for dry-run previews', async () => {
    const clients = injectedClients('fixture-ao-client');
    const result = await assignIssueWithAo(statePath(), auditPath(), config(), clients, request(), inspector());
    expect(result.capabilities.commands).toEqual({ spawn: true, session: true, report: true, review: true });
    expect(clients.ao.getCapabilities).toHaveBeenCalledTimes(1);
    expect(clients.ao.spawnWorker).not.toHaveBeenCalled();

    const missingCapability = injectedClients('fixture-ao-client');
    missingCapability.ao.getCapabilities = vi.fn().mockResolvedValue({
      adapterName: 'fixture-ao-client',
      version: 'fixture',
      commands: { spawn: false, session: true, report: true, review: true }
    });
    await expect(assignIssueWithAo(
      statePath(), auditPath(), config(), missingCapability, request(), inspector()
    )).rejects.toMatchObject({ code: 'EAO_CAPABILITY' });
  });

  it('still rejects untrusted AO adapters for dry-run previews', async () => {
    await expect(assignIssueWithAo(
      statePath(), auditPath(), config(), injectedClients('shell-out-anything'), request(), inspector()
    )).rejects.toThrow(/Untrusted AO adapter/);
  });

  it('preserves dry-run duplicate-owner and branch validation', async () => {
    const cfg = config({
      identities: {
        issues: [],
        sessions: [{ id: 'existing', branch: 'ao/issue-7-ao-spawn-planner', worktreePath, issueNumber: 7 }],
        pullRequests: []
      }
    });
    await expect(assignIssueWithAo(
      statePath(), auditPath(), cfg, createFixtureClients(cfg), request(), inspector()
    )).rejects.toMatchObject({ code: 'EDUPLICATE_OWNER' });
    await expect(assignIssueWithAo(
      statePath(), auditPath(), config(), createFixtureClients(config()), request({ branch: 'main' }), inspector()
    )).rejects.toMatchObject({ code: 'EBRANCH' });
  });

  it('keeps read-only assignment planning available', async () => {
    const cfg = config();
    await writeStateAtomic(statePath(), createInitialState(cfg));
    const clients = injectedClients('fixture-ao-client');
    clients.ao.listSessions = vi.fn().mockResolvedValue([]);

    expect(await planAssignments(statePath(), cfg, clients)).toMatchObject({
      eligible: [], blocked: [],
      capacity: { activeBuilders: 0, pendingReservations: 0 }
    });
    expect(clients.ao.spawnWorker).not.toHaveBeenCalled();
  });

  it('keeps dry-run capacity blocked by existing uncertain reservations', async () => {
    const cfg = config({ limits: { ...defaultConfig.limits, maxBuilders: 1 } });
    const uncertain: OperationRecord = {
      intent: {
        key: 'existing-uncertain',
        action: 'ao-spawn-worker',
        targetType: 'issue',
        targetId: 8,
        payload: { branch: 'ao/issue-8', sessionId: 'issue-8' }
      },
      status: 'uncertain',
      attempts: 1,
      createdAt: '2026-10-12T00:00:00.000Z',
      updatedAt: '2026-10-12T00:00:00.000Z'
    };
    await writeStateAtomic(statePath(), { ...createInitialState(cfg), operations: [uncertain] });
    await expect(assignIssueWithAo(
      statePath(), auditPath(), cfg, createFixtureClients(cfg), request(), inspector()
    )).rejects.toMatchObject({ code: 'EADMISSION_LIMIT' });
    expect((await readState(statePath())).operations).toEqual([uncertain]);
  });
});

describe('assignment worktree validation', () => {
  it('rejects paths outside the E: worktree root', async () => {
    await expect(validateAssignmentWorktree(
      config(), 'C:\\outside\\issue-7', inspector()
    )).rejects.toMatchObject({ code: 'EWORKTREE_PATH' });
    await expect(validateAssignmentWorktree(
      config(), 'E:\\outside\\issue-7', inspector()
    )).rejects.toMatchObject({ code: 'EWORKTREE_PATH' });
  });

  it('rejects links, escaped real paths, and wrong repositories', async () => {
    await expect(validateAssignmentWorktree(
      config(), worktreePath, inspector({ link: true })
    )).rejects.toMatchObject({ code: 'EWORKTREE_LINK' });
    await expect(validateAssignmentWorktree(
      config(), worktreePath, inspector({ resolvedWorktree: 'E:\\outside\\issue-7' })
    )).rejects.toMatchObject({ code: 'EWORKTREE_PATH' });
    await expect(validateAssignmentWorktree(
      config(), worktreePath, inspector({ repository: { owner: 'Other', name: 'repo' } })
    )).rejects.toMatchObject({ code: 'EREPOSITORY' });
  });

  it('fails closed when the worktree repository identity cannot be verified', async () => {
    await expect(validateAssignmentWorktree(
      config(), worktreePath, {
        realpath: async (inputPath) => path.win32.normalize(inputPath),
        lstat: async () => ({ isSymbolicLink: () => false })
      }
    )).rejects.toMatchObject({ code: 'EREPOSITORY' });
  });
});

function statePath(): string {
  return path.join(tempDirectory, 'state.json');
}

function auditPath(): string {
  return path.join(tempDirectory, 'audit.jsonl');
}

function config(override: Partial<ControllerConfig> = {}): ControllerConfig {
  return {
    ...defaultConfig,
    worktreeRoot,
    limits: { ...defaultConfig.limits, maxBuilders: 2, maxRetries: 1 },
    identities: { issues: [], sessions: [], pullRequests: [] },
    ...override
  };
}

function request(override: Partial<Parameters<typeof assignIssueWithAo>[4]> = {}) {
  const issue: DiscoveryIssue = {
    id: 7, number: 7, title: 'AO Session Assignment Adapter', state: 'open', body: 'Parent Epic: #3'
  };
  return { issue, branch: 'ao/issue-7-ao-spawn-planner', worktreePath, ...override };
}

function authorization(approvedAt: string) {
  return { approved: true as const, policy: 'trusted-controller' as const, approvedBy: 'caller', approvedAt };
}

function injectedClients(adapterName: string): ControllerClients {
  return {
    github: createFixtureClients(config()).github,
    ao: {
      adapterName,
      getCapabilities: vi.fn().mockResolvedValue({
        adapterName, version: 'fixture', commands: { spawn: true, session: true, report: true, review: true }
      }),
      getSession: vi.fn().mockResolvedValue({ id: 'unused', branch: 'unused', status: 'active' }),
      listSessions: vi.fn().mockResolvedValue([]),
      spawnWorker: vi.fn().mockResolvedValue({ sessionId: 'should-never-exist' })
    }
  };
}

function inspector(options: {
  link?: boolean;
  resolvedWorktree?: string;
  repository?: { owner: string; name: string };
} = {}) {
  return {
    async realpath(inputPath: string) {
      if (path.win32.normalize(inputPath).toLowerCase() === path.win32.normalize(worktreeRoot).toLowerCase()) {
        return path.win32.normalize(worktreeRoot);
      }
      return path.win32.normalize(options.resolvedWorktree ?? inputPath);
    },
    async lstat() {
      return { isSymbolicLink: () => options.link === true };
    },
    async getRepositoryIdentity() {
      return options.repository ?? { owner: 'KevoCodo', name: 'ai-delivery-lab' };
    }
  };
}
