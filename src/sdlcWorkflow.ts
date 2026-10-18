/** Browser-only M2 demonstration. Nothing in this module calls a provider or launches a process. */
export const demoEpic = {
  repository: 'demo/sdlc-role-lab', number: 201, title: 'Accessible shortcut guide',
  objective: 'Deliver and validate a keyboard shortcut guide in a disposable demonstration app.',
  children: [{ number: 202, title: 'Build the shortcut guide', dependencies: [] as number[] }]
} as const;

export const roles = ['LEAD ORCHESTRATOR', 'BUILDER', 'TESTER', 'PR REVIEWER', 'MERGER'] as const;
export type Role = typeof roles[number];
export type Provenance = 'LOCAL_FIXTURE' | 'USER_SUPPLIED_CLAIM' | 'INDEPENDENTLY_VERIFIED' | 'UNKNOWN_UNAVAILABLE';
export type Stage = 'PLAN' | 'BUILDER' | 'TESTER' | 'PR REVIEWER' | 'MERGER' | 'CLOSURE' | 'AWAITING_INDEPENDENT_VERIFICATION' | 'INTERVENTION';
export interface Report {
  role: Role;
  epic: number;
  child: number;
  handoffVersion: number;
  approved: boolean;
  work: string;
  commit: string;
  tests: string;
  findings: string;
  pr: string;
  blockers: string;
  outcome: 'PASS' | 'FAIL';
  provenance: 'USER_SUPPLIED_CLAIM';
  timestamp: string;
  stale: boolean;
}
export interface SdlcState {
  schema: 2;
  stage: Stage;
  version: number;
  corrections: number;
  planApproved: boolean;
  handoffApproved: boolean;
  currentCommit: string;
  reports: Report[];
  mergeReported: boolean;
  stopped: boolean;
}
export type ReportInput = Pick<Report, 'work' | 'commit' | 'tests' | 'findings' | 'pr' | 'blockers' | 'outcome'>;
const sha = /^[a-f0-9]{40}$/i;
const allowed = new Set<Stage>(['PLAN','BUILDER','TESTER','PR REVIEWER','MERGER','CLOSURE','AWAITING_INDEPENDENT_VERIFICATION','INTERVENTION']);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const hasExactKeys = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v,k));
const reportKeys = ['role','epic','child','handoffVersion','approved','work','commit','tests','findings','pr','blockers','outcome','provenance','timestamp','stale'];
const stateKeys = ['schema','stage','version','corrections','planApproved','handoffApproved','currentCommit','reports','mergeReported','stopped'];
export const newSdlc = (): SdlcState => ({ schema: 2, stage: 'PLAN', version: 1, corrections: 0,
  planApproved: false, handoffApproved: false, currentCommit: '', reports: [], mergeReported: false, stopped: false });

export function dependencyOrder(children: readonly { number: number; dependencies: readonly number[] }[]): number[] {
  const seen = new Set<number>(), active = new Set<number>(), order: number[] = [];
  const byId = new Map(children.map(c => [c.number, c]));
  if (byId.size !== children.length) throw new Error('Duplicate child issue.');
  const visit = (n: number) => {
    if (active.has(n)) throw new Error('Dependency cycle.');
    if (seen.has(n)) return;
    const child = byId.get(n); if (!child) throw new Error('Unknown dependency.');
    active.add(n); child.dependencies.forEach(visit); active.delete(n); seen.add(n); order.push(n);
  };
  children.forEach(c => visit(c.number)); return order;
}

export function approveEpicPlan(s: SdlcState): SdlcState {
  if (s.stage !== 'PLAN' || s.stopped) throw new Error('Plan approval is unavailable.');
  dependencyOrder(demoEpic.children);
  return { ...s, planApproved: true, stage: 'BUILDER' };
}
export function activeRole(s: SdlcState): Role {
  return s.stage === 'PLAN' || s.stage === 'CLOSURE' || s.stage === 'AWAITING_INDEPENDENT_VERIFICATION' || s.stage === 'INTERVENTION'
    ? 'LEAD ORCHESTRATOR' : s.stage;
}
export function approveRoleHandoff(s: SdlcState): SdlcState {
  if (s.stopped || !s.planApproved || s.handoffApproved || !['BUILDER','TESTER','PR REVIEWER','MERGER'].includes(s.stage))
    throw new Error('No current handoff can be approved.');
  if (s.stage === 'TESTER' && !passing(s,'BUILDER')) throw new Error('Fresh unblocked Builder report required.');
  if (s.stage === 'PR REVIEWER' && !passing(s,'TESTER')) throw new Error('Fresh passing tests required.');
  if (s.stage === 'MERGER' && (!passing(s,'TESTER') || !passing(s,'PR REVIEWER'))) throw new Error('Fresh test and review reports required.');
  return { ...s, handoffApproved: true };
}
export function latest(s: SdlcState, role: Role): Report | undefined {
  return [...s.reports].reverse().find(r => r.role === role && !r.stale && r.commit === s.currentCommit);
}
const passing = (s: SdlcState, role: Role) => {
  const report = latest(s,role);
  return report?.outcome === 'PASS' && !report.blockers.trim();
};

