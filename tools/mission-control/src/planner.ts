import { readState } from './state.js';
import type { ControllerClients } from './clients.js';
import type { ControllerConfig, DependencyGraphNode } from './types.js';

export interface AssignmentPlan {
  eligible: number[];
  blocked: number[];
  capacity: {
    maxBuilders: number;
    activeBuilders: number;
    pendingReservations: number;
    available: number;
  };
}

export async function planAssignments(
  statePath: string,
  config: ControllerConfig,
  clients: ControllerClients
): Promise<AssignmentPlan> {
  const state = await readState(statePath);
  const latestGraph = [...state.discoveries].reverse().find((discovery) => discovery.dependencyGraph)?.dependencyGraph;
  const nodes = latestGraph?.nodes ?? [];
  const pendingReservations = state.operations.filter(
    (operation) =>
      operation.intent.action === 'ao-spawn-worker' &&
      (operation.status === 'pending' || operation.status === 'uncertain')
  ).length;
  const recoveredBuilders = clients.ao.listSessions ? (await clients.ao.listSessions()).length : 0;
  const activeBuilders = Math.max(state.identities.sessions.length, recoveredBuilders);
  const maxBuilders = Math.min(config.limits.maxBuilders, 2);
  const available = Math.max(0, maxBuilders - activeBuilders - pendingReservations);

  return {
    eligible: nodes.filter(isAssignable).map((node) => node.number),
    blocked: nodes.filter((node) => node.blocked || node.completionStatus === 'closed-unverified').map((node) => node.number),
    capacity: {
      maxBuilders,
      activeBuilders,
      pendingReservations,
      available
    }
  };
}

function isAssignable(node: DependencyGraphNode): boolean {
  return node.eligible && !node.blocked && node.completionStatus === 'open';
}
