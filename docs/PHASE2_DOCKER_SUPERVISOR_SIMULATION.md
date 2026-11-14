# Phase 2: Inert Docker Worker Supervisor model

**Status: NO-GO. No Docker or worker execution is enabled.**

This milestone adds a **pure TypeScript simulation** of the future host supervisor, not a runner. It has no Docker CLI, engine socket, subprocess, file, clock, timer, network, service or credential integration. It cannot create, start, inspect, kill, or delete a container.

The model enforces these **synthetic decision rules**:
- All real launch claims are denied by default: there is no independent Gate A authorization.
- A separately constructed **synthetic already-active fixture** supports testing deadline behavior at exactly 300,000 milliseconds.
- STOP latches; attempted fixture restarts are denied.
- On fixture exit or deadline, the model **requests** cleanup. It cannot perform it.
- Missing container, descendant, or mount absence claims quarantine the simulation.
- Even complete cleanup **claims** remain unverified and never provide permission to execute.
- Non-monotonic/invalid timestamps quarantine the model. A trusted monotonic host clock and durable restart fencing have NOT been implemented.

## Unit tests

From Git Bash after the PR is merged:

```bash
git pull origin main
npx vitest run tools/mission-control/src/__tests__/dockerSupervisorSimulation.test.ts --environment node
```

This checks TypeScript logic only. It does not start Docker or affect existing ContextFlow containers.

## Next implementation stages, each separately gated

1. **Independent Gate A design review:** verify the Windows/WSL2 host, reviewed non-AI image digest, explicit disposable test root, effective restrictions, protected observers and cleanup plan. Existing Gate A is NO-GO.
2. **Issue #8 scoped experiment:** only after reviewer approval, implement a native disposable **sealed-fixture** adapter with atomic host enforcement, host-monotonic watchdog, full process-tree observations, cleanup quarantine, disk/output quotas and repeatable negative test evidence.
3. **Issue #9 trusted controller:** atomic one-use authenticated grants, durable STOP/epoch barriers and crash/restart recovery before accepting real agent workloads. The synthetic simulation is not an enforcement authority.

Operator inspection showed an Alpine `worker-test` record and subsequent successful `docker rm -f worker-test`; this demonstrates Docker object removal, not complete process-tree containment. The other three stopped ContextFlow containers must not be touched.

**No user command or API in this milestone runs containers.**
