# Issue #23 B3B-2: AO capability evidence and protocol verification

## 1. Executive finding

**UNKNOWN:** The authorized static inspection found no readable authoritative AO application or daemon implementation. It cannot establish any of the thirteen required provider guarantees. No live AO integration route is currently justified. Mission Control's B1 default-deny gate must stay in place. `issue12-phase2h-supervised-assignment` remains unresolved; this assessment makes no reconciliation claim.

This finding is limited to the inspected installation at `E:\ao\agent-orchestrator`. It does not claim that a feature is absent from all AO builds. `CONFIRMED` below means direct implementation evidence; `PARTIAL` means an implemented part without the required guarantee; `UNKNOWN` means insufficient implementation evidence; `ABSENT IN INSPECTED SOURCE` is used only for a demonstrably missing feature within an inspected source scope. None of the AO provider rows qualifies as confirmed, partial, or absent because its authoritative implementation was not readable.

## 2. AO identity, version, and source visibility

| Static item inspected | Observation | Evidentiary limit |
| --- | --- | --- |
| `E:\ao\agent-orchestrator\agent-orchestrator.exe` file version metadata | Product name `Agent Orchestrator`; product/file version `0.13.6`. | This verifies the desktop executable metadata, not the daemon's or packaged application's internal package version. No executable was run. |
| `E:\ao\agent-orchestrator\version:1` | Contains `33.4.11`. | Its meaning is undocumented in readable source; it conflicts with the executable's `0.13.6` metadata and cannot safely be called the AO application version. |
| `E:\ao\agent-orchestrator\resources\acp-runtime\package.json:2-7` | Package `@aoagents/acp-runtime`, version `0.1.0`, describes pinned ACP adapters and a `@agentclientprotocol/claude-agent-acp` dependency. | This is a bundled adapter package, not proof of the AO application package name, dispatch protocol, or execution checks. AO's application package name is **unknown**. |
| `resources\app.asar`; `resources\app.asar.unpacked\node_modules\better-sqlite3`; `resources\daemon\ao.exe`; `resources\agent-browser\agent-browser.exe` | Packaged desktop artifact, unpacked native dependency, packaged daemon, and browser executable are present. | No readable AO application/daemon source, source maps, protocol definition, or persistence schema was found in the bounded top-level and relevant unpacked/daemon inspection. The ASAR and executables were not unpacked, decompiled, or run. `better-sqlite3` packaging does not prove AO uses SQLite for dispatch durability. |

The installation suggests a packaged desktop and separate daemon layout, but their internal architecture is **UNKNOWN**. The daemon entry-point **source location**, worker creation implementation, messaging and instruction-dispatch implementations, protocol definitions, and persistence architecture are **UNKNOWN**. The daemon executable's path is an artifact location, not an entry-point source reference. Third-party ACP adapter code and command descriptions cannot establish AO safety semantics.

## 3. Capability evidence matrix

Exactly one classification column is marked for each AO provider capability. `U` means **UNKNOWN**; an em dash means that classification was not established. File references point to the nearest available static evidence or the local interface boundary, not to a provider implementation.

