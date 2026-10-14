import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  AoCapabilityReport,
  AoClient,
  AoNativeReviewRun,
  AoSessionQuery,
  AoSpawnWorkerRequest,
  AoSpawnWorkerResult
} from './clients.js';
import type { NativeReviewRunStatus, NativeReviewVerdict, RepositoryIdentity, SessionIdentity } from './types.js';

const execFileAsync = promisify(execFile);

export interface AoCliClientOptions {
  command?: string;
  cwd?: string;
  timeoutMs?: number;
  runCommand?: (args: string[]) => Promise<string>;
}

export function createAoCliClient(options: AoCliClientOptions = {}): AoClient {
  const command = options.command ?? 'ao';
  const timeout = options.timeoutMs ?? 10000;

  async function run(args: string[]): Promise<string> {
    if (options.runCommand) {
      return options.runCommand(args);
    }
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
      const [version, spawnHelp, sessionHelp, reportHelp, reviewHelp] = await Promise.all([
        run(['version']).catch((error) => capabilityError('version', error)),
        run(['spawn', '--help']).catch((error) => capabilityError('spawn', error)),
        run(['session', 'ls', '--help']).catch((error) => capabilityError('session ls', error)),
        run(['report', '--help']).catch((error) => capabilityError('report', error)),
        run(['review', '--help']).catch((error) => capabilityError('review', error))
      ]);

      return {
        adapterName: 'ao-cli-client',
        version: version.trim(),
        commands: {
          spawn: !spawnHelp.startsWith('missing:'),
          session: !sessionHelp.startsWith('missing:'),
          report: !reportHelp.startsWith('missing:'),
          review: !reviewHelp.startsWith('missing:')
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
    },
    async getNativeReviewCapability() {
      const capabilities = await this.getCapabilities?.();
      return {
        supported: capabilities?.commands.review === true,
        statusSupported: capabilities?.commands.review === true,
        triggerSupported: capabilities?.commands.review === true,
        triggerRequiresHumanAuthorization: true,
        reviewerIndependenceRequired: true
      };
    },
    async getNativeReviewRun(request) {
      const raw = await run(['review', 'ls', '--json']);
      return parseAoReviewList(raw, request.pullRequestNumber, request.headSha, request.repository);
    }
  };
}

export function parseAoReviewList(raw: string, pullRequestNumber: number, headSha: string, repository?: RepositoryIdentity): AoNativeReviewRun {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return unavailable('AO_REVIEW_LIST_MALFORMED_JSON', pullRequestNumber, headSha);
  }

  const reviews = readReviews(parsed);
  if (!reviews) {
    return unavailable('AO_REVIEW_LIST_UNSUPPORTED_SHAPE', pullRequestNumber, headSha);
  }

  const matches = reviews.filter((review): review is Record<string, unknown> => {
    if (!isRecord(review)) {
      return false;
    }
    return readNumber(review.prNumber) === pullRequestNumber || readPrNumber(readString(review.prUrl)) === pullRequestNumber;
  });
  if (matches.length !== 1) {
    return unavailable(matches.length === 0 ? 'AO_REVIEW_LIST_PR_MISSING' : 'AO_REVIEW_LIST_PR_DUPLICATE', pullRequestNumber, headSha);
  }

  const review = matches[0];
  if (repository && !matchesRepository(readString(review.prUrl), repository, pullRequestNumber)) {
    return unavailable('AO_REVIEW_LIST_REPOSITORY_MISMATCH', pullRequestNumber, headSha);
  }
  const targetSha = readString(review.targetSha);
  if (!targetSha || targetSha !== headSha) {
    return {
      pullRequestNumber,
      headSha: targetSha ?? headSha,
      status: 'unavailable',
      diagnosticCode: 'AO_REVIEW_LIST_SHA_MISMATCH',
      source: 'ao-review-list'
    };
  }

  const latestRun = isRecord(review.latestRun) ? review.latestRun : undefined;
  if (!latestRun) {
    return {
      pullRequestNumber,
      headSha,
      status: mapReviewStatus(readString(review.status)),
      diagnosticCode: 'AO_REVIEW_RUN_MISSING',
      source: 'ao-review-list'
    };
  }

  const runPr = readPrNumber(readString(latestRun.prUrl)) ?? readNumber(latestRun.prNumber);
  const runSha = readString(latestRun.targetSha);
  if (repository && !matchesRepository(readString(latestRun.prUrl), repository, pullRequestNumber)) {
    return unavailable('AO_REVIEW_RUN_REPOSITORY_MISMATCH', pullRequestNumber, headSha);
  }
  if (runPr !== pullRequestNumber || runSha !== headSha) {
    return {
      runId: readString(latestRun.id),
      pullRequestNumber,
      headSha: runSha ?? headSha,
      status: 'unavailable',
      diagnosticCode: runPr !== pullRequestNumber ? 'AO_REVIEW_RUN_PR_MISMATCH' : 'AO_REVIEW_RUN_SHA_MISMATCH',
      source: 'ao-review-list'
    };
  }

  const status = mapReviewStatus(readString(latestRun.status));
  const verdict = readVerdict(latestRun.verdict);
  return {
    runId: readString(latestRun.id),
    pullRequestNumber,
    headSha,
    status,
    verdict,
    reviewer: {
      id: readString(latestRun.sessionId) ?? readString(latestRun.harness) ?? 'ao-reviewer',
      displayName: readString(latestRun.harness),
      type: 'unknown',
      independent: false,
      provenance: 'unsupported'
    },
    diagnosticCode: status === 'completed' && verdict === 'unknown'
      ? 'AO_REVIEW_VERDICT_UNAVAILABLE'
      : 'AO_REVIEW_REVIEWER_INDEPENDENCE_UNVERIFIED',
    source: 'ao-review-list'
  };
}

function readVerdict(value: unknown): NativeReviewVerdict {
  if (value === 'approved') return 'approved';
  if (value === 'changes_requested' || value === 'changes-requested' || value === 'rejected') return 'changes-requested';
  return 'unknown';
}

function matchesRepository(value: string | undefined, repository: RepositoryIdentity, number: number): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    const parts = url.pathname.split('/').filter(Boolean);
    return url.protocol === 'https:' && url.hostname === 'github.com' &&
      parts.length === 4 && parts[0].toLowerCase() === repository.owner.toLowerCase() &&
      parts[1].toLowerCase() === repository.name.toLowerCase() && parts[2] === 'pull' &&
      Number(parts[3]) === number;
  } catch {
    return false;
  }
}

function readReviews(parsed: unknown): unknown[] | undefined {
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (isRecord(parsed) && Array.isArray(parsed.reviews)) {
    return parsed.reviews;
  }
  return undefined;
}

function unavailable(diagnosticCode: string, pullRequestNumber: number, headSha: string): AoNativeReviewRun {
  return {
    pullRequestNumber,
    headSha,
    status: 'unavailable',
    diagnosticCode,
    source: 'ao-review-list'
  };
}

function mapReviewStatus(value: string | undefined): NativeReviewRunStatus {
  if (value === 'completed' || value === 'complete') {
    return 'completed';
  }
  if (value === 'running' || value === 'in_progress' || value === 'pending') {
    return 'running';
  }
  if (value === 'failed' || value === 'cancelled') {
    return 'failed';
  }
  if (value === 'needs_review' || value === 'not_started' || value === undefined) {
    return 'not-started';
  }
  return 'unavailable';
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

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function readPrNumber(value: string | undefined): number | undefined {
  const match = value?.match(/\/pull\/(\d+)(?:$|[/?#])/);
  return match ? Number(match[1]) : undefined;
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
