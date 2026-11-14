import { describe, expect, it } from 'vitest';
import { exampleFixturePolicy } from '../dockerFixturePolicy.js';
import { previewDisabledDockerFixtureSpec } from '../dockerDisabledAdapterSpec.js';

const digest = 'sha256:' + 'a'.repeat(64);
const ref = 'alpine@' + digest;
const candidate = () => ({ ...exampleFixturePolicy(), imageDigest: digest });

describe('disabled Docker sealed fixture spec preview', () => {
  it('produces a non-executable, fixed no-network, nonroot review artifact', () => {
    const decision = previewDisabledDockerFixtureSpec(candidate(), ref);
    expect(decision.readyForReview).toBe(true);
    expect(decision.executable).toBe(false);
    if (!decision.readyForReview) throw new Error('Expected preview');
    const preview = decision.preview;
    expect(preview.launchAllowed).toBe(false);
    expect(preview.independentGateA).toBe('NO_GO');
    expect(preview.config).toMatchObject({
      Image: ref, User: '65532:65532', NetworkDisabled: true,
      Env: [], Cmd: ['/bin/true'],
      HostConfig: {
        NetworkMode: 'none', ReadonlyRootfs: true, Privileged: false,
        CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'],
        NanoCpus: 2_000_000_000, Memory: 2_147_483_648,
        MemorySwap: 2_147_483_648, PidsLimit: 64, Binds: [], Mounts: [],
        Devices: []
      }
    });
    expect(preview.config.HostConfig.Tmpfs['/workspace']).toContain('size=67108864');
    expect(preview.unresolvedEnforcement).toContain('FIVE_MINUTE_WATCHDOG');
    expect(preview.unresolvedEnforcement).toContain('HOST_DISK_AND_OUTPUT_QUOTAS');
  });
  it('refuses tag-only, wrong repository, missing, or mismatched digest', () => {
    for (const imageRef of [
      'alpine:latest', 'alpine@sha256:bad',
      'busybox@' + digest, 'alpine@sha256:' + 'b'.repeat(64),
      '', null
    ]) {
      expect(previewDisabledDockerFixtureSpec(candidate(), imageRef).readyForReview).toBe(false);
    }
  });
  it('rejects the all-zero example digest and prevents accidental use', () => {
    const policy = exampleFixturePolicy();
    const decision = previewDisabledDockerFixtureSpec(policy, 'alpine@' + policy.imageDigest);
    expect(decision).toMatchObject({
      readyForReview: false, executable: false
    });
  });
  it('refuses overrides that expose Docker, environment, devices, or host mounts', () => {
    const policy = candidate();
    for (const [key, value] of [
      ['networkMode', 'bridge'],
      ['user', '0:0'],
      ['privileged', true],
      ['hostMounts', [{ source: 'C:\\', destination: '/host' }]],
      ['dockerSocketMounted', true],
      ['environment', ['AWS_ACCESS_KEY_ID']],
      ['devices', ['/dev/dri']],
      ['timeoutSeconds', 0],
      ['memoryMiB', 8192]
    ] as const) {
      expect(previewDisabledDockerFixtureSpec({ ...policy, [key]: value }, ref).readyForReview,
        key).toBe(false);
    }
  });
  it('rejects unknown policy privileges or extra properties', () => {
    const decision = previewDisabledDockerFixtureSpec({ ...candidate(), authorized: true }, ref);
    expect(decision).toMatchObject({ readyForReview: false, executable: false });
    expect(decision).not.toHaveProperty('preview');
  });
});
