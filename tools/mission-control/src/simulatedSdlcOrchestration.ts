import { createHash } from 'node:crypto';
import type { AgentRole, ExecutionEnvelope } from './executionProtocol.js';

/** In-memory fixture coordination only; no dispatch, authorization, or worker implementation. */
export type SimulatedStage = 'ISSUE_VALIDATED' | 'PLAN_READY' | 'AWAITING_PLAN_APPROVAL' |
  'BUILDER_RUNNING_SIMULATED' | 'TESTER_RUNNING_SIMULATED' | 'REVIEWER_RUNNING_SIMULATED' |
  'CORRECTION_REQUIRED' | 'PR_READY_AWAITING_HUMAN' | 'BLOCKED' | 'STOPPED';
export type SimulatedRole = Extract<AgentRole, 'ORCHESTRATOR' | 'BUILDER' | 'TESTER' | 'REVIEWER'>;
export type FixtureOutcome = 'PASS' | 'FAIL' | 'UNKNOWN';
type Repository = ExecutionEnvelope['repository'];

export interface SyntheticIssueInput {
  version: 1;
  synthetic: true;
  issueId: string;
  issueNumber: number;
  repository: Repository;
  generation: number;
  stopEpoch: number;
  dependencies: { status: 'SATISFIED' | 'BLOCKED' | 'UNKNOWN'; evidenceRef: string | null };
  plan: { steps: string[] };
}

/** A local approval fixture is a gate in this simulation, never authenticated human authority. */
export interface HumanPlanApprovalFixture {
  kind: 'HUMAN_APPROVAL_FIXTURE';
  approvalId: string;
  issueId: string;
  issueNumber: number;
  repository: Repository;
  planDigest: string;
  generation: number;
  stopEpoch: number;
}

interface FixtureResultBase {
  kind: 'SIMULATED_ROLE_RESULT';
  resultId: string;
  role: SimulatedRole;
  issueId: string;
  issueNumber: number;
  repository: Repository;
  planDigest: string;
  generation: number;
  stopEpoch: number;
  stage: SimulatedStage;
  outcome: FixtureOutcome;
  commitSha: string | null;
  blockerReason: string | null;
}
export type LeadFixtureResult = FixtureResultBase & { role: 'ORCHESTRATOR'; stage: 'ISSUE_VALIDATED'; outcome: 'PASS'; commitSha: null };
export type BuilderFixtureResult = FixtureResultBase & { role: 'BUILDER'; stage: 'BUILDER_RUNNING_SIMULATED'; commitSha: string | null };
export type TesterFixtureResult = FixtureResultBase & { role: 'TESTER'; stage: 'TESTER_RUNNING_SIMULATED'; commitSha: string };
export type ReviewerFixtureResult = FixtureResultBase & { role: 'REVIEWER'; stage: 'REVIEWER_RUNNING_SIMULATED'; commitSha: string };
export type FixtureRoleResult = LeadFixtureResult | BuilderFixtureResult | TesterFixtureResult | ReviewerFixtureResult;

export interface SimulatedTransition {
  stage: SimulatedStage;
  issueId: string;
  generation: number;
  role: SimulatedRole | null;
  result: string;
  blockerReason: string | null;
}

export interface SimulatedSnapshot {
  stage: SimulatedStage;
  issueId: string;
  issueNumber: number;
  repository: Repository;
  planDigest: string;
  generation: number;
  stopEpoch: number;
  corrections: number;
  commitSha: string | null;
  testerEvidence: string | null;
  reviewerEvidence: string | null;
  history: SimulatedTransition[];
  productionAuthorized: false;
  executable: false;
}

export interface FixtureScriptStep { role: SimulatedRole; outcome: FixtureOutcome; resultId: string }
export interface SyntheticPrPreparation {
  fixtureOnly: true;
  actualPrExists: false;
  issueId: string;
  repository: Repository;
  planDigest: string;
  simulatedCommitSha: string;
  summary: string;
}

const SHA256 = /^[a-f0-9]{64}$/;
const SHA1 = /^[a-f0-9]{40}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const validId = (v: unknown): v is string => typeof v === 'string' && ID.test(v);
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const nonnegative = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;

