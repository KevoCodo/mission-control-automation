# Mission Control

Mission Control is a read-only controller skeleton for coordinating explicit
GitHub issue, AO session, and pull request identities. It defaults to dry-run
mode, uses fixture adapters unless trusted adapters are injected by a caller,
and must not mutate GitHub, AO, branches, issues, sessions, or deployments.

## Commands

```bash
npm run build:controller
npm run test:controller
node tools/mission-control/dist/cli.js --help
node tools/mission-control/dist/cli.js discover --config tools/mission-control/examples/dry-run.config.json
```

The CLI accepts `--config <path>` for a JSON file. Without a config file it uses
safe dry-run defaults.

## Configuration Guardrails

- `executionMode` defaults to `dry-run`; other modes are rejected.
- `repository.owner`, `repository.name`, and `project.id` are required.
- Issue, session, and pull request identities must be explicit in `identities`.
- `limits.maxBuilders` is capped at `2`.
- `limits.correctionAttempts` is capped at `2`.
- Worktree roots must be on the Windows `E:` drive.
- Feature branches must not be `main`, `master`, or the configured default
  branch.
- Deployment must stay disabled.
- Config files must not contain credential-bearing keys such as tokens,
  passwords, secrets, private keys, or authorization headers.

## Adapter Boundaries

External access is isolated behind `githubClient` and `aoClient` interfaces.
The included fixture clients only implement read methods. Trusted authenticated
adapters may be supplied by a caller in a controlled environment, but secrets
must come from that environment rather than config files. Agent review is useful
for finding defects; it is not a substitute for required GitHub approval or
human/policy authorization before merge.

## State And Audit

State is versioned JSON written atomically by same-directory temporary write and
rename. Unsupported versions and corrupt JSON are rejected clearly. Audit events
are append-only JSONL records with structured data redacted for common secret
shapes before persistence.

## Windows Restrictions

Controller worktrees are constrained to `E:` roots. The skeleton does not build
shell commands from issue text and does not spawn workers, schedule loops, create
issues, merge pull requests, or deploy software.
