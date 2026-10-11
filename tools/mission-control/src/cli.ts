#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { appendAuditEvent } from './audit.js';
import { createFixtureClients } from './clients.js';
import { ConfigError, loadConfig } from './config.js';
import { DiscoveryError, discover } from './discovery.js';
import { appendDiscovery } from './state.js';

const HELP = `Mission Control

Usage:
  mission-control --help
  mission-control discover [--config <path>] [--state <path>] [--audit <path>]

Commands:
  discover  Run read-only dry-run discovery using fixture adapters by default.

Options:
  --config <path>  JSON config path. Defaults to safe dry-run config.
  --state <path>   State JSON path. Defaults to .mission-control/state.json.
  --audit <path>   Audit JSONL path. Defaults to .mission-control/audit.jsonl.
  --help           Show this help.
`;

interface CliArgs {
  command?: string;
  configPath?: string;
  statePath: string;
  auditPath: string;
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
    if (args.command !== 'discover') {
      process.stderr.write(`Unsupported command: ${args.command}\n`);
      return 1;
    }

    const config = await loadConfig(args.configPath);
    const result = await discover(config, createFixtureClients(config));
    await appendDiscovery(args.statePath, config, result);
    await appendAuditEvent(args.auditPath, {
      type: 'discovery.completed',
      timestamp: new Date().toISOString(),
      data: result
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    const prefix = error instanceof ConfigError || error instanceof DiscoveryError ? error.name : 'MissionControlError';
    process.stderr.write(`${prefix}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    statePath: path.join('.mission-control', 'state.json'),
    auditPath: path.join('.mission-control', 'audit.jsonl'),
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
    } else if (!args.command) {
      args.command = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return args;
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