// Only read descriptors from caller-controlled objects. Throwing Proxy traps fail closed.
function data(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length) throw new Error('INVALID_OBJECT');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length !== keys.length || Object.keys(descriptors).some(k => !keys.includes(k)))
    throw new Error('INVALID_KEYS');
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new Error('INVALID_PROPERTY');
    copy[key] = descriptor.value;
  }
  return copy;
}

function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length)
    throw new Error('INVALID_ARRAY');
  const descriptors: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > max || Object.keys(descriptors).length !== length + 1)
    throw new Error('INVALID_ARRAY');
  const copy: unknown[] = [];
  for (let i = 0; i < length; i++) {
    const descriptor = descriptors[String(i)];
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new Error('INVALID_ARRAY');
    copy.push(descriptor.value);
  }
  return copy;
}

function repository(value: unknown): Repository {
  const v = data(value, ['owner', 'name']);
  if (!validId(v.owner) || !validId(v.name)) throw new Error('INVALID_REPOSITORY');
  return { owner: v.owner, name: v.name };
}

function issueInput(value: unknown): SyntheticIssueInput {
  const v = data(value, ['version', 'synthetic', 'issueId', 'issueNumber', 'repository', 'generation', 'stopEpoch', 'dependencies', 'plan']);
  const d = data(v.dependencies, ['status', 'evidenceRef']);
  const p = data(v.plan, ['steps']);
  const steps = array(p.steps, 5);
  if (v.version !== 1 || v.synthetic !== true || !validId(v.issueId) || !v.issueId.startsWith('fixture-') ||
      !positive(v.issueNumber) || !positive(v.generation) || !nonnegative(v.stopEpoch) ||
      !['SATISFIED', 'BLOCKED', 'UNKNOWN'].includes(d.status as string) ||
      (d.evidenceRef !== null && !validId(d.evidenceRef)) || steps.length < 1 ||
      steps.some(step => typeof step !== 'string' || !step.trim() || step.length > 300)) throw new Error('INVALID_FIXTURE_ISSUE');
  return { version: 1, synthetic: true, issueId: v.issueId, issueNumber: v.issueNumber,
    repository: repository(v.repository), generation: v.generation, stopEpoch: v.stopEpoch,
    dependencies: { status: d.status as SyntheticIssueInput['dependencies']['status'], evidenceRef: d.evidenceRef as string | null },
    plan: { steps: steps as string[] } };
}

function roleFor(stage: SimulatedStage): SimulatedRole | null {
  if (stage === 'ISSUE_VALIDATED') return 'ORCHESTRATOR';
  if (stage === 'BUILDER_RUNNING_SIMULATED') return 'BUILDER';
  if (stage === 'TESTER_RUNNING_SIMULATED') return 'TESTER';
  if (stage === 'REVIEWER_RUNNING_SIMULATED') return 'REVIEWER';
  return null;
}

function parseResult(value: unknown): FixtureRoleResult {
  const v = data(value, ['kind', 'resultId', 'role', 'issueId', 'issueNumber', 'repository', 'planDigest', 'generation',
    'stopEpoch', 'stage', 'outcome', 'commitSha', 'blockerReason']);
  if (v.kind !== 'SIMULATED_ROLE_RESULT' || !validId(v.resultId) || !validId(v.issueId) ||
      !positive(v.issueNumber) || !positive(v.generation) || !nonnegative(v.stopEpoch) ||
      typeof v.planDigest !== 'string' || !SHA256.test(v.planDigest) ||
      !['PASS', 'FAIL', 'UNKNOWN'].includes(v.outcome as string) ||
      !['ORCHESTRATOR', 'BUILDER', 'TESTER', 'REVIEWER'].includes(v.role as string) ||
      typeof v.stage !== 'string' || roleFor(v.stage as SimulatedStage) !== v.role ||
      (v.commitSha !== null && (typeof v.commitSha !== 'string' || !SHA1.test(v.commitSha))) ||
      (v.blockerReason !== null && !validId(v.blockerReason)) ||
      (v.outcome === 'PASS' && v.blockerReason !== null) ||
      (v.outcome !== 'PASS' && v.blockerReason === null) ||
      (v.role === 'ORCHESTRATOR' && (v.outcome !== 'PASS' || v.commitSha !== null)) ||
      (v.role === 'BUILDER' && v.outcome === 'PASS' && v.commitSha === null) ||
      ((v.role === 'TESTER' || v.role === 'REVIEWER') && v.commitSha === null)) throw new Error('INVALID_RESULT');
  return { ...v, repository: repository(v.repository) } as FixtureRoleResult;
}

