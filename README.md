# AI Delivery Lab

## Mission Control M2 supervised SDLC demo

The first screen now follows fictional Epic `demo/sdlc-role-lab#201` and child #202 through Lead Orchestrator planning, Builder, Tester, PR Reviewer, Merger, and Lead closure review. It shows the stage, role, handoff instructions, reported work, findings, correction count, blockers, and next human action. The M1 single-issue planning screen remains below it.

Approve the Epic plan, then explicitly approve each role handoff. Copy the role instructions and manually launch Codex in a separately authorized, independently checked worktree. Import a structured completion report after each external role finishes. The browser validates the report shape, exact commit and stage; it stores the report locally as a **user-supplied claim**, never as provider proof. A Tester or Reviewer failure returns to Builder for a manual correction, up to two correction cycles. A changed Builder commit invalidates old checks and requires fresh tests and review. Browser reload clears pending handoff approval.

Merger preparation requires fresh local test and review reports and a PR URL in the completion report. The human checks the exact PR head and performs any merge through an approved external GitHub interface. The final Lead report keeps child and Epic completion **blocked / awaiting independent verification** because this browser has no authenticated GitHub provider evidence. A user-reported merge does not verify completion or close issues. Reset removes the local M2 record. No role starts, GitHub writes, AO calls, production execution, or deployment are implemented.

M3 remains an actual supervised demonstration using a separately authorized disposable worktree and approved GitHub interface, with saved redacted evidence and independent source review. This fictional browser sequence is not that demonstration.

## Mission Control M1 manual handoff

The React app opens on a single-operator Mission Control screen. Select one of two **fictional local demo issues** in `demo/manual-handoff-lab`, review its fixture-only details and dependencies, edit the template-derived plan, submit it, and explicitly approve it. Issue #102 has an unverified dependency, so approval is blocked. The existing task board remains available in a collapsed section.

Approval binds the exact plan text, issue, repository and version in the current browser session. Editing, changing issue, requesting changes or cancelling clears approval and any prepared handoff. Local storage keeps a draft, but restored approval is always removed and must be given again. Reset deletes the local draft. Browser storage is treated as untrusted and never supplies credentials or execution authority.

An approved plan can produce copy-ready manual Codex instructions. Because the demo has no independently verified GitHub issue, separate worktree or Git baseline, the handoff labels those facts **unknown** and requires the human to verify them before external execution. Copying only changes the local status to “awaiting manual execution”; it does not launch, observe or authorize a worker. Live GitHub issue integration, evidence import and PR preparation are deferred beyond M1. Production execution gates remain disabled.

**Current product direction (2026-10-18):** Prioritize a [manual supervised issue-to-PR MVP](docs/MVP_SCOPE_AND_ROADMAP.md), with a human-approved plan, manual external Codex handoff, user-imported test/review evidence, and a human-executed PR workflow. Automatic worker launching, production execution, live AO, and controller write/merge/close are not enabled. The older documentation checkpoint below is historical; the merged native build-preparation milestone is [PR #33](https://github.com/KevoCodo/ai-delivery-lab/pull/33) at `062bce956c0add05c4c7e3400714c45e3050985c`. Actual OS containment remains unverified.

Documentation checkpoint: version 1, 2026-10-14, base `02d15718057ebe08264923b56b528bad3efbdf30` after merged Issues #4–#10. This repository contains an experimental Mission Control controller and a React/Vite sample task dashboard. The controller is not a production autonomous delivery service. Read the [living SOP](docs/MISSION_CONTROL_LIVING_SOP.md), [project journey](docs/PROJECT_JOURNEY_AND_LESSONS.md), and [technical controller README](tools/mission-control/README.md).

A lightweight task management application foundation built with Vite, React,
TypeScript, and Vitest.

## Requirements

- Node.js `^20.19.0 || ^22.12.0 || >=24.0.0`
- npm 10 or newer

## Installation

```bash
npm ci
```

## Development

Start the local development server:

```bash
npm run dev
```

Vite prints the local URL after startup.

## Testing

Run the automated test suite:

```bash
npm test
```

## Production Build

Create a production build:

```bash
npm run build
```

Preview the built app locally:

```bash
npm run preview
```

## Project Structure

- `tools/mission-control/src` contains dependency discovery, AO assignment, PR/CI tracking, native review evidence, schema-v2 state, versioned audit events, deterministic audit reports, recovery, and a pure merge eligibility policy. The CLI defaults to dry run with fixtures. Planning and operation intent do not grant authority; live merge/close and deployment are disabled.
- `docs/` contains the living operating notes and project history.
- `src/components` contains reusable dashboard UI components.
- `src/data` contains static sample task data for the starter interface.
- `src/test` contains shared Vitest setup.
- `.github/workflows/ci.yml` runs installation, tests, and production build checks.

## Controller verification and roadmap

```bash
npm run test:controller
npm run build:controller
node tools/mission-control/dist/cli.js --help
```

The root [lockfile](package-lock.json) covers both app and controller. Windows x64/arm64 is required for controller ownership tests and state changes. Assignment requires a physical `E:` worktree without reparse ancestors. Use the [Windows CI workflow](.github/workflows/ci.yml) and exact-head check links; the merged Issue #10 baseline is [PR #20](https://github.com/KevoCodo/ai-delivery-lab/pull/20) with [successful CI](https://github.com/KevoCodo/ai-delivery-lab/actions/runs/38650924864/job/116149214592). AO native verdicts remain distinct from GitHub approval. Controller-local STOP does not enforce AO queued turns. There is no trusted grant issuer/verifier, revocation or single-use grant store, production provider validation, or full E2E demonstration. [Issue #11](https://github.com/KevoCodo/ai-delivery-lab/issues/11) assesses dependencies; [#12](https://github.com/KevoCodo/ai-delivery-lab/issues/12) and [#13](https://github.com/KevoCodo/ai-delivery-lab/issues/13) remain roadmap work.
