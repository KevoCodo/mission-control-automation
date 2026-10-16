import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../config.js';
import { createInitialState } from '../state.js';
import { generateAuditReport, renderAuditReport } from '../report.js';

const at = '2026-01-01T00:00:00.000Z';
const base = { version: 2, eventId: 'event-1', type: 'observation', timestamp: at, issueNumber: 4,
  category: 'observation', data: { issueNumber: 4 }, provenance: { source: 'fixture', evidenceId: 'fixture-1' } };
let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(process.cwd(), '.issue12-golden-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function fixture(name: string) {
  const state = createInitialState(defaultConfig, new Date(at));
  const pr = { pullRequestNumber: 14, issueNumber: 4, sessionId: 'session-4', branch: 'issue-4',
    headSha: 'abcdef123456', status: 'successful' as const, reviewDecision: 'unknown' as const,
    checks: [], requiredChecksComplete: true, stale: false, unavailable: false,
    generation: 1, dataSource: 'github' as const, observedAt: at };
  const review = { pullRequestNumber: 14, issueNumber: 4, sessionId: 'session-4', branch: 'issue-4',
    headSha: 'abcdef123456', runStatus: 'completed' as const, runVerdict: 'approved' as const,
    nativeReviewDecision: 'approved' as const, githubRequiredApproval: 'approved' as const,
    capabilityVerified: true, triggerAuthorized: false,
    triggerAuthorization: { humanAuthorized: false, source: 'missing' as const },
    correctionAuthorization: { humanAuthorized: false, source: 'missing' as const },
    stopState: { active: true }, independentReviewer: true, findings: [], findingsComplete: true,
    threadsComplete: true, unresolvedThreadIds: [], duplicateThreadIds: [], stale: false,
    unavailable: false, correctionCycle: 0, correctionEscalated: false, observedAt: at };
  const events: unknown[] = [{ ...base }];
  if (name !== 'incomplete' && name !== 'injection') {
    state.identities.sessions.push({ id: 'session-4', issueNumber: 4, branch: 'issue-4', worktreePath: 'E:/work/issue-4' });
    state.pullRequestTracking.push(pr);
    state.nativeReviewTracking.push(review);
  }
  if (name === 'blocked') { state.nativeReviewControl.stopActive = true; state.pullRequestTracking[0]!.status = 'failed'; }
  if (name === 'completed') state.nativeReviewControl.stopActive = false;
  if (name === 'recovered') {
    events.push({ ...base, eventId: 'recovery-1', type: 'operation.recovered', category: 'recovery',
      retryOf: 'event-1', outcome: 'succeeded', data: { issueNumber: 4, recovery: 'provider reconciled', usage: { tokens: 42 } } });
  }
  if (name === 'duplicates') events.push({ ...base }, { ...base, eventId: 'event-2', type: 'observation.replayed' });
  if (name === 'incomplete') events.length = 0;
  if (name === 'stale') { state.pullRequestTracking[0]!.stale = true; state.nativeReviewTracking[0]!.headSha = 'old-head'; }
  if (name === 'uncertain') {
    events.push({ ...base, eventId: 'intent-1', category: 'intent', outcome: 'uncertain',
      authorization: 'caller-claimed', type: 'merge.intent', data: { issueNumber: 4 } });
    state.operations.push({ intent: { key: 'merge-14', action: 'merge-pr', targetType: 'pullRequest', targetId: 14 },
      status: 'uncertain', attempts: 1, createdAt: at, updatedAt: at });
  }
  if (name === 'injection') {
    state.identities.issues[0]!.title = '<script>alert(1)</script> | [click](javascript:alert(1))';
    events[0] = { ...base, type: 'x|y\n<script>alert(1)</script>',
      actor: { id: 'human', provenance: 'spoofed' }, authorization: 'verified',
      data: { token: 'ghp_CANARY12345', nested: [{ password: 'CANARY_PASSWORD' }],
        note: 'Bearer CANARY_BEARER\n<script>alert(1)</script> | [link](javascript:alert(1))',
        html: '<img src=x onerror=alert(1)>', control: 'a\u0000b' } };
  }
  return { state, events };
}

describe('engineering history golden reports', () => {
  for (const name of ['completed', 'blocked', 'recovered', 'duplicates', 'incomplete', 'stale', 'uncertain', 'injection']) {
    it(name, async () => {
      const { state, events } = fixture(name);
      const auditPath = path.join(dir, 'audit.jsonl');
      const statePath = path.join(dir, 'state.json');
      await writeFile(auditPath, events.map((event) => JSON.stringify(event)).join('\n') + (events.length ? '\n' : ''));
      if (name !== 'incomplete') await writeFile(statePath, JSON.stringify(state));
      const first = await generateAuditReport(auditPath, statePath);
      const second = await generateAuditReport(auditPath, statePath);
      const json = renderAuditReport(first, 'json');
      const markdown = renderAuditReport(first, 'markdown');
      expect(json).toBe(renderAuditReport(second, 'json'));
      expect(markdown).toBe(renderAuditReport(second, 'markdown'));
      expect({ json, markdown }).toMatchSnapshot();
      expect(first.history.every((row) => row.completion === 'unverified')).toBe(true);
      if (name === 'injection') {
        for (const canary of ['CANARY12345', 'CANARY_PASSWORD', 'CANARY_BEARER']) {
          expect(json).not.toContain(canary);
          expect(markdown).not.toContain(canary);
        }
        expect(markdown).not.toContain('<script>');
        expect(markdown).not.toContain('<img');
        expect(markdown).not.toContain('](javascript:');
        expect(markdown).not.toContain('\u0000');
        expect(first.events[0]!.authority).toBe('unverified');
      }
      expect(await readFile(auditPath, 'utf8')).toBe(events.map((event) => JSON.stringify(event)).join('\n') + (events.length ? '\n' : ''));
    });
  }
});
