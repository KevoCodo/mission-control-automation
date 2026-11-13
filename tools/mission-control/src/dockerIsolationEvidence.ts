/** Pure, untrusted Phase 2 Gate A evidence inventory. Never a runtime authorization. */
export const DOCKER_GATE_A_CHECKS = [
  'HOST_IDENTITY', 'HOST_NONOVERLAP', 'DISPOSABLE_ROOT', 'WORKER_IDENTITY',
  'PINNED_FIXTURE', 'FILESYSTEM_BOUNDARY', 'KERNEL_RESTRICTIONS',
  'NETWORK_DENIAL', 'CREDENTIAL_ABSENCE', 'RESOURCE_LIMITS',
  'PROCESS_OBSERVER', 'CLEANUP_QUARANTINE', 'NEGATIVE_TEST_PLAN',
  'INDEPENDENT_REVIEW'
] as const;
export type DockerGateACheck = typeof DOCKER_GATE_A_CHECKS[number];
export type DockerGateAFinding = 'UNVERIFIED' | 'MISSING' | 'UNSUPPORTED' | 'REPORTED';
export interface DockerGateAFact {
  check: DockerGateACheck;
  finding: DockerGateAFinding;
  evidenceRef: string | null;
}
export interface DockerGateAInventory {
  version: 1;
  target: 'DOCKER_DESKTOP_WSL2';
  source: 'OPERATOR_REPORTED';
  facts: DockerGateAFact[];
}
export interface DockerGateAAssessment {
  status: 'NO_GO';
  executionAuthorized: false;
  independentlyAuthenticated: false;
  reportOnly: true;
  unresolved: DockerGateACheck[];
  errors: string[];
}
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype ||
        Object.getOwnPropertySymbols(value).length !== 0) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return Object.values(descriptors).every(desc => 'value' in desc && desc.enumerable) &&
      Object.keys(descriptors).length === Object.keys(value).length;
  } catch { return false; }
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return plain(value) && Object.keys(value).length === keys.length &&
    keys.every(k => Object.hasOwn(value, k));
}
function dense(value: unknown, n: number): value is unknown[] {
  if (!Array.isArray(value)) return false;
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype ||
        Object.getOwnPropertySymbols(value).length !== 0 ||
        value.length !== n) return false;
    const d = Object.getOwnPropertyDescriptors(value);
    return Object.keys(d).length === n + 1 &&
      Array.from({ length: n }, (_, i) => d[String(i)]).every(x => !!x && 'value' in x && x.enumerable);
  } catch { return false; }
}
/** A complete operator report is still only an operator assertion: NO_GO remains fixed. */
export function assessDockerGateAInventory(input: unknown): DockerGateAAssessment {
  const errors: string[] = [];
  const found = new Set<DockerGateACheck>();
  const reported = new Set<DockerGateACheck>();
  if (!exact(input, ['version', 'target', 'source', 'facts']) ||
      input.version !== 1 || input.target !== 'DOCKER_DESKTOP_WSL2' ||
      input.source !== 'OPERATOR_REPORTED' ||
      !dense(input.facts, DOCKER_GATE_A_CHECKS.length)) {
    errors.push('INVALID_GATE_A_INVENTORY');
  } else {
    for (const fact of input.facts) {
      if (!exact(fact, ['check', 'finding', 'evidenceRef']) ||
          !DOCKER_GATE_A_CHECKS.includes(fact.check as DockerGateACheck) ||
          !['UNVERIFIED', 'MISSING', 'UNSUPPORTED', 'REPORTED'].includes(fact.finding as string) ||
          (fact.evidenceRef !== null &&
            (typeof fact.evidenceRef !== 'string' || !ID.test(fact.evidenceRef)))) {
        errors.push('INVALID_GATE_A_FACT');
        continue;
      }
      const check = fact.check as DockerGateACheck;
      if (found.has(check)) errors.push('DUPLICATE_GATE_A_CHECK');
      found.add(check);
      if (fact.finding === 'REPORTED') {
        if (!fact.evidenceRef) errors.push('REPORTED_WITHOUT_REFERENCE');
        else reported.add(check);
      }
    }
    if (found.size !== DOCKER_GATE_A_CHECKS.length) errors.push('INCOMPLETE_GATE_A_CHECKS');
  }
  return { status: 'NO_GO', executionAuthorized: false,
    independentlyAuthenticated: false, reportOnly: true,
    unresolved: [...DOCKER_GATE_A_CHECKS].filter(x => !reported.has(x)), errors };
}
export function emptyDockerGateAInventory(): DockerGateAInventory {
  return { version: 1, target: 'DOCKER_DESKTOP_WSL2', source: 'OPERATOR_REPORTED',
    facts: DOCKER_GATE_A_CHECKS.map(check =>
      ({ check, finding: 'UNVERIFIED', evidenceRef: null })) };
}
