# Disabled Docker adapter specification: first integration seam

**Gate A NO-GO. This PR cannot execute containers.**

This milestone adds a TypeScript-only **Docker Engine create-spec preview**, not an adapter connected to Docker Desktop. It takes a proposal already constrained by `dockerFixturePolicy.ts` and an exact image reference in the form `alpine@sha256:<64 hex>`. It outputs a review artifact with `launchAllowed=false`, `independentGateA=NO_GO` and `executable=false`, with no Docker CLI, API, socket, child process, filesystem access, or agent dispatch.

## Fixed fixture configuration

- Sealed test workload **only**: `/bin/true`, with exact image digest placeholder supplied by a caller. The image and its digest must be independently reviewed before future use. The synthetic all-zero digest is rejected.
- Non-root UID:GID `65532:65532` (our current strict policy), capabilities dropped, no-new-privileges, non-privileged.
- `NetworkMode=none`; no environment variables, host binds, devices, Docker socket or container mounts.
- Read-only root filesystem, dedicated size-limited in-memory `/workspace` (64 MiB) and `/tmp` (16 MiB). No host workspace is mounted. Tmpfs memory is accounted toward the container's memory allocation, but this proposal is not actual enforcement evidence.
- Two CPU quota, 2 GiB RAM and swap cap, 64 PIDs, and capped local log rotation. All require live verification.
- `AutoRemove=false` so future protected observers may inspect the terminated container before an independently verified removal. Nothing in this PR triggers removal.

A `300 second` wall-clock watchdog, disk/output quotas beyond the specifically sized tmpfs and local log, process-tree evidence, durable STOP, trusted one-use grants and independent Gate A review are **NOT** implemented. The preview lists these unresolved items and never treats its own content as authorization.

## Safe unit test

```bash
git pull origin main
npx vitest run tools/mission-control/src/__tests__/dockerDisabledAdapterSpec.test.ts --environment node
```

The test suite constructs JavaScript objects only, without starting Docker or touching the existing ContextFlow containers.

## Path to the first approved live fixture

1. Complete the independent Gate A host/container review, including the WSL2 trust boundary, exact reviewed Alpine image digest, host OS evidence, safe observer and all required negative-test design. The operator's previous self-review is useful inventory, not independent approval.
2. Design a trusted TypeScript-only runtime provider that can create a **sealed fixture container** only after an independent narrowly scoped approval. A plain preview object must never be an executable instruction or grant.
3. Enforce the deadline, independent cleanup and STOP fencing with durable state and failure handling before real workloads.
4. Keep Codex, other AI agents, GitHub writes, and production repositories outside the container until later gates are independently approved.

See Issue #7 for Gate A and Issue #8 for planned containment experiments.
