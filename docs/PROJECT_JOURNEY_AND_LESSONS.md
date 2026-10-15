# Project journey and lessons

Version 1 · checkpoint 2026-10-14 · base `02d1571`. Evidence: [Epic #3](https://github.com/KevoCodo/ai-delivery-lab/issues/3), merged PRs and linked CI, repository code, and the local authorization incident artifact at `E:/AI-Development/ao-data/data/artifacts/ai-delivery-lab-2/authorization-incident-roadmap-addendum.md`. This history does not claim autonomous production delivery.

1. [PR #2](https://github.com/KevoCodo/ai-delivery-lab/pull/2) established the React/Vite sample task dashboard and Windows CI.
2. [Issue #4 / PR #14](https://github.com/KevoCodo/ai-delivery-lab/pull/14) established a dry-run controller skeleton and explicit configuration/identity checks.
3. Windows ownership required a Koffi `CreateFileW` handle. The persistent file's age is not ownership; unsupported native environments fail closed.
4. [Issue #5 / PR #15](https://github.com/KevoCodo/ai-delivery-lab/pull/15) added GitHub dependency discovery and verified-completion graph gating.
5. [Issue #6 / PR #16](https://github.com/KevoCodo/ai-delivery-lab/pull/16) added schema-v2 state, audit, durable intent, and recovery; uncertain outcomes require reconciliation.
6. [Issue #7 / PR #17](https://github.com/KevoCodo/ai-delivery-lab/pull/17) added AO assignment checks for E: worktrees, repository identity, concurrency, and trusted callers.
7. A 2026-10-12 automated review turn queued before STOP ran afterward, published a correction, and triggered another review. Technical success did not supply authority.
8. The incident analysis found that an AO `human` origin label is not authenticated human provenance. Broker-enforced STOP, scoped grants, budget persistence, and revocation remain proposals.
9. The recorded gpt-5.5 attempt failed; gpt-6-sol recovered locally. A full C: cache disk also interrupted work. Model recovery and disk capacity are operational lessons, not verification evidence.
10. [Issue #8 / PR #18](https://github.com/KevoCodo/ai-delivery-lab/pull/18) tied PR/CI evidence to one assignment and exact head, blocking reuse of stale check results.
11. [Issue #9 / PR #19](https://github.com/KevoCodo/ai-delivery-lab/pull/19) captured native review verdict provenance and kept AO verdicts separate from GitHub approval.
12. [Issue #10 / PR #20](https://github.com/KevoCodo/ai-delivery-lab/pull/20) added a pure merge eligibility policy with live permission disabled. Issuer/verifier, revocation, single-use grants, AO queued STOP, live merge/close, production provider and E2E demonstration remain missing.

Each listed issue PR was merged with a linked successful [Windows CI](../.github/workflows/ci.yml) job at this checkpoint. New heads require their own evidence.

| Issue | Merged PR | Successful Windows CI job |
| --- | --- | --- |
| #4 | [#14](https://github.com/KevoCodo/ai-delivery-lab/pull/14) | [Run 38175874748](https://github.com/KevoCodo/ai-delivery-lab/actions/runs/38175874748/job/114578036499) |
| #5 | [#15](https://github.com/KevoCodo/ai-delivery-lab/pull/15) | [Run 38276516157](https://github.com/KevoCodo/ai-delivery-lab/actions/runs/38276516157/job/114903205987) |
| #6 | [#16](https://github.com/KevoCodo/ai-delivery-lab/pull/16) | [Run 38274237256](https://github.com/KevoCodo/ai-delivery-lab/actions/runs/38274237256/job/114895702170) |
| #7 | [#17](https://github.com/KevoCodo/ai-delivery-lab/pull/17) | [Run 38312332789](https://github.com/KevoCodo/ai-delivery-lab/actions/runs/38312332789/job/115020776763) |
| #8 | [#18](https://github.com/KevoCodo/ai-delivery-lab/pull/18) | [Run 38494278043](https://github.com/KevoCodo/ai-delivery-lab/actions/runs/38494278043/job/115626378272) |
| #9 | [#19](https://github.com/KevoCodo/ai-delivery-lab/pull/19) | [Run 38636717798](https://github.com/KevoCodo/ai-delivery-lab/actions/runs/38636717798/job/116101650495) |
| #10 | [#20](https://github.com/KevoCodo/ai-delivery-lab/pull/20) | [Run 38650924864](https://github.com/KevoCodo/ai-delivery-lab/actions/runs/38650924864/job/116149214592) |

## Potential Professional Talking Points

- Fail-closed policy design and separating evidence from authority.
- Native Windows lock ownership, atomic state, redacted audit, and crash recovery.
- Exact-head CI and reviewer provenance without treating checks as permission.
- Learning from the documented STOP failure and specifying broker controls.
- Staged delivery with explicit scope, budgets, and reproducible dependencies.
