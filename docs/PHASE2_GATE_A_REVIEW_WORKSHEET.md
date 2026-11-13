# Phase 2 Gate A: independent isolation design review worksheet

**Epic #3 / Issue #7. Status: NOT APPROVED. NO-GO.**  
Companion to [Phase 2 isolation threat model](PHASE2_WORKER_ISOLATION_THREAT_MODEL.md). This worksheet is for a qualified **independent reviewer**. A completed questionnaire or passing CI does not establish containment and cannot authorize any worker to run.

## Host selection and evidence record

| Required reviewer finding | Recorded value / evidence link | Result |
| --- | --- | --- |
| Dedicated disposable Linux VM or separate approved host; owner and custodian | TBD | UNVERIFIED |
| Host OS, kernel and patches, container runtime and configuration | TBD | UNVERIFIED |
| Host isolation from production, AO, Operis, and client data | TBD | UNVERIFIED |
| Proposed root verified by handle, mount/device, component identity and protected ancestry | TBD | UNVERIFIED |
| Least-privilege test identity, no admin/root or engine socket access | TBD | UNVERIFIED |
| Reviewed immutable image, source, binary and all transitive inputs | TBD | UNVERIFIED |
| Effective read-only mounts; named writable workspace; all other paths denied | TBD | UNVERIFIED |
| Kernel policy: namespaces, capability drop, no-new-privileges, seccomp, LSM | TBD | UNVERIFIED |
| Denied network and host/loopback gateway, DNS, IPv4 and IPv6 | TBD | UNVERIFIED |
| No ambient env, HOME, cloud tokens, SSH agent, Git/GitHub credentials | TBD | UNVERIFIED |
| Explicit cgroup CPU, memory, PID, disk, output and runtime limits | TBD | UNVERIFIED |
| Independent process observer, identity/ancestry and loss-detection coverage | TBD | UNVERIFIED |
| Independent protected evidence storage and cleanup/quarantine procedure | TBD | UNVERIFIED |
| Review of ISO-01 through ISO-12 negative-test procedures | TBD | UNVERIFIED |
| Reviewer identity, scope, approval timestamp and signed decision | TBD | NOT APPROVED |

Every required row must have independently obtained, reproducible evidence. Do not infer verification from container configuration strings, proposed docs, CI tests, fixture output, local path claims, or the assistant's analysis.

## Gate A decisions

- **NO-GO (current):** any missing, uncertain, contradictory or unreviewed evidence, or the absence of an independently signed decision. No container process, even a fixed fixture, may be started as part of this milestone.
- **GO for a future separately authorized sealed-fixture experiment only:** all preflight details verified and independent reviewer signs scope and exact approved fixture/root. GO at Gate A is *not* a containment result, worker authorization, or permission to use real agents.
- **Gate B remains separately required under Issue #8** to produce independent OS evidence of containment, descendant termination, cleanup, absence of network/credential leaks, and fail-closed uncertainty.
- **Gate C remains separately required under Issue #9** for controller-owned authenticated one-use grants and durable STOP ordering.

## Required human review declaration

> I independently reviewed the exact host, disposable root and immutable fixture, process and filesystem boundaries, observer completeness, resource limits and cleanup plan. My decision is (GO / NO-GO) **for the sealed, non-AI experiment only**. Evidence references: ____. Reviewer: ____. Date: ____. Conditions: ____.

**Do not fill or sign this declaration using an LLM or synthetic fixture.** A missing independent reviewer is a blocker, not an implicit approval.

## Next safe action

Obtain the selected evaluation host type (dedicated disposable Linux VM preferred; Docker Desktop/WSL2 requires its own assessment) and an independent reviewer who can verify the actual host security controls. Until then, CI-only documentation or pure-function test changes can proceed; no runtime execution may occur.
