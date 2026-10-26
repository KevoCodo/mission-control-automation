import { describe, expect, it } from 'vitest';
import { fixtureRoleResult, SimulatedSdlcCoordinator, type FixtureScriptStep,
  type HumanPlanApprovalFixture, type SyntheticIssueInput } from '../simulatedSdlcOrchestration.js';

function issue(): SyntheticIssueInput {
  return { version: 1, synthetic: true, issueId: 'fixture-issue-42', issueNumber: 42,
    repository: { owner: 'fixture', name: 'sdlc-lab' }, generation: 1, stopEpoch: 0,
    dependencies: { status: 'SATISFIED', evidenceRef: 'fixture-dependencies-1' },
    plan: { steps: ['Make a synthetic change', 'Check it with fixture evidence'] } };
}
const step = (role: FixtureScriptStep['role'], outcome: FixtureScriptStep['outcome'], resultId: string): FixtureScriptStep =>
  ({ role, outcome, resultId });
const lead = step('ORCHESTRATOR', 'PASS', 'lead-1');
const builder = step('BUILDER', 'PASS', 'builder-1');
const tester = step('TESTER', 'PASS', 'tester-1');
const reviewer = step('REVIEWER', 'PASS', 'reviewer-1');

function awaiting(): SimulatedSdlcCoordinator {
  const coordinator = new SimulatedSdlcCoordinator(issue());
  expect(coordinator.runFixtureScript([lead]).stage).toBe('AWAITING_PLAN_APPROVAL');
  return coordinator;
}
function approval(coordinator: SimulatedSdlcCoordinator): HumanPlanApprovalFixture {
  const s = coordinator.snapshot();
  return { kind: 'HUMAN_APPROVAL_FIXTURE', approvalId: 'fixture-human-click-1', issueId: s.issueId,
    issueNumber: s.issueNumber, repository: s.repository, planDigest: s.planDigest,
    generation: s.generation, stopEpoch: s.stopEpoch };
}
function approved(): SimulatedSdlcCoordinator {
  const coordinator = awaiting();
  expect(coordinator.approvePlan(approval(coordinator)).stage).toBe('BUILDER_RUNNING_SIMULATED');
  return coordinator;
}

