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

**Important gaps:** unlike the existing TypeScript simulator, this initial graph does not bind results to a specific commit SHA, verify evidence provenance, protect against durable cross-process replay, or implement an independently enforced STOP mechanism. It must not be connected to worker execution, GitHub writes or the production controller. Phase 1 requires dependency-backed tests and parity review before sign-off.
