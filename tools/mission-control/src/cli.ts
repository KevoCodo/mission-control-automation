#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { appendAuditEvent } from './audit.js';
import { createFixtureClients } from './clients.js';
import { createAoCliClient } from './aoCliClient.js';
import { ConfigError, loadConfig } from './config.js';
import { DiscoveryError, discover } from './discovery.js';
import { getDefaultControllerLockPath, withControllerOwnership } from './locks.js';
import { planAssignments } from './planner.js';
import { PullRequestTrackingError, trackPullRequestChecks } from './prTracking.js';
import { collectNativeReviewEvidence, NativeReviewEvidenceError } from './reviewEvidence.js';
import { appendDiscovery } from './state.js';
import { generateAuditReport, renderAuditReport } from './report.js';

const HELP = `Mission Control

Usage:
  mission-control --help
  mission-control discover [--config <path>] [--state <path>] [--audit <path>]
  mission-control plan-assignments [--config <path>] [--state <path>]
  mission-control track-pr [--config <path>] [--state <path>] [--audit <path>] [--issue <number>] [--session <id>] [--branch <name>] [--head <sha>]
  mission-control review-evidence [--config <path>] [--state <path>] [--audit <path>] [--issue <number>] [--session <id>] [--branch <name>] [--head <sha>] [--authorize-review] [--authorize-correction]
  mission-control report [--audit <path>] [--state <path>] [--format json|markdown]

Commands:
  discover  Run read-only dry-run discovery using fixture adapters by default.
  plan-assignments  Print eligible, blocked, and capacity using state plus AO session status.
  track-pr  Print and persist read-only PR/CI status for an intended issue/session/branch.
  review-evidence  Print and persist read-only AO native review evidence for an exact PR head.
  report  Print a deterministic, read-only audit report.

Options:
  --config <path>  JSON config path. Defaults to safe dry-run config.
  --state <path>   State JSON path. Defaults to .mission-control/state.json.
  --audit <path>   Audit JSONL path. Defaults to .mission-control/audit.jsonl.
  --format <name> JSON or Markdown report format. Defaults to JSON.
  --issue <number> Issue number for track-pr. Defaults to first configured issue.
  --session <id>   AO session id for track-pr. Defaults to first configured session.
  --branch <name>  Feature branch for track-pr. Defaults to selected session branch.
  --head <sha>     Expected PR head SHA for exact-head validation.
  --authorize-review  Record that a human explicitly authorized a future live native review trigger.
  --authorize-correction  Record that a human authorized the next planner-only correction cycle.
  --help           Show this help.
`;

interface CliArgs {
  command?: string;
  configPath?: string;
  statePath: string;
  auditPath: string;
  format: 'json' | 'markdown';
  issueNumber?: number;
  sessionId?: string;
  branch?: string;
  expectedHeadSha?: string;
  authorizeReview: boolean;
  authorizeCorrection: boolean;
  help: boolean;
}