function sameRepository(a: Repository, b: Repository): boolean { return a.owner === b.owner && a.name === b.name; }
function digest(input: SyntheticIssueInput): string {
  return createHash('sha256').update(JSON.stringify({ issueId: input.issueId, issueNumber: input.issueNumber,
    repository: input.repository, steps: input.plan.steps })).digest('hex');
}

/** Deterministic data adapter. It performs no work and its PASS is never independent evidence. */
export function fixtureRoleResult(state: SimulatedSnapshot, step: FixtureScriptStep): FixtureRoleResult {
  const role = roleFor(state.stage);
  if (!role || role !== step.role) throw new Error('FIXTURE_STAGE_MISMATCH');
  const commitSha = role === 'ORCHESTRATOR' ? null : role === 'BUILDER' && step.outcome === 'PASS'
    ? createHash('sha1').update(`fixture:${state.issueId}:${state.generation}:${step.resultId}`).digest('hex')
    : state.commitSha;
  return { kind: 'SIMULATED_ROLE_RESULT', resultId: step.resultId, role, issueId: state.issueId,
    issueNumber: state.issueNumber, repository: { ...state.repository }, planDigest: state.planDigest,
    generation: state.generation, stopEpoch: state.stopEpoch, stage: state.stage, outcome: step.outcome,
    commitSha, blockerReason: step.outcome === 'PASS' ? null : step.outcome === 'FAIL' ? 'FIXTURE_FAILURE' : 'EVIDENCE_UNAVAILABLE' } as FixtureRoleResult;
}

export class SimulatedSdlcCoordinator {
  private readonly issue: SyntheticIssueInput;
  private readonly planDigest: string;
  private stage: SimulatedStage;
  private generation: number;
  private stopEpoch: number;
  private corrections = 0;
  private commitSha: string | null = null;
  private priorCommitSha: string | null = null;
  private testerEvidence: string | null = null;
  private reviewerEvidence: string | null = null;
  private readonly usedResults = new Set<string>();
  private readonly history: SimulatedTransition[] = [];

  constructor(input: unknown) {
    this.issue = issueInput(input);
    this.planDigest = digest(this.issue);
    this.generation = this.issue.generation;
    this.stopEpoch = this.issue.stopEpoch;
    this.stage = this.issue.dependencies.status === 'SATISFIED' && this.issue.dependencies.evidenceRef
      ? 'ISSUE_VALIDATED' : 'BLOCKED';
    this.record(null, this.stage === 'ISSUE_VALIDATED' ? 'SYNTHETIC_ISSUE_VALIDATED' : 'BLOCKED',
      this.stage === 'BLOCKED' ? this.issue.dependencies.status === 'BLOCKED' ? 'DEPENDENCY_BLOCKED' : 'DEPENDENCY_EVIDENCE_UNAVAILABLE' : null);
  }

