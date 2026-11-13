/** Proposed Docker fixture constraints only. No Docker API, CLI, launch or authorization. */
export interface DisposableFixturePolicy {
  version: 1;
  purpose: 'SEALED_FIXTURE_ONLY';
  platform: 'docker-desktop-wsl2';
  imageDigest: string;
  networkMode: 'none';
  readOnlyRoot: true;
  user: '65532:65532';
  capDrop: 'ALL';
  noNewPrivileges: true;
  privileged: false;
  hostPid: false;
  hostIpc: false;
  hostNetwork: false;
  dockerSocketMounted: false;
  hostMounts: [];
  devices: [];
  environment: [];
  cpus: 2;
  memoryMiB: 2048;
  pidsLimit: 64;
  timeoutSeconds: 300;
  automaticCleanup: true;
}
export interface FixturePolicyAssessment {
  eligibleForIndependentReview: boolean;
  productionAuthorized: false;
  executable: false;
  gate: 'NO_GO';
  reasons: string[];
}
const KEYS = ['version', 'purpose', 'platform', 'imageDigest', 'networkMode',
  'readOnlyRoot', 'user', 'capDrop', 'noNewPrivileges', 'privileged',
  'hostPid', 'hostIpc', 'hostNetwork', 'dockerSocketMounted', 'hostMounts',
  'devices', 'environment', 'cpus', 'memoryMiB', 'pidsLimit', 'timeoutSeconds',
  'automaticCleanup'] as const;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ownData = (v: unknown): v is Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  try {
    if (Object.getPrototypeOf(v) !== Object.prototype || Object.getOwnPropertySymbols(v).length) return false;
    const desc = Object.getOwnPropertyDescriptors(v);
    return Object.keys(desc).length === Object.keys(v).length &&
      Object.values(desc).every(d => Object.hasOwn(d, 'value') && d.enumerable);
  } catch { return false; }
};
export function assessDisposableFixturePolicy(input: unknown): FixturePolicyAssessment {
  const reasons: string[] = [];
  if (!ownData(input) || Object.keys(input).length !== KEYS.length ||
      !KEYS.every(k => Object.hasOwn(input, k))) {
    reasons.push('INVALID_OR_INCOMPLETE_POLICY');
  } else {
    const expected: Record<string, unknown> = {
      version: 1, purpose: 'SEALED_FIXTURE_ONLY', platform: 'docker-desktop-wsl2',
      networkMode: 'none', readOnlyRoot: true, user: '65532:65532',
      capDrop: 'ALL', noNewPrivileges: true, privileged: false,
      hostPid: false, hostIpc: false, hostNetwork: false,
      dockerSocketMounted: false, cpus: 2, memoryMiB: 2048,
      pidsLimit: 64, timeoutSeconds: 300, automaticCleanup: true
    };
    for (const [field, value] of Object.entries(expected)) {
      if (input[field] !== value) reasons.push('UNSAFE_OR_UNSUPPORTED_' + field.toUpperCase());
    }
    if (typeof input.imageDigest !== 'string' || !DIGEST.test(input.imageDigest))
      reasons.push('UNPINNED_IMAGE');
    for (const field of ['hostMounts', 'devices', 'environment']) {
      const arr = input[field];
      if (!Array.isArray(arr) || Object.getPrototypeOf(arr) !== Array.prototype ||
          Object.getOwnPropertySymbols(arr).length !== 0 ||
          Object.keys(arr).length !== 0 || arr.length !== 0)
        reasons.push('UNSUPPORTED_' + field.toUpperCase());
    }
  }
  return { eligibleForIndependentReview: reasons.length === 0,
    productionAuthorized: false, executable: false, gate: 'NO_GO', reasons };
}
/** Synthetic policy example. The digest is a placeholder, not a reviewed image. */
export function exampleFixturePolicy(): DisposableFixturePolicy {
  return {
    version: 1, purpose: 'SEALED_FIXTURE_ONLY',
    platform: 'docker-desktop-wsl2', imageDigest: 'sha256:' + '0'.repeat(64),
    networkMode: 'none', readOnlyRoot: true, user: '65532:65532',
    capDrop: 'ALL', noNewPrivileges: true, privileged: false,
    hostPid: false, hostIpc: false, hostNetwork: false,
    dockerSocketMounted: false, hostMounts: [], devices: [], environment: [],
    cpus: 2, memoryMiB: 2048, pidsLimit: 64, timeoutSeconds: 300,
    automaticCleanup: true
  };
}
