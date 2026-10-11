import type { ControllerClients } from './clients.js';
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

    return {
      mode: 'dry-run',
      repository: `${config.repository.owner}/${config.repository.name}`,
      project: config.project.id,
      issues,
      sessions,
      pullRequests
    };
  } catch (error) {
    throw new DiscoveryError(`Dry-run discovery failed: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error
    });
  }
}
