import { assessDisposableFixturePolicy, type DisposableFixturePolicy } from './dockerFixturePolicy.js';

/**
 * Review-only Docker Engine create-spec template.
 * No CLI calls, socket calls, executable code, or permission grants.
 * IMPORTANT: the preview is not suitable as an authorization token or as proof
 * of effective runtime restrictions.
 */
export interface DisabledDockerSpecPreview {
  kind: 'NON_EXECUTABLE_DOCKER_SPEC_PREVIEW';
  launchAllowed: false;
  independentGateA: 'NO_GO';
  requiresTrustedRuntime: true;
  config: {
    Image: string;
    User: '65532:65532';
    NetworkDisabled: true;
    AttachStdin: false;
    OpenStdin: false;
    Tty: false;
    Env: [];
    WorkingDir: '/workspace';
    Cmd: ['/bin/true'];
    HostConfig: {
      NetworkMode: 'none';
      ReadonlyRootfs: true;
      Privileged: false;
      CapDrop: ['ALL'];
      SecurityOpt: ['no-new-privileges:true'];
      NanoCpus: 2_000_000_000;
      Memory: 2_147_483_648;
      MemorySwap: 2_147_483_648;
      PidsLimit: 64;
      Init: true;
      AutoRemove: false;
      Binds: [];
      Mounts: [];
      Devices: [];
      Tmpfs: {
        '/tmp': 'rw,noexec,nosuid,nodev,size=16777216,mode=1777';
        '/workspace': 'rw,noexec,nosuid,nodev,size=67108864,uid=65532,gid=65532,mode=0700';
      };
      LogConfig: { Type: 'local'; Config: { 'max-size': '1m'; 'max-file': '1' } };
    };
  };
  /** Host-enforced watchdog and validated cleanup have not been implemented. */
  unresolvedEnforcement: readonly [
    'FIVE_MINUTE_WATCHDOG',
    'INDEPENDENT_PROCESS_TREE_EVIDENCE',
    'DURABLE_STOP_BARRIER',
    'TRUSTED_ONE_USE_GRANT',
    'HOST_DISK_AND_OUTPUT_QUOTAS',
    'EFFECTIVE_KERNEL_POLICY_REVIEW'
  ];
}
export type DisabledDockerSpecDecision =
  | { readyForReview: true; executable: false; preview: DisabledDockerSpecPreview }
  | { readyForReview: false; executable: false; reasons: string[] };

const REF = /^alpine@sha256:[a-f0-9]{64}$/;
/** Build an inert proposal for a fixed, sealed Alpine /bin/true test only. */
export function previewDisabledDockerFixtureSpec(
  policy: unknown,
  imageRef: unknown
): DisabledDockerSpecDecision {
  const assessment = assessDisposableFixturePolicy(policy);
  const reasons = [...assessment.reasons];
  if (typeof imageRef !== 'string' || !REF.test(imageRef))
    reasons.push('IMAGE_REFERENCE_MUST_BE_PINNED_ALPINE');
  else if (policy === null || typeof policy !== 'object' ||
      imageRef.slice('alpine@'.length) !== (policy as Partial<DisposableFixturePolicy>).imageDigest)
    reasons.push('IMAGE_DIGEST_MISMATCH');
  if (imageRef === 'alpine@sha256:' + '0'.repeat(64))
    reasons.push('PLACEHOLDER_IMAGE_DIGEST');
  if (reasons.length) return { readyForReview: false, executable: false, reasons };
  return {
    readyForReview: true, executable: false,
    preview: {
      kind: 'NON_EXECUTABLE_DOCKER_SPEC_PREVIEW',
      launchAllowed: false, independentGateA: 'NO_GO',
      requiresTrustedRuntime: true,
      config: {
        Image: imageRef as string, User: '65532:65532',
        NetworkDisabled: true, AttachStdin: false, OpenStdin: false,
        Tty: false, Env: [], WorkingDir: '/workspace', Cmd: ['/bin/true'],
        HostConfig: {
          NetworkMode: 'none', ReadonlyRootfs: true, Privileged: false,
          CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'],
          NanoCpus: 2_000_000_000, Memory: 2_147_483_648,
          MemorySwap: 2_147_483_648, PidsLimit: 64,
          Init: true, AutoRemove: false, Binds: [], Mounts: [], Devices: [],
          Tmpfs: {
            '/tmp': 'rw,noexec,nosuid,nodev,size=16777216,mode=1777',
            '/workspace': 'rw,noexec,nosuid,nodev,size=67108864,uid=65532,gid=65532,mode=0700'
          },
          LogConfig: { Type: 'local', Config: { 'max-size': '1m', 'max-file': '1' } }
        }
      },
      unresolvedEnforcement: [
        'FIVE_MINUTE_WATCHDOG', 'INDEPENDENT_PROCESS_TREE_EVIDENCE',
        'DURABLE_STOP_BARRIER', 'TRUSTED_ONE_USE_GRANT',
        'HOST_DISK_AND_OUTPUT_QUOTAS', 'EFFECTIVE_KERNEL_POLICY_REVIEW'
      ]
    }
  };
}
