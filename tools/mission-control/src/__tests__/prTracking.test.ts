import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendAuditEvent } from '../audit.js';
import { createFixtureClients } from '../clients.js';
import { defaultConfig } from '../config.js';
import { trackPullRequestChecks } from '../prTracking.js';
import { createInitialState, readState, writeStateAtomic } from '../state.js';
import type { ControllerClients } from '../clients.js';
import type {
  ControllerConfig,
  OperationRecord,
  PullRequestCheckRun,
  PullRequestDetails,
  RequiredCheckDiscovery,
  SessionIdentity
} from '../types.js';

let tempDirectory: string;

beforeEach(async () => {
  tempDirectory = await mkdtemp(path.join(process.cwd(), '.tmp-mission-control-pr-'));
  await writeStateAtomic(statePath(), stateWithAssignment());
});

afterEach(async () => {
  await rm(tempDirectory, { recursive: true, force: true });
});

describe('PR and CI tracking', () => {
  it('associates the intended issue session and branch with a single PR', async () => {
    const result = await trackPullRequestChecks(statePath(), config(), clients(), request());

    expect(result.observation).toMatchObject({
      pullRequestNumber: 17,
      issueNumber: 8,
      sessionId: 'session-8',
      branch: 'ao/issue-8-pr-session-gate',
      headSha: 'head-1',
      status: 'successful'
    });
    expect(result.observation.reviewDecision).toBe('unknown');
  });

  it('rejects multiple PRs for the same branch as an explicit duplicate ambiguity', async () => {
    await expect(
      trackPullRequestChecks(statePath(), config(), clients({ pullRequests: [pr(), { ...pr(), number: 18, id: 'pr-18' }] }), request())
    ).rejects.toMatchObject({ code: 'EPR_DUPLICATE' });
  });

  it('rejects PRs from unrelated branches', async () => {
    await expect(
      trackPullRequestChecks(statePath(), config(), clients({ pullRequests: [{ ...pr(), branch: 'ao/other', head: { ...pr().head, branch: 'ao/other' } }] }), request())
    ).rejects.toMatchObject({ code: 'EBRANCH' });
  });

  it('rejects unrelated head repositories', async () => {
    await expect(
      trackPullRequestChecks(
        statePath(),
        config(),
        clients({ pullRequests: [{ ...pr(), head: { ...pr().head, repository: { owner: 'Other', name: 'repo', defaultBranch: 'main' } } }] }),
        request()
      )
    ).rejects.toMatchObject({ code: 'EREPOSITORY' });
  });

  it('rejects fork heads so restricted check visibility cannot masquerade as trusted success', async () => {
    await expect(
      trackPullRequestChecks(statePath(), config(), clients({ pullRequests: [{ ...pr(), head: { ...pr().head, fork: true } }] }), request())
    ).rejects.toMatchObject({ code: 'EREPOSITORY' });
  });

  it('rejects draft pull requests', async () => {
    await expect(trackPullRequestChecks(statePath(), config(), clients({ pullRequests: [{ ...pr(), draft: true }] }), request())).rejects.toMatchObject({
      code: 'EPR_DRAFT'
    });
  });

  it('rejects closed pull requests', async () => {
    await expect(
      trackPullRequestChecks(statePath(), config(), clients({ pullRequests: [{ ...pr(), state: 'closed', closed: true }] }), request())
    ).rejects.toMatchObject({ code: 'EPR_CLOSED' });
  });

  it('rejects PRs associated with a different issue', async () => {
    await expect(
      trackPullRequestChecks(statePath(), config(), clients({ pullRequests: [{ ...pr(), association: { issueNumber: 9, sessionId: 'session-8' } }] }), request())
    ).rejects.toMatchObject({ code: 'EISSUE' });
  });

  it('rejects PRs associated with a different session', async () => {
    await expect(
      trackPullRequestChecks(statePath(), config(), clients({ pullRequests: [{ ...pr(), association: { issueNumber: 8, sessionId: 'other' } }] }), request())
    ).rejects.toMatchObject({ code: 'ESESSION' });
  });

  it('rejects stale expected head checks before evaluating inherited success', async () => {
    await expect(trackPullRequestChecks(statePath(), config(), clients(), request({ expectedHeadSha: 'old-head' }))).rejects.toMatchObject({
      code: 'ESTALE_HEAD'
    });
  });

  it('tracks pending checks on the exact PR head', async () => {
    const result = await trackPullRequestChecks(statePath(), config(), clients({ checks: [check({ status: 'in_progress' })] }), request());

    expect(result.observation.status).toBe('pending');
    expect(result.observation.checks[0]).toMatchObject({ name: 'test', status: 'pending', headSha: 'head-1' });
  });

  it('tracks failed checks on the exact PR head', async () => {
    const result = await trackPullRequestChecks(
      statePath(),
      config(),
      clients({ checks: [check({ conclusion: 'failure' })] }),
      request()
    );

    expect(result.observation.status).toBe('failed');
    expect(result.observation.reviewDecision).toBe('changes-requested');
  });

  it('tracks successful required checks', async () => {
    const result = await trackPullRequestChecks(statePath(), config(), clients(), request());

    expect(result.observation.status).toBe('successful');
    expect(result.observation.checks).toContainEqual({
      name: 'test',
      required: true,
      status: 'successful',
      headSha: 'head-1',
      conclusion: 'success'
    });
    expect(result.observation.reviewDecision).toBe('unknown');
  });

  it('marks stale check runs from a previous head', async () => {
    const result = await trackPullRequestChecks(statePath(), config(), clients({ checks: [check({ headSha: 'old-head' })] }), request());

    expect(result.observation.status).toBe('stale');
    expect(result.observation.stale).toBe(true);
  });

  it('fails closed on skipped required checks without an explicit trusted conclusion policy', async () => {
    const result = await trackPullRequestChecks(
      statePath(),
      config(),
      clients({ checks: [check({ conclusion: 'skipped' })] }),
      request()
    );

    expect(result.observation.status).toBe('failed');
    expect(result.observation.checks[0].status).toBe('failed');
  });

  it('allows skipped required checks only through explicit trusted conclusion policy', async () => {
    const result = await trackPullRequestChecks(
      statePath(),
      config(),
      clients({
        checks: [check({ conclusion: 'skipped' })],
        requiredChecks: { complete: true, rules: [{ name: 'test', trusted: true, allowedConclusions: ['skipped'] }] }
      }),
      request()
    );

    expect(result.observation.status).toBe('successful');
    expect(result.observation.checks[0]).toMatchObject({ status: 'successful', allowedByPolicy: true });
  });

  it('tracks missing required checks', async () => {
    const result = await trackPullRequestChecks(statePath(), config(), clients({ checks: [] }), request());

    expect(result.observation.status).toBe('failed');
    expect(result.observation.checks[0]).toMatchObject({ name: 'test', status: 'missing', required: true });
  });

  it('fails closed when required check discovery is unavailable', async () => {
    const result = await trackPullRequestChecks(
      statePath(),
      config(),
      clients({ requiredChecks: undefined }),
      request()
    );

    expect(result.observation.status).toBe('unavailable');
    expect(result.observation.requiredChecksComplete).toBe(false);
  });

  it('fails closed on untrusted required rules', async () => {
    const result = await trackPullRequestChecks(
      statePath(),
      config(),
      clients({ requiredChecks: { complete: true, rules: [{ name: 'test', trusted: false }] } }),
      request()
    );

    expect(result.observation.status).toBe('unavailable');
    expect(result.observation.checks[0]).toMatchObject({ status: 'unavailable' });
  });

  it('persists rate-limit outages with redacted details', async () => {
    const result = await trackPullRequestChecks(
      statePath(),
      config(),
      clients({ rateLimited: true, checks: [check()] }),
      request()
    );

    const raw = await readFile(statePath(), 'utf8');
    const state = await readState(statePath());
    expect(state.pullRequestTracking[0]).toMatchObject({ status: 'unavailable', diagnosticCode: 'CHECK_RATE_LIMITED' });
    expect(raw).not.toContain('ghp_');
  });

  it('persists only bounded provider outage diagnostics without raw embedded secrets', async () => {
    const result = await trackPullRequestChecks(
      statePath(),
      config(),
      clients({
        checkError: new Error(
          'Bearer bearer-value Basic basic-value token=ghp_supersecret https://token-user:token-pass@example.test/path?access_token=abc'
        )
      }),
      request()
    );

    const raw = await readFile(statePath(), 'utf8');
    const cliSummary = JSON.stringify(result.observation, null, 2);
    const auditPath = path.join(tempDirectory, 'audit.jsonl');
    await appendAuditEvent(auditPath, {
      type: 'prTracking.completed',
      timestamp: '2026-01-01T00:00:00.000Z',
      data: result.observation
    });
    const auditRaw = await readFile(auditPath, 'utf8');
    const state = await readState(statePath());
    expect(state.pullRequestTracking[0]).toMatchObject({ status: 'unavailable', diagnosticCode: 'CHECK_PROVIDER_UNAVAILABLE' });
    for (const persisted of [raw, auditRaw, cliSummary]) {
      expect(persisted).not.toContain('bearer-value');
      expect(persisted).not.toContain('basic-value');
      expect(persisted).not.toContain('ghp_supersecret');
      expect(persisted).not.toContain('token-pass');
      expect(persisted).not.toContain('access_token=abc');
    }
  });

  it('bounds check pagination and persists an unavailable observation instead of spinning', async () => {
    const result = await trackPullRequestChecks(
      statePath(),
      config(),
      clients({ checkPages: [[check()], [check({ name: 'lint' })]] }),
      request({ maxPages: 1 })
    );

    expect(result.observation.status).toBe('unavailable');
    expect(result.observation.diagnosticCode).toBe('CHECK_PAGINATION_LIMIT');
  });

  it('bounds polling attempts for pending checks', async () => {
    let polls = 0;
    await trackPullRequestChecks(
      statePath(),
      config(),
      clients({
        getCheckPages() {
          polls += 1;
          return [[check({ status: 'queued' })]];
        }
      }),
      request({ maxPolls: 2 })
    );

    expect(polls).toBe(2);
  });

  it('persists observations and invalidates earlier success when the head changes across restarts', async () => {
    await writeStateAtomic(statePath(), stateWithAssignment());
    await trackPullRequestChecks(statePath(), config(), clients(), request());
    const next = await trackPullRequestChecks(
      statePath(),
      config(),
      clients({ pullRequests: [{ ...pr(), head: { ...pr().head, sha: 'head-2' } }], checks: [check({ headSha: 'head-2', status: 'queued' })] }),
      request()
    );

    const state = await readState(statePath());
    expect(state.pullRequestTracking.map((entry) => entry.headSha)).toEqual(['head-1', 'head-2']);
    expect(next.observation.status).toBe('pending');
  });

  it('preserves concurrent observations for distinct heads', async () => {
    await writeStateAtomic(statePath(), stateWithAssignment());

    await Promise.all([
      trackPullRequestChecks(statePath(), config(), clients(), request()),
      trackPullRequestChecks(
        statePath(),
        config(),
        clients({
          pullRequests: [{ ...pr(), head: { ...pr().head, sha: 'head-2' } }],
          checks: [check({ headSha: 'head-2' })]
        }),
        request()
      )
    ]);

    const state = await readState(statePath());
    expect(state.pullRequestTracking.map((entry) => entry.headSha).sort()).toEqual(['head-1', 'head-2']);
  });

  it('rejects missing durable assignment ownership even when branch identities match', async () => {
    await writeStateAtomic(statePath(), createInitialState(config()));

    await expect(trackPullRequestChecks(statePath(), config(), clients(), request())).rejects.toMatchObject({
      code: 'EASSIGNMENT'
    });
  });

  it('rejects conflicting durable assignment ownership', async () => {
    await writeStateAtomic(statePath(), {
      ...stateWithAssignment(),
      operations: [assignmentOperation({ sessionId: 'other-session' })]
    });

    await expect(trackPullRequestChecks(statePath(), config(), clients(), request())).rejects.toMatchObject({
      code: 'EASSIGNMENT'
    });
  });

  it('rejects ambiguous duplicate durable assignment ownership', async () => {
    await writeStateAtomic(statePath(), {
      ...stateWithAssignment(),
      operations: [assignmentOperation(), assignmentOperation()]
    });

    await expect(trackPullRequestChecks(statePath(), config(), clients(), request())).rejects.toMatchObject({
      code: 'EASSIGNMENT'
    });
  });

  it('rejects superseded heads when delayed observations complete after a newer generation', async () => {
    await trackPullRequestChecks(
      statePath(),
      config(),
      clients({
        pullRequests: [{ ...pr(), head: { ...pr().head, sha: 'head-2' } }],
        checks: [check({ headSha: 'head-2' })]
      }),
      request(),
      new Date('2026-01-01T00:00:02.000Z')
    );

    await expect(
      trackPullRequestChecks(statePath(), config(), clients(), request(), new Date('2026-01-01T00:00:01.000Z'))
    ).rejects.toMatchObject({ code: 'ESTALE_HEAD' });
  });

  it('keeps the newer same-SHA observation during reverse completion', async () => {
    const newer = await trackPullRequestChecks(
      statePath(),
      config(),
      clients({ checks: [check({ status: 'queued' })] }),
      request(),
      new Date('2026-01-01T00:00:02.000Z')
    );
    const slower = await trackPullRequestChecks(
      statePath(),
      config(),
      clients(),
      request(),
      new Date('2026-01-01T00:00:01.000Z')
    );

    expect(slower.observation).toEqual(newer.observation);
    expect((await readState(statePath())).pullRequestTracking).toHaveLength(1);
  });

  it('revalidates authoritative current head before persistence', async () => {
    await expect(
      trackPullRequestChecks(
        statePath(),
        config(),
        clients({ currentPullRequest: { ...pr(), head: { ...pr().head, sha: 'head-2' } } }),
        request()
      )
    ).rejects.toMatchObject({ code: 'ESTALE_HEAD' });
  });

  it('requires authoritative complete PR search pagination', async () => {
    await expect(trackPullRequestChecks(statePath(), config(), clients({ searchPages: [{ page: 1, hasNextPage: true, pullRequests: [pr()] }] }), request())).rejects.toMatchObject({
      code: 'EPAGE_TRUNCATED'
    });
  });

  it('rejects malformed PR search pagination', async () => {
    await expect(trackPullRequestChecks(statePath(), config(), clients({ searchPages: [{ page: 2, hasNextPage: false, pullRequests: [pr()] }] }), request())).rejects.toMatchObject({
      code: 'EPAGE_MALFORMED'
    });
  });

  it('rejects duplicate PRs discovered on later pages', async () => {
    await expect(
      trackPullRequestChecks(
        statePath(),
        config(),
        clients({
          searchPages: [
            { page: 1, hasNextPage: true, pullRequests: [pr()] },
            { page: 2, hasNextPage: false, pullRequests: [{ ...pr(), id: 'pr-18', number: 18 }] }
          ]
        }),
        request()
      )
    ).rejects.toMatchObject({ code: 'EPR_DUPLICATE' });
  });

  it('rejects PR search pagination beyond configured bounds', async () => {
    await expect(
      trackPullRequestChecks(
        statePath(),
        config(),
        clients({
          searchPages: [
            { page: 1, hasNextPage: true, pullRequests: [] },
            { page: 2, hasNextPage: false, pullRequests: [pr()] }
          ]
        }),
        request({ maxPages: 1 })
      )
    ).rejects.toMatchObject({ code: 'EPAGE_LIMIT' });
  });

  it('rejects untrusted GitHub adapters before PR tracking reads', async () => {
    await expect(trackPullRequestChecks(statePath(), config(), clients({ adapterName: 'shell' }), request())).rejects.toThrow(
      /Untrusted GitHub adapter/
    );
  });
});

