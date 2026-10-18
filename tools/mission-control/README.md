# Mission Control

The M1 React workflow is a separate browser-only manual planning and handoff UI. It uses fictional local issue fixtures and a deterministic template plan. It does not call this controller's AO assignment planner or discovery adapters, and it adds no live provider or execution capability. See the root README for use and limits.

Documentation checkpoint: version 1, 2026-10-14, base `02d1571`. See the [living SOP](../../docs/MISSION_CONTROL_LIVING_SOP.md) and [root README](../../README.md).

Mission Control is a read-only controller skeleton for coordinating explicit
GitHub issue, AO session, and pull request identities. It defaults to dry-run
mode, uses fixture adapters unless trusted adapters are injected by a caller,
and must not mutate GitHub, AO, branches, issues, sessions, or deployments.

The exported AO assignment function denies every live request before calling an AO client, including injected clients. It records a controller-local `assignment.dispatch.denied` audit outcome and throws `EAO_EXECUTION_BOUNDARY_UNAVAILABLE`; it creates no spawn intent or session identity. Dry-run previews remain available. The bundled CLI does not invoke live spawning, and the merge adapter is disabled. A plan, pending intent, CI result, or review verdict does not grant permission for a side effect.

## B2 dispatch identity

Correction: lifecycle fixture transitions now live only in a pure evaluator under `src/__tests__`; production exports cannot persist fixture-based provider outcomes. `quarantineDispatch` can mark a local intent or interrupted attempt `UNCERTAIN` without asserting a provider result. Existing records with fixture evidence remain readable, explicitly unverified, and quarantined. A terminal fixture state cannot free its issue or branch for another dispatch intent. Generic reconciliation returns unresolved legacy AO operations in `blocked` without probing or changing them, while preserving non-AO reconciliation.

Dispatch fingerprints use SHA-256 of recursively canonical JSON with sorted object keys. JSON primitives and dense arrays are accepted. Cycles, undefined, functions, symbols, bigint, non-finite numbers, sparse arrays, accessors, symbol or non-enumerable keys, and non-plain object prototypes raise `EDISPATCH_PAYLOAD`. Payload contents are never persisted or logged.

State schema v3 adds `dispatches` with record version 1. `recordDispatchIntent` records a UUID dispatch ID, stable operation key, repository/issue/branch target, optional intended target/session ID, SHA-256 of canonical JSON payload, correlation ID, timestamps, local lifecycle state, and evidence metadata. It stores no payload or private instructions. The same key and payload returns the prior identity; a changed payload or target conflicts. A second active identity for the same issue or branch is blocked under the controller ownership lock. An intent is a local record and never an AO receipt or execution permission.

The lifecycle model covers `INTENT_RECORDED`, `SUBMITTING`, `ACCEPTED`, `REJECTED`, `UNCERTAIN`, `RETIRED`, and `COMPLETED`. Provider-result transitions are only evaluated in tests; production has no AO receipt verifier, lookup, or transport. `SUBMITTING` never hands off transport. Session, Builder, branch, PR, and audit absence never establishes retirement. The legacy `reconcileAoSpawnIntents` export returns `EAO_RECONCILIATION_BLOCKED` without AO calls or state mutation.

The state file uses a temporary file and atomic rename under controller ownership. Audit JSONL is appended separately after state persistence. A crash or audit failure can leave a state record without an audit event; state remains authoritative for local deduplication and no dispatch occurs. The two files are not one atomic transaction. The current writer does not fsync the file and directory, so power-loss durability is not guaranteed. Reports label dispatch receipt status unverified, including fixture evidence, and never interpret local intent as AO acceptance. The historical `issue12-phase2h-supervised-assignment` delivery remains unresolved and is not imported as a new dispatch.

## Commands