export function importReport(s: SdlcState, value: unknown, now: string): SdlcState {
  if (s.stopped || !s.handoffApproved || !['BUILDER','TESTER','PR REVIEWER','MERGER'].includes(s.stage)) throw new Error('Approve the current role handoff first.');
  if (!isObject(value) || !hasExactKeys(value,['work','commit','tests','findings','pr','blockers','outcome']) ||
    !Object.values(value).every(v => typeof v === 'string') ||
    Object.values(value).some(v => (v as string).length > 5000) || !['PASS','FAIL'].includes(value.outcome as string) ||
    !Number.isFinite(Date.parse(now))) throw new Error('Malformed completion report.');
  const v = value as unknown as ReportInput;
  if (!v.work.trim()) throw new Error('Reported work is required.');
  if (v.outcome === 'PASS' && v.blockers.trim()) throw new Error('PASS report cannot contain outstanding blockers.');
  if (v.commit && !sha.test(v.commit)) throw new Error('Commit must be a full SHA.');
  if (v.pr && !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(v.pr)) throw new Error('PR must be a GitHub pull URL.');
  if (s.stage === 'BUILDER' && !sha.test(v.commit)) throw new Error('Builder needs a full commit SHA.');
  if (s.stage === 'BUILDER' && s.corrections > 0 && v.commit === s.currentCommit) throw new Error('Corrective Builder report needs a changed commit.');
  if (s.stage !== 'BUILDER' && v.commit !== s.currentCommit) throw new Error('Report targets a stale or different commit.');
  if (s.stage === 'TESTER' && !v.tests.trim()) throw new Error('Test results are required.');
  if (v.outcome === 'FAIL' && !v.findings.trim()) throw new Error('Failure findings are required.');
  if (s.stage === 'MERGER' && (!v.pr || !passing(s,'TESTER') || !passing(s,'PR REVIEWER'))) throw new Error('PR, test, and review reports are required.');
  const role = activeRole(s);
  const changed = s.stage === 'BUILDER' && !!s.currentCommit && v.commit !== s.currentCommit;
  const reports = changed ? s.reports.map(r => ({ ...r, stale: true })) : s.reports;
  const report: Report = { ...v, role, epic: demoEpic.number, child: demoEpic.children[0].number,
    handoffVersion: s.version, approved: true, provenance: 'USER_SUPPLIED_CLAIM', timestamp: now, stale: false };
  const base = { ...s, reports: [...reports, report], currentCommit: v.commit || s.currentCommit,
    version: s.version + 1, handoffApproved: false };
  if ((s.stage === 'TESTER' || s.stage === 'PR REVIEWER') && v.outcome === 'FAIL') {
    const invalidated = base.reports.map(r => r.role === 'TESTER' || r.role === 'PR REVIEWER' ? { ...r, stale: true } : r);
    return { ...base, reports: invalidated, corrections: s.corrections + 1,
      stage: s.corrections >= 2 ? 'INTERVENTION' : 'BUILDER' };
  }
  if (s.stage === 'BUILDER') return { ...base, stage: 'TESTER' };
  if (s.stage === 'TESTER') return { ...base, stage: 'PR REVIEWER' };
  if (s.stage === 'PR REVIEWER') return { ...base, stage: 'MERGER' };
  return v.outcome === 'PASS' ? { ...base, mergeReported: true, stage: 'CLOSURE' } : { ...base, stage: 'INTERVENTION' };
}

export function reviewClosure(s: SdlcState): SdlcState {
  if (s.stage !== 'CLOSURE') throw new Error('Merge report required before closure review.');
  return { ...s, stage: 'AWAITING_INDEPENDENT_VERIFICATION' };
}
export function closureReport(s: SdlcState): string {
  const child = demoEpic.children[0];
  return [`EPIC COMPLETION REVIEW — ${demoEpic.repository}#${demoEpic.number} (fictional local fixture)`,
    `Objective: ${demoEpic.objective}`, `Child #${child.number}: ${child.title}`,
    `Builder commit: ${s.currentCommit || 'unavailable'}`,
    `Fresh test report: ${passing(s,'TESTER') ? 'user-supplied PASS claim' : 'missing or stale'}`,
    `Fresh review report: ${passing(s,'PR REVIEWER') ? 'user-supplied PASS claim' : 'missing or stale'}`,
    `Merge: ${s.mergeReported ? 'user-reported; provider verification unavailable' : 'not reported'}`,
    'Child completion: AWAITING INDEPENDENT VERIFICATION.',
    'Epic completion: BLOCKED. No child or Epic is VERIFIED COMPLETE.',
    'Closure checklist: independently verify exact merged PR head, test/review status, merge, child acceptance, and GitHub issue state; then use an approved GitHub interface to close externally.',
    'No GitHub write or automatic closure occurs here.'].join('\n');
}

