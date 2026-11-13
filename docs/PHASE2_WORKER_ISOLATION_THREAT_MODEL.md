# Phase 2 / Issue #7: disposable worker isolation threat model and GO/NO-GO design

**Status: DESIGN CANDIDATE ONLY. NO-GO for runtime, real worker launch, or production integration.**
**Reviewer decision: PENDING.** No OS-level experiment, host change, container build/run, credential issuance, or agent dispatch was performed for this document.

## 1. Decision in scope

Evaluate an **unprivileged Linux OCI container** with a dedicated disposable test workspace as the first *candidate* runtime for future bounded, supervised coding workers. Docker or a rootless container engine on a dedicated Linux VM is a candidate implementation, not an approved security boundary. Docker Desktop / WSL2 on a Windows workstation is an alternate evaluation host only after separately checking daemon privileges, host mounts, WSL distribution boundaries, and escape impact. Neither environment is assumed secure because it uses containers.

This decision does **not** replace or approve the separate [Windows Gate 2B experiment plan](BUILDER_WINDOWS_GATE2B_EXPERIMENT_PLAN.md). Windows Experiment 00 and subsequent native investigations remain NO-GO. No Linux kernel feature is assumed to provide an equivalent Windows evidence guarantee.

The first allowable experiment, **after independent written authorization**, is a fixed non-AI fixture program from reviewed and hashed bytes in a disposable environment. A generic command runner, Codex executable, arbitrary shell payload, AO, Operis, real repositories, networked provider, and GitHub writes are outside this experiment.

## 2. Authority, assets and adversary

| Boundary / asset | Owner / requirement | Threat |
| --- | --- | --- |
| Admission and STOP | TypeScript Mission Control controller, independently enforced at effect boundary | Untrusted LangGraph fixture, stale approval or delayed dispatch triggers execution |
| Worker image/executable | Custodian-owned immutable digest and independently verified signature/source | Swapped executable, poisoned image/tag or untrusted build input |
| Host filesystem | Disposable workspace and explicitly mounted paths only | Symlink, procfs, mount or volume escape; host credential and repository reads |
| Credentials | None in initial experiment; no host cloud/GitHub keys inside worker | Ambient tokens, SSH agent, host sockets or environment leakage |
| Process tree | Entire container and its descendants, including orphan/reparented processes | Fork, daemonize, detached child, PID reuse, re-entry after STOP |
| Network | Denied by default at namespace/firewall/host boundary | Unapproved DNS, dependency downloads, exfiltration or access to host services |
| Evidence | Independent OS/engine observer with protected records | Worker self-report, lost events, forged receipt, incomplete cleanup |
| Resources | Host-enforced CPU/memory/PID/runtime/output ceilings | Fork bomb, disk fill, CPU starvation, supervisor denial |
| Host / control plane | Separate privileged custodian identity; no worker access to engine socket | Daemon API abuse, privileged mode, container escape or host compromise |

Assume the worker can execute arbitrary instructions, ignore prompts, alter its working files, generate malicious filenames and scripts, and attempt to mislead logs and reviewers. Do not treat prompts, fixture PASS, local process exit, PID or container ID as trusted confinement proof.

## 3. Proposed isolation baseline (all subject to independent verification)

- Separate disposable Linux VM preferred for first evaluation; record host and kernel versions, kernel hardening and virtualization boundary before GO. Do not use a machine with live AO, Operis, customer data or production cloud credentials.
- Non-root worker UID, rootless engine if supported; no privileged container, no host PID/IPC/network namespace, no host Docker/Podman socket, no devices, no host process handles, no added capabilities, deny privilege escalation, restrictive seccomp and LSM profile reviewed for actual effective enforcement.
- Read-only root filesystem; writable ephemeral workspace only, owned by dedicated identity. Temp and output quotas. No bind mount outside the verified disposable root. Explicit destination rules and handle-based checks for symlinks, hard links, mount points, path replacement and time-of-check/time-of-use races.
- Deny network traffic by default, independently observe and test both IPv4 and IPv6, DNS, host gateway and Unix sockets. An allowlist is a separate design revision requiring review.
- Clean constructed environment and empty credential mounts. Do not inherit HOME, SSH_AUTH_SOCK, cloud credential variables, Git config, git credential helpers, proxy variables or personal environment settings.
- Host-enforced cgroup v2 CPU, memory and PID caps, timeout, output-size cap, and bounded storage. Exact values are **TBD**, not asserted defaults; do not run until capacities are set and measured.
- Independent supervisor/custodian observes creation, PID namespace and host PID mapping, descendant lineage and post-stop absence. Record event loss, time source and observer continuity; a missing child event does not prove no child.
- A separately designed controller authorization gate and durable STOP fence must bind worker identity, exact image/executable digest, issue, repository, worktree, action, generation, STOP epoch, limits and expiry before **any** effect. Issue #9 will design that authority; no launch integration in #7.

## 4. Proposed disposable roots (not created, verified, or approved)

- On a **separate Linux VM only**, proposed root: `/var/tmp/mission-control-isolation-disposable`. This is a *candidate path*, not proof of safety. Before approval, custodian independently verifies mount/device ID, path ownership and ancestry, no symlink/bind-mount overlap, effective permissions, absence of live data, no existing contents, and filesystem suitability.
- Inside the root, plan `images/` (custodian-protected), `work/` (worker-writable), `canaries/` (worker-denied), `evidence/` (independent reviewer only), `cleanup/` (reviewer logs).
- Docker Desktop/WSL2 does not inherit approval from this proposal. A Windows host requires separate named disposable path, daemon/WSL threat model, and independent review. Do **not** reuse the Windows Gate 2B `E:\AI-Development\isolated\mission-control-gate2b-disposable` path for the Linux experiment.
- No directory creation, image pull, container run, test fixture launch, ACL edit, runtime capability or egress change is authorized by the path proposal.