  private record(role: SimulatedRole | null, result: string, blockerReason: string | null): void {
    this.history.push({ stage: this.stage, issueId: this.issue.issueId, generation: this.generation, role, result, blockerReason });
  }
  private block(reason: string, role: SimulatedRole | null = null): void {
    this.stage = 'BLOCKED'; this.record(role, 'BLOCKED', reason);
  }
  private paused(): boolean {
    return this.stage === 'STOPPED' || this.stage === 'BLOCKED' ||
      this.stage === 'PR_READY_AWAITING_HUMAN' || this.stage === 'AWAITING_PLAN_APPROVAL';
  }
  snapshot(): SimulatedSnapshot {
    return { stage: this.stage, issueId: this.issue.issueId, issueNumber: this.issue.issueNumber,
      repository: { ...this.issue.repository }, planDigest: this.planDigest, generation: this.generation,
      stopEpoch: this.stopEpoch, corrections: this.corrections, commitSha: this.commitSha,
      testerEvidence: this.testerEvidence, reviewerEvidence: this.reviewerEvidence,
      history: this.history.map(item => ({ ...item })), productionAuthorized: false, executable: false };
  }
  stop(): SimulatedSnapshot {
    if (this.stage !== 'STOPPED') {
      const canAdvanceEpoch = Number.isSafeInteger(this.stopEpoch) && this.stopEpoch < Number.MAX_SAFE_INTEGER;
      if (canAdvanceEpoch) this.stopEpoch++;
      this.stage = 'STOPPED';
      this.record(null, 'STOP', canAdvanceEpoch ? 'STOP_ACTIVE' : 'STOP_EPOCH_EXHAUSTED');
    }
    return this.snapshot();
  }
  approvePlan(value: unknown): SimulatedSnapshot {
    if (this.stage === 'STOPPED' || this.stage === 'BLOCKED' || this.stage === 'PR_READY_AWAITING_HUMAN') return this.snapshot();
    if (this.stage !== 'AWAITING_PLAN_APPROVAL') { this.block('STALE_STAGE'); return this.snapshot(); }
    try {
      const v = data(value, ['kind', 'approvalId', 'issueId', 'issueNumber', 'repository', 'planDigest', 'generation', 'stopEpoch']);
      if (v.kind !== 'HUMAN_APPROVAL_FIXTURE' || !validId(v.approvalId) || !validId(v.issueId) ||
          !positive(v.issueNumber) || typeof v.planDigest !== 'string' || !SHA256.test(v.planDigest) ||
          !positive(v.generation) || !nonnegative(v.stopEpoch)) throw new Error('INVALID_APPROVAL');
      const repo = repository(v.repository);
      if (v.issueId !== this.issue.issueId || v.issueNumber !== this.issue.issueNumber ||
          !sameRepository(repo, this.issue.repository) || v.planDigest !== this.planDigest ||
          v.generation !== this.generation || v.stopEpoch !== this.stopEpoch) throw new Error('STALE_APPROVAL_BINDING');
    } catch (error) { this.block(error instanceof Error && error.message === 'STALE_APPROVAL_BINDING'
      ? 'STALE_APPROVAL_BINDING' : 'MALFORMED_APPROVAL'); return this.snapshot(); }
    this.stage = 'BUILDER_RUNNING_SIMULATED'; this.record(null, 'HUMAN_APPROVAL_FIXTURE_ACCEPTED', null);
    return this.snapshot();
  }
  advance(value?: unknown): SimulatedSnapshot {
    if (this.stage === 'STOPPED' || this.stage === 'BLOCKED' || this.stage === 'PR_READY_AWAITING_HUMAN') return this.snapshot();
    if (this.stage === 'PLAN_READY') {
      if (value !== undefined) this.block('UNEXPECTED_RESULT');
      else { this.stage = 'AWAITING_PLAN_APPROVAL'; this.record(null, 'PLAN_AWAITING_HUMAN_FIXTURE', null); }
      return this.snapshot();
    }
    if (this.stage === 'AWAITING_PLAN_APPROVAL') return this.snapshot();
    if (this.stage === 'CORRECTION_REQUIRED') {
      if (value !== undefined) this.block('UNEXPECTED_RESULT');
      else {
        if (!Number.isSafeInteger(this.generation) || this.generation >= Number.MAX_SAFE_INTEGER) {
          this.block('GENERATION_EXHAUSTED'); return this.snapshot();
        }
        this.corrections++; this.generation++; this.priorCommitSha = this.commitSha;
        this.commitSha = null; this.testerEvidence = null; this.reviewerEvidence = null;
        this.stage = 'BUILDER_RUNNING_SIMULATED'; this.record(null, 'CORRECTION_GENERATION_ADVANCED', null);
      }
      return this.snapshot();
    }
    const expectedRole = roleFor(this.stage);
    if (!expectedRole) { this.block('STALE_STAGE'); return this.snapshot(); }
    let result: FixtureRoleResult;
    try { result = parseResult(value); }
    catch { this.block('UNKNOWN_OR_MALFORMED_EVIDENCE', expectedRole); return this.snapshot(); }
    if (this.usedResults.has(result.resultId)) { this.block('DUPLICATE_RESULT', expectedRole); return this.snapshot(); }
    if (result.role !== expectedRole || result.stage !== this.stage || result.issueId !== this.issue.issueId ||
        result.issueNumber !== this.issue.issueNumber || !sameRepository(result.repository, this.issue.repository) ||
        result.planDigest !== this.planDigest || result.generation !== this.generation || result.stopEpoch !== this.stopEpoch) {
      this.block('STALE_RESULT_BINDING', expectedRole); return this.snapshot();
    }
    this.usedResults.add(result.resultId);
    if (result.outcome === 'UNKNOWN') { this.block('EVIDENCE_UNAVAILABLE', expectedRole); return this.snapshot(); }
    if (expectedRole === 'ORCHESTRATOR') {
      this.stage = 'PLAN_READY'; this.record(expectedRole, result.resultId, null); return this.snapshot();
    }
    if (expectedRole === 'BUILDER') {
      if (result.outcome !== 'PASS' || !result.commitSha || result.commitSha === this.priorCommitSha) {
        this.block(result.outcome !== 'PASS' ? 'BUILDER_FIXTURE_FAILED' : 'UNCHANGED_CORRECTION_COMMIT', expectedRole);
      } else {
        this.commitSha = result.commitSha; this.testerEvidence = null; this.reviewerEvidence = null;
        this.stage = 'TESTER_RUNNING_SIMULATED'; this.record(expectedRole, result.resultId, null);
      }
      return this.snapshot();
    }
    if (!this.commitSha || result.commitSha !== this.commitSha) { this.block('STALE_COMMIT_EVIDENCE', expectedRole); return this.snapshot(); }
    if (expectedRole === 'REVIEWER' && !this.testerEvidence) { this.block('TEST_EVIDENCE_MISSING', expectedRole); return this.snapshot(); }
    if (result.outcome === 'FAIL') {
      if (this.corrections >= 2) this.block('CORRECTION_BUDGET_EXCEEDED', expectedRole);
      else { this.stage = 'CORRECTION_REQUIRED'; this.record(expectedRole, result.resultId, result.blockerReason); }
      return this.snapshot();
    }
    if (expectedRole === 'TESTER') {
      this.testerEvidence = result.resultId; this.stage = 'REVIEWER_RUNNING_SIMULATED';
    } else { this.reviewerEvidence = result.resultId; this.stage = 'PR_READY_AWAITING_HUMAN'; }
    this.record(expectedRole, result.resultId, null);
    return this.snapshot();
  }

