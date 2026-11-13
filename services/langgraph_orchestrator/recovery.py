"""Durable fixture-only checkpoint inspection and gated resume.

This module has no worker adapters, OS process controls, or authenticated grants.
Its STOP and replay checks protect only this synthetic test interface.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.types import Command

from graph import build_graph, new_fixture, valid_id

TERMINAL = {"BLOCKED", "STOPPED", "PR_READY_AWAITING_HUMAN"}


class FixtureRecoveryError(ValueError):
    """Caller must not advance the simulated workflow."""


def _config(thread_id: str) -> dict:
    if not valid_id(thread_id) or not thread_id.startswith("fixture-"):
        raise FixtureRecoveryError("INVALID_FIXTURE_THREAD")
    return {"configurable": {"thread_id": thread_id}}


def _database(path: str | Path) -> str:
    if not isinstance(path, (str, Path)) or not str(path).strip():
        raise FixtureRecoveryError("INVALID_CHECKPOINT_PATH")
    # Local, disposable fixture data only. Do not accept this as a trusted storage boundary.
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


def start_fixture(path: str | Path, thread_id: str, issue: dict, results: list[dict]) -> dict:
    """Start a NEW fixture thread. Never restart a known thread from initial input."""
    config = _config(thread_id)
    with SqliteSaver.from_conn_string(_database(path)) as saver:
        graph = build_graph(saver)
        if graph.get_state(config).values:
            raise FixtureRecoveryError("FIXTURE_THREAD_ALREADY_EXISTS")
        state = graph.invoke(new_fixture(issue, results), config=config)
        return dict(state)


def inspect_fixture(path: str | Path, thread_id: str) -> dict:
    """Read the persisted workflow, including whether a real graph interrupt is pending."""
    config = _config(thread_id)
    with SqliteSaver.from_conn_string(_database(path)) as saver:
        snapshot = _snapshot(build_graph(saver), config)
        return {"stage": snapshot.values["stage"], "waiting_for_approval": _waiting(snapshot),
                "plan_digest": snapshot.values["plan_digest"],
                "generation": snapshot.values["generation"],
                "stop_epoch": snapshot.values["stop_epoch"],
                "blocked_reason": snapshot.values["blocked_reason"],
                "production_authorized": False, "executable": False}


def resume_fixture(path: str | Path, thread_id: str, *, plan_digest: str,
                   generation: int, stop_epoch: int, approved: bool) -> dict:
    """Explicit fixture resume; never infer approval from checkpoint presence.

    Caller values bind a resume to the exact checkpoint. This is NOT authentication.
    """
    config = _config(thread_id)
    with SqliteSaver.from_conn_string(_database(path)) as saver:
        graph = build_graph(saver)
        snapshot = _snapshot(graph, config)
        state = snapshot.values
        if state["stage"] in TERMINAL or not _waiting(snapshot):
            raise FixtureRecoveryError("NO_PENDING_FIXTURE_APPROVAL")
        if (state["plan_digest"], state["generation"], state["stop_epoch"]) != (
            plan_digest, generation, stop_epoch
        ):
            raise FixtureRecoveryError("STALE_FIXTURE_RESUME")
        if type(approved) is not bool:
            raise FixtureRecoveryError("INVALID_FIXTURE_DECISION")
        return dict(graph.invoke(Command(resume={
            "kind": "HUMAN_APPROVAL_FIXTURE",
            "issueId": state["issue"]["issueId"],
            "planDigest": plan_digest, "generation": generation,
            "stopEpoch": stop_epoch, "approved": approved
        }), config=config))
