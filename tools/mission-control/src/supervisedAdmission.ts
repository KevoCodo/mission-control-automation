import { evaluateAuthorization, parseAuthorizationRecord, parseAuthorizationState } from './authorization.js';
import type { IssuanceEvidence } from './authorization.js';
import type { AuthorizationAction, AuthorizationRecord, AuthorizationState, DispatchState } from './types.js';

/** An isolated planning snapshot. None of its fields is execution authority. */
export interface SupervisedAdmissionInput {
  now: string;
  request: {
    role: string;
    action: AuthorizationAction;
    actorId: string;
    repository: { owner: string; name: string };
    issueNumber: number;
    branch: string;
    dispatchId: string;
    generation: number;
  };
  stop: { active: boolean; generation: number };
  target: { repository: { owner: string; name: string }; issueNumber: number; branch: string; generation: number };
  dispatches: Array<{ dispatchId: string; repository: { owner: string; name: string }; issueNumber: number; branch: string; state: DispatchState }>;
  grant: AuthorizationRecord;
  issuanceEvidence: IssuanceEvidence;
  authorizationState: AuthorizationState;
  dependencies: { status: 'satisfied' | 'blocked' | 'unknown'; evidenceRef?: string };
  capacity: { limit: number; active: number; reserved: number; evidenceRef?: string };
}

export interface SupervisedAdmissionDecision {
  status: 'eligible' | 'blocked' | 'unknown';
  reason: string;
  eligibleForPlanning: boolean;
  productionAuthorized: false;
  executable: false;
}

const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const nonnegative = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const sameRepository = (a: { owner: string; name: string }, b: { owner: string; name: string }) => a.owner === b.owner && a.name === b.name;
const states: DispatchState[] = ['INTENT_RECORDED', 'SUBMITTING', 'ACCEPTED', 'REJECTED', 'UNCERTAIN', 'RETIRED', 'COMPLETED'];

function decision(status: SupervisedAdmissionDecision['status'], reason: string): SupervisedAdmissionDecision {
  return { status, reason, eligibleForPlanning: status === 'eligible', productionAuthorized: false, executable: false };
}

/** Pure eligibility calculation. Fixture evidence can establish scope for a plan, never permission. */
export function planSupervisedAdmission(value: unknown): SupervisedAdmissionDecision {
  if (!record(value)) return decision('blocked', 'MALFORMED_INPUT');
  const { request: q, stop, target, dispatches, dependencies, capacity } = value;
  if (!record(q) || !record(q.repository) || !id(q.actorId) || !id(q.repository.owner) || !id(q.repository.name) ||
    !positive(q.issueNumber) || !id(q.branch) || !id(q.dispatchId) || !positive(q.generation) ||
    !record(stop) || typeof stop.active !== 'boolean' || !positive(stop.generation) ||
    !record(target) || !record(target.repository) || !id(target.repository.owner) || !id(target.repository.name) ||
    !positive(target.issueNumber) || !id(target.branch) || !positive(target.generation) ||
    !Array.isArray(dispatches) || dispatches.some((item) => !record(item) || !id(item.dispatchId) ||
      !record(item.repository) || !id(item.repository.owner) || !id(item.repository.name) ||
      !positive(item.issueNumber) || !id(item.branch) || !states.includes(item.state as DispatchState)) ||
    !record(dependencies) || !['satisfied', 'blocked', 'unknown'].includes(String(dependencies.status)) ||
    (dependencies.evidenceRef !== undefined && !id(dependencies.evidenceRef)) ||
    !record(capacity) || !positive(capacity.limit) || !nonnegative(capacity.active) ||
    !nonnegative(capacity.reserved) || (capacity.evidenceRef !== undefined && !id(capacity.evidenceRef)) ||
    typeof value.now !== 'string' || !Number.isFinite(Date.parse(value.now)) ||
    new Date(value.now).toISOString() !== value.now) return decision('blocked', 'MALFORMED_INPUT');

  // S1 has only the existing issue-scoped ASSIGNMENT action. Other workers need distinct scoped actions.
  if (q.role !== 'BUILDER' || q.action !== 'ASSIGNMENT') return decision('blocked', 'UNSUPPORTED_ROLE_OR_ACTION');
  if (stop.active) return decision('blocked', 'STOP_ACTIVE');
  if (stop.generation !== q.generation || target.generation !== q.generation ||
    !sameRepository(q.repository as { owner: string; name: string }, target.repository as { owner: string; name: string }) ||
    target.issueNumber !== q.issueNumber || target.branch !== q.branch) return decision('blocked', 'STALE_TARGET_BINDING');

  const related = dispatches.filter((item) => item.dispatchId === q.dispatchId || item.issueNumber === q.issueNumber || item.branch === q.branch);
  if (related.some((item) => item.state === 'UNCERTAIN')) return decision('blocked', 'UNCERTAIN_DISPATCH');
  if (related.length !== 1 || related[0].dispatchId !== q.dispatchId || related[0].state !== 'INTENT_RECORDED' ||
    !sameRepository(related[0].repository as { owner: string; name: string }, q.repository as { owner: string; name: string }) ||
    related[0].issueNumber !== q.issueNumber || related[0].branch !== q.branch ||
    new Set(dispatches.map((item) => item.dispatchId)).size !== dispatches.length)
    return decision('blocked', 'CONFLICTING_DISPATCH');

  if (value.grant === undefined) return decision('blocked', 'GRANT_MISSING');
  let grant: AuthorizationRecord;
  let authState: AuthorizationState;
  try {
    grant = parseAuthorizationRecord(value.grant);
    authState = parseAuthorizationState(value.authorizationState);
  } catch { return decision('blocked', 'MALFORMED_AUTHORIZATION'); }
  if (!authState.grants.some((item) => item.grantId === grant.grantId && JSON.stringify(item) === JSON.stringify(grant)))
    return decision('blocked', 'CONTRADICTORY_AUTHORIZATION');
  const evidence = value.issuanceEvidence as IssuanceEvidence | undefined;
  const auth = evaluateAuthorization(grant, evidence, {
    action: 'ASSIGNMENT', actorId: q.actorId as string,
    repository: q.repository as { owner: string; name: string },
    target: { kind: 'issue', number: q.issueNumber as number }, issueNumber: q.issueNumber as number
  }, authState, new Date(value.now));
  if (!auth.scopeValid) return decision('blocked', auth.reason);
  if (dependencies.status === 'blocked') return decision('blocked', 'DEPENDENCY_BLOCKED');
  if (dependencies.status !== 'satisfied' || !id(dependencies.evidenceRef)) return decision('unknown', 'DEPENDENCY_EVIDENCE_MISSING');
  if (!id(capacity.evidenceRef)) return decision('unknown', 'CAPACITY_EVIDENCE_MISSING');
  if ((capacity.active as number) + (capacity.reserved as number) >= (capacity.limit as number))
    return decision('blocked', 'CAPACITY_EXHAUSTED');
  return decision('eligible', 'PLANNING_SCOPE_VALID_FIXTURE_ONLY');
}
