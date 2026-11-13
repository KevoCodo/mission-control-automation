# Mission Control 2.0: LangGraph foundation

**Experimental, fixture-only. No real agent execution or external API calls.**

This Python service is a parallel orchestration evaluation. The existing TypeScript controller in `tools/mission-control` remains authoritative for all policies, evidence and dispatch denial. Graph state, interrupted approvals and simulated PASS results are **never trusted grants or independent test/review evidence**.

## Install and test

Requires Python 3.11+.

```bash
cd services/langgraph_orchestrator
python -m venv .venv
source .venv/Scripts/activate  # Git Bash on Windows
python -m pip install -e '.[test]'
python -m pytest -q
```

`build_graph(checkpointer)` takes an explicit LangGraph checkpoint implementation. Tests use `InMemorySaver()`; durable local fixture experiments can use `SqliteSaver` from `langgraph-checkpoint-sqlite` with its supported context manager. SQLite checkpointing is **not** a substitute for independently verified crash recovery, STOP fencing or an append-only audit log.

Graph input must contain one strictly marked synthetic issue with a bounded plan and satisfied fixture dependency, plus explicit Builder, Tester and Reviewer fixture results. It stops at a LangGraph `interrupt` for an approval fixture. Resume using `Command(resume=...)`, binding exact issue ID, plan digest, generation and stop epoch. `approve_fixture` is a convenience for tests, not a user authentication system.

Outcomes are never assumed. Missing, unknown, mismatched and over-budget fixture results block progression. `PR_READY_AWAITING_HUMAN` means synthetic progression only; no PR exists.

**Important gaps:** fixture result identity and commit strings are compared by exact value, but are still untrusted caller claims. The graph does not independently verify evidence provenance, provide an authenticated authorization grant, or implement a real worker STOP mechanism. It must not be connected to worker execution, GitHub writes or the production controller. Phase 1 requires dependency-backed tests and parity review before sign-off.


## Phase 1B: durable fixture recovery (experimental)

`recovery.py` uses a disposable on-disk SQLite checkpoint file to persist the LangGraph state and approval interrupt. Calls to `start_fixture`, `inspect_fixture` and `resume_fixture` reopen the database each time, simulating a fresh process. A thread ID must begin with `fixture-`. An already-known thread cannot be restarted from its initial input. Resuming requires an actual pending interrupt, matching plan digest, generation, and STOP epoch, and an explicit Boolean approval fixture. Completed or blocked threads reject repeated resume calls.

Example using a Python interpreter in this directory:

```python
from recovery import start_fixture, inspect_fixture, resume_fixture
# Supply a synthetic issue and explicit fixture-only role results.
# start_fixture("fixture.sqlite", "fixture-demo-1", issue, results)
# inspect_fixture("fixture.sqlite", "fixture-demo-1")
# resume_fixture("fixture.sqlite", "fixture-demo-1", plan_digest=..., generation=1, stop_epoch=0, approved=True)
```

This is a **controlled synthetic replay experiment**, not safe autonomous recovery. The SQLite file and caller are not authenticated, concurrent execution is not fenced, and the simulated STOP epoch is only an input binding. There is no independent process-tree STOP, transactional authorization grant, verified identity, immutable audit trail, authenticated exact-commit evidence, or controller-backed admission. No real worker or GitHub side effect is connected. A checkpoint is not an authorization receipt. Keep fixture database files outside version control.


## Phase 1C Issue #5: persistent fixture STOP gate

The exported recovery interface adds `stop_fixture(path, thread_id)`. It records an irreversible terminal STOP in a dedicated SQLite `fixture_stop_fence` row with one monotonic epoch increment. Repeated STOP calls are idempotent and do not increment again. `inspect_fixture` returns effective `STOPPED` and `waiting_for_approval: false` even if the underlying LangGraph checkpoint retains its previously interrupted approval. `resume_fixture` rejects stopped threads **before** accepting a stored approval. An absent or inconsistent ledger record fails closed. A thread ID remains reserved across failures and STOP.

The API is deliberately limited to **synthetic, serial, local experiments**. This is a terminal STOP *at the recovery interface*, not within arbitrary direct `graph.invoke` calls. It does **not** guarantee atomic order against concurrent `resume_fixture` calls or STOP racing with a resume, and cannot kill a process. Do not expose these helpers as a network service or connect them to real workers. The controller-owned durable fence, authenticated permissions, exact admission ordering and process-tree termination belong to Phase 2 / issue #9.

Run `python -m pytest -q` to exercise restart, repeated STOP, denial, missing/tampered row, and complete-thread STOP cases. The stop tests use separate SQLite connections per operation, not full operating-system crash injection.


## Phase 1C Issue #6: deny-only controller interface proposal

`controller_contract.py` specifies a versioned, strict, **synthetic-only** request/decision shape. The TypeScript-side mirror is `tools/mission-control/src/langgraphFixtureContract.ts` and both languages have fixture tests for malformed requests, role/scope mismatch and a DENY-only response. Validating a request does **not** authorize it: even a well-formed request always yields `DENY` with `authoritative=false`, `productionAuthorized=false` and `executable=false`. There is no transport or execution adapter.

See `docs/LANGGRAPH_CONTROLLER_CONTRACT_PHASE1C.md` for the mapping to existing B2/B3A/B3B protocols and unresolved authentication, atomic STOP, provider identity and replay protections. This is a proposal for future integration, not a working controller bridge.
