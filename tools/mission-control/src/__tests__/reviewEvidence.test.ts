import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFixtureClients } from '../clients.js';
import { defaultConfig } from '../config.js';
import { collectNativeReviewEvidence } from '../reviewEvidence.js';
import { createInitialState, readState, writeStateAtomic } from '../state.js';
import type { ControllerClients } from '../clients.js';
import type {
  ControllerConfig,
  NativeReviewFinding,
  NativeReviewVerdict,
  NativeReviewThread,
  OperationRecord,
  PullRequestDetails,
  SessionIdentity
} from '../types.js';

let tempDirectory: string;

beforeEach(async () => {
  tempDirectory = await mkdtemp(path.join(process.cwd(), '.tmp-mission-control-review-'));
  await writeStateAtomic(statePath(), stateWithAssignment());
});

afterEach(async () => {
  await rm(tempDirectory, { recursive: true, force: true });
});

describe('native review evidence', () => {
  it('records capability verified native review evidence without authorizing a live trigger', async () => {
    const result = await collectNativeReviewEvidence(statePath(), config(), clients(), request());

    expect(result.observation).toMatchObject({
      pullRequestNumber: 19,
      issueNumber: 9,
      sessionId: 'session-9',
      headSha: 'head-9',
      capabilityVerified: true,
      triggerAuthorized: false,
      nativeReviewDecision: 'approved',
      githubRequiredApproval: 'unknown'
    });
  });

  it('records explicit human review-trigger authorization as evidence only', async () => {
    const result = await collectNativeReviewEvidence(statePath(), config(), clients(), request({ triggerAuthorized: true }));

    expect(result.observation.triggerAuthorized).toBe(false);
    expect(result.observation.triggerAuthorization).toEqual({ humanAuthorized: false, source: 'caller-flag' });
    expect(result.observation.runStatus).toBe('completed');
  });

  it('rejects untrusted AO adapters before reading native review status', async () => {
    await expect(collectNativeReviewEvidence(statePath(), config(), clients({ aoAdapterName: 'shell' }), request())).rejects.toThrow(
      /Untrusted AO adapter/
    );
  });

  it('rejects untrusted GitHub adapters before reading PR review findings', async () => {
    await expect(collectNativeReviewEvidence(statePath(), config(), clients({ githubAdapterName: 'shell' }), request())).rejects.toThrow(
      /Untrusted GitHub adapter/
    );
  });

  it('requires a verified durable assignment before review evidence collection', async () => {
    await writeStateAtomic(statePath(), createInitialState(config()));

    await expect(collectNativeReviewEvidence(statePath(), config(), clients(), request())).rejects.toMatchObject({ code: 'EASSIGNMENT' });
  });

  it('rejects duplicate durable assignments for the same issue session and branch', async () => {
    await writeStateAtomic(statePath(), {
      ...stateWithAssignment(),
      operations: [assignmentOperation(), assignmentOperation()]
    });

    await expect(collectNativeReviewEvidence(statePath(), config(), clients(), request())).rejects.toMatchObject({ code: 'EASSIGNMENT' });
  });

  it('rejects stale expected PR head SHA before collecting review evidence', async () => {
    await expect(
      collectNativeReviewEvidence(statePath(), config(), clients(), request({ expectedHeadSha: 'old-head' }))
    ).rejects.toMatchObject({ code: 'ESTALE_HEAD' });
  });

  it('marks AO review runs from an older head as stale immutable evidence', async () => {
    const result = await collectNativeReviewEvidence(
      statePath(),
      config(),
      clients({ runHeadSha: 'old-head' }),
      request()
    );

    expect(result.observation.stale).toBe(true);
    expect(result.observation.nativeReviewDecision).toBe('stale');
  });

  it('marks GitHub review findings from an older head as stale', async () => {
    const result = await collectNativeReviewEvidence(
      statePath(),
      config(),
      clients({ findings: [finding({ headSha: 'old-head' })] }),
      request()
    );

    expect(result.observation.stale).toBe(true);
    expect(result.observation.nativeReviewDecision).toBe('stale');
  });

  it('fails closed when AO native review status is unavailable', async () => {
    const result = await collectNativeReviewEvidence(statePath(), config(), clients({ runStatus: 'unavailable' }), request());

    expect(result.observation.unavailable).toBe(true);
    expect(result.observation.nativeReviewDecision).toBe('unavailable');
  });

  it('distinguishes verified empty review evidence from missing capabilities', async () => {
    const verified = await collectNativeReviewEvidence(statePath(), config(), clients(), request(), new Date('2026-01-01T00:00:01.000Z'));
    const missing = await collectNativeReviewEvidence(
      statePath(), config(), clients({ findingsRead: 'missing' }), request(), new Date('2026-01-01T00:00:02.000Z')
    );

    expect(verified.observation).toMatchObject({ findingsComplete: true, threadsComplete: true, nativeReviewDecision: 'approved' });
    expect(missing.observation).toMatchObject({ findingsComplete: false, unavailable: true, nativeReviewDecision: 'unavailable', diagnosticCode: 'REVIEW_FINDINGS_CAPABILITY_MISSING' });
  });

  it.each(['throw', 'incomplete', 'malformed'] as const)('fails closed when findings read is %s', async (mode) => {
    const result = await collectNativeReviewEvidence(statePath(), config(), clients({ findingsRead: mode }), request());
    expect(result.observation).toMatchObject({ findingsComplete: false, unavailable: true, nativeReviewDecision: 'unavailable' });
    expect(result.observation.diagnosticCode).toBe(mode === 'throw' ? 'REVIEW_FINDINGS_UNAVAILABLE' : 'REVIEW_FINDINGS_INCOMPLETE');
    expect(result.observation.correctionPlan).toBeUndefined();
    expect(JSON.stringify(result.observation)).not.toContain('ghp_secret');
  });

  it.each(['missing', 'throw', 'incomplete'] as const)('fails closed when threads read is %s', async (mode) => {
    const result = await collectNativeReviewEvidence(statePath(), config(), clients({ threadsRead: mode }), request());
    expect(result.observation).toMatchObject({ threadsComplete: false, unavailable: true, nativeReviewDecision: 'unavailable' });
    expect(JSON.stringify(result.observation)).not.toContain('ghp_secret');
  });

  it('respects an explicit changes-requested verdict even with no open findings', async () => {
    const result = await collectNativeReviewEvidence(statePath(), config(), clients({ runVerdict: 'changes-requested' }), request());
    expect(result.observation).toMatchObject({ runVerdict: 'changes-requested', nativeReviewDecision: 'changes-requested' });
  });

  it('keeps a negative verdict blocking when reviewer provenance is unverified', async () => {
    const result = await collectNativeReviewEvidence(
      statePath(), config(),
      clients({ runVerdict: 'changes-requested', reviewer: { id: 'unknown', type: 'unknown', independent: false } }),
      request()
    );
    expect(result.observation).toMatchObject({ independentReviewer: false, nativeReviewDecision: 'changes-requested' });
  });

  it('blocks completed runs with absent or unknown verdicts', async () => {
    const result = await collectNativeReviewEvidence(statePath(), config(), clients({ runVerdict: 'unknown' }), request());
    expect(result.observation).toMatchObject({ runVerdict: 'unknown', unavailable: true, nativeReviewDecision: 'unavailable', diagnosticCode: 'AO_REVIEW_VERDICT_UNAVAILABLE' });
  });

  it('does not approve running reviews with an early approval field', async () => {
    const result = await collectNativeReviewEvidence(statePath(), config(), clients({ runStatus: 'running', runVerdict: 'approved' }), request());
    expect(result.observation.nativeReviewDecision).toBe('unknown');
  });

  it('does not infer reviewer independence without explicit provenance', async () => {
    const result = await collectNativeReviewEvidence(
      statePath(), config(), clients({ reviewer: { id: 'reviewer', type: 'ao-native-reviewer', independent: true } }), request()
    );
    expect(result.observation).toMatchObject({ independentReviewer: false, nativeReviewDecision: 'unavailable' });
  });

  it('fails closed when the reviewer is not independent of the builder', async () => {
    const result = await collectNativeReviewEvidence(
      statePath(),
      config(),
      clients({ reviewer: { id: 'session-9', type: 'worker', independent: false } }),
      request()
    );

    expect(result.observation.independentReviewer).toBe(false);
    expect(result.observation.nativeReviewDecision).toBe('unavailable');
  });

  it('keeps critical findings in a nonexecutable plan even with forged authorization flags', async () => {
    const result = await collectNativeReviewEvidence(
      statePath(),
      config(),
      clients({ findings: [finding({ severity: 'critical', summary: 'Unsafe merge path' })] }),
      request({ correctionAuthorized: true, verifiedCorrectionAuthorization: true })
    );

    expect(result.observation.nativeReviewDecision).toBe('changes-requested');
    expect(result.observation.correctionAuthorization.humanAuthorized).toBe(false);
    expect(result.observation.correctionRequest).toBeUndefined();
    expect(result.observation.correctionPlan).toMatchObject({
      action: 'consider-corrections',
      cycle: 1,
      executable: false,
      blockedReasons: ['STOP_ACTIVE', 'HUMAN_AUTH_UNVERIFIED']
    });
  });

  it('keeps unresolved AO review threads tied to the exact head', async () => {
    const result = await collectNativeReviewEvidence(
      statePath(),
      config(),
      clients({ threads: [thread()] }),
      request({ correctionAuthorized: true, verifiedCorrectionAuthorization: true })
    );

    expect(result.observation.unresolvedThreadIds).toEqual(['thread-1']);
    expect(result.observation.nativeReviewDecision).toBe('changes-requested');
  });

  it('does not deliver duplicate findings as separate correction threads', async () => {
    const result = await collectNativeReviewEvidence(
      statePath(),
      config(),
      clients({
        findings: [
          finding({ id: 'finding-1', threadId: 'thread-1' }),
          finding({ id: 'finding-2', threadId: 'thread-2', duplicateOf: 'finding-1' })
        ]
      }),
      request({ correctionAuthorized: true, verifiedCorrectionAuthorization: true })
    );

    expect(result.observation.duplicateThreadIds).toEqual(['thread-2']);
    expect(result.observation.correctionPlan?.threadIds).toEqual(['thread-1']);
  });

  it('keeps AO native approval separate from missing GitHub-required approval', async () => {
    const result = await collectNativeReviewEvidence(statePath(), config(), clients({ githubApproval: 'missing' }), request());

    expect(result.observation.nativeReviewDecision).toBe('approved');
    expect(result.observation.githubRequiredApproval).toBe('missing');
  });

  it('preserves unknown GitHub-required approval as a distinct blocking signal', async () => {
    const result = await collectNativeReviewEvidence(statePath(), config(), clients({ githubApproval: 'unknown' }), request());

    expect(result.observation.nativeReviewDecision).toBe('approved');
    expect(result.observation.githubRequiredApproval).toBe('unknown');
  });

  it('does not create a correction request without per-cycle human authorization', async () => {
    const result = await collectNativeReviewEvidence(
      statePath(),
      config(),
      clients({ findings: [finding()] }),
      request({ correctionAuthorized: true })
    );

    expect(result.observation.nativeReviewDecision).toBe('changes-requested');
    expect(result.observation.correctionAuthorization).toEqual({ humanAuthorized: false, source: 'caller-flag' });
    expect(result.observation.correctionRequest).toBeUndefined();
    expect(result.observation.correctionCycle).toBe(0);
  });

  it('treats missing durable control as STOP and never consumes budget from repeated forged flags', async () => {
    const state = await readState(statePath());
    const legacy = { ...state } as Record<string, unknown>;
    delete legacy.nativeReviewControl;
    await writeStateAtomic(statePath(), legacy as unknown as typeof state);
    for (const second of [1, 2]) {
      const result = await collectNativeReviewEvidence(
        statePath(), config(), clients({ findings: [finding()] }),
        request({ correctionAuthorized: true, verifiedCorrectionAuthorization: true, stopActive: false }),
        new Date(`2026-01-01T00:00:0${second}.000Z`)
      );
      expect(result.observation).toMatchObject({ correctionCycle: 0, stopState: { active: true }, correctionAuthorization: { humanAuthorized: false } });
      expect(result.observation.correctionRequest).toBeUndefined();
    }
  });

  it('does not treat a caller STOP override or forged verified flag as authority when durable STOP is false', async () => {
    const state = await readState(statePath());
    await writeStateAtomic(statePath(), { ...state, nativeReviewControl: { stopActive: false, reason: 'legacy local state' } });
    const result = await collectNativeReviewEvidence(
      statePath(), config(), clients({ findings: [finding()] }),
      request({ stopActive: false, verifiedCorrectionAuthorization: true })
    );
    expect(result.observation).toMatchObject({ correctionCycle: 0, stopState: { active: false }, correctionAuthorization: { humanAuthorized: false } });
    expect(result.observation.correctionRequest).toBeUndefined();
    expect(result.observation.correctionPlan?.blockedReasons).toEqual(['HUMAN_AUTH_UNVERIFIED']);
  });

  it('preserves legacy two-cycle history and blocks a third cycle across restart', async () => {
    const first = await collectNativeReviewEvidence(
      statePath(),
      config(),
      clients({ findings: [finding()] }),
      request({ correctionAuthorized: true, verifiedCorrectionAuthorization: true, maxCorrectionCycles: 2 }),
      new Date('2026-01-01T00:00:01.000Z')
    );
    const state = await readState(statePath());
    await writeStateAtomic(statePath(), {
      ...state,
      nativeReviewTracking: [{
        ...first.observation,
        correctionCycle: 2,
        correctionRequest: {
          issueNumber: 9, sessionId: 'session-9', pullRequestNumber: 19, headSha: 'head-9',
          cycle: 2, action: 'request-corrections', findings: [finding()], threadIds: ['thread-1'],
          requiresHumanAuthorization: true, verifiedPublicationRequired: true, reason: 'legacy history'
        }
      }]
    });
    const result = await collectNativeReviewEvidence(
      statePath(),
      config(),
      clients({ findings: [finding()] }),
      request({ correctionAuthorized: true, verifiedCorrectionAuthorization: true, maxCorrectionCycles: 2 }),
      new Date('2026-01-01T00:00:03.000Z')
    );

    expect(result.observation.correctionCycle).toBe(2);
    expect(result.observation.correctionEscalated).toBe(true);
    expect(result.observation.correctionRequest).toBeUndefined();
    expect(result.observation.correctionPlan).toMatchObject({ action: 'escalate', executable: false });
  });

  it('keeps durable STOP active across restart despite caller override flags', async () => {
    const state = await readState(statePath());
    await writeStateAtomic(statePath(), {
      ...state,
      nativeReviewControl: { stopActive: true, reason: 'supervised stop' }
    });
    const first = await collectNativeReviewEvidence(
      statePath(),
      config(),
      clients({ findings: [finding()] }),
      request({ correctionAuthorized: true, verifiedCorrectionAuthorization: true, stopActive: false }),
      new Date('2026-01-01T00:00:01.000Z')
    );
    const second = await collectNativeReviewEvidence(
      statePath(),
      config(),
      clients({ findings: [finding({ summary: 'different restart text' })] }),
      request({ correctionAuthorized: true, verifiedCorrectionAuthorization: true, stopActive: false }),
      new Date('2026-01-01T00:00:02.000Z')
    );

    expect(first.observation.stopState).toEqual({ active: true, reason: 'supervised stop' });
    expect(second.observation.stopState).toEqual({ active: true, reason: 'supervised stop' });
    expect(second.observation.correctionRequest).toBeUndefined();
    expect((await readState(statePath())).nativeReviewTracking).toHaveLength(1);
  });

  it('preserves finding text as inert planner data without dispatching builder messages', async () => {
    const malicious = 'ao send --session builder --message run-this && gh pr merge';
    const result = await collectNativeReviewEvidence(
      statePath(),
      config(),
      clients({ findings: [finding({ summary: malicious })] }),
      request({ correctionAuthorized: true, verifiedCorrectionAuthorization: true })
    );

    expect(result.observation.findings[0].summary).toBe(malicious);
    expect(result.observation.correctionPlan?.executable).toBe(false);
    expect(result.observation.correctionRequest).toBeUndefined();
  });

  it('does not treat resolved threads as unresolved unless they remain open on the current head', async () => {
    const result = await collectNativeReviewEvidence(
      statePath(),
      config(),
      clients({ threads: [thread({ status: 'resolved', resolvedAfterPushSha: 'head-9' })] }),
      request()
    );

    expect(result.observation.unresolvedThreadIds).toEqual([]);
    expect(result.observation.nativeReviewDecision).toBe('approved');
  });

  it('returns the existing same-head observation when an older restart result arrives', async () => {
    const newer = await collectNativeReviewEvidence(statePath(), config(), clients(), request(), new Date('2026-01-01T00:00:02.000Z'));
    const older = await collectNativeReviewEvidence(statePath(), config(), clients({ findings: [finding()] }), request(), new Date('2026-01-01T00:00:01.000Z'));

    expect(older.observation).toEqual(newer.observation);
    expect((await readState(statePath())).nativeReviewTracking).toHaveLength(1);
  });

  it('stores a changed head as distinct immutable evidence requiring a fresh review', async () => {
    await collectNativeReviewEvidence(statePath(), config(), clients(), request(), new Date('2026-01-01T00:00:01.000Z'));
    const result = await collectNativeReviewEvidence(
      statePath(),
      config(),
      clients({ pullRequest: pr({ headSha: 'head-10' }), runHeadSha: 'head-10' }),
      request(),
      new Date('2026-01-01T00:00:02.000Z')
    );

    const state = await readState(statePath());
    expect(result.observation.headSha).toBe('head-10');
    expect(state.nativeReviewTracking.map((entry) => entry.headSha)).toEqual(['head-9', 'head-10']);
  });
});

