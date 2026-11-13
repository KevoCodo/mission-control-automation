# Phase 1C Issue #6 | LangGraph ↔ TypeScript controller contract (fixture proposal)

## Trust boundary

The existing TypeScript Mission Control controller retains the only trusted policy/admission authority. LangGraph may **request** an action but must not issue permissions, authenticate users, validate actual runtime isolation, or dispatch workers. `controller_contract.py` is a standalone pure schema evaluation for synthetic test inputs. It always returns a denial. No transport exists.

## Version 1 request schema

All keys are mandatory and unexpected keys are rejected: `version=1`, `kind=CONTROLLER_DECISION_REQUEST_FIXTURE`, `requestId` (fixture- prefix), `issueId` (fixture- prefix), `issueNumber` (positive safe integer), `repository` with exactly `owner` and `name`, lowercase SHA-256 `planDigest`, positive `generation`, nonnegative `stopEpoch`, `actionScope`, `agentRole`, nullable lowercase 40-hex `commitSha`.

Only request shapes for ASSIGNMENT, REVIEW, and CORRECTION are accepted. MERGE and CLOSURE are always unsupported. TESTER/REVIEWER requests require an exact commit identity, but that string is only a caller claim. Role-action structural compatibility is not an authority decision.

## Response schema

`deny_request` returns `version=1`, `kind=CONTROLLER_DECISION_FIXTURE`, the matching `requestId`, `decision=DENY`, `authoritative=false`, `productionAuthorized=false`, `executable=false`, `reason=NO_TRUSTED_CONTROLLER_ADAPTER`. Invalid requests raise `InvalidFixtureRequest`. There is no `ALLOW` response or switch.

## Mapping to existing TypeScript protocols

| This fixture contract | Existing TypeScript concept | Gap before real integration |
| --- | --- | --- |
| repository / issueNumber | ExecutionEnvelope.repository / issueNumber | Independently bind to authoritative dispatch record |
| generation / stopEpoch | ExecutionEnvelope.generation / fencingEpoch | Atomic provider-owned admission and durable STOP |
| actionScope / agentRole | AuthorizationAction / AgentRole | Authenticate actor and issue a narrowly scoped grant in TypeScript |
| planDigest | SyntheticIssueInput.plan / planDigest | Map to canonical payloadDigest over actual executable bytes |
| commitSha | FixtureRoleResult.commitSha | Independently authenticate exact Git head and provider-produced evidence |
| requestId | ExecutionEnvelope.dispatchId / correlationId | Globally immutable UUID dispatch IDs, idempotency and durable ledger |
| DENY / authoritative=false | B3A default-deny, B3B receipt authoritative=false | Authenticated one-use grants; verified issuer and provider receipts |

The fixture request is **not** an `ExecutionEnvelope`, `ProviderReceipt`, B2 persisted dispatch ID, authorization grant, or authenticated proof. Do not reinterpret `stopEpoch` as a trusted fence, or `planDigest` as a verified workload digest.

## Acceptance boundaries and future requirements

Tests reject malformed claims, unknown versions/actions/roles, unexpected grant or authority fields and incompatible role/action shapes. Valid requests always DENY. Before any live controller adapter: independently reviewed transport authentication, protocol version negotiation, replay protection, exact workload digest, trusted request origin, controller-side authorization, one-use grant consumption, epoch checks on all ingress, authenticated provider receipts, and independently verified containment. See `docs/EXECUTION_PROTOCOL_CONTRACTS.md`. Windows Gate 2B remains NO-GO.

No live execution, GitHub writes, HTTP endpoint, shell commands, or external process exists in this feature.
