export interface DemoIssue {
  number: number;
  title: string;
  repository: string;
  description: string;
  status: 'Open demo issue';
  dependencies: number[];
  dependencyEvidence: 'local-demo-fixture';
}

// Fictional local examples. These are never GitHub observations or execution targets.
export const demoIssues: readonly DemoIssue[] = [
  {
    number: 101,
    title: 'Add a keyboard shortcut reference',
    repository: 'demo/manual-handoff-lab',
    description: 'Create a small, accessible reference panel for the demonstration app.',
    status: 'Open demo issue',
    dependencies: [],
    dependencyEvidence: 'local-demo-fixture'
  },
  {
    number: 102,
    title: 'Add shortcut search',
    repository: 'demo/manual-handoff-lab',
    description: 'Filter the demonstration shortcut reference by a typed query.',
    status: 'Open demo issue',
    dependencies: [101],
    dependencyEvidence: 'local-demo-fixture'
  }
];
