# Mission Control 2.0: Development and Merge Delegation Policy

**Approved by project owner in conversation, November 13, 2026.**
**Scope:** GitHub Epic #3 in this repository. This is a human workflow policy, **not** a trusted worker authorization, execution grant, or GitHub branch-protection bypass.

## Routine changes: delegated

For ordinary code, tests, documentation, UI, and nonprivileged refactors, the assistant may:
1. Take the next dependency-ready issue, work on a new branch, and open a PR.
2. Run required automated tests, add negative-case tests where relevant, and fix failures within the issue's stated scope.
3. Merge a routine PR without a separate user check-in **only if** every required check passes on the exact current head SHA, all required repository review/branch protection rules are satisfied, the PR is mergeable, and the diff stays within scope.
4. Close its issue and check its epic item only after verified merge and satisfied acceptance criteria.
5. Continue to the next eligible routine issue while working in an active supported session or an explicitly configured authorized workflow.

A green CI result is **necessary but not sufficient**: never bypass required GitHub reviewers, branch protection, auditability, or evidence requirements. Any failed check that cannot be safely fixed, unexpected permission change, or scope expansion stops automatic merging and triggers a user check-in.

## Review required: do not self-approve

The assistant must stop for explicit human/independent review before claiming a security GO, merging or enabling a security-sensitive change, or crossing a live execution boundary. Examples:
- Sandboxing, worker/container/process launch, host permissions, filesystem isolation, credential access, network egress, or changes to effective execution limits.
- STOP fencing/revocation, controller-owned one-use grants, security policy, authentication, privilege boundaries, or real worker admission.
- Live GitHub mutation automation, merge/close permissions, production integrations or deployment, or any client/production environment access.
- Independent containment/observer evidence, security attestations, risk acceptance, or required GO/NO-GO signatures.

A **design-only proposal** for a future security gate may be merged as clearly labeled NO-GO documentation after the owner explicitly approves that documentation merge and all repository checks pass. Merging such a document **never** closes an issue requiring independent host verification or security sign-off.

## Exception behavior

- If a test fails, diagnose and attempt a scoped, reviewable fix, rerun checks; involve the user if the failure is unresolved, would need unsafe permissions, or changes scope.
- If CI/check data are unavailable, stale, pending, or contradictory, do not infer success. Leave PR open.
- If actual independent security evidence is missing or any STOP/permission state is uncertain, default deny; do not start agents or experiments.
- Never let LangGraph, a fixture, or the AI assistant authorize its own execution. The TypeScript controller stays the policy authority.
- Do not represent this chat as a persistent background agent. Autonomous continuation requires an active session or a specifically configured authorized execution workflow.

## Project-specific tracking

- Epic: #3
- Issue #7 (worker isolation design) has a proposed independent Gate A review; the security gate remains NO-GO until verified and signed.
- Issues #8 and #9 are security-sensitive and require additional independent evidence and explicit approvals even when tests are green.
- Phase 1C fixtures remain non-executable and do not imply a production security grant.

This policy governs review delegation only. It does not make a new runtime, background schedule, credential issuer, or authorization interface available.
