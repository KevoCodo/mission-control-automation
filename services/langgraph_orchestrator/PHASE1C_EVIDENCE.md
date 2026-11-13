# Phase 1C Issue #4: Exact Fixture Evidence Validation

## Intent
All LangGraph role results remain **synthetic fixtures**, never authenticated execution evidence or permission. The existing TypeScript controller retains the sole security/authorization role. This change adds deterministic fixture-only checks for exact issue, repository, plan, generation, STOP epoch, and commit identity.

## Fixture schema
Every role result has exactly these fields:
- `role`: expected BUILDER, TESTER, or REVIEWER
- `outcome`: PASS, FAIL, or UNKNOWN (UNKNOWN is blocked)
- `resultId`: unique ID within workflow history
- `repository`: exact owner/name pair
- `issueId`, `issueNumber`: exact issue identity
- `planDigest`: current deterministic plan fingerprint
- `generation`: current correction generation (type-strict integer)
- `stopEpoch`: current fixture epoch (type-strict integer)
- `commit`: lowercase 40-hex **synthetic** Git-style identifier

A Builder result must use a different commit identifier after a correction. Tester and Reviewer must reference the current Builder identifier. Any missing, extra, malformed, out-of-order, stale, or duplicate result blocks the fixture workflow. A failed Tester/Reviewer increments the correction generation, with a maximum of two corrections.

## Verification
The Python tests in `tests/test_graph.py` exercise identity mismatches, stale generations, mismatched commits, unchanged Builder corrections, duplicates, extra fields, and successful corrected-commit progression. Existing SQLite recovery tests use the same fixture helper.

Run from `services/langgraph_orchestrator`:
```sh
python -m pip install -e '.[test]'
python -m pytest -q
```

## Security limitations
- Fixture result fields and commit strings are caller-provided and untrusted. A digest is **not** a signature or authenticated provider receipt.
- This is not provenance of a real Git commit, worker, process, human approval, or isolated runtime.
- The STOP epoch is checked against stored fixture state but is not yet backed by independent persistent controller STOP fencing. That belongs to issue #5.
- No LangGraph output authorizes real execution, writes, PR creation, or merges.
- The versioned controller request/decision contract belongs to issue #6. Gate 2B containment remains unverified.

Issue: #4. Parent: #3.
