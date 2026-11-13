"""Synthetic-only LangGraph evaluation. NEVER connect to real worker execution."""
from __future__ import annotations
import hashlib
import json
import re
from typing import Any, TypedDict
from langgraph.graph import START, END, StateGraph
from langgraph.types import Command, interrupt

ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$")

class State(TypedDict):
    issue: dict
    results: list[dict]
    stage: str
    plan_digest: str
    generation: int
    stop_epoch: int
    corrections: int
    index: int
    history: list[str]
    blocked_reason: str | None
    current_commit: str
    production_authorized: bool
    executable: bool

def valid_id(value: Any) -> bool:
    return type(value) is str and bool(ID.fullmatch(value))

def valid_issue(issue: Any) -> bool:
    if type(issue) is not dict or set(issue) != {
        "version", "synthetic", "issueId", "issueNumber", "repository",
        "generation", "stopEpoch", "dependencies", "plan"
    }:
        return False
    repo, dep, plan = issue["repository"], issue["dependencies"], issue["plan"]
    return (issue["version"] == 1 and issue["synthetic"] is True
        and valid_id(issue["issueId"]) and issue["issueId"].startswith("fixture-")
        and type(issue["issueNumber"]) is int and issue["issueNumber"] > 0
        and type(issue["generation"]) is int and 0 < issue["generation"] < 2**53
        and type(issue["stopEpoch"]) is int and 0 <= issue["stopEpoch"] < 2**53
        and type(repo) is dict and set(repo) == {"owner", "name"}
        and all(valid_id(repo[k]) for k in ("owner", "name"))
        and type(dep) is dict and set(dep) == {"status", "evidenceRef"}
        and dep["status"] == "SATISFIED" and valid_id(dep["evidenceRef"])
        and type(plan) is dict and set(plan) == {"steps"}
        and type(plan["steps"]) is list and 1 <= len(plan["steps"]) <= 5
        and all(type(s) is str and 0 < len(s.strip()) <= 300 for s in plan["steps"]))

def plan_fingerprint(issue: dict) -> str:
    bound = {"issueId": issue["issueId"], "issueNumber": issue["issueNumber"],
        "repository": issue["repository"], "steps": issue["plan"]["steps"]}
    return hashlib.sha256(json.dumps(bound, separators=(",", ":")).encode()).hexdigest()

def valid_commit(value: Any) -> bool:
    return type(value) is str and bool(re.fullmatch(r"[0-9a-f]{40}", value))

def block(state: State, reason: str) -> dict:
    return {"stage": "BLOCKED", "blocked_reason": reason,
        "history": [*state["history"], "BLOCKED:" + reason],
        "production_authorized": False, "executable": False}

def plan(state: State) -> dict:
    issue = state["issue"]
    if not valid_issue(issue):
        return block(state, "INVALID_SYNTHETIC_ISSUE")
    if type(state["results"]) is not list or len(state["results"]) > 16:
        return block(state, "INVALID_FIXTURE_RESULTS")
    digest = plan_fingerprint(issue)
    return {"stage": "AWAITING_PLAN_APPROVAL", "plan_digest": digest,
        "generation": issue["generation"], "stop_epoch": issue["stopEpoch"],
        "corrections": 0, "index": 0, "blocked_reason": None, "current_commit": "",
        "history": ["FIXTURE_PLAN_READY"],
        "production_authorized": False, "executable": False}

def after_plan(state: State) -> str:
    return "end" if state["stage"] == "BLOCKED" else "approval"

def approval(state: State) -> dict:
    decision = interrupt({"kind": "PLAN_APPROVAL_FIXTURE_REQUEST",
        "issueId": state["issue"]["issueId"], "planDigest": state["plan_digest"],
        "generation": state["generation"], "stopEpoch": state["stop_epoch"]})
    if type(decision) is not dict or set(decision) != {
        "kind", "issueId", "planDigest", "generation", "stopEpoch", "approved"
    }:
        return block(state, "MALFORMED_APPROVAL_FIXTURE")
    if decision["kind"] != "HUMAN_APPROVAL_FIXTURE" or decision["approved"] is not True:
        return block(state, "APPROVAL_NOT_GRANTED")
    if (decision["issueId"], decision["planDigest"], decision["generation"], decision["stopEpoch"]) != (
        state["issue"]["issueId"], state["plan_digest"], state["generation"], state["stop_epoch"]
    ):
        return block(state, "STALE_APPROVAL_FIXTURE")
    return {"stage": "BUILDER_RUNNING_SIMULATED",
        "history": [*state["history"], "APPROVAL_FIXTURE_ACCEPTED"]}