function statePath(): string {
  return path.join(tempDirectory, 'state.json');
}

function request(override: Partial<Parameters<typeof trackPullRequestChecks>[3]> = {}) {
  return {
    issueNumber: 8,
    sessionId: 'session-8',
    branch: 'ao/issue-8-pr-session-gate',
    ...override
  };
}

function config(override: Partial<ControllerConfig> = {}): ControllerConfig {
  return {
    ...defaultConfig,
    identities: {
      issues: [{ id: 8, number: 8, title: 'PR and CI Tracking' }],
      sessions: [session()],
      pullRequests: [{ id: 'pr-17', number: 17, branch: 'ao/issue-8-pr-session-gate', issueNumber: 8 }]
    },
    ...override
  };
}

function stateWithAssignment() {
  return {
    ...createInitialState(config()),
    operations: [assignmentOperation()]
  };
}

function assignmentOperation(override: Partial<{ sessionId: string; branch: string; issueNumber: number }> = {}): OperationRecord {
  const sessionId = override.sessionId ?? 'session-8';
  const branch = override.branch ?? 'ao/issue-8-pr-session-gate';
  const issueNumber = override.issueNumber ?? 8;
  return {
    intent: {
      key: `ao-spawn-worker:issue:${issueNumber}:${sessionId}:${branch}`,
      action: 'ao-spawn-worker',
      targetType: 'issue',
      targetId: issueNumber,
      payload: {
        sessionId,
        branch,
        worktreePath: 'E:\\AI-Development\\ao-data\\data\\worktrees\\ai-delivery-lab\\ai-delivery-lab-7'
      }
    },
    status: 'succeeded',
    attempts: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    outcome: {
      provider: 'ao',
      externalId: sessionId
    }
  };
}

