import type {
  ControllerConfig,
  DiscoveryIssue,
  DiscoveryPullRequest,
  DiscoverySession,
  IssueIdentity,
  PullRequestIdentity,
  SessionIdentity
} from './types.js';

export interface GithubClient {
  getIssue(identity: IssueIdentity): Promise<DiscoveryIssue>;
  getPullRequest(identity: PullRequestIdentity): Promise<DiscoveryPullRequest>;
}

export interface AoClient {
  getSession(identity: SessionIdentity): Promise<DiscoverySession>;
}

export interface ControllerClients {
  github: GithubClient;
  ao: AoClient;
}

export interface ReadOnlyCallLog {
  githubReads: string[];
  githubMutations: string[];
  aoReads: string[];
  aoMutations: string[];
}

export function createFixtureClients(config: ControllerConfig, calls: ReadOnlyCallLog = createCallLog()): ControllerClients {
  return {
    github: {
      async getIssue(identity) {
        calls.githubReads.push(`issue:${identity.number}`);
        return {
          id: identity.id,
          number: identity.number,
          title: identity.title ?? `Issue ${identity.number}`,
          state: 'open'
        };
      },
      async getPullRequest(identity) {
        calls.githubReads.push(`pullRequest:${identity.number}`);
        return {
          id: identity.id,
          number: identity.number,
          branch: identity.branch,
          state: identity.number === 0 ? 'pending' : 'open'
        };
      }
    },
    ao: {
      async getSession(identity) {
        calls.aoReads.push(`session:${identity.id}`);
        return {
          id: identity.id,
          branch: identity.branch,
          status: config.executionMode
        };
      }
    }
  };
}

export function createCallLog(): ReadOnlyCallLog {
  return {
    githubReads: [],
    githubMutations: [],
    aoReads: [],
    aoMutations: []
  };
}
