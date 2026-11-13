# Phase 2: first Docker fixture policy milestone

**Status: POLICY-ONLY, NO-GO. No executable worker is enabled.**

The local host inventory shared by the operator on November 13, 2026 indicates Docker Engine 29.2.1, Docker Desktop Linux context `desktop-linux`, WSL2, Linux x86_64, cgroup v2, seccomp builtin and 15.32 GiB memory. Those are operator-reported observations, not independently authenticated host evidence. There are three stopped containers which are **not** owned or modified by this effort.

`tools/mission-control/src/dockerFixturePolicy.ts` is a pure, deterministic assessor for a **future, sealed, non-AI** fixture. It **never** invokes Docker, creates an image/container/volume, opens a socket, reads credentials, selects or executes an executable, returns authorization, or authorizes the host. Invalid or incomplete configuration is rejected. Even an eligible proposal always returns `gate=NO_GO`, `productionAuthorized=false` and `executable=false`.

Proposed evaluation baseline: image identified by immutable SHA-256 digest, non-root UID/GID 65532, no elevated capability or privilege escalation, read-only root, no host mounts or devices, no ambient environment values, network mode none, 2 CPUs, 2048 MiB memory, 64 PIDs, 300 second timeout, cleanup requested. An example all-zero image digest is **a placeholder only**, not an approved image. It must never be launched. Host-enforced disk/output limits and actual automatic cleanup require separate verified implementation and are **not** guaranteed by this parser.

## Verify policy tests locally (Git Bash)

After a reviewable PR is merged and `main` is updated:

```bash
git pull origin main
npm test -- --run tools/mission-control/src/__tests__/dockerFixturePolicy.test.ts
```

This executes JavaScript unit tests **on the local development host**; it does not build or start containers. The normal project CI runs them as well. If npm test fails due to missing dependencies, use the repository's existing documented npm install procedure; don't alter Docker settings.

## Remaining evidence and permission gates

Before any `docker run` or disposable fixture experiment, Issue #7 requires an independent host/WSL2 trust-boundary review, exact disposable root and mount identity verification, pinned reviewed image, non-root/effective host policy, independently observed network denial, process lineage/cleanup completeness, credentials absence, and a signed Gate A decision. A signed Gate A would authorize **only** a separately scoped sealed-fixture experiment, not real AI agents. Issue #8 will then collect reproducible containment evidence. Issue #9 must supply trusted TypeScript-owned one-use grants and durable STOP ordering. The current status for all live execution is **NO-GO**.

No production, client, AO/Operis, GitHub write or real autonomous worker permission is introduced here.
