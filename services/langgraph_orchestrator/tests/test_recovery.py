"""Disposable SQLite checkpoint tests. No external providers or coding agents."""
import pytest

from recovery import FixtureRecoveryError, inspect_fixture, resume_fixture, start_fixture
from test_graph import issue, steps


def begin(tmp_path, results=None):
    db = tmp_path / "fixtures.sqlite"
    waiting = start_fixture(db, "fixture-thread-one", issue(), results or [])
    return db, waiting


def resume(db, waiting, approved=True):
    return resume_fixture(db, "fixture-thread-one",
        plan_digest=waiting["plan_digest"],
        generation=waiting["generation"], stop_epoch=waiting["stop_epoch"],
        approved=approved)


def test_resume_after_reopening_database(tmp_path):
    db, waiting = begin(tmp_path, steps(
        ("BUILDER", "PASS"), ("TESTER", "PASS"), ("REVIEWER", "PASS")))
    assert inspect_fixture(db, "fixture-thread-one")["waiting_for_approval"] is True
    # Each helper opens a new independent SQLite connection/checkpointer.
    done = resume(db, waiting)
    assert done["stage"] == "PR_READY_AWAITING_HUMAN"
    stored = inspect_fixture(db, "fixture-thread-one")
    assert stored["stage"] == "PR_READY_AWAITING_HUMAN"
    assert stored["waiting_for_approval"] is False
    assert stored["production_authorized"] is False
    assert stored["executable"] is False


def test_duplicate_start_and_replay_resume_denied(tmp_path):
    db, waiting = begin(tmp_path, steps(
        ("BUILDER", "PASS"), ("TESTER", "PASS"), ("REVIEWER", "PASS")))
    with pytest.raises(FixtureRecoveryError, match="ALREADY_EXISTS"):
        start_fixture(db, "fixture-thread-one", issue(), [])
    resume(db, waiting)
    with pytest.raises(FixtureRecoveryError, match="NO_PENDING"):
        resume(db, waiting)


def test_rejected_approval_is_persistent_and_terminal(tmp_path):
    db, waiting = begin(tmp_path)
    stopped = resume(db, waiting, approved=False)
    assert stopped["stage"] == "BLOCKED"
    assert inspect_fixture(db, "fixture-thread-one")["blocked_reason"] == "APPROVAL_NOT_GRANTED"
    with pytest.raises(FixtureRecoveryError, match="NO_PENDING"):
        resume(db, waiting)


def test_stale_checkpoint_identity_denied_without_consuming_interrupt(tmp_path):
    db, waiting = begin(tmp_path, steps(
        ("BUILDER", "PASS"), ("TESTER", "PASS"), ("REVIEWER", "PASS")))
    with pytest.raises(FixtureRecoveryError, match="STALE"):
        resume_fixture(db, "fixture-thread-one", plan_digest="0" * 64,
            generation=1, stop_epoch=0, approved=True)
    assert inspect_fixture(db, "fixture-thread-one")["waiting_for_approval"] is True
    assert resume(db, waiting)["stage"] == "PR_READY_AWAITING_HUMAN"


def test_invalid_and_unknown_threads_fail_closed(tmp_path):
    db = tmp_path / "fixtures.sqlite"
    with pytest.raises(FixtureRecoveryError, match="INVALID_FIXTURE_THREAD"):
        inspect_fixture(db, "production-worker")
    with pytest.raises(FixtureRecoveryError, match="UNKNOWN_FIXTURE_THREAD"):
        inspect_fixture(db, "fixture-unknown")


def test_missing_role_evidence_fails_closed_after_restart(tmp_path):
    db, waiting = begin(tmp_path)
    result = resume(db, waiting)
    assert result["stage"] == "BLOCKED"
    assert inspect_fixture(db, "fixture-thread-one")["blocked_reason"] == "EVIDENCE_UNAVAILABLE"
