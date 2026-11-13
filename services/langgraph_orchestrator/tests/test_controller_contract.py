"""Cross-boundary fixtures: strict parsing cannot create an authorization."""
import copy

import pytest
from controller_contract import InvalidFixtureRequest, deny_request, parse_request


def request():
    return {
        "version": 1, "kind": "CONTROLLER_DECISION_REQUEST_FIXTURE",
        "requestId": "fixture-request-1", "issueId": "fixture-demo",
        "issueNumber": 7, "repository": {"owner": "demo", "name": "sandbox"},
        "planDigest": "a" * 64, "generation": 1, "stopEpoch": 0,
        "actionScope": "ASSIGNMENT", "agentRole": "BUILDER",
        "commitSha": None,
    }


def test_well_formed_request_still_denied():
    item = request()
    assert parse_request(item) == item
    decision = deny_request(item)
    assert decision == {
        "version": 1, "kind": "CONTROLLER_DECISION_FIXTURE",
        "requestId": "fixture-request-1",
        "decision": "DENY", "authoritative": False,
        "productionAuthorized": False, "executable": False,
        "reason": "NO_TRUSTED_CONTROLLER_ADAPTER",
    }


@pytest.mark.parametrize("field,replacement", [
    ("version", 2), ("version", True), ("kind", "LIVE"),
    ("requestId", "request-1"), ("issueId", "live-issue"),
    ("issueNumber", True), ("issueNumber", 0),
    ("planDigest", "0"), ("generation", True), ("generation", 0),
    ("stopEpoch", -1), ("stopEpoch", True),
    ("actionScope", "MERGE"), ("actionScope", "DEPLOY"),
    ("agentRole", "MERGER"), ("agentRole", "ADMIN"),
    ("commitSha", "not-a-commit"),
])
def test_invalid_claims_rejected(field, replacement):
    item = request()
    item[field] = replacement
    with pytest.raises(InvalidFixtureRequest):
        deny_request(item)


def test_reject_extra_and_missing_fields():
    for operation in ("extra", "missing"):
        item = request()
        if operation == "extra":
            item["grantId"] = "fixture-grant"
        else:
            del item["requestId"]
        with pytest.raises(InvalidFixtureRequest, match="INVALID_FIXTURE_REQUEST"):
            parse_request(item)


def test_repository_strict_and_detached():
    item = request()
    parsed = parse_request(item)
    item["repository"]["owner"] = "changed"
    assert parsed["repository"]["owner"] == "demo"
    for bad in ({}, {"owner": "demo", "name": "sandbox", "root": True}, "demo/sandbox"):
        case = request()
        case["repository"] = bad
        with pytest.raises(InvalidFixtureRequest):
            parse_request(case)


def test_role_action_pairings_fail_closed():
    for role, action, commit in [
        ("BUILDER", "MERGE", None),
        ("REVIEWER", "ASSIGNMENT", "a" * 40),
        ("ORCHESTRATOR", "CORRECTION", None),
        ("TESTER", "REVIEW", None),
    ]:
        item = request()
        item.update(agentRole=role, actionScope=action, commitSha=commit)
        with pytest.raises(InvalidFixtureRequest):
            parse_request(item)


def test_review_request_with_commit_still_denied():
    item = request()
    item.update(agentRole="REVIEWER", actionScope="REVIEW", commitSha="f" * 40)
    assert deny_request(item)["decision"] == "DENY"


def test_no_request_field_can_inject_authority():
    item = request()
    for key in ("approved", "executable", "authoritative", "grant", "shellCommand"):
        changed = copy.deepcopy(item)
        changed[key] = True
        with pytest.raises(InvalidFixtureRequest):
            deny_request(changed)
