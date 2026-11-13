"""Fixture-only SQLite checkpoints plus a persistent, terminal STOP record.

STOP fences only the exported recovery helpers; it cannot stop running agents,
secure concurrent graph writes, authenticate a caller, or authorize execution.
"""
from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.types import Command

from graph import build_graph, new_fixture, valid_id, valid_issue

TERMINAL = {"BLOCKED", "STOPPED", "PR_READY_AWAITING_HUMAN"}
MAX_EPOCH = 2**53 - 1


class FixtureRecoveryError(ValueError):
    """Caller must not advance the simulated workflow."""


def _config(thread_id: str) -> dict:
    if not valid_id(thread_id) or not thread_id.startswith("fixture-"):
        raise FixtureRecoveryError("INVALID_FIXTURE_THREAD")
    return {"configurable": {"thread_id": thread_id}}


def _database(path: str | Path) -> str:
    if not isinstance(path, (str, Path)) or not str(path).strip():
        raise FixtureRecoveryError("INVALID_CHECKPOINT_PATH")
    # Disposable local fixture data only; not a trusted filesystem boundary.
    p = Path(path)
    if not p.is_file() and not p.parent.is_dir():
        raise FixtureRecoveryError("CHECKPOINT_DIRECTORY_UNAVAILABLE")
    return str(p)


def _snapshot(graph: Any, config: dict):
    snapshot = graph.get_state(config)
    if not snapshot.values:
        raise FixtureRecoveryError("UNKNOWN_FIXTURE_THREAD")
    state = snapshot.values
    if state.get("production_authorized") is not False or state.get("executable") is not False:
        raise FixtureRecoveryError("UNTRUSTED_CHECKPOINT")
    return snapshot


def _waiting(snapshot: Any) -> bool:
    return snapshot.values.get("stage") == "AWAITING_PLAN_APPROVAL" and any(
        bool(task.interrupts) for task in snapshot.tasks
    )


# The STOP ledger is independent of LangGraph's interrupt checkpoint.
# Do not infer an ACTIVE permission from an absent, damaged, or old record.
def _ledger(conn: sqlite3.Connection) -> None:
    conn.execute("""CREATE TABLE IF NOT EXISTS fixture_stop_fence (
        thread_id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('ACTIVE','STOPPED')),
        epoch INTEGER NOT NULL CHECK (epoch >= 0 AND epoch <= 9007199254740991)
    )""")


def _fence(conn: sqlite3.Connection, thread_id: str, state: dict) -> tuple[str, int]:
    _ledger(conn)
    row = conn.execute(
        "SELECT status, epoch FROM fixture_stop_fence WHERE thread_id = ?", (thread_id,)
    ).fetchone()
    if row is None:
        raise FixtureRecoveryError("MISSING_FIXTURE_STOP_FENCE")
    status, epoch = row
    baseline = state.get("stop_epoch")
    if (status not in ("ACTIVE", "STOPPED") or type(epoch) is not int
        or not 0 <= epoch <= MAX_EPOCH or type(baseline) is not int
        or not 0 <= baseline <= MAX_EPOCH):
        raise FixtureRecoveryError("INVALID_FIXTURE_STOP_FENCE")
    if status == "ACTIVE" and epoch != baseline:
        raise FixtureRecoveryError("STALE_FIXTURE_STOP_FENCE")
    if status == "STOPPED" and (epoch <= baseline or epoch != baseline + 1):
        raise FixtureRecoveryError("INVALID_FIXTURE_STOP_FENCE")
    return status, epoch