```bash
npm run build:controller
npm run test:controller
node tools/mission-control/dist/cli.js --help
node tools/mission-control/dist/cli.js discover --config tools/mission-control/examples/dry-run.config.json
node tools/mission-control/dist/cli.js track-pr --config tools/mission-control/examples/dry-run.config.json
node tools/mission-control/dist/cli.js review-evidence --config tools/mission-control/examples/dry-run.config.json
node tools/mission-control/dist/cli.js report --audit .mission-control/audit.jsonl --state .mission-control/state.json --format json
node tools/mission-control/dist/cli.js report --audit .mission-control/audit.jsonl --format markdown
```

The CLI accepts `--config <path>` for a JSON file. Without a config file it uses
safe dry-run defaults.

## Configuration Guardrails

- `executionMode` defaults to `dry-run`; other modes are rejected.
- `repository.owner`, `repository.name`, and `project.id` are required.
- Issue, session, and pull request identities must be explicit in `identities`.
- `limits.maxBuilders` is capped at `2`.
- `limits.correctionAttempts` is capped at `2`.
- Worktree roots must be on the Windows `E:` drive.
- Feature branches must not be `main`, `master`, or the configured default
  branch.
- Deployment must stay disabled.
- Config files must not contain credential-bearing keys such as tokens,
  passwords, secrets, private keys, or authorization headers.

## Adapter Boundaries

External access is isolated behind `githubClient` and `aoClient` interfaces.
The included fixture clients only implement read methods. Trusted authenticated
adapters may be supplied by a caller in a controlled environment, but secrets
must come from that environment rather than config files. Agent review is useful
for finding defects; it is not a substitute for required GitHub approval or
human/policy authorization before merge.

## GitHub Dependency Discovery

Epic child discovery is available only through an allowlisted GitHub adapter.
The controller reads paginated Epic children, parses explicit issue-number
dependencies from native metadata and documented body references, and builds a
deterministic graph without creating or mutating issues. Dependencies must point
to actual issues in the configured repository; cycles, duplicates, missing
dependencies, cross-repository references, and mismatched native/body dependency
sets are rejected.

Graph nodes distinguish open issues, closed issues with verified completion, and
closed-but-unverified issues. A node is eligible only when every dependency is
verified complete.

## Pull Request And CI Tracking

`track-pr` performs read-only PR/session/branch association and exact-head CI
observation for an already assigned worker. The intended issue/session/branch
must be backed by exactly one succeeded durable AO assignment record in schema v2
state; matching a branch alone is not enough. It rejects duplicate PR matches,
incomplete or malformed PR search pagination, unrelated branches or
repositories, forks, draft PRs, closed PRs, mismatched issue/session
associations, and stale expected head SHAs.

Required check discovery is trusted adapter data; missing, untrusted,
incomplete, rate-limited, paginated-out, or unavailable required checks fail
closed rather than inheriting success from an earlier head. Skipped required
checks are accepted only when an explicit trusted required-check rule lists that
conclusion as allowed. A successful CI observation never records review
approval; the review decision remains `unknown` unless a separate exact-head
review signal is added in a later authorized phase.

PR observations are persisted in schema v2 state under `pullRequestTracking`
with the PR number, issue number, session id, branch, head SHA, check
reconciliation, generation, fixture-vs-GitHub data source, stale/unavailable
flags, and bounded diagnostic codes. Raw provider exceptions are not persisted
to state, audit, or CLI output. A new head is stored as a distinct generation so
restart reconciliation cannot reuse an older successful decision, and a delayed
observation cannot overwrite a newer same-head observation.

## Native Review Evidence

`review-evidence` performs read-only AO native review status and GitHub review
finding collection for the exact current PR head. It records AO native review
capability, run status, reviewer independence, immutable head SHA, findings,
unresolved threads, duplicate threads, stale-head detection, correction-cycle
budget, and GitHub-required approval status as separate evidence.

