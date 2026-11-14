# Phase 2 Gate A: independent isolation design review worksheet

**Epic #3 / Issue #7. Status: NOT APPROVED. NO-GO.**  
Companion to [Phase 2 isolation threat model](PHASE2_WORKER_ISOLATION_THREAT_MODEL.md). This worksheet is for a qualified **independent reviewer**. A completed questionnaire or passing CI does not establish containment and cannot authorize any worker to run.

## Issue #7: candidate host evidence and exact outstanding findings (November 2026)

**Status: operator-reported inventory; NOT independently verified. Gate A remains NO-GO.**
This section records observed/reportable details to speed up the one required design review, not to approve execution.

| Gate A category | Currently reported or proposed | Decision / evidence still required |
| --- | --- | --- |
| Host / engine identity | Windows workstation, Docker Desktop Linux context `desktop-linux`; client/server v29.2.1; WSL2, Linux kernel `6.18.58.1-microsoft-standard-WSL2`, cgroup v2, built-in seccomp | Reviewer independently corroborates host, Docker daemon endpoint/security settings, WSL2/Windows version and patch status |
| Separation from other work | Existing ContextFlow containers/images on the *same Docker Desktop engine*; worker-test was removed | Reviewer must assess whether shared workstation/daemon and live client/project data meet the threat model; do not assume isolated host |
| Exact disposable workspace | Gemini reported one workspace bind, but its canonical Windows source path, identity and mount rights were not provided; later adapter proposal uses only tmpfs | Choose **one** model and approved exact root: zero host binds with fixed in-memory workspace preferred for sealed fixture. Verify Windows/WSL mount boundary and root ancestry if any host bind remains |
| Image and executable | Operator-reported SHA-256 `f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf`; Alpine `worker-test` previously used a mutable `alpine:latest` tag | Determine whether SHA is image ID, manifest digest, or something else; verify reviewed immutable image manifest/source and exact fixed executable digest; **do not** treat reported hex as approved image ref |
| Least privilege | Gemini reports nonroot `1000:1000`, cap drop ALL, no-new-privileges and read-only root; current proposed policy specifies `65532:65532` | Settle UID/GID mismatch using verified image identity and inspect effective runtime, not just expected template |
| Network | Gemini reports `NetworkMode=none` | Independently verify namespace and egress denial plan including IPv4, IPv6, DNS, gateway, host/Unix sockets and effective firewall behavior |
| Credentials | Gemini reports no secret variables or mounts | Review effective env, image layers, host bind paths and sockets, especially Docker Desktop/WSL2 sharing |
| Resource limits | Gemini reports 2 CPUs, 2 GiB, 64 PIDs and 10 MiB log cap; prototype proposes 300-second deadline and tmpfs limits | Approve enforceable independent watchdog, disk/output ceilings and evidence collection; Docker log cap alone does not bound workspace disk |
| Process observer | None independently identified or verified; Docker inspect/exit code and successful `docker rm -f worker-test` do not prove process-tree absence | Name reviewer-controlled host/engine observer, required lineage fields, loss handling, protected evidence location, STOP/cleanup verification procedure |
| Negative test plan | ISO-01 through ISO-12 documented in threat model | Reviewer accepts or rejects each scenario, expected denial, observer coverage, failure quarantine and cleanup design **before** any scoped fixture run |
| Independent sign-off | No independent review declaration on record | Qualified independent reviewer supplies identity, date, bounded scope, evidence links, residual risks and signed GO/NO-GO |

### Design decision required before a reviewer can sign

- **Fixture test boundary:** Fixed, non-AI test program only. No Codex/Claude/LLM or generic shell executor.
- **Workspace decision:** Prefer *no host bind mounts* for the first sealed fixture to avoid shared host files. If a host bind is necessary, record its exact absolute Windows path, verified identity, ACLs, ancestry and access restrictions first. The previous `C:\\path` placeholder is **not** an approved root.
- **Observer decision:** A Docker object disappearance is insufficient; review process-ancestry and independent observer completeness and loss behavior.
- **Host nonoverlap:** Because ContextFlow and other workloads exist on this machine, an independent reviewer must decide whether Docker Desktop/WSL2 is an acceptable test host, or whether a more isolated environment is required.
- **Controller authority:** TypeScript remains sole trusted policy/admission authority. LangGraph never grants execution. No real worker or sealed fixture launch is authorized by this worksheet.

### Handoff and exit

Reviewer works from this worksheet, [isolation threat model](PHASE2_WORKER_ISOLATION_THREAT_MODEL.md), [Docker preflight](PHASE2_DOCKER_WSL2_PREFLIGHT.md), [fixture policy](PHASE2_DOCKER_FIXTURE_POLICY.md), and the Issue #7 acceptance criteria. Reviewer records independently verified facts and a scoped signature in the declaration below. If any required evidence or independent approval is missing, the **only** valid result remains NO-GO and Issue #7 stays open.

## Proposed sealed-fixture isolation and observation design for reviewer decision

**Proposal only. NOT approved; NO-GO.** This section resolves the *design choice* for Issue #7 without asserting a successful implementation or authorizing the Issue #8 experiment.

### A. Workspace boundary and container configuration (design selection)

