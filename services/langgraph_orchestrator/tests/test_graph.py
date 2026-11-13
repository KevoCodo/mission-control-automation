from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command
from graph import approve_fixture, build_graph, new_fixture, plan_fingerprint

def issue():
    return {"version": 1, "synthetic": True, "issueId": "fixture-demo",
        "issueNumber": 1, "repository": {"owner": "demo", "name": "sandbox"},
        "generation": 1, "stopEpoch": 0,
        "dependencies": {"status": "SATISFIED", "evidenceRef": "fixture-dep"},
        "plan": {"steps": ["Synthetic task"]}}

def steps(*items):
    fixture = issue()
    generation = fixture["generation"]
    builder_number = 0
    commit = ""
    results = []
    for i, (role, outcome) in enumerate(items):
        if role == "BUILDER":
            builder_number += 1
            commit = f"{builder_number:040x}"
        results.append({"role": role, "outcome": outcome, "resultId": f"result-{i}",
            "repository": fixture["repository"].copy(), "issueId": fixture["issueId"],
            "issueNumber": fixture["issueNumber"], "planDigest": plan_fingerprint(fixture),
            "generation": generation, "stopEpoch": fixture["stopEpoch"], "commit": commit})
        if role in ("TESTER", "REVIEWER") and outcome == "FAIL":
            generation += 1
    return results

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

def test_rejects_mismatched_identity_and_stale_generation():
    for field, replacement in (
        ("issueId", "fixture-other"), ("issueNumber", 99),
        ("repository", {"owner": "other", "name": "sandbox"}),
        ("planDigest", "0" * 64), ("generation", 9), ("stopEpoch", 1),
    ):
        evidence = steps(("BUILDER", "PASS"))
        evidence[0][field] = replacement
        graph, config, waiting = start(evidence)
        assert approve_fixture(graph, config, waiting)["blocked_reason"] == "STALE_ROLE_FIXTURE", field

def test_rejects_mismatched_exact_commit():
    evidence = steps(("BUILDER", "PASS"), ("TESTER", "PASS"), ("REVIEWER", "PASS"))
    evidence[1]["commit"] = "f" * 40
    graph, config, waiting = start(evidence)
    assert approve_fixture(graph, config, waiting)["blocked_reason"] == "MISMATCHED_ROLE_COMMIT"

def test_rejects_reused_builder_commit_after_correction():
    evidence = steps(("BUILDER", "PASS"), ("TESTER", "FAIL"),
        ("BUILDER", "PASS"), ("TESTER", "PASS"), ("REVIEWER", "PASS"))
    evidence[2]["commit"] = evidence[0]["commit"]
    graph, config, waiting = start(evidence)
    assert approve_fixture(graph, config, waiting)["blocked_reason"] == "REUSED_BUILDER_COMMIT"

def test_rejects_stale_generation_after_correction():
    evidence = steps(("BUILDER", "PASS"), ("TESTER", "FAIL"),
        ("BUILDER", "PASS"), ("TESTER", "PASS"), ("REVIEWER", "PASS"))
    evidence[2]["generation"] = 1
    graph, config, waiting = start(evidence)
    assert approve_fixture(graph, config, waiting)["blocked_reason"] == "STALE_ROLE_FIXTURE"

def test_rejects_duplicate_result_and_extra_fields():
    evidence = steps(("BUILDER", "PASS"), ("TESTER", "PASS"))
    evidence[1]["resultId"] = evidence[0]["resultId"]
    graph, config, waiting = start(evidence)
    assert approve_fixture(graph, config, waiting)["blocked_reason"] == "DUPLICATE_FIXTURE"
    evidence = steps(("BUILDER", "PASS"))
    evidence[0]["unexpected"] = True
    graph, config, waiting = start(evidence)
    assert approve_fixture(graph, config, waiting)["blocked_reason"] == "INVALID_ROLE_FIXTURE"

def test_corrected_commit_happy_path():
    evidence = steps(("BUILDER", "PASS"), ("TESTER", "FAIL"),
        ("BUILDER", "PASS"), ("TESTER", "PASS"), ("REVIEWER", "PASS"))
    graph, config, waiting = start(evidence)
    done = approve_fixture(graph, config, waiting)
    assert done["stage"] == "PR_READY_AWAITING_HUMAN"
    assert done["current_commit"] == evidence[2]["commit"]
    assert done["production_authorized"] is False and done["executable"] is False