| Capability | Supported | Partially supported | Not implemented in inspected source | Unknown | Source file and line reference | Evidence explanation | Missing guarantee | Required follow-up |
| --- | :---: | :---: | :---: | :---: | --- | --- | --- | --- |
| Immutable dispatch IDs | — | — | — | U | `resources/app.asar` (packaged); MC `src/dispatch.ts:73-108` | MC creates and persists a local ID; AO binding code is unreadable. | Provider binds one ID to exact immutable payload and target. | Obtain version-matched AO source and ID schema. |
| Durable acceptance and rejection receipts | — | — | — | U | `resources/daemon/ao.exe` (packaged); MC `src/clients.ts:125-140` | Local spawn result has no receipt fields. | Authenticated, durable acceptance/rejection with exact bindings. | Inspect AO admission transaction and receipt implementation. |
| Request idempotency | — | — | — | U | `resources/app.asar` (packaged); MC `src/dispatch.ts:86-99` | MC deduplicates local operation keys only. | One provider queue item/effect per ID; conflicting replay rejection. | Inspect AO atomic uniqueness and retry handling. |
| Exact dispatch-ID reconciliation | — | — | — | U | `resources/daemon/ao.exe` (packaged); MC `src/dispatch.ts:132-136` | MC explicitly blocks snapshot reconciliation. | Authenticated complete lookup and delayed-delivery semantics. | Obtain lookup contract, retention, and completeness proof. |
| Durable instruction retirement | — | — | — | U | `resources/app.asar` (packaged); MC `src/types.ts:70-97` | A local `RETIRED` state name is no provider retirement evidence. | Permanent provider tombstone surviving restart. | Trace AO retirement write and all consumers. |
| Queued-message cancellation | — | — | — | U | `resources/daemon/ao.exe` (packaged) | Queue implementation is unreadable. | Durable cancel covering delayed and dequeued items. | Inspect queue, replicas, dequeue race, and restart behavior. |
| STOP enforcement | — | — | — | U | `resources/daemon/ao.exe` (packaged); MC `src/state.ts:31-47` | MC initializes local review STOP active; AO enforcement is unproven. | Durable provider barrier observed by every ingress and worker start. | Trace STOP ordering and barrier acknowledgment. |
| Monotonic fencing epochs | — | — | — | U | `resources/app.asar` (packaged); MC `src/authorization.ts:207-237` | MC increments a local revocation epoch only. | Provider-controlled, rollback-resistant epoch ordered with spawn. | Inspect AO epoch storage and atomic comparison. |
| Pre-spawn worker authorization | — | — | — | U | `resources/daemon/ao.exe` (packaged); MC `src/assignment.ts:85-108` | MC denies live assignment before its adapter call. | Mandatory AO-side check immediately before every worker creation. | Enumerate and inspect all worker-start paths. |
| Trusted grant verification | — | — | — | U | `resources/app.asar` (packaged); MC `src/authorization.ts:126-163` | MC production verifier always denies; fixture scope checks are not AO checks. | Trusted issuer, actor, scope, expiry, revocation, and one-use consumption at execution. | Inspect provider grant authority and atomic consumption. |
| Session generation fencing | — | — | — | U | `resources/daemon/ao.exe` (packaged); MC `src/clients.ts:125-152` | Local spawn request and session read have no generation contract. | Exact target generation checked at admission and pre-spawn. | Inspect AO session identity and worker handoff. |
| Restart-safe delivery and execution tracking | — | — | — | U | `resources/app.asar.unpacked/node_modules/better-sqlite3` (native dependency); MC `src/state.ts:70-92` | Bundled SQLite dependency does not establish AO storage use or transaction semantics. | Durable ordered admission, dequeue, start, completion, and restart recovery. | Inspect AO data model, transaction boundaries, and crash recovery. |
| Independent provider audit evidence | — | — | — | U | `resources/app.asar` (packaged); MC `src/dispatch.ts:139-144` | MC writes its own audit event marked provider receipt unverified. | Independently obtainable authenticated AO event history. | Obtain provider audit export/read contract and provenance proof. |

The matrix does not classify any capability as `ABSENT IN INSPECTED SOURCE`: no authoritative AO implementation source was available for a meaningful absence claim.

## 4. Instruction and worker execution path

The AO-side path cannot be traced from this installation. The following is a boundary map, **not a claim that AO follows this sequence**:

| Stage | What source establishes | Trust boundary and open question |
| --- | --- | --- |
| Instruction submission | MC's `AoSpawnWorkerRequest` contains project, issue, branch, worktree, prompt, usage limit, and dry-run flag (`tools/mission-control/src/clients.ts:125-133`). The CLI adapter's live `spawnWorker` throws (`src/aoCliClient.ts:73-81`). | A future controller-to-AO handoff would cross into an independent provider. No versioned dispatch envelope exists in this adapter. |
| Message admission | **UNKNOWN** in AO. | Does every CLI, desktop, daemon, API, reconnect, scheduled job, and internal route enter one authorization gate before acceptance? |
| Durable storage and queueing | **UNKNOWN** in AO. | Is the accepted message committed before acknowledgment, and can old queue entries reappear after restart? |
| Worker creation and execution | **UNKNOWN** in AO. | Is grant, STOP epoch, and session generation checked atomically with each worker start and before effects? |
| Completion reporting | **UNKNOWN** in AO. MC's spawn result is session/branch/worktree plus uncertainty (`src/clients.ts:135-140`). | Are outcomes bound to the exact dispatch ID and independently auditable? |

