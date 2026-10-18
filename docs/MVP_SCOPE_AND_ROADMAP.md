# Mission Control: supervised MVP scope and roadmap

**Checkpoint:** 2026-10-18 | **Verified main before this documentation change:** `062bce956c0add05c4c7e3400714c45e3050985c`

**Decision:** Deliver a human-operated, single-Builder **issue-to-PR MVP** before adding more autonomous execution infrastructure. This document is the current forward-looking scope; historical phase documents remain evidence of what was implemented at their checkpoints. This is a **proposed product milestone**, not a claim that an end-to-end demonstration has happened.

## Ultimate goal and MVP boundary

The eventual goal is GitHub issue → AI plan → Codex Builder → testing/review → bounded correction cycle → PR → explicitly approved merge, with trustworthy execution and recovery.

The **MVP** is a **human-supervised handoff workflow**. The controller can guide the user through selection, planning, approvals, handoff export, evidence import and PR preparation, but **does not launch Codex, execute commands, write to GitHub, merge, or close issues**. The human independently runs Codex in a separately authorized worktree, reviews its output and performs any GitHub writes via an existing approved user-controlled workflow. No user-provided “success” field is trusted as independent proof. A PR link may be recorded only as an external reference; its mere presence is not verification.

## Definition of done: one supervised issue-to-PR demonstration

1. Select a **safe, independent, disposable demonstration issue/repository** with no dependency on AO or uncertain historical dispatches. Show identity, scope, dependencies, and available evidence; unknown facts must remain unknown.
2. Produce a bounded implementation plan and a human-readable, copy-ready Codex handoff. The user explicitly approves both. The handoff includes allowed root, precise task, verification, excluded actions, and a manual STOP/abort instruction.
3. User launches Codex **outside the controller**, in a separate preflight-checked workspace. Mission Control itself neither starts nor supervises the process. No implication that controller STOP can stop this external session.
4. Import only **explicitly labeled user-supplied evidence**: changed commit/patch, test output, review notes, blockers, and optional PR URL. Validate shape, consistency and exact identities; never elevate imports to authenticated provider receipts or production permission.
5. Show a single review screen summarizing plan, completed work, tests, unknowns, and outstanding approvals. Allow **manual, explicitly approved** corrective handoff, with at most two iterations in the MVP. Do not spawn correction workers.
6. Generate a human-executable PR checklist and description. The human performs publication and merge through an independently approved GitHub interface. Mission Control does not assert a PR was merged or the issue closed without independently verified current provider facts.
7. Demonstrate the workflow end to end with saved local, redacted evidence and reproducible controller/React tests; document limitations. The **original Issue #13 live AO demonstration criteria remain blocked and are not satisfied by this alternate demonstration**.

## MVP feature decisions

| Capability | MVP | Reality / boundary |
| --- | --- | --- |
| GitHub issue selection, dependency view | Reuse existing discovery / planner where appropriate | Existing controller has dry-run and evidence/identity checks; wire UI only where independently safe |
| AI plan and approval | Human-approved plan and handoff | Do not claim a new authenticated grant issuer |
| One Codex Builder | **Manual external Codex launch** | Controller provides instructions; never launches AI or AO |
| Tests and review | Import and display results with provenance | User claims are not independently authenticated |
| Corrections | Manual handoff, up to two rounds | No automatic worker retry or queue |
| PR delivery | Prepare description/checklist, user performs write | No controller GitHub write/merge/close executor |
| Basic UI and state | Reuse React dashboard and controller fixture contracts, local draft state | Fail closed on missing identity, unexpected data, or uncertain state |
| STOP | Stop local workflow progression / deny further handoff issuance | Cannot fence already-running external Codex or AO |
| Native Windows isolation | **Not required for manual-handoff MVP** | Prototype/build remains untrusted and disconnected; retain as separate future work |

## Verified implementation history

At this checkpoint, the repository has merged the foundational controller/React/CI work, subsequent security and reporting work, and:

