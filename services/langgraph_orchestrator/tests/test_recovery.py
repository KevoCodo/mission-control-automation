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


def test_stop_survives_reopened_checkpoint_and_rejects_old_approval(tmp_path):
    from recovery import stop_fixture
    db, waiting = begin(tmp_path, steps(
        ("BUILDER", "PASS"), ("TESTER", "PASS"), ("REVIEWER", "PASS")))
    initial = inspect_fixture(db, "fixture-thread-one")
    stopped = stop_fixture(db, "fixture-thread-one")
    assert stopped["stage"] == "STOPPED"
    assert stopped["stop_epoch"] == initial["stop_epoch"] + 1
    assert stopped["waiting_for_approval"] is False
    assert stopped["blocked_reason"] == "STOP_ACTIVE"
    assert stopped["production_authorized"] is False
    assert stopped["executable"] is False
    # Every call below opens a different saver and SQLite connection.
    assert inspect_fixture(db, "fixture-thread-one") == stopped
    with pytest.raises(FixtureRecoveryError, match="FIXTURE_STOPPED"):
        resume(db, waiting)
    with pytest.raises(FixtureRecoveryError, match="FIXTURE_STOPPED"):
        resume_fixture(db, "fixture-thread-one", plan_digest=waiting["plan_digest"],
            generation=waiting["generation"], stop_epoch=stopped["stop_epoch"], approved=True)


def test_stop_is_idempotent_and_new_start_does_not_reset_fence(tmp_path):
    from recovery import stop_fixture
    db, waiting = begin(tmp_path)
    first = stop_fixture(db, "fixture-thread-one")
    second = stop_fixture(db, "fixture-thread-one")
    assert first == second
    assert second["stop_epoch"] == waiting["stop_epoch"] + 1
    with pytest.raises(FixtureRecoveryError, match="ALREADY_EXISTS"):
        start_fixture(db, "fixture-thread-one", issue(), [])
    assert inspect_fixture(db, "fixture-thread-one")["stage"] == "STOPPED"


def test_corrupt_or_missing_fence_fails_closed(tmp_path):
    import sqlite3
    db, waiting = begin(tmp_path)
    with sqlite3.connect(db) as conn:
        conn.execute("DELETE FROM fixture_stop_fence WHERE thread_id=?", ("fixture-thread-one",))
    with pytest.raises(FixtureRecoveryError, match="MISSING_FIXTURE_STOP_FENCE"):
        resume(db, waiting)
    with pytest.raises(FixtureRecoveryError, match="MISSING_FIXTURE_STOP_FENCE"):
        inspect_fixture(db, "fixture-thread-one")


def test_mismatched_active_epoch_fails_closed(tmp_path):
    import sqlite3
    db, waiting = begin(tmp_path)
    with sqlite3.connect(db) as conn:
        conn.execute("UPDATE fixture_stop_fence SET epoch=epoch+1 WHERE thread_id=?",
            ("fixture-thread-one",))
    with pytest.raises(FixtureRecoveryError, match="STALE_FIXTURE_STOP_FENCE"):
        resume(db, waiting)
    with pytest.raises(FixtureRecoveryError, match="STALE_FIXTURE_STOP_FENCE"):
        inspect_fixture(db, "fixture-thread-one")


def test_terminal_completed_fixture_can_be_stopped_without_resuming(tmp_path):
    from recovery import stop_fixture
    db, waiting = begin(tmp_path, steps(
        ("BUILDER", "PASS"), ("TESTER", "PASS"), ("REVIEWER", "PASS")))
    assert resume(db, waiting)["stage"] == "PR_READY_AWAITING_HUMAN"
    stopped = stop_fixture(db, "fixture-thread-one")
    assert stopped["stage"] == "STOPPED"
    assert stopped["waiting_for_approval"] is False
    with pytest.raises(FixtureRecoveryError, match="FIXTURE_STOPPED"):
        resume(db, waiting)


def test_stopped_fence_with_invalid_epoch_does_not_downgrade_to_active(tmp_path):
    import sqlite3
    from recovery import stop_fixture
    db, waiting = begin(tmp_path)
    stop_fixture(db, "fixture-thread-one")
    with sqlite3.connect(db) as conn:
        conn.execute("UPDATE fixture_stop_fence SET epoch=? WHERE thread_id=?",
            (waiting["stop_epoch"], "fixture-thread-one"))
    with pytest.raises(FixtureRecoveryError, match="INVALID_FIXTURE_STOP_FENCE"):
        inspect_fixture(db, "fixture-thread-one")
    with pytest.raises(FixtureRecoveryError, match="INVALID_FIXTURE_STOP_FENCE"):
        resume(db, waiting)


def test_stop_invalid_and_unknown_threads_fail_closed(tmp_path):
    from recovery import stop_fixture
    db = tmp_path / "fixtures.sqlite"
    with pytest.raises(FixtureRecoveryError, match="INVALID_FIXTURE_THREAD"):
        stop_fixture(db, "worker")
    with pytest.raises(FixtureRecoveryError, match="UNKNOWN_FIXTURE_THREAD"):
        stop_fixture(db, "fixture-unknown")