For the existing MC path, live assignment is denied before adapter use (`src/assignment.ts:85-109`); its later legacy spawn call is unreachable in live mode. MC's CLI capability probe checks command availability (`src/aoCliClient.ts:41-59`), which proves no provider protocol. The AO tree does not reveal whether checks occur before queue admission, before or after worker creation, or only in a client. All possible alternative AO ingress and worker-start paths remain **UNKNOWN**; no single controller API can be treated as exhaustive.

## 5. Cancellation and STOP analysis

| Required distinction | Finding |
| --- | --- |
| Permanently retire a queued instruction | **UNKNOWN**; no AO tombstone or queue implementation is readable. |
| Cancellation survives restart | **UNKNOWN**; no AO persistence transaction or recovery code is readable. |
| Fence already dequeued work | **UNKNOWN**; no consumer-to-spawn ordering can be inspected. |
| Prevent stale messages creating new workers | **UNKNOWN**; no universal pre-spawn gate is visible. |
| Durable STOP barrier acknowledgment | **UNKNOWN**; no receipt, epoch, or acknowledgment contract is visible. |
| Every consumer and worker-start path checks the barrier | **UNKNOWN**; consumer and worker-start paths cannot be enumerated from packaged artifacts. |

Stopping an existing worker would not prove that a delayed or replayed message cannot create another one. MC's STOP is local controller state (`src/state.ts:31-47`); its revocation increments only local state (`src/authorization.ts:207-237`). Neither establishes AO queue cancellation, running-work termination, or a provider pre-spawn barrier.

## 6. Provider receipt and lookup capabilities

**UNKNOWN:** No readable AO protocol establishes immutable provider IDs, authenticated acceptance/rejection receipts, exact-ID lookup, durable retirement receipts, or completeness and retention rules. MC's local `DispatchRecord` and digest (`src/dispatch.ts:59-60,73-108`) provide an identity to build on, but `recordDispatchIntent` explicitly has no transport handoff. `reconcileDispatchSnapshot` remains blocked (`:132-136`), as does legacy AO reconciliation (`src/assignment.ts:261-268`; `src/recovery.ts:99-101,152-167`). A session listing, missing session, client response, or local terminal label cannot settle an uncertain dispatch.

## 7. Authorization and revocation capabilities

**CONFIRMED locally:** MC checks grant shape and fixture-only scope, epoch, replay, expiry, and revocation (`src/authorization.ts:126-155`), while its production `verifyCurrentPermission` always denies (`:158-163`). Revocation records a local audit event before advancing the local epoch (`:207-237`). **UNKNOWN in AO:** trusted issuer validation, provider-side grant consumption, revocation propagation, and all-ingress pre-spawn enforcement. The local check cannot prevent a queued AO message from executing after a later revocation.

## 8. Persistence and restart semantics

**CONFIRMED locally:** MC writes state via temporary file and rename (`src/state.ts:70-92`), persists local dispatch intent without handoff (`src/dispatch.ts:73-110`), and quarantines uncertainty (`:114-129`). The local controller lock serializes local ownership (`src/locks.ts:72-163`). **LIMIT:** state and audit are separate writes, with no file-plus-directory sync in the shown state writer; the lock does not order AO queue or worker creation. **UNKNOWN in AO:** persistence engine, acceptance-before-ack ordering, queue replay rules, crash consistency, retention, and restart-safe execution tracking. The bundled `better-sqlite3` native module is not evidence for any of these semantics.

## 9. Integration versus AO modification analysis

