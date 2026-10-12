import type {
  DependencyGraph,
  DependencyGraphNode,
  DiscoveryIssue,
  IssueCompletionStatus,
  IssueDependencyReference,
  RepositoryIdentity
} from './types.js';

export class DependencyGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DependencyGraphError';
  }
}

interface GraphInput {
  repository: RepositoryIdentity;
  epicIssueNumber: number;
  issues: DiscoveryIssue[];
}

type DependencySet = Map<number, IssueDependencyReference>;

export function buildDependencyGraph(input: GraphInput): DependencyGraph {
  const repositoryName = `${input.repository.owner}/${input.repository.name}`;
  const byNumber = new Map<number, DiscoveryIssue>();

  for (const issue of input.issues) {
    if (byNumber.has(issue.number)) {
      throw new DependencyGraphError(`Duplicate issue node: ${repositoryName}#${issue.number}.`);
    }
    byNumber.set(issue.number, issue);
  }

  const nodes = [...byNumber.values()]
    .sort((left, right) => left.number - right.number)
    .map((issue) => toNode(input.repository, issue, readDependencies(input.repository, issue)));

  const nodeByNumber = new Map(nodes.map((node) => [node.number, node]));
  for (const node of nodes) {
    for (const dependency of node.dependencies) {
      if (!sameRepository(input.repository, dependency)) {
        throw new DependencyGraphError(
          `Unsupported cross-repository dependency: ${formatRef(input.repository, node.number)} depends on ${formatDependency(
            dependency
          )}.`
        );
      }
      if (!nodeByNumber.has(dependency.number)) {
        throw new DependencyGraphError(
          `Missing dependency: ${formatRef(input.repository, node.number)} depends on ${formatDependency(dependency)}.`
        );
      }
    }
  }

  const order = topologicalOrder(input.repository, nodes);
  const complete = new Set(nodes.filter((node) => node.completionStatus === 'complete').map((node) => node.number));

  for (const node of nodes) {
    node.blocked = node.dependencies.some((dependency) => !complete.has(dependency.number));
    node.eligible = !node.blocked;
  }

  return {
    repository: repositoryName,
    epicIssueNumber: input.epicIssueNumber,
    nodes,
    order,
    open: nodes.filter((node) => node.completionStatus === 'open').map((node) => node.number),
    blocked: nodes.filter((node) => node.blocked).map((node) => node.number),
    unverified: nodes.filter((node) => node.completionStatus === 'closed-unverified').map((node) => node.number)
  };
}

function toNode(
  repository: RepositoryIdentity,
  issue: DiscoveryIssue,
  dependencies: IssueDependencyReference[]
): DependencyGraphNode {
  return {
    id: issue.id,
    owner: repository.owner,
    name: repository.name,
    number: issue.number,
    title: issue.title,
    state: issue.state,
    completionStatus: readCompletionStatus(issue),
    dependencies,
    blocked: false,
    eligible: false
  };
}

function readDependencies(repository: RepositoryIdentity, issue: DiscoveryIssue): IssueDependencyReference[] {
  const bodyDependencies = parseBodyDependencies(repository, issue.body ?? '');
  const nativeDependencies = issue.nativeDependencies ?? [];

  const bodySet = toDependencySet(bodyDependencies);
  const nativeSet = toDependencySet(nativeDependencies);
  if (bodySet.size > 0 && nativeSet.size > 0 && !sameDependencySet(bodySet, nativeSet)) {
    throw new DependencyGraphError(`Ambiguous dependencies for ${formatRef(repository, issue.number)}.`);
  }

  return [...mergeDependencySets(bodySet, nativeSet).values()].sort((left, right) => left.number - right.number);
}

export function parseBodyDependencies(repository: RepositoryIdentity, body: string): IssueDependencyReference[] {
  const dependencies = new Map<string, IssueDependencyReference>();
  const lines = body.split(/\r?\n/);

  for (const line of lines) {
    if (!/\b(depends on|blocked by|requires)\b/i.test(line)) {
      continue;
    }

    for (const match of line.matchAll(/https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/(\d+)/gi)) {
      addDependency(dependencies, {
        owner: match[1],
        name: match[2],
        number: Number(match[3]),
        source: 'body'
      });
    }

    for (const match of line.matchAll(/(?<![\w/.-])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)/g)) {
      addDependency(dependencies, {
        owner: match[1],
        name: match[2],
        number: Number(match[3]),
        source: 'body'
      });
    }

    for (const match of line.matchAll(/(?<![\w/])#(\d+)/g)) {
      addDependency(dependencies, {
        owner: repository.owner,
        name: repository.name,
        number: Number(match[1]),
        source: 'body'
      });
    }
  }

  return [...dependencies.values()].sort((left, right) => left.number - right.number);
}

function addDependency(dependencies: Map<string, IssueDependencyReference>, dependency: IssueDependencyReference): void {
  dependencies.set(`${dependency.owner.toLowerCase()}/${dependency.name.toLowerCase()}#${dependency.number}`, dependency);
}

function toDependencySet(dependencies: IssueDependencyReference[]): DependencySet {
  const result = new Map<number, IssueDependencyReference>();
  for (const dependency of dependencies) {
    if (result.has(dependency.number)) {
      throw new DependencyGraphError(`Duplicate dependency reference: ${formatDependency(dependency)}.`);
    }
    result.set(dependency.number, dependency);
  }
  return result;
}

function mergeDependencySets(left: DependencySet, right: DependencySet): DependencySet {
  const result = new Map<number, IssueDependencyReference>(left);
  for (const dependency of right.values()) {
    result.set(dependency.number, dependency);
  }
  return result;
}

function sameDependencySet(left: DependencySet, right: DependencySet): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const [number, dependency] of left) {
    const other = right.get(number);
    if (!other || dependency.owner !== other.owner || dependency.name !== other.name) {
      return false;
    }
  }
  return true;
}

function topologicalOrder(repository: RepositoryIdentity, nodes: DependencyGraphNode[]): number[] {
  const byNumber = new Map(nodes.map((node) => [node.number, node]));
  const visiting = new Set<number>();
  const visited = new Set<number>();
  const order: number[] = [];

  function visit(number: number, path: number[]): void {
    if (visited.has(number)) {
      return;
    }
    if (visiting.has(number)) {
      throw new DependencyGraphError(`Dependency cycle detected: ${[...path, number].join(' -> ')}.`);
    }

    const node = byNumber.get(number);
    if (!node) {
      throw new DependencyGraphError(`Missing dependency: ${formatRef(repository, number)}.`);
    }

    visiting.add(number);
    for (const dependency of node.dependencies) {
      visit(dependency.number, [...path, number]);
    }
    visiting.delete(number);
    visited.add(number);
    order.push(number);
  }

  for (const node of nodes) {
    visit(node.number, []);
  }

  return order;
}

function readCompletionStatus(issue: DiscoveryIssue): IssueCompletionStatus {
  if (issue.state.toLowerCase() !== 'closed') {
    return 'open';
  }
  return issue.completionVerified === true ? 'complete' : 'closed-unverified';
}

function sameRepository(repository: RepositoryIdentity, dependency: IssueDependencyReference): boolean {
  return (
    dependency.owner.toLowerCase() === repository.owner.toLowerCase() &&
    dependency.name.toLowerCase() === repository.name.toLowerCase()
  );
}

function formatRef(repository: RepositoryIdentity, number: number): string {
  return `${repository.owner}/${repository.name}#${number}`;
}

function formatDependency(dependency: IssueDependencyReference): string {
  return `${dependency.owner}/${dependency.name}#${dependency.number}`;
}
