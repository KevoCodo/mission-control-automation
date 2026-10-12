import { describe, expect, it } from 'vitest';
import { createCallLog, createFixtureClients, listTrustedEpicChildren, redactForLog } from '../clients.js';
import { defaultConfig } from '../config.js';
import { discover } from '../discovery.js';
import type { GithubClient } from '../clients.js';

describe('dry-run discovery', () => {
  it('uses read-only adapters and preserves fixture identities', async () => {
    const calls = createCallLog();
    const result = await discover(defaultConfig, createFixtureClients(defaultConfig, calls));

    expect(result.mode).toBe('dry-run');
    expect(result.issues[0]).toMatchObject({
      id: defaultConfig.identities.issues[0].id,
      number: defaultConfig.identities.issues[0].number
    });
    expect(result.sessions[0]).toMatchObject({
      id: defaultConfig.identities.sessions[0].id,
      branch: defaultConfig.identities.sessions[0].branch
    });
    expect(result.pullRequests[0]).toMatchObject({
      id: defaultConfig.identities.pullRequests[0].id,
      branch: defaultConfig.identities.pullRequests[0].branch
    });
    expect(result.dependencyGraph).toMatchObject({
      repository: 'KevoCodo/ai-delivery-lab',
      epicIssueNumber: 4,
      order: [4],
      unverified: []
    });
    expect(calls.githubReads).toEqual(['issue:4', 'pullRequest:4', 'epicChildren:4']);
    expect(calls.aoReads).toEqual(['session:fixture-session']);
    expect(calls.githubMutations).toEqual([]);
    expect(calls.aoMutations).toEqual([]);
  });

  it('wraps discovery failures clearly', async () => {
    await expect(
      discover(defaultConfig, {
        github: {
          async getIssue() {
            throw new Error('fixture failure');
          },
          async getPullRequest() {
            throw new Error('should not matter');
          }
        },
        ao: {
          async getSession() {
            throw new Error('should not matter');
          }
        }
      })
    ).rejects.toThrow(/Dry-run discovery failed: fixture failure/);
  });

  it('returns deterministic paginated Epic children and rejects duplicates during graph build', async () => {
    const client: GithubClient = {
      adapterName: 'fixture-github-client',
      async getIssue(identity) {
        return {
          id: identity.id,
          number: identity.number,
          title: identity.title ?? `Issue ${identity.number}`,
          state: 'open'
        };
      },
      async getPullRequest(identity) {
        return {
          id: identity.id,
          number: identity.number,
          branch: identity.branch,
          state: 'open'
        };
      },
      async *listEpicChildren() {
        yield {
          pageInfo: { page: 2, hasNextPage: false },
          issues: [{ id: 9, number: 9, title: 'Issue 9', state: 'open' }]
        };
        yield {
          pageInfo: { page: 1, hasNextPage: true },
          issues: [{ id: 5, number: 5, title: 'Issue 5', state: 'open' }]
        };
      }
    };

    await expect(
      discover(
        {
          ...defaultConfig,
          identities: {
            ...defaultConfig.identities,
            issues: [{ id: 3, number: 3, title: 'Epic' }]
          }
        },
        {
          github: client,
          ao: createFixtureClients(defaultConfig).ao
        }
      )
    ).resolves.toMatchObject({
      dependencyGraph: {
        order: [5, 9]
      }
    });
  });

  it('rejects untrusted adapters before Epic child discovery', async () => {
    await expect(
      listTrustedEpicChildren(
        {
          adapterName: 'unknown-client',
          async getIssue() {
            throw new Error('unused');
          },
          async getPullRequest() {
            throw new Error('unused');
          },
          async *listEpicChildren() {
            yield {
              pageInfo: { page: 1, hasNextPage: false },
              issues: []
            };
          }
        },
        {
          repository: defaultConfig.repository,
          epicIssue: defaultConfig.identities.issues[0]
        }
      )
    ).rejects.toThrow(/Untrusted GitHub adapter/i);
  });

  it('redacts GitHub API failures and rate-limit details before wrapping', async () => {
    const client: GithubClient = {
      adapterName: 'fixture-github-client',
      async getIssue() {
        throw new Error('unused');
      },
      async getPullRequest() {
        throw new Error('unused');
      },
      async *listEpicChildren() {
        throw new Error('rate limit exceeded token ghp_secret authorization: bearer-value');
      }
    };

    await expect(
      listTrustedEpicChildren(client, {
        repository: defaultConfig.repository,
        epicIssue: defaultConfig.identities.issues[0]
      })
    ).rejects.toThrow(/token=\[REDACTED\]/);
    await expect(
      listTrustedEpicChildren(client, {
        repository: defaultConfig.repository,
        epicIssue: defaultConfig.identities.issues[0]
      })
    ).rejects.not.toThrow(/ghp_secret|bearer-value/);
    expect(redactForLog('apiKey=abc123 password: hunter2')).toBe('apiKey=[REDACTED] password=[REDACTED]');
  });
});
