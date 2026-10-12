import { describe, expect, it } from 'vitest';
import { buildDependencyGraph } from '../graph.js';
import type { DiscoveryIssue, RepositoryIdentity } from '../types.js';

const repository: RepositoryIdentity = {
  owner: 'KevoCodo',
  name: 'ai-delivery-lab',
  defaultBranch: 'main'
};

describe('dependency graph', () => {
  it('orders DAG dependencies by actual issue number, not sequence assumptions', () => {
    const graph = buildDependencyGraph({
      repository,
      epicIssueNumber: 3,
      issues: [
        issue(9, { body: 'Depends on #2' }),
        issue(2, { state: 'closed', completionVerified: true }),
        issue(7, { body: 'Depends on KevoCodo/ai-delivery-lab#9' })
      ]
    });

    expect(graph.order).toEqual([2, 9, 7]);
    expect(graph.nodes.find((node) => node.number === 9)).toMatchObject({
      eligible: true,
      blocked: false
    });
    expect(graph.nodes.find((node) => node.number === 7)).toMatchObject({
      eligible: false,
      blocked: true
    });
  });

  it('rejects cycles', () => {
    expect(() =>
      buildDependencyGraph({
        repository,
        epicIssueNumber: 3,
        issues: [issue(5, { body: 'Depends on #6' }), issue(6, { body: 'Depends on #5' })]
      })
    ).toThrow(/cycle/i);
  });

  it('rejects missing dependencies', () => {
    expect(() =>
      buildDependencyGraph({
        repository,
        epicIssueNumber: 3,
        issues: [issue(5, { body: 'Depends on #4' })]
      })
    ).toThrow(/Missing dependency/i);
  });

  it('rejects duplicate issue nodes', () => {
    expect(() =>
      buildDependencyGraph({
        repository,
        epicIssueNumber: 3,
        issues: [issue(5), issue(5)]
      })
    ).toThrow(/Duplicate issue node/i);
  });

  it('rejects explicit cross-repository dependencies', () => {
    expect(() =>
      buildDependencyGraph({
        repository,
        epicIssueNumber: 3,
        issues: [issue(5, { body: 'Depends on OtherOrg/other-repo#4' }), issue(4)]
      })
    ).toThrow(/cross-repository/i);
  });

  it('rejects ambiguous native and body dependencies', () => {
    expect(() =>
      buildDependencyGraph({
        repository,
        epicIssueNumber: 3,
        issues: [
          issue(5, {
            body: 'Depends on #4',
            nativeDependencies: [{ owner: repository.owner, name: repository.name, number: 6, source: 'native' }]
          }),
          issue(4),
          issue(6)
        ]
      })
    ).toThrow(/Ambiguous dependencies/i);
  });

  it('represents closed-but-unverified issues separately', () => {
    const graph = buildDependencyGraph({
      repository,
      epicIssueNumber: 3,
      issues: [issue(4, { state: 'closed', completionVerified: false })]
    });

    expect(graph.unverified).toEqual([4]);
    expect(graph.nodes[0]).toMatchObject({
      completionStatus: 'closed-unverified',
      eligible: true
    });
  });
});

function issue(number: number, override: Partial<DiscoveryIssue> = {}): DiscoveryIssue {
  return {
    id: number,
    number,
    title: `Issue ${number}`,
    state: 'open',
    body: '',
    completionVerified: false,
    nativeDependencies: [],
    ...override
  };
}
