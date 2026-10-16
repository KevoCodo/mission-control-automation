import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../config.js';
import { generateAuditReport, renderAuditReport } from '../report.js';
import { createInitialState } from '../state.js';
import type { ControllerState, NativeReviewObservation, OperationStatus } from '../types.js';

const at = '2026-01-01T00:00:00.000Z';
let directory: string;
beforeEach(async () => { directory = await mkdtemp(path.join(process.cwd(), '.issue12-evidence-test-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

function state(): ControllerState {
  return createInitialState(defaultConfig, new Date(at));
}
function event(type: string, extra: Record<string, unknown> = {}) {
  return { version: 2, eventId: type, type, timestamp: at, issueNumber: 4,
    data: { issueNumber: 4 }, ...extra };
}
async function report(events: unknown[], snapshot?: ControllerState) {
  const auditPath = path.join(directory, 'audit.jsonl');
  const statePath = path.join(directory, 'state.json');
  await writeFile(auditPath, events.map((item) => JSON.stringify(item)).join('\n') + (events.length ? '\n' : ''));
  if (snapshot) await writeFile(statePath, JSON.stringify(snapshot));
  return generateAuditReport(auditPath, statePath);
}
function addOperation(snapshot: ControllerState, status: OperationStatus) {
  snapshot.operations.push({ intent: { key: `assign-${status}`, action: 'ao-spawn-worker',
    targetType: 'issue', targetId: 4 }, status, attempts: 1, createdAt: at, updatedAt: at,
    ...(status === 'succeeded' ? { outcome: { provider: 'ao', externalId: 'session-4' } } : {}) });
}
function addReview(snapshot: ControllerState, overrides: Partial<NativeReviewObservation> = {}) {
  snapshot.pullRequestTracking.push({ pullRequestNumber: 14, issueNumber: 4, sessionId: 'session-4',
    branch: 'issue-4', headSha: 'abcdef123456', status: 'successful', reviewDecision: 'unknown',
    checks: [], requiredChecksComplete: true, stale: false, unavailable: false,
    generation: 1, dataSource: 'github', observedAt: at });
  snapshot.nativeReviewTracking.push({ pullRequestNumber: 14, issueNumber: 4, sessionId: 'session-4',
    branch: 'issue-4', headSha: 'abcdef123456', runStatus: 'completed', runVerdict: 'approved',
    nativeReviewDecision: 'approved', githubRequiredApproval: 'missing', capabilityVerified: true,
    triggerAuthorized: false, triggerAuthorization: { humanAuthorized: false, source: 'missing' },
    correctionAuthorization: { humanAuthorized: false, source: 'missing' }, stopState: { active: true },
    independentReviewer: true, findings: [], findingsComplete: true, threadsComplete: true,
    unresolvedThreadIds: [], duplicateThreadIds: [], stale: false, unavailable: false,
    correctionCycle: 0, correctionEscalated: false, observedAt: at, ...overrides });
}

describe('report action and approval evidence', () => {
  it('keeps assignment.spawned visible without a matching succeeded operation', async () => {
    const result = await report([event('assignment.spawned')], state());
    expect(result.history[0]?.action).toContain('Recorded action event: assignment.spawned');
    expect(result.history[0]?.action).not.toContain('No action evidence available');
    expect(result.history[0]?.verifiedOutcome).toBe('unavailable');
  });
  it('preserves recorded action evidence when the state snapshot is missing', async () => {
    const result = await report([event('assignment.spawned')]);
    expect(result.history[0]?.action).toContain('Recorded action event: assignment.spawned');
    expect(result.history[0]?.blockers).toContain('missing state');
  });
  it('keeps succeeded controller operations separate from provider verification', async () => {
    const snapshot = state();
    addOperation(snapshot, 'succeeded');
    const result = await report([], snapshot);
    expect(result.history[0]?.action).toContain('Controller operation succeeded: ao-spawn-worker');
    expect(result.history[0]?.verifiedOutcome).toBe('unavailable');
    expect(result.history[0]?.completion).toBe('unverified');
  });
  it.each(['pending', 'failed', 'uncertain'] as const)('retains %s controller operation status', async (status) => {
    const snapshot = state();
    addOperation(snapshot, status);
    const result = await report([], snapshot);
    expect(result.history[0]?.action).toContain(`Controller operation ${status}: ao-spawn-worker`);
    expect(result.history[0]?.action).not.toContain('Controller operation succeeded');
  });
  it('keeps correction authorization scoped to correction dispatch', async () => {
    const snapshot = state();
    addReview(snapshot, { correctionAuthorization: { humanAuthorized: true, source: 'verified-human' } });
    const permissions = (await report([], snapshot)).history[0]!.permissions;
    expect(permissions.correctionDispatch).toContain('stored controller observation: verified-human');
    expect(permissions.githubMerge).toBe('unavailable');
    expect(permissions.builderAssignment).toBe('unavailable');
    expect(permissions.prPublication).toBe('unavailable');
    expect(permissions.nativeAoReview).toBe('unavailable');
    expect(permissions.githubIssueClosure).toBe('unavailable');
  });
  it('does not turn an AO native verdict into GitHub approval', async () => {
    const snapshot = state();
    addReview(snapshot);
    const row = (await report([], snapshot)).history[0]!;
    expect(row.nativeReview).toContain('approved');
    expect(row.githubApproval).toContain('stored controller observation: missing');
    expect(row.blockers).toContain('GitHub-required approval missing');
  });
  it('labels stored GitHub approval as historical controller evidence', async () => {
    const snapshot = state();
    addReview(snapshot, { githubRequiredApproval: 'approved' });
    const row = (await report([], snapshot)).history[0]!;
    expect(row.githubApproval).toContain('stored controller observation: approved');
    expect(row.githubApproval).toContain('current GitHub verification unavailable');
    expect(row.verifiedOutcome).toBe('unavailable');
  });
  it('does not treat stale approval as current provider verification', async () => {
    const snapshot = state();
    addReview(snapshot, { githubRequiredApproval: 'approved', stale: true });
    const row = (await report([], snapshot)).history[0]!;
    expect(row.githubApproval).toContain('stale');
    expect(row.blockers).toContain('GitHub approval observation stale or unavailable');
    expect(row.verifiedOutcome).toBe('unavailable');
  });
  it('renders identical JSON and Markdown for identical inputs', async () => {
    const snapshot = state();
    addOperation(snapshot, 'uncertain');
    addReview(snapshot, { githubRequiredApproval: 'approved', unavailable: true });
    const events = [event('assignment.spawned', { category: 'action', authorization: 'caller-claimed' })];
    const first = await report(events, snapshot);
    const second = await report(events, snapshot);
    expect(renderAuditReport(first, 'json')).toBe(renderAuditReport(second, 'json'));
    expect(renderAuditReport(first, 'markdown')).toBe(renderAuditReport(second, 'markdown'));
  });
});