export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`MissionControlError: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  try {
    if (args.help || !args.command) {
      process.stdout.write(HELP);
      return 0;
    }
    if (args.command !== 'discover' && args.command !== 'plan-assignments' && args.command !== 'track-pr' && args.command !== 'review-evidence' && args.command !== 'report') {
      process.stderr.write(`Unsupported command: ${args.command}\n`);
      return 1;
    }

    if (args.command === 'report') {
      process.stdout.write(renderAuditReport(await generateAuditReport(args.auditPath, args.statePath), args.format));
      return 0;
    }
    const config = await loadConfig(args.configPath);
    return await withControllerOwnership({ owner: 'mission-control-cli', lockPath: getDefaultControllerLockPath() }, async () => {
      if (args.command === 'plan-assignments') {
        const result = await planAssignments(args.statePath, config, {
          github: createFixtureClients(config).github,
          ao: createAoCliClient()
        });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return 0;
      }
      if (args.command === 'track-pr') {
        const issue = args.issueNumber ?? config.identities.issues[0]?.number;
        const session = args.sessionId
          ? config.identities.sessions.find((identity) => identity.id === args.sessionId)
          : config.identities.sessions[0];
        if (issue === undefined || !session) {
          process.stderr.write('MissionControlError: track-pr requires configured issue and session identities.\n');
          return 1;
        }
        const result = await trackPullRequestChecks(
          args.statePath,
          config,
          createFixtureClients(config),
          {
            issueNumber: issue,
            sessionId: session.id,
            branch: args.branch ?? session.branch,
            expectedHeadSha: args.expectedHeadSha
          }
        );
        await appendAuditEvent(args.auditPath, {
          type: 'prTracking.completed',
          timestamp: new Date().toISOString(),
          issueNumber: result.observation.issueNumber,
          sessionId: result.observation.sessionId,
          pullRequestNumber: result.observation.pullRequestNumber,
          headSha: result.observation.headSha,
          category: 'observation',
          outcome: result.observation.status === 'successful' ? 'succeeded' : 'unknown',
          data: result.observation,
          provenance: { source: result.observation.dataSource === 'github' ? 'github' : 'fixture', observedAt: result.observation.observedAt }
        });
        process.stdout.write(`${JSON.stringify(result.observation, null, 2)}\n`);
        return 0;
      }
      if (args.command === 'review-evidence') {
        const issue = args.issueNumber ?? config.identities.issues[0]?.number;
        const session = args.sessionId
          ? config.identities.sessions.find((identity) => identity.id === args.sessionId)
          : config.identities.sessions[0];
        if (issue === undefined || !session) {
          process.stderr.write('MissionControlError: review-evidence requires configured issue and session identities.\n');
          return 1;
        }
        const result = await collectNativeReviewEvidence(
          args.statePath,
          config,
          createFixtureClients(config),
          {
            issueNumber: issue,
            sessionId: session.id,
            branch: args.branch ?? session.branch,
            expectedHeadSha: args.expectedHeadSha,
            triggerAuthorized: args.authorizeReview,
            correctionAuthorized: args.authorizeCorrection
          }
        );
        await appendAuditEvent(args.auditPath, {
          type: 'nativeReview.completed',
          timestamp: new Date().toISOString(),
          issueNumber: result.observation.issueNumber,
          sessionId: result.observation.sessionId,
          pullRequestNumber: result.observation.pullRequestNumber,
          headSha: result.observation.headSha,
          category: 'observation',
          authorization: args.authorizeCorrection || args.authorizeReview ? 'caller-claimed' : 'unknown',
          outcome: result.observation.runStatus === 'completed' ? 'succeeded' : 'unknown',
          data: result.observation,
          provenance: { source: 'fixture', observedAt: result.observation.observedAt }
        });
        process.stdout.write(`${JSON.stringify(result.observation, null, 2)}\n`);
        return 0;
      }

      const result = await discover(config, createFixtureClients(config));
      await appendDiscovery(args.statePath, config, result);
      await appendAuditEvent(args.auditPath, {
        type: 'discovery.completed',
        timestamp: new Date().toISOString(),
        category: 'observation',
        outcome: 'succeeded',
        data: result,
        provenance: { source: 'fixture' }
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    });
  } catch (error) {
    const prefix =
      error instanceof ConfigError ||
      error instanceof DiscoveryError ||
      error instanceof PullRequestTrackingError ||
      error instanceof NativeReviewEvidenceError
        ? error.name
        : 'MissionControlError';
    process.stderr.write(`${prefix}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    statePath: path.join('.mission-control', 'state.json'),
    auditPath: path.join('.mission-control', 'audit.jsonl'),
    format: 'json',
    authorizeReview: false,
    authorizeCorrection: false,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--config') {
      args.configPath = readOptionValue(argv, ++index, '--config');
    } else if (arg === '--state') {
      args.statePath = readOptionValue(argv, ++index, '--state');
    } else if (arg === '--audit') {
      args.auditPath = readOptionValue(argv, ++index, '--audit');
    } else if (arg === '--format') {
      const format = readOptionValue(argv, ++index, '--format');
      if (format !== 'json' && format !== 'markdown') throw new Error('--format must be json or markdown.');
      args.format = format;
    } else if (arg === '--issue') {
      args.issueNumber = readPositiveInteger(readOptionValue(argv, ++index, '--issue'), '--issue');
    } else if (arg === '--session') {
      args.sessionId = readOptionValue(argv, ++index, '--session');
    } else if (arg === '--branch') {
      args.branch = readOptionValue(argv, ++index, '--branch');
    } else if (arg === '--head') {
      args.expectedHeadSha = readOptionValue(argv, ++index, '--head');
    } else if (arg === '--authorize-review') {
      args.authorizeReview = true;
    } else if (arg === '--authorize-correction') {
      args.authorizeCorrection = true;
    } else if (!args.command) {
      args.command = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return args;
}

function readPositiveInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${option} requires a positive integer.`);
  }
  return parsed;
}

function readOptionValue(argv: string[], index: number, option: string): string {
  const value = argv[index];
  if (!value) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().then((code) => {
    process.exitCode = code;
  });
}
