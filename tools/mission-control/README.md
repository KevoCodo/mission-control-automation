# Mission Control

Mission Control is a read-only controller skeleton for coordinating explicit
GitHub issue, AO session, and pull request identities. It defaults to dry-run
mode, uses fixture adapters unless trusted adapters are injected by a caller,
and must not mutate GitHub, AO, branches, issues, sessions, or deployments.

## Commands

```bash
npm run build:controller
npm run test:controller
node tools/mission-control/dist/cli.js --help
node tools/mission-control/dist/cli.js discover --config tools/mission-control/examples/dry-run.config.json
node tools/mission-control/dist/cli.js track-pr --config tools/mission-control/examples/dry-run.config.json
node tools/mission-control/dist/cli.js review-evidence --config tools/mission-control/examples/dry-run.config.json
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