The controller does not trigger live reviews, submit GitHub reviews, resolve
threads, or deliver controller-originated corrections in this phase. Future live
review triggers and each correction cycle require a future trusted human
authorization gate. Caller-provided boolean flags are recorded as unverified
input and cannot create a correction request or consume the budget. Missing
controller-local STOP state defaults to active; caller flags cannot clear it.
Historical cycles remain visible across restarts and heads, with a maximum of
two before an informational escalation plan. All correction plans are
nonexecutable. This is not AO-wide STOP enforcement or a privileged execution
gate. Fixed threads remain unresolved until a verified push can be observed by
a future authorized workflow.
AO/internal review status is never treated as GitHub-required independent
approval.

The concrete AO CLI adapter uses only `ao review ls --json` for review-run
lookup. It parses the documented review list shape, verifies PR number and exact
target SHA, preserves the native verdict, and fails closed when output is
unsupported, missing, duplicated, or mismatched. A completed run without an
approved or changes-requested verdict cannot approve. Findings and threads
require explicit complete read results; missing, failed, or incomplete reads
block approval even when their item arrays are empty. The adapter does not call `ao review trigger`, `ao review submit`,
`ao send`, or thread-resolution commands. Reviewer independence is not inferred
from harness names or session ids; absent explicit runtime provenance, the
review evidence remains unavailable for approval purposes.

## State And Audit

State is versioned JSON written atomically by same-directory temporary write and
rename. Unsupported versions and corrupt JSON are rejected clearly. Audit events
are append-only JSONL records with structured data redacted for common secret
shapes before persistence.

Audit append and recovery callers use the same controller-first ownership
protocol. Public audit helpers acquire controller ownership themselves when the
caller does not already hold it, and reuse caller-held ownership when invoked
inside a controller transaction. After controller ownership is established,
audit operations also enter a narrow process-local audit transaction queue so
sibling append/recovery promises inside one controller callback cannot
interleave read-modify-write repair work. Audit recovery reads, parses,
validates, writes the repaired candidate, copies original bytes to quarantine
evidence, and publishes the repaired canonical file while holding that audit
transaction.

## Audit reporting (Issue #12)

New audit records use a version 2 envelope with a generated event ID, timestamp,
type, and redacted data. Optional fields carry correlation and operation keys,
actor ID and provenance claim, evidence reference, issue/session/PR identities,
exact PR head, authorization state, intent/action category, outcome, and retry
reference. Absent fields render as `unavailable`; the reporter never derives
authority from a provider or actor label. Version 1 and unversioned legacy records
remain readable. A caller authorization claim remains a claim. The dry-run CLI
labels fixture observations as `fixture`.

`report` reads the audit JSONL and optional state snapshot without changing
either file. It rejects malformed events, unsupported versions, empty lines,
and incomplete tails; repair remains a separate explicit operation. Reports
contain events in log order, sorted summary counts, SHA-256 hashes of the exact
input bytes, and a conservative engineering history per issue. The history
links Epic, issue, AO session, branch/worktree, PR, exact-head CI, native review,
GitHub-required approval, authorization, recorded action, and verified outcome.
It lists blockers and never promotes intent, eligibility, a merely closed issue,
or a recorded successful operation into verified completion. State and audit
are read separately, so hashes cannot prove an atomic cross-file snapshot.
Provider truth and actor authentication remain unavailable to this command.
JSON schema version 2 and Markdown are deterministic for identical inputs:
neither includes the current clock or local file paths. Redaction applies to
legacy records at read time, and Markdown treats untrusted text as inert text.
The evidence hierarchy is current authenticated provider state at the exact
head, then controller state plus matching audit, then unauthenticated fixture
or caller claims. This CLI accesses only local files and performs no repair.

## Controller Ownership

State-changing controller work is guarded by one canonical repository-level
lock at `.mission-control/controller.lock`. On Windows x64/arm64, Mission
Control opens this file with `CreateFileW` share mode `0` through Koffi, keeps
the native handle in process memory, and relies on Windows to close the handle
when the owner process exits. The lock file is persistent and is not deleted to
release ownership.

