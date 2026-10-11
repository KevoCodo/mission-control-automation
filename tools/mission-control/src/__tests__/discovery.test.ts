import { describe, expect, it } from 'vitest';
import { createCallLog, createFixtureClients } from '../clients.js';
import { defaultConfig } from '../config.js';
import { discover } from '../discovery.js';

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
    expect(calls.githubReads).toEqual(['issue:4', 'pullRequest:4']);
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
});
