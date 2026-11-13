/** Synthetic-only cross-language contract. Never a trusted authorization grant or dispatch path. */
export interface LanggraphFixtureRequest {
  version: 1;
  kind: 'CONTROLLER_DECISION_REQUEST_FIXTURE';
  requestId: string;
  issueId: string;
  issueNumber: number;
  repository: { owner: string; name: string };
  planDigest: string;
  generation: number;
  stopEpoch: number;
  actionScope: 'ASSIGNMENT' | 'REVIEW' | 'CORRECTION';
  agentRole: 'ORCHESTRATOR' | 'BUILDER' | 'TESTER' | 'REVIEWER';
  commitSha: string | null;
}
const KEYS = ['version', 'kind', 'requestId', 'issueId', 'issueNumber', 'repository',
  'planDigest', 'generation', 'stopEpoch', 'actionScope', 'agentRole', 'commitSha'];
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const plain = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype &&
  Object.getOwnPropertySymbols(value).length === 0 &&
  Object.getOwnPropertyNames(value).length === Object.keys(value).length &&
  Object.keys(value).every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !!descriptor && 'value' in descriptor;
  });
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  plain(v) && Object.keys(v).length === keys.length &&
  keys.every(key => Object.hasOwn(v, key));
const id = (v: unknown): v is string => typeof v === 'string' && ID.test(v);
const number = (v: unknown, min: number): v is number => Number.isSafeInteger(v) && Number(v) >= min;

export function parseLanggraphFixtureRequest(value: unknown): LanggraphFixtureRequest {
  if (!exact(value, KEYS) || value.version !== 1 || value.kind !== 'CONTROLLER_DECISION_REQUEST_FIXTURE' ||
    !id(value.requestId) || !value.requestId.startsWith('fixture-') ||
    !id(value.issueId) || !value.issueId.startsWith('fixture-') ||
    !number(value.issueNumber, 1) || !exact(value.repository, ['owner', 'name']) ||
    !id(value.repository.owner) || !id(value.repository.name) ||
    typeof value.planDigest !== 'string' || !HASH.test(value.planDigest) ||
    !number(value.generation, 1) || !number(value.stopEpoch, 0) ||
    !['ASSIGNMENT', 'REVIEW', 'CORRECTION'].includes(value.actionScope as string) ||
    !['ORCHESTRATOR', 'BUILDER', 'TESTER', 'REVIEWER'].includes(value.agentRole as string) ||
    (value.commitSha !== null && (typeof value.commitSha !== 'string' || !COMMIT.test(value.commitSha)))) {
    throw new Error('INVALID_FIXTURE_REQUEST');
  }
  const allowed: Record<string, string[]> = {
    ORCHESTRATOR: ['ASSIGNMENT'], BUILDER: ['ASSIGNMENT', 'CORRECTION'],
    TESTER: ['REVIEW'], REVIEWER: ['REVIEW']
  };
  if (!allowed[value.agentRole as string]?.includes(value.actionScope as string))
    throw new Error('UNSUPPORTED_ROLE_ACTION');
  if ((value.agentRole === 'TESTER' || value.agentRole === 'REVIEWER') && value.commitSha === null)
    throw new Error('MISSING_EXACT_COMMIT');
  return { ...value, repository: { ...value.repository } } as unknown as LanggraphFixtureRequest;
}

/** Caller supplied valid claims must still be denied, without any ALLOW path. */
export function denyLanggraphFixtureRequest(value: unknown) {
  const request = parseLanggraphFixtureRequest(value);
  return {
    version: 1 as const, kind: 'CONTROLLER_DECISION_FIXTURE' as const,
    requestId: request.requestId, decision: 'DENY' as const,
    authoritative: false as const, productionAuthorized: false as const,
    executable: false as const, reason: 'NO_TRUSTED_CONTROLLER_ADAPTER' as const
  };
}