export function instructions(s: SdlcState): string {
  const common = [`MANUAL ${activeRole(s)} HANDOFF v${s.version} — fictional local fixture; no provider evidence`,
    `Epic ${demoEpic.repository}#${demoEpic.number}: ${demoEpic.objective}`,
    `Child #${demoEpic.children[0].number}: ${demoEpic.children[0].title}`,
    `Commit under review: ${s.currentCommit || 'unknown until Builder reports'}`,
    'Human: verify a separately authorized worktree, clean baseline, repository and issue scope before manually launching Codex outside Mission Control. Stop the external session yourself if uncertain.',
    'Never access AO or historical dispatch; do not launch other workers, deploy, merge, close issues, or claim provider verification. Report exact commit, results, findings and blockers.'];
  const task: Record<Role,string> = {
    'LEAD ORCHESTRATOR': 'Review child scope, dependencies, evidence and closure checklist. Approve the plan or request intervention.',
    BUILDER: `Implement only the child objective. ${s.corrections ? `Correct recorded findings from cycle ${s.corrections}; use a new commit and report all changes.` : 'Report a full local commit SHA and changed work.'}`,
    TESTER: 'Independently test the exact Builder commit. Report commands, results and reproducible failures. Do not change code.',
    'PR REVIEWER': 'Review the exact tested commit for correctness, scope and safety. Report findings and verdict. Do not merge.',
    MERGER: 'Check fresh test and review reports and the exact PR URL/head via an approved GitHub interface. Obtain human approval before external merge. Report the outcome; this browser cannot verify it.'
  };
  return [...common, `Role task: ${task[activeRole(s)]}`, 'Completion report fields: work, commit SHA, tests, findings, PR URL, blockers, PASS or FAIL.'].join('\n\n');
}

export function restoreSdlc(v: unknown): SdlcState | null {
  if (!isObject(v) || !hasExactKeys(v,stateKeys) || v.schema !== 2 || !allowed.has(v.stage as Stage) ||
    !Number.isSafeInteger(v.version) || (v.version as number) < 1 || !Number.isSafeInteger(v.corrections) ||
    (v.corrections as number) < 0 || (v.corrections as number) > 3 ||
    typeof v.planApproved !== 'boolean' || typeof v.handoffApproved !== 'boolean' ||
    typeof v.currentCommit !== 'string' || !!v.currentCommit && !sha.test(v.currentCommit) ||
    typeof v.mergeReported !== 'boolean' || typeof v.stopped !== 'boolean' || !Array.isArray(v.reports) || v.reports.length > 30) return null;
  for (const r of v.reports) {
    if (!isObject(r) || !hasExactKeys(r,reportKeys) || !roles.includes(r.role as Role) ||
      r.epic !== demoEpic.number || r.child !== demoEpic.children[0].number || !Number.isSafeInteger(r.handoffVersion) ||
      (r.handoffVersion as number) < 1 || (r.handoffVersion as number) >= (v.version as number) || r.approved !== true ||
      r.provenance !== 'USER_SUPPLIED_CLAIM' || typeof r.stale !== 'boolean' ||
      !['PASS','FAIL'].includes(r.outcome as string) || !Number.isFinite(Date.parse(r.timestamp as string)) ||
      ['work','commit','tests','findings','pr','blockers'].some(k => typeof r[k] !== 'string' || (r[k] as string).length > 5000) ||
      r.outcome === 'PASS' && typeof r.blockers === 'string' && !!r.blockers.trim() ||
      !!r.commit && !sha.test(r.commit as string)) return null;
  }
  const s = v as unknown as SdlcState;
  if (!s.planApproved && s.stage !== 'PLAN' || s.handoffApproved && !['BUILDER','TESTER','PR REVIEWER','MERGER'].includes(s.stage) ||
    s.mergeReported && !s.reports.some(r => r.role === 'MERGER' && r.outcome === 'PASS') ||
    s.stage === 'AWAITING_INDEPENDENT_VERIFICATION' && !s.mergeReported ||
    ['TESTER','PR REVIEWER','MERGER','CLOSURE','AWAITING_INDEPENDENT_VERIFICATION'].includes(s.stage) && (!s.currentCommit || !passing(s,'BUILDER')) ||
    ['PR REVIEWER','MERGER','CLOSURE','AWAITING_INDEPENDENT_VERIFICATION'].includes(s.stage) && !passing(s,'TESTER') ||
    ['MERGER','CLOSURE','AWAITING_INDEPENDENT_VERIFICATION'].includes(s.stage) && !passing(s,'PR REVIEWER') ||
    ['CLOSURE','AWAITING_INDEPENDENT_VERIFICATION'].includes(s.stage) && !s.mergeReported) return null;
  // A browser reload never preserves a handoff approval as live consent.
  return { ...s, handoffApproved: false };
}
