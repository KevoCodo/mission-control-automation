import { demoIssues, type DemoIssue } from './data/demoIssues';

export type WorkflowStatus = 'issue-selected' | 'planning' | 'awaiting-approval' | 'approved' |
  'handoff-prepared' | 'awaiting-manual-execution' | 'changes-requested' | 'cancelled';

export interface Plan {
  objective: string;
  scope: string;
  files: string;
  acceptanceCriteria: string;
  tests: string;
  restrictions: string;
  dependencies: string;
  assumptions: string;
}

export interface Draft {
  schema: 1;
  issueNumber: number;
  repository: string;
  plan: Plan;
  planVersion: number;
  status: WorkflowStatus;
  approval?: { version: number; exactPlan: string; issueNumber: number; repository: string };
}

const planKeys: (keyof Plan)[] = ['objective', 'scope', 'files', 'acceptanceCriteria', 'tests',
  'restrictions', 'dependencies', 'assumptions'];
const statuses: WorkflowStatus[] = ['issue-selected', 'planning', 'awaiting-approval', 'approved',
  'handoff-prepared', 'awaiting-manual-execution', 'changes-requested', 'cancelled'];
const forbiddenIssues = new Set([12, 13, 23]);
const own = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function selectIssue(number: number, repository: string, issues: readonly DemoIssue[] = demoIssues): DemoIssue {
  if (!Number.isSafeInteger(number) || number <= 0 || forbiddenIssues.has(number) || !repository) {
    throw new Error('Missing or invalid issue identity.');
  }
  const matches = issues.filter((issue) => issue.number === number && issue.repository === repository);
  if (matches.length !== 1 || issues.some((issue) => issue.number === number && issue.repository !== repository)) {
    throw new Error('Missing or contradictory issue identity.');
  }
  const issue = matches[0];
  if (issue.dependencyEvidence !== 'local-demo-fixture' || !Array.isArray(issue.dependencies) ||
    issue.dependencies.some((dependency) => !Number.isSafeInteger(dependency) || dependency <= 0 ||
      issues.filter((candidate) => candidate.number === dependency && candidate.repository === repository).length !== 1)) {
    throw new Error('Dependency evidence is missing or contradictory.');
  }
  return issue;
}

export function createPlan(issue: DemoIssue): Plan {
  selectIssue(issue.number, issue.repository);
  return {
    objective: issue.title,
    scope: issue.description,
    files: 'Identify affected components and files in the independently verified worktree before editing.',
    acceptanceCriteria: 'Implement the stated scope; preserve existing behavior and accessibility.',
    tests: 'Run relevant tests and the project build; report exact commands and results.',
    restrictions: 'Stay within the approved scope. Do not access AO, launch workers, publish, merge, close issues, or deploy.',
    dependencies: issue.dependencies.length ? issue.dependencies.map((number) => `Demo issue #${number}: completion unverified`).join('\n') : 'None listed in the local demo fixture; provider evidence unavailable.',
    assumptions: 'Issue identity, repository, dependencies and status come from a fictional local fixture. Workspace, Git HEAD, provider status and dependency completion are unverified.'
  };
}

export function newDraft(issue: DemoIssue): Draft {
  const selected = selectIssue(issue.number, issue.repository);
  return { schema: 1, issueNumber: selected.number, repository: selected.repository,
    plan: createPlan(selected), planVersion: 1, status: 'issue-selected' };
}

export function editPlan(draft: Draft, plan: Plan): Draft {
  return { ...draft, plan, planVersion: draft.planVersion + 1, status: 'planning', approval: undefined };
}

export function exactPlan(draft: Draft): string {
  return JSON.stringify([draft.issueNumber, draft.repository, ...planKeys.map((key) => draft.plan[key])]);
}

export function isApproved(draft: Draft): boolean {
  return !!draft.approval && draft.status !== 'cancelled' &&
    draft.approval.version === draft.planVersion && draft.approval.exactPlan === exactPlan(draft) &&
    draft.approval.issueNumber === draft.issueNumber && draft.approval.repository === draft.repository;
}

export function approvePlan(draft: Draft): Draft {
  const issue = selectIssue(draft.issueNumber, draft.repository);
  if (issue.dependencies.length) throw new Error('Demo dependency completion is unverified; approval is blocked.');
  if (draft.status !== 'awaiting-approval') throw new Error('Submit the current plan for approval first.');
  if (planKeys.some((key) => !draft.plan[key].trim())) throw new Error('Complete every plan field before approval.');
  return { ...draft, status: 'approved', approval: { version: draft.planVersion,
    exactPlan: exactPlan(draft), issueNumber: draft.issueNumber, repository: draft.repository } };
}

