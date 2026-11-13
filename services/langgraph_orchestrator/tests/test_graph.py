from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command
from graph import approve_fixture, build_graph, new_fixture

def issue():
    return {"version": 1, "synthetic": True, "issueId": "fixture-demo",
        "issueNumber": 1, "repository": {"owner": "demo", "name": "sandbox"},
        "generation": 1, "stopEpoch": 0,
        "dependencies": {"status": "SATISFIED", "evidenceRef": "fixture-dep"},
        "plan": {"steps": ["Synthetic task"]}}

def steps(*items):
    return [{"role": role, "outcome": outcome, "resultId": f"result-{i}"}
        for i, (role, outcome) in enumerate(items)]

def start(results, custom_issue=None):
    graph = build_graph(InMemorySaver())
    config = {"configurable": {"thread_id": "test"}}
    waiting = graph.invoke(new_fixture(custom_issue if custom_issue is not None else issue(), results), config=config)
    return graph, config, waiting

def test_interrupt_and_success():
    graph, config, waiting = start(steps(("BUILDER", "PASS"), ("TESTER", "PASS"), ("REVIEWER", "PASS")))
    assert waiting["stage"] == "AWAITING_PLAN_APPROVAL"
    assert "__interrupt__" in waiting
    done = approve_fixture(graph, config, waiting)
    assert done["stage"] == "PR_READY_AWAITING_HUMAN"
    assert done["production_authorized"] is False and done["executable"] is False

def test_rejection():
    graph, config, waiting = start([])
    rejected = graph.invoke(Command(resume={"kind": "HUMAN_APPROVAL_FIXTURE",
        "issueId": waiting["issue"]["issueId"], "planDigest": waiting["plan_digest"],
        "generation": 1, "stopEpoch": 0, "approved": False}), config=config)
    assert rejected["blocked_reason"] == "APPROVAL_NOT_GRANTED"

def test_stale_approval():
    graph, config, waiting = start([])
    rejected = graph.invoke(Command(resume={"kind": "HUMAN_APPROVAL_FIXTURE",
        "issueId": waiting["issue"]["issueId"], "planDigest": "stale",
        "generation": 1, "stopEpoch": 0, "approved": True}), config=config)
    assert rejected["blocked_reason"] == "STALE_APPROVAL_FIXTURE"

def test_missing_evidence():
    graph, config, waiting = start([])
    assert approve_fixture(graph, config, waiting)["blocked_reason"] == "EVIDENCE_UNAVAILABLE"

def test_bounded_corrections():
    result = steps(("BUILDER", "PASS"), ("TESTER", "FAIL"),
        ("BUILDER", "PASS"), ("TESTER", "FAIL"),
        ("BUILDER", "PASS"), ("TESTER", "FAIL"))
    graph, config, waiting = start(result)
    done = approve_fixture(graph, config, waiting)
    assert done["blocked_reason"] == "CORRECTION_BUDGET_EXCEEDED"
    assert done["corrections"] == 2

def test_non_synthetic_issue_fails_closed():
    bad = issue()
    bad["synthetic"] = False
    _, _, result = start([], bad)
    assert result["blocked_reason"] == "INVALID_SYNTHETIC_ISSUE"
