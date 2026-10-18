# Supervised execution architecture (S1)

**Status:** architecture proposal plus a pure admission planner. No worker runner, credential issuer, trusted grant verifier, network adapter, live AO dispatch, merge, close, or deployment is implemented. The historical `issue12-phase2h-supervised-assignment` delivery remains unresolved and is excluded from this design's inputs.

## Boundary and reuse

The proposed path is GitHub Issue → Orchestrator → Builder → Tester → Reviewer → correction loop → Pull Request → approved merge → completion evidence. A supervisor approves each privileged step. A role name, local plan, stored claim, simulated receipt, test fixture, or process exit is never authority. B1 live AO assignment remains denied; B2 uncertain identities remain quarantined; B3A production permission remains denied; B3B's AO protocol and fencing no-go remains in force. This architecture is independent of AO and does not migrate its uncertain delivery or reuse AO sessions as worker receipts.

| Proposed component | Reusable controller code | Missing trusted enforcement |
| --- | --- | --- |
| Delivery planner | `graph.ts`, `planner.ts`, discovery and dependency security policy | Fresh, independently sourced dependency and capacity facts; supervised step ordering |
| Execution admission gate | `supervisedAdmission.ts` planning only; `authorization.ts` scope model | Authenticated issuer, actor, current STOP and generation, atomic grant consumption at effect boundary |
| Workspace isolation manager | Assignment worktree validation and config root | Per-worker isolated roots, canonical path/symlink checks, immutable base, cleanup and escape prevention |
| Codex execution adapter | None; AO CLI adapter is not a substitute | Narrow versioned Codex invocation, sandbox enforcement, controlled inputs and outputs; no generic shell API |
| Worker lifecycle tracker | B2 dispatch identity and local ledger; audit/state/lock | Durable process identity binding, verified launch and result receipts, crash-safe transitions |
| Independent test/review coordinator | Review evidence, PR tracking, merge policy | Fresh read-only reviewer workspace and credentials, exact-head test evidence, reviewer separation |
| Correction-loop controller | Config limits, review findings | Bounded iterations, fresh authorization and generation for each correction, changed-head re-review |
| GitHub PR integration | PR tracking, GitHub client abstractions | Scoped GitHub credentials, idempotent PR write receipts and exact-head reconciliation |
| Human approval gate | B3A claim schema and merge policy | Authenticated human identity, trusted grant issuance and revocation, single-use check at effect |
| Recovery and audit coordinator | B2 quarantine, recovery, audit, controller lock | Independent provider evidence, durable event ordering, authoritative lookup and fencing |

Keep one authoritative dispatch ledger and one lifecycle per worker dispatch. Future worker records should extend the B2 identity model only after a reviewed migration; they must not create a competing dispatch store or silently reinterpret B2 AO records. The existing v4 state schema and transitions are unchanged in S1. Local state and audit are separate writes and lack file plus directory sync guarantees; controller ownership does not serialize external worker effects.

## Trust and permission model

Each future grant must bind authenticated actor, action, repository, issue or PR, exact branch/head as applicable, workspace root, worker role, dispatch ID, generation, STOP epoch, expiry, limits, and one-use nonce. A trusted admission authority must verify these independently at acceptance and immediately before any effect. The process sandbox must enforce capabilities even when the worker disregards instructions. All ingress paths, delayed starts, reconnects, and retries need the same gate. S1 has no such authority: `planSupervisedAdmission` accepts supplied snapshots, checks a fixture-scoped B3A record, and returns `eligibleForPlanning` only. It always returns `productionAuthorized: false` and `executable: false`. Missing dependency or capacity evidence yields `unknown`. It only supports issue-scoped Builder assignment planning; distinct scoped test and orchestration actions are prerequisites for those roles.

| Role | Proposed filesystem | Proposed process/tools | Proposed network and GitHub | Repository/branch and limits |
| --- | --- | --- | --- | --- |
| ORCHESTRATOR | Read issue, policy, and metadata; write plan only | Planner and evidence readers | Read-only GitHub endpoints | One repository; no worker shell; bounded plan time |
| BUILDER | Write isolated worktree; read allowed project files | Narrow Codex adapter, allowlisted build/test tools | Only approved dependency endpoints; no write GitHub token | Assigned branch only; CPU, memory, time and output limits |
| TESTER | Read fresh exact-head checkout; write test artifacts outside source | Allowlisted tests | Approved dependency endpoints; read-only GitHub if needed | Exact commit; bounded runtime and resources |
| REVIEWER | Read fresh exact-head checkout and evidence; no Builder workspace or secrets | Review tools only | Read-only GitHub | Exact commit; separate identity, credentials, process, and limits |
| CORRECTOR | Write isolated correction worktree | Narrow Codex adapter and allowlisted tools | Approved dependency endpoints | Assigned branch and finding set; attempt and resource caps |
| MERGER | No source write; read verified evidence | Narrow merge operation only | GitHub merge endpoint with short-lived scoped credential | Exact PR head, required approval, one-use grant |

