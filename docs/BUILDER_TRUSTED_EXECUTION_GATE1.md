# Gate 1: Builder trusted execution contract

`tools/mission-control/src/builderTrustedExecution.ts` defines a version 1 request for one future
`KevoCodo/operis` issue #4 Builder. The request reuses the B2 dispatch ID, operation key, canonical
payload digest, target and branch; the execution envelope's generation, grant ID and STOP epoch;
the worker identity's base commit and workspace; and the existing worker capability policy.
It requires an exact SHA-256 digest and evidence reference for the approved plan, a pinned Codex path and SHA-256 digest,
one dedicated worktree, no GitHub capability, no network destinations, an empty environment
allowlist, and finite resource ceilings. The separate `BuilderGrantBinding` specifies the extra
scope that a trusted issuer must authenticate for the existing grant ID. It includes a digest of
the exact capability policy so a narrower or broader request cannot be substituted after approval.
For an issue assignment, admission derives the canonical target ID as issue-<issueNumber>
from both the authorization grant and the grant binding. The pilot additionally requires
KevoCodo/operis issue #4 with target ID issue-4; a matching dispatch and STOP fence for
another target cannot expand that approved scope. The reusable request parser does not set
the pilot repository, issue or target.
`builderDispatchPayload` is the canonical B2 payload projection for these request fields; its
digest must equal the existing dispatch record and envelope digest.

`assessBuilderAdmission` is a pure comparison of supplied claims. It rejects malformed, unknown,
expired, mismatched, consumed and stale claims. An empty reason list means only that fixture data
is structurally consistent. It does not authorize execution. The `TrustedBuilderSupervisor`
interface names the required admission, exact-ID evidence lookup, durable STOP/fencing and
recovery operations. It has no implementation, transport, process launch or production wiring.
The controller's `productionAuthorized: false` and `executable: false` boundaries remain in force.

Before any independent launch review, an implementer must provide a trusted issuer and verifier
for the grant plus its new scope binding, a reviewed migration for existing authorization and B2
state, atomic one-use consumption and STOP ordering across every start ingress, authenticated
durable evidence with complete exact-ID retention, and restart reconciliation that quarantines
uncertainty. OS-enforced identity, ACL and path checks, restricted token, creation-time Job
containment, network enforcement, executable pinning, resource limits and descendant termination
are not implemented or verified here. Passing source tests cannot establish those guarantees.

The Gate 1 fixture test is `tools/mission-control/src/__tests__/builderTrustedExecution.test.ts`.
It imports pure controller contracts and does not call AO, GitHub, a native runner or a worker.
