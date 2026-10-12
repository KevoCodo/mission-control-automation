import { listTrustedEpicChildren } from './clients.js';
import type { ControllerClients } from './clients.js';
import { buildDependencyGraph } from './graph.js';
import type { ControllerConfig, DiscoveryResult } from './types.js';

export class DiscoveryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DiscoveryError';
  }
}

export async function discover(config: ControllerConfig, clients: ControllerClients): Promise<DiscoveryResult> {
  if (config.executionMode !== 'dry-run') {
    throw new DiscoveryError('Discovery only supports dry-run mode.');
  }

  try {
    const issues = await Promise.all(config.identities.issues.map((identity) => clients.github.getIssue(identity)));
    const sessions = await Promise.all(config.identities.sessions.map((identity) => clients.ao.getSession(identity)));
    const pullRequests = await Promise.all(
      config.identities.pullRequests.map((identity) => clients.github.getPullRequest(identity))
    );
    const epicIssue = config.identities.issues[0];
    const epicChildren = clients.github.listEpicChildren
      ? await listTrustedEpicChildren(clients.github, {
          repository: config.repository,
          epicIssue
        })
      : [];

    return {
      mode: 'dry-run',
      repository: `${config.repository.owner}/${config.repository.name}`,
      project: config.project.id,
      issues,
      sessions,
      pullRequests,
      dependencyGraph:
        epicChildren.length > 0
          ? buildDependencyGraph({
              repository: config.repository,
              epicIssueNumber: epicIssue.number,
              issues: epicChildren
            })
          : undefined
    };
  } catch (error) {
    throw new DiscoveryError(`Dry-run discovery failed: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error
    });
  }
}