Unsupported platforms, unsupported architectures, native binding load failures,
ownership contention, and uncertain ownership fail closed before provider
callbacks or state/audit mutations run. There is no TTL, PID, or stale-lock
takeover fallback in production; operators should restart the owning controller
process rather than edit lock sidecars.

## Windows Restrictions

Controller worktrees are constrained to `E:` roots. The skeleton does not build
shell commands from issue text and does not spawn workers, schedule loops, create
issues, merge pull requests, or deploy software.

## Dependency security assessment

`evaluateDependencySecurity` is a pure assessment of a complete npm audit v2 report, the root package manifest and lockfile, and the current Node version. It has no filesystem, network, CLI, merge, or grant effect. Missing or malformed evidence, unsupported Node, lock mismatch, and any unresolved high or critical package block eligibility, including development-only findings. Caller exception or remediation flags cannot clear an audit finding. Its output contains bounded package names, severity, runtime/development classification, and advisory IDs, not raw audit titles or paths. The caller must obtain authentic current audit evidence; this function does not authenticate npm or authorize execution.

Baseline assessment on 2026-10-14 with Node 20.19.5, npm 10.8.2 and the `02d1571` lockfile: `npm audit` exited 1 with three package entries (two critical, one moderate); `npm audit --omit=dev` exited 0 with zero. All were in the development-only Vitest test runner, reachable when tests run in CI or against untrusted test inputs, not in the production React bundle. The critical [tinypool worker-options advisory](https://github.com/advisories/GHSA-5gmw-xhrv-c9v3) is fixed at 2.1.1 and [run-options advisory](https://github.com/advisories/GHSA-85c8-ppgw-ccpr) at 2.1.2. The moderate [Vitest/mocker redirect-mock advisory](https://github.com/advisories/GHSA-82fw-gwwq-j7x9) is fixed at 4.1.11. Vitest 3.2.7 required tinypool `^1.1.1` and exact `@vitest/mocker` 3.2.7; no compatible patch/minor fix covered all findings.

| Package | Base locked version | Relationship | Advisory exposure | Remediated lock |
| --- | --- | --- | --- | --- |
| `vitest` | 3.2.7 | Direct development | Aggregate critical and moderate test runner advisories | 4.1.11 |
| `tinypool` | 1.1.1 | Transitive development | Two critical prototype-pollution/RCE advisories | Removed from graph |
| `@vitest/mocker` | 3.2.7 | Transitive development | Moderate path traversal/file read | 4.1.11 |

The scoped Issue #11 migration pinned Vitest 4.1.11 and updated only its necessary transitive graph. Vite remains 7.3.7 and Koffi remains 3.3.2. Vitest 4.1.11 declares Node `^20.0.0 || ^22.0.0 || >=24.0.0`, so the separately approved project range is `^20.19.0 || ^22.12.0 || >=24.0.0`; Node 23 is unsupported. Windows CI continues to use Node 20.19.0. After `npm ci`, full and production-only audits each exited 0 with zero findings, controller tests passed 252/252, full tests 253/253, and both builds passed locally. No advisory exception or audit suppression is in use. Residual limits: the pure policy relies on an authentic complete npm audit report supplied by its caller, and the exact PR head still requires Windows CI and independent review before any merge decision.

## B3A scoped authorization records

State schema v4 adds versioned authorization records, revocation events, consumed grant IDs,
and a monotonic revocation epoch. Migration from v1, v2, or v3 creates empty authorization
collections; v3 dispatch identities remain intact. Claim ingestion accepts only REQUESTED or
UNVERIFIED records and writes an audit observation before changing state. Duplicate grant IDs,
including conflicting contents, fail closed under the controller state lock. State writes reject
VERIFIED records and fixture provenance. No approved issuer is wired into production.

Revocation audit entries identify the grant holder separately. An initiating actor is omitted
unless the caller supplies an ID, and that ID remains explicitly caller-claimed and unverified.
The controller's audit observation does not verify a human or service initiator. Older B3A
revocation records without initiator metadata remain readable; their absence implies no verified
initiator. State loading rejects missing or extra revocation events, active grants with revocation
events, duplicate event identities, noncontiguous or out-of-range epochs, and mismatched grant
timestamps or issuance epochs. Contradictory records are rejected rather than migrated or repaired.
Version 3 migration adds only empty authorization collections and preserves populated B2
dispatch records, including uncertain delivery quarantine details. A legacy state with unexpected
authorization evidence fails migration instead of having that evidence discarded.

The pure `evaluateAuthorization` function accepts an explicit clock and test fixture issuance
evidence to inspect scope. Its result never has verified permission or execution capability.
`verifyCurrentPermission` is the production boundary and always returns
`TRUSTED_ISSUER_UNAVAILABLE`. A caller claim, a stored record, an audit entry, and a test fixture
are not human authorization. There is no environment or configuration switch to enable actions.

Each grant binds an actor, repository, action, issue or PR, and for PR actions the exact head SHA.
REVIEW, CORRECTION, MERGE, and CLOSURE are separate scopes. The evaluator rejects future issuance,
expiration, revocation, stale epochs, replayed grant IDs, and missing or mismatched evidence.
Revocation changes the historical record and increments the durable epoch; it cannot undo an
external side effect already completed. The eventual trusted runtime must obtain current time
from its own clock, verify issuer evidence independently, atomically consume a single-use grant,
and recheck scope, revocation, STOP, exact head, provider truth, and policy immediately before any
side effect. B3A supplies none of that execution capability. Live AO remains prohibited.

## Merge policy boundary

`evaluateMergePolicy` is a pure, versioned, fail-closed assessment. It returns policy eligibility,
action permission, and result separately. It checks durable assignment ownership,
repository and PR identity, exact head generation, trusted required CI, an independent
native approval with explicit runtime reviewer provenance, GitHub approval, complete
findings and threads, acceptance evidence, low risk, changed paths and content,
branch protection, and controller STOP state. Issue #10 is always excluded from
unattended eligibility. Unknown files and sensitive security, authentication,
secrets, CI, infrastructure, deployment, migration, gate, merge policy, and STOP
changes are blocked. A caller's `risk: low` claim is insufficient: the only
positive risk evidence currently supported is an explicit independent, complete
**test mock** file inventory with old and new paths and content. Renames,
deletions, unknown file types, incomplete inventories, and missing content fail
closed. The test mock is simulated evidence, not production provenance or authority.

The controller has no trusted grant issuer or verifier. A live grant would need an
external verifiable issuer and a signature bound to repository, PR, exact SHA,
action, expiry, and nonce. The trusted runtime must check revocation, consume the
nonce once, audit the decision, and revalidate STOP, provider state, protection,
policy, and exact head when queued and immediately before the side effect. Caller
flags, fixtures, and configuration are never authority. Until that component
exists, action permission is always false and `DisabledGithubMergeAdapter` throws.
Its narrow contract uses GitHub's merge API with an expected head SHA and only
the permission needed to merge; it provides no shell merge or protection bypass.
This is a controller-local boundary, not AO-wide enforcement.

`mergeIntentKey` provides a stable future operation key. `stageMergeIntent` only
stores one idempotent, nonexecutable informational audit event and never creates
a pending `merge-pr` operation. `reconcileMergeIntent` applies only to a separate
historically authorized operation; it requires authoritative provider truth before
handling an uncertain response and never blindly repeats a merge. A future trusted
runtime would need a verified grant and fresh STOP, head, policy, and provider checks
before creating or executing an operation. Issue closure has its own eligibility assessment and
requires separately authorized action after verified merge and completion evidence;
no close adapter is provided. Dependency scheduling continues to rely on verified
completion, not a merge attempt or a merely closed issue.