| PR | Delivered code / evidence | What it does **not** prove |
| --- | --- | --- |
| [#28](https://github.com/KevoCodo/ai-delivery-lab/pull/28) | S1 supervised admission planning | No authorized live worker |
| [#29](https://github.com/KevoCodo/ai-delivery-lab/pull/29) | S2A worker isolation contracts | No enforcement |
| [#30](https://github.com/KevoCodo/ai-delivery-lab/pull/30) | S2B-1 trusted runner preflight | No executable native isolation |
| [#31](https://github.com/KevoCodo/ai-delivery-lab/pull/31) | S2B-2A read-only filesystem inspection | No filesystem sandbox enforcement |
| [#32](https://github.com/KevoCodo/ai-delivery-lab/pull/32) | S2B-2B1 Windows Job Object source prototype | No native compilation or process test at that stage |
| [#33](https://github.com/KevoCodo/ai-delivery-lab/pull/33) | S2B-2B2 local MSVC build, opt-in disposable test harness and claim parsing | No actual process experiment or independently verified containment |

The PR #33 implementation was merged at `062bce956c0add05c4c7e3400714c45e3050985c`. A compiled native build on the developer workstation does **not** prove runtime containment, restricted-token identity, handle safety, process-tree termination, or crash recovery. By default the runtime experiment stays disabled. No Codex worker launch path is authorized.

## Work remaining for the supervised MVP

**M1: MVP workflow and persistence.** Connect existing issue/discovery and planning data to a simple single-task UI or existing CLI; add plan approval, explicit manual handoff generation, and safe locally persisted drafts. No new execution path.

**M2: Evidence and PR handoff.** Allow user-controlled import of a patch/commit and test/review output; clearly label source provenance and unknowns; generate a PR description/checklist. No GitHub write permission or automatic merge.

**M3: One end-to-end supervised demonstration.** Use a disposable issue/repo independent of AO. Run one manual Codex Builder cycle and at most two manually initiated corrections. Capture results, failure cases, tests, and a truthful demo report. This is a **separate supervised demonstration**, not closure of original live AO Issue #13.

**Scope guard:** New work is MVP-critical only if it is necessary for these three deliverables or prevents unsafe claims/effects. Defer every other addition to post-MVP unless an actual tested blocker is identified.

## Post-MVP backlog, ordered by dependencies rather than fixed phase counts

- **Verified native execution boundary:** run explicit disposable Windows containment tests only after independent source review and separate authorization; close fixture identity races and demonstrate cleanup. Restricted token/ACL, network isolation, process-tree STOP, and authenticated native results must be enforced before any production worker start.
- **Trusted launcher / automation:** authenticated grant issuer/verifier, atomic single-use consumption, STOP fencing, scoped capabilities, durable launch/termination evidence and crash-safe recovery, then a narrow Codex adapter. Do not reuse AO dispatches.
- **Dedicated Tester and Reviewer workers**, independently scoped and supplied with fresh exact-head evidence.
- **Automated correction loops** with budgets and STOP/epoch rechecks; durable queue orchestration and multiworker scheduling.
- **GitHub write automation** for authorized PR creation, review/merge/close actions, only after scoped authorization and independent provider reconciliation.
- **Broader autonomy, monitoring, dashboards, and scalability** after supervised success.

Post-MVP items are intentions, not current capabilities. Their order and number may change based on verified blockers. No fixed timeline or percent-complete claim is made.

## Safety invariants

- **Never access or activate live AO**, its daemon, transport, state, sessions, or historical delivery. The uncertain `issue12-phase2h-supervised-assignment` remains **unresolved**; do not retry, duplicate, retire, or infer acceptance. Issue [#23](https://github.com/KevoCodo/ai-delivery-lab/issues/23) stays open. The original [#13](https://github.com/KevoCodo/ai-delivery-lab/issues/13) live AO demonstration stays blocked.
- Production `productionAuthorized` and `executable` remain false where defined. No trust in role labels, fixtures, report text, CI pass flags, native local claims, or user-imported results as authority.
- External manual Codex must be separately preflight-checked and explicitly user-launched; the controller must not imply independent OS containment or guaranteed STOP for that external run.
- Keep issue selection, plan approval, external launch, GitHub publication, review, merge and closure as distinct consent/evidence boundaries. Human approval in the UI is not automatically an authenticated execution grant.
- Require exact-head evidence for decisions; fail closed on stale, missing, contradictory or unverified provider state. Do not say the end-to-end MVP is complete until it is demonstrated and independently reviewed.

## Next implementation

Begin **M1: Manual Supervised Handoff MVP** only after independent review of this documentation. The Codex task must preserve all safety invariants, avoid any AO connection, avoid changes to the native harness, and stop after a local commit for source review.