def after_role(state: State) -> str:
    return "end" if state["stage"] in ("BLOCKED", "PR_READY_AWAITING_HUMAN") else "role"

def role(state: State) -> dict:
    idx, results = state["index"], state["results"]
    if idx >= len(results):
        return block(state, "EVIDENCE_UNAVAILABLE")
    expected = {"BUILDER_RUNNING_SIMULATED": "BUILDER",
        "TESTER_RUNNING_SIMULATED": "TESTER",
        "REVIEWER_RUNNING_SIMULATED": "REVIEWER"}.get(state["stage"])
    item = results[idx]
    if (not expected or type(item) is not dict
        or set(item) != {"role", "outcome", "resultId", "repository", "issueId",
            "issueNumber", "planDigest", "generation", "stopEpoch", "commit"}
        or item.get("role") != expected
        or item.get("outcome") not in ("PASS", "FAIL", "UNKNOWN")
        or not valid_id(item.get("resultId")) or not valid_commit(item.get("commit"))):
        return block(state, "INVALID_ROLE_FIXTURE")
    issue = state["issue"]
    if (item["repository"] != issue["repository"] or item["issueId"] != issue["issueId"]
        or type(item["issueNumber"]) is not int or item["issueNumber"] != issue["issueNumber"]
        or item["planDigest"] != state["plan_digest"]
        or type(item["generation"]) is not int or item["generation"] != state["generation"]
        or type(item["stopEpoch"]) is not int or item["stopEpoch"] != state["stop_epoch"]):
        return block(state, "STALE_ROLE_FIXTURE")
    if expected == "BUILDER":
        if item["commit"] == state["current_commit"]:
            return block(state, "REUSED_BUILDER_COMMIT")
    elif item["commit"] != state["current_commit"]:
        return block(state, "MISMATCHED_ROLE_COMMIT")
    if item["resultId"] in state["history"]:
        return block(state, "DUPLICATE_FIXTURE")
    if item["outcome"] == "UNKNOWN":
        return block(state, "EVIDENCE_UNAVAILABLE")
    if expected == "BUILDER" and item["outcome"] == "FAIL":
        return block(state, "BUILDER_FIXTURE_FAILED")
    update: dict = {"index": idx + 1, "production_authorized": False, "executable": False}
    if expected == "BUILDER":
        update["current_commit"] = item["commit"]
    if item["outcome"] == "FAIL":
        if state["corrections"] >= 2 or state["generation"] >= 2**53 - 1:
            return block(state, "CORRECTION_BUDGET_EXCEEDED")
        update.update(stage="BUILDER_RUNNING_SIMULATED",
            corrections=state["corrections"] + 1, generation=state["generation"] + 1)
    else:
        update["stage"] = {"BUILDER": "TESTER_RUNNING_SIMULATED",
            "TESTER": "REVIEWER_RUNNING_SIMULATED",
            "REVIEWER": "PR_READY_AWAITING_HUMAN"}[expected]
    update["history"] = [*state["history"], item["resultId"]]
    return update

def build_graph(checkpointer: Any):
    workflow = StateGraph(State)
    workflow.add_node("plan", plan)
    workflow.add_node("approval", approval)
    workflow.add_node("role", role)
    workflow.add_edge(START, "plan")
    workflow.add_conditional_edges("plan", after_plan, {"approval": "approval", "end": END})
    workflow.add_conditional_edges("approval", after_role, {"role": "role", "end": END})
    workflow.add_conditional_edges("role", after_role, {"role": "role", "end": END})
    return workflow.compile(checkpointer=checkpointer)

def new_fixture(issue: dict, results: list[dict]) -> State:
    return {"issue": issue, "results": results, "stage": "NEW",
        "plan_digest": "", "generation": 0, "stop_epoch": 0, "corrections": 0,
        "index": 0, "history": [], "blocked_reason": None, "current_commit": "",
        "production_authorized": False, "executable": False}

def approve_fixture(graph: Any, config: dict, waiting: dict):
    """For tests only; NOT an authenticated human approval."""
    return graph.invoke(Command(resume={"kind": "HUMAN_APPROVAL_FIXTURE",
        "issueId": waiting["issue"]["issueId"], "planDigest": waiting["plan_digest"],
        "generation": waiting["generation"], "stopEpoch": waiting["stop_epoch"],
        "approved": True}), config=config)
