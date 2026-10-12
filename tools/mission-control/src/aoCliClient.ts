import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  AoCapabilityReport,
  AoClient,
  AoSessionQuery,
  AoSpawnWorkerRequest,
  AoSpawnWorkerResult
} from './clients.js';
import type { SessionIdentity } from './types.js';

const execFileAsync = promisify(execFile);

export interface AoCliClientOptions {
  command?: string;
  cwd?: string;
  timeoutMs?: number;
}

export function createAoCliClient(options: AoCliClientOptions = {}): AoClient {
  const command = options.command ?? 'ao';
  const timeout = options.timeoutMs ?? 10000;

  async function run(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync(command, args, {
      cwd: options.cwd,
      timeout,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    });
    return stdout;
  }

  return {
    adapterName: 'ao-cli-client',
    async getCapabilities(): Promise<AoCapabilityReport> {
      const [version, spawnHelp, sessionHelp, reportHelp] = await Promise.all([
        run(['version']).catch((error) => capabilityError('version', error)),
        run(['spawn', '--help']).catch((error) => capabilityError('spawn', error)),
        run(['session', 'ls', '--help']).catch((error) => capabilityError('session ls', error)),
        run(['report', '--help']).catch((error) => capabilityError('report', error))
      ]);

      return {
        adapterName: 'ao-cli-client',
        version: version.trim(),
        commands: {
          spawn: !spawnHelp.startsWith('missing:'),
          session: !sessionHelp.startsWith('missing:'),
          report: !reportHelp.startsWith('missing:')
        }
      };
    },
    async getSession(identity) {
      const sessions = await listAoSessions(run, { branch: identity.branch });
      const match = sessions.find((session) => session.id === identity.id || session.branch === identity.branch);
      return {
        id: identity.id,
        branch: identity.branch,
        status: match ? 'active' : 'missing'
      };
    },
    async listSessions(query) {
      return listAoSessions(run, query);
    },
    async spawnWorker(request: AoSpawnWorkerRequest): Promise<AoSpawnWorkerResult> {
      if (request.dryRun) {
        return {
          sessionId: `dry-run-issue-${request.issueNumber}`,
          branch: request.branch,
          worktreePath: request.worktreePath
        };
      }
      throw new Error('Live AO spawn is disabled in this controller phase; use assignment intents and trusted external launch.');
    },
    async report(message) {
      await run(['report', '--checkpoint', '--note', message]);
    }
  };
}

async function listAoSessions(
  run: (args: string[]) => Promise<string>,
  query: AoSessionQuery = {}
): Promise<SessionIdentity[]> {
  const raw = await run(['session', 'ls', '--json']);
  const parsed = JSON.parse(raw) as unknown;
  const records = Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed.sessions) ? parsed.sessions : [];

  return records
    .map((record): SessionIdentity | undefined => {
      if (!isRecord(record)) {
        return undefined;
      }
      const id = readString(record.id ?? record.sessionId);
      const branch = readString(record.branch);
      const worktreePath = readString(record.worktreePath ?? record.worktree ?? record.cwd);
      const issueNumber = readIssueNumber(record.issueNumber ?? record.issue);
      if (!id || !branch || !worktreePath) {
        return undefined;
      }
      return { id, branch, worktreePath, issueNumber };
    })
    .filter((session): session is SessionIdentity => {
      if (!session) {
        return false;
      }
      return (
        (query.issueNumber === undefined || session.issueNumber === query.issueNumber) &&
        (query.branch === undefined || session.branch === query.branch)
      );
    });
}

function capabilityError(command: string, error: unknown): string {
  return `missing:${command}:${error instanceof Error ? error.message : String(error)}`;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function readIssueNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const match = value.match(/\d+/);
    return match ? Number(match[0]) : undefined;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