export function requestChanges(draft: Draft): Draft {
  return { ...draft, status: 'changes-requested', approval: undefined };
}

export function cancelHandoff(draft: Draft): Draft {
  return { ...draft, status: 'cancelled', approval: undefined };
}

export function prepareHandoff(draft: Draft): { draft: Draft; text: string } {
  if (!isApproved(draft)) throw new Error('Exact current plan needs approval before handoff.');
  const issue = selectIssue(draft.issueNumber, draft.repository);
  const sections: [string, string][] = [
    ['Objective', draft.plan.objective], ['Scope', draft.plan.scope],
    ['Likely files or components', draft.plan.files], ['Acceptance criteria', draft.plan.acceptanceCriteria],
    ['Required tests and builds', draft.plan.tests], ['Restrictions', draft.plan.restrictions],
    ['Known dependencies', draft.plan.dependencies], ['Unverified assumptions', draft.plan.assumptions]
  ];
  const text = [
    'MANUAL CODEX HANDOFF — local demonstration data; no provider facts verified',
    `Issue: ${issue.repository}#${issue.number} — ${issue.title}`,
    `Description: ${issue.description}`,
    `Issue status: ${issue.status} (local demo fixture only)`,
    `Approved plan version: ${draft.planVersion}`,
    'Exact approved plan:',
    ...sections.map(([label, value]) => `${label}:\n${value}`),
    'Worktree and baseline: UNKNOWN. Before execution, the human must independently verify the authorized separate worktree, repository identity, clean Git state and exact expected Git HEAD. Stop if any check fails.',
    'Allowed implementation scope: only the approved scope above, in the independently verified worktree.',
    'Excluded actions: no AO access or dispatch, no automatic worker launch, no GitHub publish/PR/merge/issue closure, no deployment, no production grant issuance.',
    'Completion report: list changed files, implementation, test and build commands/results, limitations, and full local commit SHA.',
    'Commit: after review and successful verification, create one local commit for this approved scope. Stop after that commit; do not push.',
    'Manual STOP/abort: if identity, dependency, worktree, baseline, scope or safety evidence is uncertain, stop the external Codex session manually and report the blocker. Cancelling this browser workflow cannot terminate an external session.'
  ].join('\n\n');
  return { draft: { ...draft, status: 'handoff-prepared' }, text };
}

export function recordCopy(draft: Draft): Draft {
  if (!isApproved(draft) || draft.status !== 'handoff-prepared') throw new Error('No current handoff to copy.');
  return { ...draft, status: 'awaiting-manual-execution' };
}

export function restoreDraft(value: unknown): Draft | null {
  if (!own(value) || value.schema !== 1 || !Number.isSafeInteger(value.issueNumber) ||
    typeof value.repository !== 'string' || !Number.isSafeInteger(value.planVersion) ||
    Number(value.planVersion) < 1 || !statuses.includes(value.status as WorkflowStatus) || !own(value.plan) ||
    Object.keys(value).some((key) => !['schema','issueNumber','repository','plan','planVersion','status','approval'].includes(key))) return null;
  const plan = value.plan;
  if (Object.keys(plan).length !== planKeys.length ||
    planKeys.some((key) => typeof plan[key] !== 'string' || !String(plan[key]).trim() || String(plan[key]).length > 5000)) return null;
  try { selectIssue(value.issueNumber as number, value.repository); } catch { return null; }
  const draft = value as unknown as Draft;
  const issue = selectIssue(draft.issueNumber, draft.repository);
  if (issue.dependencies.length && ['approved', 'handoff-prepared', 'awaiting-manual-execution'].includes(draft.status)) return null;
  if (draft.approval !== undefined && (!own(draft.approval) ||
    Object.keys(draft.approval).length !== 4 || !isApproved(draft))) return null;
  if (['approved', 'handoff-prepared', 'awaiting-manual-execution'].includes(draft.status) && !isApproved(draft)) return null;
  if (['planning','awaiting-approval','changes-requested','cancelled','issue-selected'].includes(draft.status) && draft.approval) return null;
  // Browser storage is caller-controlled. A prior UI click is never restored as current approval.
  return draft.approval ? { ...draft, status: 'awaiting-approval', approval: undefined } : draft;
}