No role label grants any of these capabilities. Filesystem roots, process executables, network destinations, repository and branch scope, GitHub credentials, approved tools, and resource/runtime limits must be enforced outside worker prompts. Reviewer and Tester identities must not inherit Builder credentials or privileged process state. Merge and issue closure require separate grants and evidence. A simulated permission decision must be labeled as simulation and can never satisfy production authorization.

## Proposed lifecycle and identity

`PLANNED → ADMISSION_PENDING → AUTHORIZED → STARTING → RUNNING → RESULT_PENDING → COMPLETED | FAILED | UNCERTAIN | FENCED` is a future worker lifecycle, **not persisted in S1**. `AUTHORIZED` requires an independently verified grant and current fence; `STARTING` requires a durable dispatch intent; `RUNNING` requires a verified process-start event; `COMPLETED` or `FAILED` requires independently verified terminal evidence. `UNCERTAIN` holds any lost acknowledgment, conflicting identity, missing result, or crash gap. `FENCED` requires evidence that no later start/effect is possible for that generation; a local label cannot establish it.

Existing persisted B2 states are `INTENT_RECORDED`, `SUBMITTING`, `ACCEPTED`, `REJECTED`, `UNCERTAIN`, `RETIRED`, `COMPLETED`. They are AO dispatch records; provider-result fixture transitions are test-only. No new persisted transition is introduced here. A local intent, PID, exit code, branch, session, PR, or audit entry is an **unverified local observation**. A verified external outcome would need an authenticated, independently checked receipt bound to exact dispatch ID, payload digest, generation, provider identity, epoch, and durable sequence. None exists in S1.

Future worker identity is a unique supervised worker ID bound to role and actor. Dispatch identity is a stable operation key plus unique dispatch ID, repository, issue/PR, branch/head, payload digest, and generation. Process identity must include a supervisor-owned launch ID, OS process identity plus creation time or equivalent anti-reuse token, workspace identity, and dispatch ID. Generation increments when target, grant, or STOP fence changes; stale messages fail before launch and before effect. Identity bindings and receipts need crash-safe persistence before handoff. PIDs alone are reusable and not proof of worker identity.

On STOP, the controller denies new plans locally and the future execution authority must commit a durable, monotonic fence before acknowledging STOP. It must reject delayed starts and recheck every effect path. Running work should receive termination and credential revocation, then move to `RESULT_PENDING` or `UNCERTAIN` until independent evidence settles it. Terminating a parent process does **not** prove a child process cannot later act; sandbox and credential fencing plus process-tree and external effect evidence are required. Crash recovery must never blindly replay an uncertain dispatch. It must inspect durable local history and independent launch/result/retirement evidence, quarantine contradictions, and require supervised resolution when proof is missing.

## S2 prerequisites and live no-go

S2 needs a reviewed Codex execution contract with a non-bypassable sandbox, workspace isolation, scoped credentials, process-tree supervision, a trusted grant issuer and verifier, atomic single-use and STOP epoch checks, durable dispatch and process receipts, independent audit, crash recovery, exact-head test/review evidence, and human approval for merge. Specify migration and durability before adding worker state. Test delayed launch, STOP races, child survival, PID reuse, credential revocation, retry, and crash gaps in isolation before live use.

Supervised operation requires a human to approve privileged steps; autonomous operation would require separate policy, authority, and review. Neither is enabled. Issue #23 supplies the safety and fencing requirements. Issue #13 retains its original live AO acceptance criteria; a supervised demonstration needs a separately documented scope decision and cannot be called completion of those criteria.

**Live execution is no-go** while any trust, sandbox, issuer, grant-consumption, STOP fence, delayed-start control, durable identity/receipt, independent audit, or recovery guarantee is missing or unverified; while historical AO delivery remains unresolved; or before independent review authorizes a specifically scoped pilot. S1's eligible planning result never clears these conditions.