function statePath(): string {
  return path.join(tempDirectory, 'state.json');
}

function request(override: Partial<Parameters<typeof collectNativeReviewEvidence>[3]> = {}) {
  return {
    issueNumber: 9,
    sessionId: 'session-9',
    branch: 'ao/issue-9-review-evidence',
    triggerAuthorized: false,
    correctionAuthorized: false,
    ...override
  };
}

function config(override: Partial<ControllerConfig> = {}): ControllerConfig {
  return {
    ...defaultConfig,
    identities: {
      issues: [{ id: 9, number: 9, title: 'Native Review Workflow Integration' }],
      sessions: [session()],
      pullRequests: [{ id: 'pr-19', number: 19, branch: 'ao/issue-9-review-evidence', issueNumber: 9 }]
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
  const sessionId = override.sessionId ?? 'session-9';
  const branch = override.branch ?? 'ao/issue-9-review-evidence';
  const issueNumber = override.issueNumber ?? 9;
  return {
    intent: {
      key: `ao-spawn-worker:issue:${issueNumber}:${sessionId}:${branch}`,
      action: 'ao-spawn-worker',
      targetType: 'issue',
      targetId: issueNumber,
      payload: {
        sessionId,
        branch,
        worktreePath: 'E:\\AI-Development\\ao-data\\data\\worktrees\\ai-delivery-lab\\ai-delivery-lab-8'
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
    id: 'session-9',
    branch: 'ao/issue-9-review-evidence',
    worktreePath: 'E:\\AI-Development\\ao-data\\data\\worktrees\\ai-delivery-lab\\ai-delivery-lab-8',
    issueNumber: 9
  };
}

function pr(override: Partial<{ headSha: string }> = {}): PullRequestDetails {
  return {
    id: 'pr-19',
    number: 19,
    branch: 'ao/issue-9-review-evidence',
    state: 'open',
    baseBranch: 'main',
    draft: false,
    closed: false,
    head: {
      sha: override.headSha ?? 'head-9',
      branch: 'ao/issue-9-review-evidence',
      repository: defaultConfig.repository,
      fork: false
    },
    association: {
      issueNumber: 9,
      sessionId: 'session-9'
    }
  };
}

function finding(override: Partial<NativeReviewFinding> = {}): NativeReviewFinding {
  return {
    id: 'finding-1',
    threadId: 'thread-1',
    headSha: 'head-9',
    severity: 'major',
    status: 'open',
    summary: 'Fix required',
    ...override
  };
}

function thread(override: Partial<NativeReviewThread> = {}): NativeReviewThread {
  return {
    id: 'thread-1',
    headSha: 'head-9',
    status: 'open',
    findingIds: ['finding-1'],
    ...override
  };
}

function clients(options: {
  githubAdapterName?: string;
  aoAdapterName?: string;
  pullRequest?: PullRequestDetails;
  runHeadSha?: string;
  runStatus?: 'not-started' | 'running' | 'completed' | 'failed' | 'unavailable';
  reviewer?: { id: string; type: 'ao-native-reviewer' | 'worker' | 'human' | 'unknown'; independent: boolean };
  findings?: NativeReviewFinding[];
  threads?: NativeReviewThread[];
  findingsRead?: 'missing' | 'throw' | 'incomplete' | 'malformed';
  threadsRead?: 'missing' | 'throw' | 'incomplete';
  runVerdict?: NativeReviewVerdict;
  githubApproval?: 'approved' | 'missing' | 'changes-requested' | 'unknown' | 'unavailable';
} = {}): ControllerClients {
  const fixture = createFixtureClients(config());
  const pullRequest = options.pullRequest ?? pr();
  return {
    ...fixture,
    github: {
      ...fixture.github,
      adapterName: options.githubAdapterName ?? 'fixture-github-client',
      async *findPullRequestsForBranch() {
        yield { pageInfo: { page: 1, hasNextPage: false }, pullRequests: [pullRequest] };
      },
      async getPullRequestDetails() {
        return pullRequest;
      },
      listPullRequestReviewFindings: options.findingsRead === 'missing' ? undefined : async () => {
        if (options.findingsRead === 'throw') throw new Error('Bearer ghp_secret');
        if (options.findingsRead === 'malformed') {
          return { findings: [{ ...finding(), severity: 'unsupported' as NativeReviewFinding['severity'] }], complete: true };
        }
        return { findings: options.findings ?? [], complete: options.findingsRead !== 'incomplete' };
      },
      async getRequiredReviewApproval() {
        return options.githubApproval ?? 'unknown';
      }
    },
    ao: {
      ...fixture.ao,
      adapterName: options.aoAdapterName ?? 'fixture-ao-client',
      async getNativeReviewCapability() {
        return {
          supported: true,
          statusSupported: true,
          triggerSupported: true,
          triggerRequiresHumanAuthorization: true,
          reviewerIndependenceRequired: true
        };
      },
      async getNativeReviewRun() {
        return {
          runId: 'review-19',
          pullRequestNumber: 19,
          headSha: options.runHeadSha ?? pullRequest.head.sha,
          status: options.runStatus ?? 'completed',
          verdict: options.runVerdict ?? 'approved',
          reviewer: options.reviewer ?? {
            id: 'ao-reviewer',
            type: 'ao-native-reviewer',
            independent: true,
            provenance: 'fixture'
          }
        };
      },
      listNativeReviewThreads: options.threadsRead === 'missing' ? undefined : async () => {
        if (options.threadsRead === 'throw') throw new Error('Bearer ghp_secret');
        return { threads: options.threads ?? [], complete: options.threadsRead !== 'incomplete' };
      }
    }
  };
}
