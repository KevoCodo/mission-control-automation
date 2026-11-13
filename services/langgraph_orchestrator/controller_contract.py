"""Pure, default-deny fixture contract; never an execution authorization.

TypeScript controller remains the only potential security authority. No transport,
issuer, trusted grant, process execution, or live controller integration exists.
"""
from __future__ import annotations

import re
from typing import Any

VERSION = 1
ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$")
SHA256 = re.compile(r"^[a-f0-9]{64}$")
SHA1 = re.compile(r"^[a-f0-9]{40}$")
ACTIONS = frozenset({"ASSIGNMENT", "REVIEW", "CORRECTION"})
ROLES = frozenset({"ORCHESTRATOR", "BUILDER", "TESTER", "REVIEWER"})
EXPECTED = frozenset({
    "version", "kind", "requestId", "issueId", "issueNumber", "repository",
    "planDigest", "generation", "stopEpoch", "actionScope", "agentRole", "commitSha"
})


class InvalidFixtureRequest(ValueError):
    """Malformed requests are not eligible for even simulated consideration."""


def _id(value: Any) -> bool:
    return type(value) is str and ID.fullmatch(value) is not None


def _number(value: Any, *, zero: bool = False) -> bool:
    return type(value) is int and (0 if zero else 1) <= value < 2**53


def parse_request(value: Any) -> dict:
    """Validate caller-supplied claims, not identity, authority, or authenticity."""
    if type(value) is not dict or set(value) != EXPECTED:
        raise InvalidFixtureRequest("INVALID_FIXTURE_REQUEST")
    repo = value["repository"]
    if (value["version"] != VERSION or type(value["version"]) is not int
        or value["kind"] != "CONTROLLER_DECISION_REQUEST_FIXTURE"
        or not _id(value["requestId"]) or not value["requestId"].startswith("fixture-")
        or not _id(value["issueId"]) or not value["issueId"].startswith("fixture-")
        or not _number(value["issueNumber"])
        or type(repo) is not dict or set(repo) != {"owner", "name"}
        or not all(_id(repo[k]) for k in ("owner", "name"))
        or type(value["planDigest"]) is not str
        or SHA256.fullmatch(value["planDigest"]) is None
        or not _number(value["generation"])
        or not _number(value["stopEpoch"], zero=True)
        or type(value["actionScope"]) is not str
        or value["actionScope"] not in ACTIONS
        or type(value["agentRole"]) is not str
        or value["agentRole"] not in ROLES
        or (value["commitSha"] is not None and (
            type(value["commitSha"]) is not str or
            SHA1.fullmatch(value["commitSha"]) is None))):
        raise InvalidFixtureRequest("INVALID_FIXTURE_REQUEST")
    # Role-action compatibility is a *request shape* filter, not permission.
    allowed_shapes = {
        "ORCHESTRATOR": {"ASSIGNMENT"},
        "BUILDER": {"ASSIGNMENT", "CORRECTION"},
        "TESTER": {"REVIEW"},
        "REVIEWER": {"REVIEW"},
    }
    if value["actionScope"] not in allowed_shapes[value["agentRole"]]:
        raise InvalidFixtureRequest("UNSUPPORTED_ROLE_ACTION")
    if value["agentRole"] in {"TESTER", "REVIEWER"} and value["commitSha"] is None:
        raise InvalidFixtureRequest("MISSING_EXACT_COMMIT")
    return {**value, "repository": dict(repo)}


def deny_request(value: Any) -> dict:
    """Always fail closed. A valid request still has zero execution authority."""
    parsed = parse_request(value)
    return {
        "version": VERSION,
        "kind": "CONTROLLER_DECISION_FIXTURE",
        "requestId": parsed["requestId"],
        "decision": "DENY",
        "authoritative": False,
        "productionAuthorized": False,
        "executable": False,
        "reason": "NO_TRUSTED_CONTROLLER_ADAPTER",
    }
