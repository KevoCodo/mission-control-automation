# Docker Desktop + WSL2: Low-friction Phase 2 host readiness

**Status: Read-only candidate evaluation. Gate A remains NO-GO.**
**Target:** user's existing Windows development workstation with Docker Desktop and WSL2, not a new cloud VM.

## First step: inspect the existing installation

From the repository root in PowerShell:

```powershell
powershell -NoProfile -File tools/mission-control/scripts/inspect-docker-wsl2.ps1
```

The script only reads Docker version, active context name, engine OS type, cgroup version, advertised security options, and WSL status. It does **not** call `docker run`, `docker build`, `docker pull`, `docker compose`, mount paths, create files, or modify system settings. Its output is for the local operator to review; no telemetry, upload or automatic host access is implemented. Do not paste credentials or personal configuration details into GitHub tickets; review output before sharing.

If the engine cannot be inspected or is Windows-container mode, stop and report UNVERIFIED. Merely reporting Linux, cgroup v2 or some security options does not prove sandbox enforcement.

## Proposed next milestone after review

The intended low-friction workflow is: trusted TypeScript controller checks a narrowly scoped request → disposable container launched using an immutable reviewed image with no elevated privilege, engine socket, personal host paths or credentials → bounded Builder fixture executes → independent testing/review → PR prepared with GitHub handled outside worker. Initial runtime proof must use a sealed non-AI fixture only.

Before even that sealed fixture runs, independent reviewers must approve the selected disposable root, daemon/WSL2/host privilege boundaries, precise image/source hashes, network deny, mount restrictions, CPU/memory/PID/time quotas, process observer coverage and cleanup. Validate the 12 negative scenarios from `docs/PHASE2_WORKER_ISOLATION_THREAT_MODEL.md` under separately approved experiment scope. STOP with uncertain effects remains NO-GO. The baseline Windows Gate 2B experiment is separate and remains NO-GO.

The user's Docker Desktop installation availability is **not** a claim of isolated execution safety. This preflight has no authorization grants, no actual runtime observations, and no permission to run Codex or any worker.