function session(): SessionIdentity {
  return {
    id: 'session-8',
    branch: 'ao/issue-8-pr-session-gate',
    worktreePath: 'E:\\AI-Development\\ao-data\\data\\worktrees\\ai-delivery-lab\\ai-delivery-lab-7',
    issueNumber: 8
  };
}

function pr(): PullRequestDetails {
  return {
    id: 'pr-17',
    number: 17,
    branch: 'ao/issue-8-pr-session-gate',
    state: 'open',
    baseBranch: 'main',
    draft: false,
    closed: false,
    head: {
      sha: 'head-1',
      branch: 'ao/issue-8-pr-session-gate',
      repository: defaultConfig.repository,
      fork: false
    },
    association: {
      issueNumber: 8,
      sessionId: 'session-8'
    }
  };
}

function check(override: Partial<PullRequestCheckRun> = {}): PullRequestCheckRun {
  return {
    name: 'test',
    status: 'completed',
    conclusion: 'success',
    headSha: 'head-1',
    ...override
  };
}

function clients(options: {
  adapterName?: string;
  pullRequests?: PullRequestDetails[];
  checks?: PullRequestCheckRun[];
  checkPages?: PullRequestCheckRun[][];
  getCheckPages?: () => PullRequestCheckRun[][];
  currentPullRequest?: PullRequestDetails;
  searchPages?: Array<{ page: number; hasNextPage: boolean; pullRequests: PullRequestDetails[] }>;
  requiredChecks?: RequiredCheckDiscovery;
  rateLimited?: boolean;
  checkError?: Error;
} = {}): ControllerClients {
  const fixture = createFixtureClients(config());
  const pullRequests = options.pullRequests ?? [pr()];
  return {
    ...fixture,
    github: {
      ...fixture.github,
      adapterName: options.adapterName ?? 'fixture-github-client',
      async *findPullRequestsForBranch() {
        for (const page of options.searchPages ?? [{ page: 1, hasNextPage: false, pullRequests }]) {
          yield {
            pageInfo: { page: page.page, hasNextPage: page.hasNextPage },
            pullRequests: page.pullRequests
          };
        }
      },
      async getPullRequestDetails() {
        return options.currentPullRequest ?? pullRequests[0];
      },
      async *listPullRequestChecks() {
        if (options.checkError) {
          throw options.checkError;
        }
        const pages = options.getCheckPages?.() ?? options.checkPages ?? [options.checks ?? [check()]];
        for (let index = 0; index < pages.length; index += 1) {
          yield {
            pageInfo: { page: index + 1, hasNextPage: index < pages.length - 1, rateLimited: options.rateLimited },
            checks: pages[index]
          };
        }
      },
      getRequiredChecks:
        options.requiredChecks === undefined && 'requiredChecks' in options
          ? undefined
          : async () => options.requiredChecks ?? { complete: true, rules: [{ name: 'test', trusted: true }] }
    }
  };
}