describe('fixture-only SDLC coordinator', () => {
  it('advances one approved synthetic issue to human PR preparation without execution authority', () => {
    const coordinator = approved();
    const result = coordinator.runFixtureScript([builder, tester, reviewer]);
    expect(result).toMatchObject({ stage: 'PR_READY_AWAITING_HUMAN', generation: 1, corrections: 0,
      productionAuthorized: false, executable: false });
    expect(result.history.map(row => row.stage)).toEqual([
      'ISSUE_VALIDATED', 'PLAN_READY', 'AWAITING_PLAN_APPROVAL', 'BUILDER_RUNNING_SIMULATED',
      'TESTER_RUNNING_SIMULATED', 'REVIEWER_RUNNING_SIMULATED', 'PR_READY_AWAITING_HUMAN']);
    expect(coordinator.prepareSyntheticPr()).toMatchObject({ fixtureOnly: true, actualPrExists: false,
      issueId: 'fixture-issue-42' });
  });
  it('requires an explicit plan approval fixture before Builder simulation', () => {
    const coordinator = awaiting();
    expect(coordinator.advance().stage).toBe('AWAITING_PLAN_APPROVAL');
    expect(coordinator.runFixtureScript([builder]).stage).toBe('AWAITING_PLAN_APPROVAL');
    expect(coordinator.prepareSyntheticPr()).toBeNull();
  });
  it('scopes result replay detection to one in-memory coordinator instance', () => {
    const first = awaiting();
    const second = awaiting();
    const sameApprovalFixture = approval(first);
    expect(first.approvePlan(sameApprovalFixture).stage).toBe('BUILDER_RUNNING_SIMULATED');
    expect(second.approvePlan(sameApprovalFixture).stage).toBe('BUILDER_RUNNING_SIMULATED');
    const sameResults = [builder, tester, reviewer];
    expect(first.runFixtureScript(sameResults).stage).toBe('PR_READY_AWAITING_HUMAN');
    expect(second.runFixtureScript(sameResults).stage).toBe('PR_READY_AWAITING_HUMAN');
    expect(first.snapshot().history).toEqual(second.snapshot().history);
  });
  it.each([
    ['plan digest', (a: HumanPlanApprovalFixture) => { a.planDigest = '0'.repeat(64); }],
    ['issue', (a: HumanPlanApprovalFixture) => { a.issueId = 'fixture-other'; }],
    ['repository', (a: HumanPlanApprovalFixture) => { a.repository = { owner: 'other', name: 'repo' }; }],
    ['generation', (a: HumanPlanApprovalFixture) => { a.generation++; }],
    ['STOP epoch', (a: HumanPlanApprovalFixture) => { a.stopEpoch++; }],
  ] as const)('blocks approval with stale %s', (_name, mutate) => {
    const coordinator = awaiting();
    const candidate = approval(coordinator);
    mutate(candidate);
    expect(coordinator.approvePlan(candidate)).toMatchObject({ stage: 'BLOCKED', executable: false });
  });
  it('blocks a dependency conflict or missing dependency evidence', () => {
    const blocked = issue(); blocked.dependencies.status = 'BLOCKED';
    expect(new SimulatedSdlcCoordinator(blocked).snapshot().history.at(-1)?.blockerReason).toBe('DEPENDENCY_BLOCKED');
    const unknown = issue(); unknown.dependencies.evidenceRef = null;
    expect(new SimulatedSdlcCoordinator(unknown).snapshot()).toMatchObject({ stage: 'BLOCKED' });
  });
  it('STOPs before and between transitions and cannot be resumed by fixture results', () => {
    const before = new SimulatedSdlcCoordinator(issue());
    before.stop();
    expect(before.runFixtureScript([lead]).stage).toBe('STOPPED');
    const between = approved();
    between.advance(fixtureRoleResult(between.snapshot(), builder));
    const pendingTester = fixtureRoleResult(between.snapshot(), tester);
    const stopped = between.stop();
    expect(stopped.stage).toBe('STOPPED');
    expect(stopped.stopEpoch).toBe(1);
    expect(between.advance(pendingTester)).toEqual(stopped);
  });
  it('keeps STOP terminal when the epoch is already the largest safe integer', () => {
    const candidate = issue(); candidate.stopEpoch = Number.MAX_SAFE_INTEGER;
    const coordinator = new SimulatedSdlcCoordinator(candidate);
    const stopped = coordinator.stop();
    expect(stopped).toMatchObject({ stage: 'STOPPED', stopEpoch: Number.MAX_SAFE_INTEGER,
      productionAuthorized: false, executable: false });
    expect(stopped.history.at(-1)?.blockerReason).toBe('STOP_EPOCH_EXHAUSTED');
    expect(coordinator.advance().stage).toBe('STOPPED');
    expect(coordinator.runFixtureScript([lead]).stage).toBe('STOPPED');
  });
  it('blocks correction when generation cannot advance safely', () => {
    const candidate = issue(); candidate.generation = Number.MAX_SAFE_INTEGER;
    const coordinator = new SimulatedSdlcCoordinator(candidate);
    coordinator.runFixtureScript([lead]);
    coordinator.approvePlan(approval(coordinator));
    coordinator.advance(fixtureRoleResult(coordinator.snapshot(), builder));
    expect(coordinator.advance(fixtureRoleResult(coordinator.snapshot(),
      step('TESTER', 'FAIL', 'tester-at-max'))).stage).toBe('CORRECTION_REQUIRED');
    const blocked = coordinator.advance();
    expect(blocked).toMatchObject({ stage: 'BLOCKED', generation: Number.MAX_SAFE_INTEGER,
      corrections: 0, productionAuthorized: false, executable: false });
    expect(blocked.history.at(-1)?.blockerReason).toBe('GENERATION_EXHAUSTED');
    expect(coordinator.advance().stage).toBe('BLOCKED');
  });
  it('blocks stale stage, generation and plan identity in role results', () => {
    const staleStage = approved();
    const oldBuilder = fixtureRoleResult(staleStage.snapshot(), builder);
    staleStage.advance(oldBuilder);
    oldBuilder.resultId = 'old-builder-new-id';
    expect(staleStage.advance(oldBuilder)).toMatchObject({ stage: 'BLOCKED', executable: false });
    expect(staleStage.snapshot().history.at(-1)?.blockerReason).toBe('STALE_RESULT_BINDING');
    const staleGeneration = approved();
    const result = fixtureRoleResult(staleGeneration.snapshot(), builder);
    result.generation++;
    expect(staleGeneration.advance(result).history.at(-1)?.blockerReason).toBe('STALE_RESULT_BINDING');
    const stalePlan = approved();
    const planResult = fixtureRoleResult(stalePlan.snapshot(), builder);
    planResult.planDigest = 'f'.repeat(64);
    expect(stalePlan.advance(planResult).stage).toBe('BLOCKED');
  });
  it.each([
    ['issue', (r: ReturnType<typeof fixtureRoleResult>) => { r.issueId = 'fixture-other'; }],
    ['repository', (r: ReturnType<typeof fixtureRoleResult>) => { r.repository = { owner: 'other', name: 'repo' }; }],
    ['STOP epoch', (r: ReturnType<typeof fixtureRoleResult>) => { r.stopEpoch++; }],
  ] as const)('blocks stale %s in role evidence', (_name, mutate) => {
    const coordinator = approved();
    const result = fixtureRoleResult(coordinator.snapshot(), builder);
    mutate(result);
    expect(coordinator.advance(result).history.at(-1)?.blockerReason).toBe('STALE_RESULT_BINDING');
  });
  it('corrects a Tester failure with a new simulated generation and fresh checks', () => {
    const coordinator = approved();
    const state = coordinator.runFixtureScript([builder, step('TESTER', 'FAIL', 'tester-fail-1'),
      step('BUILDER', 'PASS', 'builder-correction-1'), step('TESTER', 'PASS', 'tester-2'),
      step('REVIEWER', 'PASS', 'reviewer-2')]);
    expect(state).toMatchObject({ stage: 'PR_READY_AWAITING_HUMAN', corrections: 1, generation: 2 });
    expect(state.history.map(row => row.stage)).toContain('CORRECTION_REQUIRED');
  });
  it('corrects a Reviewer failure and invalidates old Tester and Reviewer evidence', () => {
    const coordinator = approved();
    coordinator.advance(fixtureRoleResult(coordinator.snapshot(), builder));
    coordinator.advance(fixtureRoleResult(coordinator.snapshot(), tester));
    const firstCommit = coordinator.snapshot().commitSha;
    expect(coordinator.snapshot().testerEvidence).toBe('tester-1');
    coordinator.advance(fixtureRoleResult(coordinator.snapshot(), step('REVIEWER', 'FAIL', 'reviewer-fail')));
    expect(coordinator.snapshot().stage).toBe('CORRECTION_REQUIRED');
    const corrected = coordinator.advance();
    expect(corrected).toMatchObject({ generation: 2, corrections: 1, commitSha: null,
      testerEvidence: null, reviewerEvidence: null });
    coordinator.advance(fixtureRoleResult(coordinator.snapshot(), step('BUILDER', 'PASS', 'builder-2')));
    expect(coordinator.snapshot().commitSha).not.toBe(firstCommit);
    expect(coordinator.runFixtureScript([step('TESTER', 'PASS', 'tester-2'),
      step('REVIEWER', 'PASS', 'reviewer-2')]).stage).toBe('PR_READY_AWAITING_HUMAN');
  });
  it('blocks the third failure after two correction cycles', () => {
    const coordinator = approved();
    const result = coordinator.runFixtureScript([builder, step('TESTER', 'FAIL', 'test-fail-1'),
      step('BUILDER', 'PASS', 'builder-2'), step('TESTER', 'FAIL', 'test-fail-2'),
      step('BUILDER', 'PASS', 'builder-3'), step('TESTER', 'FAIL', 'test-fail-3')]);
    expect(result).toMatchObject({ stage: 'BLOCKED', corrections: 2 });
    expect(result.history.at(-1)?.blockerReason).toBe('CORRECTION_BUDGET_EXCEEDED');
  });
  it('rejects a correction Builder result that repeats the earlier commit', () => {
    const coordinator = approved();
    coordinator.advance(fixtureRoleResult(coordinator.snapshot(), builder));
    const original = coordinator.snapshot().commitSha;
    coordinator.advance(fixtureRoleResult(coordinator.snapshot(), step('TESTER', 'FAIL', 'test-fail')));
    coordinator.advance();
    const repeated = fixtureRoleResult(coordinator.snapshot(), step('BUILDER', 'PASS', 'builder-repeated'));
    repeated.commitSha = original;
    expect(coordinator.advance(repeated).history.at(-1)?.blockerReason).toBe('UNCHANGED_CORRECTION_COMMIT');
  });
  it('blocks duplicate result IDs, unavailable results and contradictory claims', () => {
    const duplicate = approved();
    expect(duplicate.runFixtureScript([builder, step('TESTER', 'PASS', 'builder-1')]).history.at(-1)?.blockerReason)
      .toBe('DUPLICATE_RESULT');
    const missing = approved();
    expect(missing.runFixtureScript([builder]).history.at(-1)?.blockerReason).toBe('EVIDENCE_UNAVAILABLE');
    const unknown = approved();
    expect(unknown.runFixtureScript([builder, step('TESTER', 'UNKNOWN', 'tester-unknown')]).stage).toBe('BLOCKED');
    const conflicting = approved();
    const claim = fixtureRoleResult(conflicting.snapshot(), builder);
    claim.blockerReason = 'failure-while-pass';
    expect(conflicting.advance(claim).history.at(-1)?.blockerReason).toBe('UNKNOWN_OR_MALFORMED_EVIDENCE');
  });
  it('does not consume role script entries across the plan approval pause', () => {
    const coordinator = new SimulatedSdlcCoordinator(issue());
    expect(coordinator.runFixtureScript([lead, builder]).history.at(-1)?.blockerReason).toBe('UNUSED_FIXTURE_RESULTS');
  });
  it('never permits external action and rejects non-synthetic issue input', () => {
    const coordinator = approved();
    expect(coordinator.snapshot()).toMatchObject({ productionAuthorized: false, executable: false });
    expect(coordinator.prepareSyntheticPr()).toBeNull();
    expect(() => new SimulatedSdlcCoordinator({ ...issue(), synthetic: false })).toThrow();
    expect(coordinator.runFixtureScript([builder, tester, reviewer]).executable).toBe(false);
  });
});
