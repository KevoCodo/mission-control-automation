import { describe, expect, it } from 'vitest';
import { assessDisposableFixturePolicy, exampleFixturePolicy } from '../dockerFixturePolicy.js';

describe('disposable Docker sealed-fixture policy, deny-only', () => {
  it('a pinned and constrained shape remains NO-GO without independent evidence', () => {
    const result = assessDisposableFixturePolicy(exampleFixturePolicy());
    expect(result).toEqual({
      eligibleForIndependentReview: true, productionAuthorized: false,
      executable: false, gate: 'NO_GO', reasons: []
    });
  });
  it('untrusted image IDs, user identity and permissions fail closed', () => {
    const overrides: Record<string, unknown[]> = {
      imageDigest: ['ubuntu:latest', 'sha256:abc', 'SHA256:' + 'a'.repeat(64)],
      user: ['0', '0:0', 'root'],
      networkMode: ['bridge', 'host'],
      readOnlyRoot: [false],
      capDrop: ['NET_ADMIN', ''],
      noNewPrivileges: [false],
      privileged: [true],
      dockerSocketMounted: [true],
      hostPid: [true], hostIpc: [true], hostNetwork: [true],
      hostMounts: [[{ source: '/mnt/c', target: '/host' }]],
      devices: [['/dev/dri']], environment: [['AWS_SECRET_ACCESS_KEY']],
      cpus: [16], memoryMiB: [0], pidsLimit: [1024],
      timeoutSeconds: [0], automaticCleanup: [false],
      purpose: ['REAL_WORKER'], platform: ['windows']
    };
    for (const [key, values] of Object.entries(overrides)) for (const value of values) {
      const result = assessDisposableFixturePolicy({ ...exampleFixturePolicy(), [key]: value });
      expect(result.eligibleForIndependentReview, key).toBe(false);
      expect(result.executable, key).toBe(false);
      expect(result.gate, key).toBe('NO_GO');
    }
  });
  it('extra and missing fields, nulls, and nonordinary objects fail closed', () => {
    for (const value of [
      null, {}, { ...exampleFixturePolicy(), grantId: 'grant' },
      Object.fromEntries(Object.entries(exampleFixturePolicy()).filter(([k]) => k !== 'platform')),
      Object.assign(Object.create(null), exampleFixturePolicy())
    ]) {
      expect(assessDisposableFixturePolicy(value).eligibleForIndependentReview).toBe(false);
    }
  });
  it('a calling fixture cannot inject permission fields', () => {
    const result = assessDisposableFixturePolicy({ ...exampleFixturePolicy(), authorized: true });
    expect(result).toMatchObject({ gate: 'NO_GO', executable: false, productionAuthorized: false });
  });
});