| Scope | Assessment |
| --- | --- |
| Existing AO interfaces | MC has a dry-run CLI adapter, session/report/review observations, and an intentionally blocked live spawn (`src/clients.ts:94-157`; `src/aoCliClient.ts:39-81`). These can support read-only or local planning, but no inspected AO interface proves safe live dispatch. |
| Small AO modification | None can be responsibly scoped from the packaged installation. Adding a field or wrapper would not prove durability, atomic fencing, or ingress coverage. A small change becomes plausible only after source review identifies an existing universal execution hook and durable ordering authority. |
| Substantial AO changes | If AO lacks native primitives, implement immutable dispatch records, durable receipts and lookup, authenticated grant use, ordered STOP epochs, queue retirement, pre-spawn checks on every path, and independent audit within AO or an officially supported execution extension. Exact effort remains unknown until AO source is available. |
| Separate mandatory execution architecture | Consider only if it can make every unsafe AO instruction ingress and worker creation path unreachable or subject to the same gate. An external proxy or gateway alone cannot fence direct AO, internal queue, or restart paths. |

## 10. Recommended architecture and route

**Option A — existing AO integration:** not supportable from available evidence. It becomes the smallest route only if version-matched AO source and contract directly prove every required primitive and all-ingress coverage.

**Option B — AO extension:** recommended planning route if source review finds missing primitives and AO can be changed or extended at its mandatory execution boundary. Place dispatch identity, durable decisions, grant verification, STOP epoch ordering, retirement, and pre-spawn checks under one provider authority. MC can then adapt its B2 ledger and B3A authorization model to verified provider receipts. This is a conditional recommendation, not an assertion that the installed build supports extension.

**Option C — controlled replacement execution boundary:** fallback only if AO cannot expose a universal enforceable gate and a separate architecture can disable or control *every* AO ingress and worker-start route. Its feasibility is **UNKNOWN**. Merely adding a gateway is insufficient.

Immediate work in a later authorized phase can prepare a versioned protocol contract, source inventory, threat model, and pure receipt/envelope validation design while live execution stays denied. AO integration, extension, runtime conformance tests, and any controlled replacement require readable version-matched implementation, a defined change boundary, and explicit separate authorization. This phase implements none of them.

## 11. Missing or inconclusive evidence

The inspection lacks AO's package manifest for the application, readable application/daemon source, source maps, message protocol schemas, ingress and worker-start inventory, queue and storage implementation, grant authority, STOP and cancellation implementation, receipt/lookup semantics, provider audit path, and restart recovery logic. The `0.13.6` executable metadata and `33.4.11` text marker need a maintainer-authenticated mapping to the exact AO build. No negative conclusion about an uninspected AO build or extension follows from this gap.

## 12. Requirements for B3B-3

1. Obtain the exact version-matched, human-readable AO source and package/build provenance, or an official versioned execution-extension contract with implementation access. Do not infer protocol behavior from CLI help or packaged dependency names.
2. Enumerate every instruction ingress, queue consumer, worker creation, reconnect, retry, and restart path. Show a mandatory shared authorization and STOP fence on each path.
3. Prove atomic immutable ID binding, same-ID idempotency, durable authenticated accept/reject receipts, exact-ID lookup with retention/completeness, and permanent retirement.
4. Prove trusted issuer/actor/scope verification, single-use grant consumption, session generation, and monotonic epoch checks at admission and immediately before spawn; show durable STOP barrier acknowledgment and behavior of already running work.
5. Specify provider event/audit provenance and storage crash semantics. Then design MC receipt verification, state/audit durability, migration, and quarantine without promoting fixtures or the historical uncertain message.
6. Obtain separate authorization for isolated AO runtime conformance testing and independent review before proposing any live execution change.

## 13. Explicit live-execution no-go conditions

Live AO dispatch remains **NO-GO** while any provider guarantee above is unknown, a receipt lacks authenticated exact ID/payload/target/generation/epoch bindings, lookup cannot rule out delayed delivery, STOP lacks a durable all-path pre-spawn barrier, revocation is only local, provider audit is unavailable, restart can replay work, or the historical uncertain message would be changed. The B1 denial remains active. No integration, AO invocation, runtime test, session inspection, network interaction, or historical reconciliation occurred in this phase.
