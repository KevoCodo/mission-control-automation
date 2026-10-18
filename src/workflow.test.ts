import { describe, expect, it } from 'vitest';
import { demoIssues } from './data/demoIssues';
import { approvePlan, cancelHandoff, createPlan, editPlan, isApproved, newDraft, prepareHandoff,
  recordCopy, requestChanges, restoreDraft, selectIssue } from './workflow';
import * as workflowApi from './workflow';

const issue = demoIssues[0];
const awaiting = () => ({ ...newDraft(issue), status: 'awaiting-approval' as const });

describe('manual MVP workflow', () => {
  it('selects one valid local issue and rejects missing, contradictory and historical identities', () => {
    expect(selectIssue(101, issue.repository)).toEqual(issue);
    expect(() => selectIssue(0, issue.repository)).toThrow();
    expect(() => selectIssue(101, 'other/repo')).toThrow();
    expect(() => selectIssue(12, issue.repository)).toThrow();
    expect(() => selectIssue(13, issue.repository)).toThrow();
    expect(() => selectIssue(23, issue.repository)).toThrow();
    expect(() => selectIssue(101, issue.repository, [issue, { ...issue, title: 'contradiction' }])).toThrow();
  });

  it('fails closed when dependency evidence is absent or completion is unverified', () => {
    expect(() => selectIssue(101, issue.repository, [{ ...issue, dependencyEvidence: undefined as never }])).toThrow();
    expect(() => selectIssue(101, issue.repository, [{ ...issue, dependencies: [999] }])).toThrow();
    expect(() => approvePlan({ ...newDraft(demoIssues[1]), status: 'awaiting-approval' })).toThrow(/dependency/i);
  });

  it('creates a bounded labeled template plan', () => {
    const plan = createPlan(issue);
    expect(plan.scope).toContain(issue.description);
    expect(plan.tests).toContain('build');
    expect(plan.assumptions).toContain('fictional local fixture');
  });

  it('binds approval to exact plan, issue, repository and version', () => {
    const approved = approvePlan(awaiting());
    expect(isApproved(approved)).toBe(true);
    expect(isApproved(editPlan(approved, { ...approved.plan, scope: 'Changed' }))).toBe(false);
    expect(isApproved({ ...approved, plan: { ...approved.plan, scope: 'Changed' } })).toBe(false);
    expect(isApproved({ ...approved, issueNumber: 102 })).toBe(false);
    expect(isApproved({ ...approved, repository: 'other/repo' })).toBe(false);
    expect(isApproved(requestChanges(approved))).toBe(false);
  });

  it('generates only approved handoffs and blocks cancelled reuse', () => {
    expect(() => prepareHandoff(awaiting())).toThrow();
    const approved = approvePlan(awaiting());
    const result = prepareHandoff(approved);
    expect(result.text).toContain(approved.plan.scope);
    expect(result.text).toContain('Worktree and baseline: UNKNOWN');
    expect(result.text).toContain('create one local commit');
    expect(result.text).toContain('Stop after that commit');
    expect(result.text).toContain('no AO access or dispatch');
    expect(result.text).not.toContain('918cd8eafa3fbce81ef2ac2f80f71d859ec5b696');
    expect(() => prepareHandoff(cancelHandoff(result.draft))).toThrow();
  });

  it('copying changes only local workflow status, never execution or permission', () => {
    const prepared = prepareHandoff(approvePlan(awaiting())).draft;
    const copied = recordCopy(prepared);
    expect(copied.status).toBe('awaiting-manual-execution');
    expect('running' in copied).toBe(false);
    expect('productionAuthorized' in copied).toBe(false);
    expect('executable' in copied).toBe(false);
    expect(Object.keys(workflowApi).some((name) => /launch|spawn|dispatch|execute|grant/i.test(name))).toBe(false);
  });

  it('keeps demonstration evidence separate from verified provider facts', () => {
    expect(demoIssues.every((item) => item.dependencyEvidence === 'local-demo-fixture')).toBe(true);
    const handoff = prepareHandoff(approvePlan(awaiting())).text;
    expect(handoff).toContain('local demonstration data; no provider facts verified');
    expect(handoff).toContain('Issue status: Open demo issue (local demo fixture only)');
    expect(handoff).toContain('Git HEAD');
  });

  it('rejects invalid restored state and removes approval from valid browser drafts', () => {
    const approved = approvePlan(awaiting());
    expect(restoreDraft({ ...approved, approval: { ...approved.approval, exactPlan: 'forged' } })).toBeNull();
    expect(restoreDraft({ ...approved, extra: 'grant' })).toBeNull();
    expect(restoreDraft({ ...approved, status: 'running' })).toBeNull();
    expect(restoreDraft({ ...approved, issueNumber: 13 })).toBeNull();
    const restored = restoreDraft(JSON.parse(JSON.stringify(approved)) as unknown);
    expect(restored?.status).toBe('awaiting-approval');
    expect(restored?.approval).toBeUndefined();
  });
});