For the **first sealed, non-AI fixture**, select **zero host bind mounts**. Use an in-container `/workspace` tmpfs (proposed 64 MiB, `uid=65532,gid=65532,mode=0700,nosuid,nodev,noexec`) and `/tmp` tmpfs (16 MiB, `nosuid,nodev,noexec`); other writable paths should be absent under a read-only root filesystem. No mapped `C:\`, `E:\`, home directory, repository, credential file, Docker/Podman socket, device or agent socket. This means there is **no host-side disposable bind-root path** to approve for this limited fixture. The reviewer must instead establish the actual *engine storage / WSL2 host containment boundary* and prove it does not expose other host projects or data. If the reviewer requires a host-side fixture root, **stop and revise the design**, name and verify it before GO. This choice does not revise the existing policy for future coding workers, which will need separately approved workspaces.

For the baseline review, the inert adapter preview proposes fixed `User=65532:65532`, `Cmd=["/bin/true"]`, `NetworkMode=none`, `ReadonlyRootfs=true`, `CapDrop=["ALL"]`, `no-new-privileges`, no elevated namespaces or devices, CPU quota 2 cores, memory/swap 2 GiB, PID limit 64, and bounded logs. The operator's prior experiment reported `1000:1000`; that is **not** proof of this proposed `65532:65532` effective UID. The actual Docker settings and image support for the chosen UID must be checked before Gate A GO.

**Image and binary:** The operator's `docker image inspect` reported `alpine@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf`, Linux/amd64, one layer `sha256:75f1d9657d880da5f75298e8f40e9928bb6e260c50d26f97af196845307e3064`, and image defaults `User=""`, `Cmd=["/bin/sh"]`. These are metadata observations only. Reviewer must independently verify that the reference is the exact platform artifact (including manifest/platform resolution where relevant), establish its provenance, and verify the specific `/bin/true` executable bytes and runtime dependencies. **No assumption that image metadata proves executable presence, integrity or effective runtime policy.** Do not use `alpine:latest` for a future approved run.

### B. Independent observation design (required verification, not established capability)

| Concern | Proposed source/evidence to evaluate | Reviewer acceptance requirement / failure action |
| --- | --- | --- |
| Container identity and start/exit/remove | Custodian-owned Docker Engine events and pre/post inspect, bound to immutable image, container ID, creation timestamp, and known fixture label | Record observer start before any approved launch; events alone do not prove OS containment; gaps, restarts or mismatch mean UNKNOWN/NO-GO |
| Process tree and descendants | Separate **host-side/WSL2 kernel-level** cgroup membership and PID/start-time observation, independent of worker logs; compare against Docker lifecycle | Demonstrate actual accessibility/visibility in Docker Desktop's WSL2/VM boundary, reliably capture short-lived and reparented children, and prove no survivors; if the host observer cannot achieve this, reject Docker Desktop host for this test |
| Filesystem and canary | Trusted host/mount identity observation and read-only denied-canary pre/post hashes (canary kept outside worker mount namespace) | Show no Windows drive mounts, no engine socket/devices, no writable host bind, and prevent symlink/mount-path escape; inability to verify is UNKNOWN/NO-GO |
| Network, DNS and gateway | Independent reviewer-controlled namespace/routing/firewall configuration inspection plus host/WSL2 packet or socket observation | Prove `network=none` denies IPv4, IPv6, DNS, host gateway and unintended Unix sockets; packet silence alone is not sufficient |
| Privileges and resources | Trusted effective Docker/OCI configuration, namespace/capability/seccomp observations and cgroup v2 CPU/memory/PID counters, plus tmpfs and log limits | Effective limits must match approved design; missing disk/output cap or indefinite execution means NO-GO |
| STOP, deadline and cleanup | Trusted supervisor monotonic deadline and protected lifecycle ledger; independent host/cgroup verification after termination and explicit object removal | Controller-owned STOP/durable fencing is Issue #9; for the Issue #8 sealed fixture, agree separately scoped external STOP/abort and quarantine procedure. Do not trust success solely from `docker rm -f` |
| Evidence integrity and observer loss | Custodian-owned append-only/restricted evidence location **outside the worker**, time correlation, observer health, event-loss counters and independent audit review | No worker write access; missing event, sensor restart, clock anomaly or incomplete lineage means NO-GO/quarantine; preserve records before cleanup |

**No particular Docker Desktop/WSL2 observer has yet been shown to satisfy these requirements.** A proposed tool or Docker inspect output is not independently authenticated evidence. Reviewer's explicit acceptance of observer completeness and failure behavior is essential.

### C. Gate A design review and experiment scope

1. Confirm this host is appropriate despite shared Docker Desktop engine and existing ContextFlow workload. If shared-host risk is unacceptable, reject this candidate and require a distinct approved host. Do not alter ContextFlow containers.
2. Independently verify OS/kernel/engine config, image/executable provenance, effective UID/capabilities and zero-host-bind plus tmpfs implementation feasibility.
3. Identify, configure and validate reviewer-owned OS process and network observations, protected evidence collection and handling of sensor loss, including ISO-01 through ISO-12 anticipated tests. **No tests are launched within Issue #7.**
4. Independently approve resource and cleanup strategy, exact fixed fixture, and a bounded scope to proceed to Issue #8, or record a NO-GO with reasons.
5. Reviewer signs the declaration at the end of this worksheet, including identity, date, evidence references, risks, constraints and decision. Gate A GO authorizes **only** separately scheduled sealed-fixture tests, never Codex/AI workers, real repositories, GitHub writes, or controller grants.

**Outstanding blockers:** reviewer-owned observer viability on Docker Desktop/WSL2; independent host non-overlap analysis; immutable fixture executable provenance; verified effective restrictions and quotas; signed scoped reviewer decision. Until all are resolved: **NO-GO**.

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
