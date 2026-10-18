import { describe, expect, it } from 'vitest';
import { activeRole, approveEpicPlan, approveRoleHandoff, closureReport, demoEpic, dependencyOrder,
  importReport, instructions, newSdlc, restoreSdlc, reviewClosure, type ReportInput, type SdlcState } from './sdlcWorkflow';

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
const report = (commit: string, extra: Partial<ReportInput> = {}): ReportInput =>
  ({ work: 'Completed assigned role', commit, tests: 'npm test: pass', findings: '', pr: '', blockers: '', outcome: 'PASS', ...extra });
const time = '2026-10-18T12:00:00.000Z';
const approved = () => approveEpicPlan(newSdlc());
const submitted = (s: SdlcState, input: ReportInput) => importReport(approveRoleHandoff(s), input, time);
const built = () => submitted(approved(), report(A));
const tested = () => submitted(built(), report(A));
const reviewed = () => submitted(tested(), report(A));

describe('supervised M2 workflow', () => {
  it('uses a separate fictional Epic and validates child dependency ordering', () => {
    expect(demoEpic.repository).toBe('demo/sdlc-role-lab');
    expect([demoEpic.number, ...demoEpic.children.map(c => c.number)]).not.toContain(13);
    expect(dependencyOrder([{number: 3,dependencies:[2]},{number:2,dependencies:[1]},{number:1,dependencies:[]}])).toEqual([1,2,3]);
    expect(() => dependencyOrder([{number:1,dependencies:[2]},{number:2,dependencies:[1]}])).toThrow('cycle');
    expect(() => dependencyOrder([{number:1,dependencies:[4]}])).toThrow('Unknown');
  });
  it('requires plan and each explicit role handoff in sequence', () => {
    expect(() => approveRoleHandoff(newSdlc())).toThrow();
    let s = approved();
    expect(activeRole(s)).toBe('BUILDER');
    expect(() => importReport(s, report(A), time)).toThrow('Approve');
    s = approveRoleHandoff(s);
    expect(() => approveRoleHandoff(s)).toThrow();
    s = importReport(s, report(A), time);
    expect(s.stage).toBe('TESTER');
    expect(s.reports[0]).toMatchObject({epic:201,child:202,handoffVersion:1,approved:true,provenance:'USER_SUPPLIED_CLAIM',timestamp:time});
    expect(s.handoffApproved).toBe(false);
    expect(() => importReport(s, report(A), time)).toThrow();
    expect(instructions(s)).toContain('Independently test');
    expect(instructions(s)).toContain('manually launching Codex outside Mission Control');
  });
  it('rejects malformed, stale, or conflicting imports', () => {
    expect(() => submitted(approved(), report('short'))).toThrow('full SHA');
    expect(() => submitted(approved(), {...report(A), pr:'http://bad'})).toThrow('PR');
    expect(() => submitted(approved(), {...report(A), extra:'bad'} as ReportInput)).toThrow('Malformed');
    expect(() => submitted(built(), report(B))).toThrow('stale');
    expect(() => submitted(built(), report(A,{tests:''}))).toThrow('Test results');
    expect(() => submitted(built(), report(A,{outcome:'FAIL',findings:''}))).toThrow('findings');
  });
  it.each([
    ['BUILDER', approved, {}],
    ['TESTER', built, {}],
    ['PR REVIEWER', tested, {}],
    ['MERGER', reviewed, {pr:'https://github.com/demo/sdlc-role-lab/pull/1'}]
  ] as const)('rejects %s PASS with outstanding blockers', (_role, makeState, extra) => {
    const s = makeState();
    expect(() => submitted(s, report(A, { ...extra, blockers:'Unresolved failure' }))).toThrow('PASS report cannot contain outstanding blockers');
    expect(s.reports).toHaveLength(_role === 'BUILDER' ? 0 : _role === 'TESTER' ? 1 : _role === 'PR REVIEWER' ? 2 : 3);
  });
  it('accepts whitespace-only blockers and rejects contradictory reports at every approval gate', () => {
    const builder = submitted(approved(), report(A,{blockers:'  \n  '}));
    expect(builder.stage).toBe('TESTER');
    expect(approveRoleHandoff(builder).handoffApproved).toBe(true);
    const blockedBuilder = {...builder,reports:builder.reports.map(r => ({...r,blockers:'unresolved'}))};
    expect(() => approveRoleHandoff(blockedBuilder)).toThrow('Builder');
    const tester = submitted(builder,report(A,{blockers:' \t '}));
    const blockedTester = {...tester,reports:tester.reports.map(r => r.role === 'TESTER' ? {...r,blockers:'unresolved'} : r)};
    expect(() => approveRoleHandoff(blockedTester)).toThrow('tests');
    const reviewer = submitted(tester,report(A));
    const blockedReviewer = {...reviewer,reports:reviewer.reports.map(r => r.role === 'PR REVIEWER' ? {...r,blockers:'unresolved'} : r)};
    expect(() => approveRoleHandoff(blockedReviewer)).toThrow('review');
  });
  it('routes Tester failure through fresh Builder, Tester and Reviewer checks', () => {
    let s = submitted(built(), report(A,{outcome:'FAIL',findings:'Keyboard focus fails'}));
    expect(s.stage).toBe('BUILDER'); expect(s.corrections).toBe(1);
    expect(s.reports.at(-1)?.stale).toBe(true);
    expect(() => submitted(s,report(A))).toThrow('changed commit');
    s = submitted(s,report(B));
    expect(s.reports[0].stale).toBe(true);
    expect(s.stage).toBe('TESTER');
    s = submitted(s,report(B));
    expect(s.stage).toBe('PR REVIEWER');
  });
  it('routes Reviewer findings to Builder and enforces the two-cycle limit', () => {
    let s = submitted(tested(), report(A,{outcome:'FAIL',findings:'Missing aria label'}));
    expect(s.stage).toBe('BUILDER'); expect(s.corrections).toBe(1);
    s = submitted(s,report(B)); s = submitted(s,report(B));
    s = submitted(s,report(B,{outcome:'FAIL',findings:'Still missing'}));
    expect(s.corrections).toBe(2); expect(s.stage).toBe('BUILDER');
    s = submitted(s,report(C));
    s = submitted(s,report(C,{outcome:'FAIL',findings:'Regression'}));
    expect(s.stage).toBe('INTERVENTION');
    expect(() => approveRoleHandoff(s)).toThrow();
  });
  it('blocks missing PR and merge evidence and never verifies a claimed merge', () => {
    let s = reviewed(); expect(s.stage).toBe('MERGER');
    expect(() => submitted(s,report(A))).toThrow('PR');
    expect(closureReport(s)).toContain('Merge: not reported');
    s = submitted(s,report(A,{pr:'https://github.com/demo/sdlc-role-lab/pull/1'}));
    expect(s.stage).toBe('CLOSURE'); expect(s.mergeReported).toBe(true);
    s = reviewClosure(s);
    expect(s.stage).toBe('AWAITING_INDEPENDENT_VERIFICATION');
    expect(closureReport(s)).toContain('Epic completion: BLOCKED');
    expect(closureReport(s)).not.toContain('Epic completion: VERIFIED COMPLETE');
  });
  it('restores only valid local state and clears handoff approval', () => {
    const s = approveRoleHandoff(approved());
    expect(restoreSdlc(JSON.parse(JSON.stringify(s)))?.handoffApproved).toBe(false);
    expect(restoreSdlc({...s,stage:'MERGER'})).toBeNull();
    expect(restoreSdlc({...s,reports:[{...built().reports[0],epic:3}]})).toBeNull();
    expect(restoreSdlc({...s,reports:[{...built().reports[0],provenance:'INDEPENDENTLY_VERIFIED'}]})).toBeNull();
    expect(restoreSdlc({...s, currentCommit:'bad'})).toBeNull();
    for (const role of ['BUILDER','TESTER','PR REVIEWER','MERGER'] as const) {
      const state = role === 'BUILDER' ? built() : role === 'TESTER' ? tested() : role === 'PR REVIEWER' ? reviewed() :
        submitted(reviewed(),report(A,{pr:'https://github.com/demo/sdlc-role-lab/pull/1'}));
      const poisoned = {...state,reports:state.reports.map(r => r.role === role ? {...r,blockers:'unresolved'} : r)};
      expect(restoreSdlc(JSON.parse(JSON.stringify(poisoned)))).toBeNull();
    }
  });
  it('contains no execution or provider calls', () => {
    const s = reviewed();
    expect(s.reports.every(r => r.provenance === 'USER_SUPPLIED_CLAIM')).toBe(true);
    expect(instructions(s)).toContain('human approval before external merge');
    expect(instructions(s)).toContain('Never access AO');
    expect(closureReport(s)).toContain('No GitHub write or automatic closure');
  });
});
