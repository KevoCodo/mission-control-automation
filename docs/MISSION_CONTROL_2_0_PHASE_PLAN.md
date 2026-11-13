# Mission Control 2.0 phase plan

Baseline: `dd11843` on `main`. Modernization branch: `feature/langgraph-orchestration-foundation`.

**Safety decision:** LangGraph coordinates only synthetic fixture workflows during Phase 1. The TypeScript controller and its default-deny safety guarantees are preserved. Gate 2B Windows runtime containment is unverified, and nothing in this branch authorizes Codex, AO, shell workers, network actions, PR writes, merges or deployment.

| Phase | Objective | Acceptance evidence |
| --- | --- | --- |
| 0 | Preserve and review baseline | Main commit, controller safety inventory, no lost work |
| 1 | Evaluate LangGraph | Separate fixture-only Python graph, approval interruption, tests, documented parity gaps |
| 2 | Trusted worker boundary | Independently verified containment, STOP fence, capability grants and cleanup, with separate security GO |
| 3 | Supervised issue-to-PR | One scoped external issue, independently verified exact-head test/review evidence |
| 4 | GitHub delivery integration | Provider reconciliation, narrowly authorized PR writes, audit trail |
| 5 | Recovery and concurrency | Durable replay protection, worker ownership, bounded retries, crash tests, parallelism |
| 6 | Operator experience | Redacted traces, accessible dashboard, incident controls |
| 7 | Production-style validation | Security review, failure injection, load tests and release evidence |
| 8 | Unified Integration Hub | Two external APIs, trustworthy webhook sync, operational performance report |

## Reused foundations

`tools/mission-control/src/simulatedSdlcOrchestration.ts` remains the richer reference implementation: synthetic input enforcement, exact plan approval fixtures, STOP epoch, role evidence binding, commit identity, bounded correction generations and fail-closed behavior. The LangGraph graph has a deliberately limited feature subset. **Do not treat a passing fixture as real authorization or independent evidence.**

## Phase 1 gates

1. Review the exact TypeScript-to-Python semantics, including plan digest and result binding.
2. Run LangGraph tests with installed dependencies in CI; current authoring environment could validate Python syntax only because the dependencies were unavailable.
3. Demonstrate interruption and resume with real checkpointing on disposable state.
4. Document missing cross-process replay, STOP and provider evidence enforcement. No live execution integration.
5. Keep new service separate from the security controller, and review the PR before merging.