  /** Consumes explicit fixture outcomes, with no default PASS and no per-role approval. */
  runFixtureScript(value: unknown): SimulatedSnapshot {
    if (this.paused()) return this.snapshot();
    let steps: unknown[];
    try { steps = array(value, 16); }
    catch { this.block('MALFORMED_FIXTURE_SCRIPT'); return this.snapshot(); }
    let index = 0;
    while (!this.paused()) {
      if (this.stage === 'PLAN_READY' || this.stage === 'CORRECTION_REQUIRED') { this.advance(); continue; }
      if (index >= steps.length) { this.block('EVIDENCE_UNAVAILABLE', roleFor(this.stage)); break; }
      let step: FixtureScriptStep;
      try {
        const raw = data(steps[index++], ['role', 'outcome', 'resultId']);
        if (!['ORCHESTRATOR', 'BUILDER', 'TESTER', 'REVIEWER'].includes(raw.role as string) ||
            !['PASS', 'FAIL', 'UNKNOWN'].includes(raw.outcome as string) || !validId(raw.resultId)) throw new Error();
        step = raw as unknown as FixtureScriptStep;
      } catch { this.block('MALFORMED_FIXTURE_STEP', roleFor(this.stage)); break; }
      try { this.advance(fixtureRoleResult(this.snapshot(), step)); }
      catch { this.block('STALE_RESULT_BINDING', roleFor(this.stage)); }
    }
    if ((this.stage === 'PR_READY_AWAITING_HUMAN' || this.stage === 'AWAITING_PLAN_APPROVAL') &&
        index !== steps.length) this.block('UNUSED_FIXTURE_RESULTS');
    return this.snapshot();
  }

  prepareSyntheticPr(): SyntheticPrPreparation | null {
    if (this.stage !== 'PR_READY_AWAITING_HUMAN' || !this.commitSha || !this.testerEvidence || !this.reviewerEvidence)
      return null;
    return { fixtureOnly: true, actualPrExists: false, issueId: this.issue.issueId,
      repository: { ...this.issue.repository }, planDigest: this.planDigest, simulatedCommitSha: this.commitSha,
      summary: 'Fixture-only simulated Builder, Tester and Reviewer progression; human PR preparation is still required.' };
  }
}
