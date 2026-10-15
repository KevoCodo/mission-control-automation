# Mission Control living SOP

Version 1 · checkpoint 2026-10-14 · base `02d15718057ebe08264923b56b528bad3efbdf30` (merged Issues #4–#10).

## A. Scope and authority

Mission Control is an experimental controller around the [React dashboard](../README.md), not a production delivery broker. The [Epic](https://github.com/KevoCodo/ai-delivery-lab/issues/3) tracks staged work. Plans, agent reports, CI and AO native verdicts are evidence, never authorization for publication, review, merge, or issue closure. Use current provider state and an exact commit for each decision.

## B. Environment and installation

Use a physical Windows `E:` worktree without reparse ancestors. The original `02d1571` checkpoint declared Node `^20.19.0 || >=22.12.0`; the approved Issue #11 migration declares Node `^20.19.0 || ^22.12.0 || >=24.0.0` and npm 10+ in [package.json](../package.json). Node 23 is excluded by the fixed Vitest 4 package engine. Run `npm ci` against the single root [lockfile](../package-lock.json); then run `npm run test:controller`, `npm run build:controller`, `npm test`, and `npm run build`. On Windows x64/arm64, Koffi opens `.mission-control/controller.lock` through `CreateFileW` with share mode zero. The live native handle owns the lock; its persistent file is not a stale-lock timer. Unsupported platform/architecture/binding or contention fails closed.

## C. Discovery and assignment

The [technical README](../tools/mission-control/README.md) lists dry-run commands. Discovery validates Epic children, explicit dependencies, cycles, duplicates, and verified completion. AO assignment checks issue/session/branch identities, repository identity, E: worktree, capabilities, and concurrency before admission. Limits are two builders and two correction cycles. A preview is informational. A trusted caller and adapter are required for live AO assignment; the bundled CLI uses fixtures. No broad unattended scheduling is provided.

## D. State, audit, and recovery

Schema-v2 JSON state is atomic; corrupt or unsupported state fails closed. Repository-level ownership precedes state and redacted JSONL audit writes. Repair copies original audit bytes to quarantine evidence under ownership and a process-local audit queue. Durable operation intent and idempotency distinguish planned, pending, succeeded, and uncertain outcomes. Reconcile uncertain external results against provider truth before retry; do not repeat effects blindly.

## E. PR, CI, and review

PR tracking requires a unique successful durable assignment and matching repository, issue, session, branch, and exact head. Required checks must be complete, trusted, current, and successful. Missing, stale, paginated-out, or unavailable checks fail closed. [Windows CI](../.github/workflows/ci.yml) installs, tests, and builds both controller and app. Native review stores exact-head verdict provenance and complete findings/thread evidence, with reviewer independence separate from GitHub-required approval. New heads need new CI and review evidence.

## F. STOP and action permission

The pure merge policy reports eligibility separately from action permission and rejects sensitive or unknown changes. There is no trusted grant issuer/verifier, revocation, single-use consumption, or live merge/close executor. Controller-local STOP is not AO-wide queued-turn enforcement. The local source incident artifact at `E:/AI-Development/ao-data/data/artifacts/ai-delivery-lab-2/authorization-incident-roadmap-addendum.md` records a 2026-10-12 queued automated correction that ran after acknowledged STOP, published a commit, and led to another review without renewed human authority. An AO message labeled human did not prove authenticated human provenance. Future enforcement requires a trusted broker, scoped exact-head grants, durable STOP generation and budgets, queue admission and pre-effect rechecks, revocation, one-time nonces, and auditable outcomes. These controls are proposed, not implemented.

## G. Handoff and remaining limits

Before an authorized handoff, verify physical workspace, branch/base, closed dependencies, current advisory evidence, exact-head Windows CI, thread status, GitHub approval, protection, human permission, and STOP. Keep publication, review, merge, and close permissions separate. Live merge and issue close are disabled; production provider validation and E2E demonstration have not occurred. [Issue #11](https://github.com/KevoCodo/ai-delivery-lab/issues/11) covers security dependencies; [#12](https://github.com/KevoCodo/ai-delivery-lab/issues/12) covers audit reporting; [#13](https://github.com/KevoCodo/ai-delivery-lab/issues/13) covers E2E demonstration. On uncertainty, stop effects and reconcile durable state, audit, and provider truth. Never delete the lock file for takeover.