def start_fixture(path: str | Path, thread_id: str, issue: dict, results: list[dict]) -> dict:
    """New fixture thread; reserve its fence identity before running the graph."""
    config = _config(thread_id)
    if not valid_issue(issue):
        raise FixtureRecoveryError("INVALID_SYNTHETIC_ISSUE")
    filename = _database(path)
    with sqlite3.connect(filename, timeout=5) as conn:
        _ledger(conn)
        try:
            conn.execute(
                "INSERT INTO fixture_stop_fence(thread_id,status,epoch) VALUES (?, 'ACTIVE', ?)",
                (thread_id, issue["stopEpoch"])
            )
        except sqlite3.IntegrityError as error:
            raise FixtureRecoveryError("FIXTURE_THREAD_ALREADY_EXISTS") from error
    # Reservation is deliberately NOT rolled back after graph failure: uncertain
    # creation must never be retried automatically using the same identity.
    with SqliteSaver.from_conn_string(filename) as saver:
        graph = build_graph(saver)
        if graph.get_state(config).values:
            raise FixtureRecoveryError("FIXTURE_THREAD_ALREADY_EXISTS")
        return dict(graph.invoke(new_fixture(issue, results), config=config))


def inspect_fixture(path: str | Path, thread_id: str) -> dict:
    """Return effective terminal STOP even if LangGraph retains an old interrupt."""
    config = _config(thread_id)
    filename = _database(path)
    with SqliteSaver.from_conn_string(filename) as saver:
        snapshot = _snapshot(build_graph(saver), config)
        with sqlite3.connect(filename, timeout=5) as conn:
            status, epoch = _fence(conn, thread_id, snapshot.values)
        stopped = status == "STOPPED"
        return {"stage": "STOPPED" if stopped else snapshot.values["stage"],
                "waiting_for_approval": not stopped and _waiting(snapshot),
                "plan_digest": snapshot.values["plan_digest"],
                "generation": snapshot.values["generation"],
                "stop_epoch": epoch,
                "blocked_reason": "STOP_ACTIVE" if stopped else snapshot.values["blocked_reason"],
                "production_authorized": False, "executable": False}


def stop_fixture(path: str | Path, thread_id: str) -> dict:
    """Persist a terminal STOP in the fixture ledger; repeated STOP is idempotent.

    This does not terminate any process or atomically fence concurrent execution.
    """
    config = _config(thread_id)
    filename = _database(path)
    with SqliteSaver.from_conn_string(filename) as saver:
        snapshot = _snapshot(build_graph(saver), config)
        with sqlite3.connect(filename, timeout=5, isolation_level=None) as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                status, epoch = _fence(conn, thread_id, snapshot.values)
                if status != "STOPPED":
                    if epoch >= MAX_EPOCH:
                        raise FixtureRecoveryError("STOP_EPOCH_EXHAUSTED")
                    epoch += 1
                    conn.execute(
                        "UPDATE fixture_stop_fence SET status='STOPPED', epoch=? WHERE thread_id=?",
                        (epoch, thread_id)
                    )
                conn.commit()
            except BaseException:
                conn.rollback()
                raise
    return inspect_fixture(filename, thread_id)


def resume_fixture(path: str | Path, thread_id: str, *, plan_digest: str,
                   generation: int, stop_epoch: int, approved: bool) -> dict:
    """Resume a fixture interrupt only when the persistent STOP fence is active-safe.

    Not authenticated and not concurrency-safe against external direct graph calls.
    """
    config = _config(thread_id)
    filename = _database(path)
    with SqliteSaver.from_conn_string(filename) as saver:
        graph = build_graph(saver)
        snapshot = _snapshot(graph, config)
        state = snapshot.values
        with sqlite3.connect(filename, timeout=5) as conn:
            status, epoch = _fence(conn, thread_id, state)
        if status == "STOPPED":
            raise FixtureRecoveryError("FIXTURE_STOPPED")
        if state["stage"] in TERMINAL or not _waiting(snapshot):
            raise FixtureRecoveryError("NO_PENDING_FIXTURE_APPROVAL")
        if (state["plan_digest"], state["generation"], epoch) != (
            plan_digest, generation, stop_epoch
        ):
            raise FixtureRecoveryError("STALE_FIXTURE_RESUME")
        if type(approved) is not bool:
            raise FixtureRecoveryError("INVALID_FIXTURE_DECISION")
        return dict(graph.invoke(Command(resume={
            "kind": "HUMAN_APPROVAL_FIXTURE",
            "issueId": state["issue"]["issueId"],
            "planDigest": plan_digest, "generation": generation,
            "stopEpoch": epoch, "approved": approved
        }), config=config))