## 5. Mandatory negative-test matrix for a later, separately approved experiment

Each test needs a recorded source digest, signed fixture identity, launch authorization, observer start/end coverage, independent OS/engine evidence and cleanup decision. `PASS` below means **expected denial observed independently**, not fixture self-report.

| ID | Test / attempted violation | Expected boundary | Required independent evidence | On failure / uncertainty |
| --- | --- | --- | --- | --- |
| ISO-01 | Read outside workspace and protected canary | Host and mount isolation denies | File/open syscall or host audit plus canary unchanged | NO-GO |
| ISO-02 | Write/rename/link via symlink, hard link, traversal and mount transitions | No outside write | Canonical handle/mount IDs, pre/post canary hashes | NO-GO |
| ISO-03 | Access SSH agent, cloud vars, Git creds, host service socket | Zero inherited secrets or socket access | Trusted env/mount inventory and denied access | NO-GO |
| ISO-04 | DNS, IPv4, IPv6, host gateway, Unix socket egress | Default-deny network | Namespace, firewall and independent packet/socket observation | NO-GO |
| ISO-05 | Fork and daemonize descendants or try to escape PID namespace | Strict PID limit; descendants fenced | Host PID + start time, cgroup membership and full lineage | NO-GO |
| ISO-06 | Timeout or custodian STOP during launch, run and cleanup | No later effect/start; all descendants terminated | Durable fence ordering, engine lifecycle and independent descendant absence | NO-GO |
| ISO-07 | Crash supervisor/engine, lose observer, reboot host | Cannot silently resume; uncertain state quarantined | Recovery ledger, restarted observer evidence and no auto-retry | NO-GO |
| ISO-08 | Exhaust memory, CPU, process count, disk and output | Enforced budgets protect host | Kernel cgroup counters, memory/PID events, disk quotas and timeouts | NO-GO |
| ISO-09 | Attempt capabilities, privileged mode, device or host namespace use | No escalation | Effective container spec, kernel policy, denied requests | NO-GO |
| ISO-10 | Replace image/tag, executable, source, or workspace after preflight | Exact immutable identity bound to execution | Digests, file/mount IDs and verified image identity at launch | NO-GO |
| ISO-11 | Replay stale approval, generation, STOP epoch or grant | Controller denies before effect | Durable grant/fence receipts and observed absence of launch | NO-GO |
| ISO-12 | Tamper with self-reported result or hide short-lived child | Observer cannot trust worker claims | Independent trace continuity, loss bounds, cross-check with kernel/engine | NO-GO |

**Evidence limits:** container logs, test assertions, engine exit code, cgroup snapshots and `docker inspect` alone are not proof of total process or host isolation. Require at least one independent observation source whose completeness, permissions and failure behavior have been reviewed. A missing signal is UNKNOWN, never PASS.

## 6. Explicit phase gates

**Gate A, architecture approval (Issue #7):** Independent reviewer names the isolated host, kernel/engine versions, trust boundaries, exact root and effective path ownership, immutable fixture source, expected observer and privileges, non-overlap with live systems, complete negative-test procedures, rollback/cleanup and failure quarantine. Reviewer signs GO/NO-GO with date, scope and evidence reference. **Current: PENDING / NO-GO.**

**Gate B, controlled experiment (Issue #8):** Separately authorize only a sealed fixed fixture and produce independently observed evidence for each required denial, exact process identity, descendant cleanup, loss detection and resource enforcement. Any unverified row or uncertainty is NO-GO.

**Gate C, authorization integration (Issue #9):** Independently prove authenticated controller-originated one-use grants, fencing at dequeue and spawn/effect, replay resistance, crash-safe recovery and irrevocable STOP. A graph checkpoint or well-formed request never counts as approval.

**Gate D, real coding agent (Issue #11 onward):** Only after Gates A–C and explicit human authorization for a limited disposable issue. No default enablement, no implicit elevation to GitHub writes, merge, issue closure or production deployment.

## 7. Decision record and independent review template

- Candidate host / OS / engine and version: **TBD**
- Exact disposable root and independent path evidence: **TBD**
- Reviewed immutable fixture source/sha/image digest: **TBD**
- Observer source, loss detection and supervisor identity: **TBD**
- Exact resource limits and egress policy: **TBD**
- Threat model concerns and accepted/residual risks: **TBD**
- Test cases approved or deferred with reasons: **TBD**
- Independent reviewer identity, approval date, evidence reference: **TBD**
- **Gate A decision: NO-GO until completed and explicitly signed**

## 8. Relationship to existing work

Reuse the claims-only `docs/SUPERVISED_WORKER_ISOLATION_CONTRACTS.md`, `docs/SUPERVISED_EXECUTION_ARCHITECTURE.md` and `docs/EXECUTION_PROTOCOL_CONTRACTS.md` as security design inputs, not executable authorities. The Windows native build and process observer docs establish source/assessor foundations only, not demonstrated containment. See `docs/BUILDER_WINDOWS_GATE2B_EXPERIMENT_PLAN.md` and `docs/BUILDER_WINDOWS_PROCESS_OBSERVER_FOUNDATION.md` for that separate still-NO-GO investigation. Phase 1C's deny-only controller contract likewise does not authorize any worker.

This issue produces a **reviewable threat-model proposal**. It must not be closed as "approved design" until an independent reviewer signs Gate A with verified host/root facts.
