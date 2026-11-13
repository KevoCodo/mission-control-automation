import { describe, expect, it } from 'vitest';
import { assessDockerGateAInventory, DOCKER_GATE_A_CHECKS,
  emptyDockerGateAInventory } from '../dockerIsolationEvidence.js';

describe('Docker Gate A inventory is never execution authority', () => {
  it('reports every missing item without ever authorizing', () => {
    const result = assessDockerGateAInventory(emptyDockerGateAInventory());
    expect(result).toEqual({
      status: 'NO_GO', executionAuthorized: false, independentlyAuthenticated: false,
      reportOnly: true, unresolved: [...DOCKER_GATE_A_CHECKS], errors: []
    });
  });
  it('even all operator-reported evidence cannot imply approval', () => {
    const inventory = emptyDockerGateAInventory();
    inventory.facts = inventory.facts.map(x =>
      ({ ...x, finding: 'REPORTED', evidenceRef: 'fixture-ref-1' }));
    const result = assessDockerGateAInventory(inventory);
    expect(result.unresolved).toEqual([]);
    expect(result.status).toBe('NO_GO');
    expect(result.executionAuthorized).toBe(false);
    expect(result.independentlyAuthenticated).toBe(false);
  });
  it('rejects missing references and duplicate checks', () => {
    const inventory = emptyDockerGateAInventory();
    inventory.facts[0] = { ...inventory.facts[0], finding: 'REPORTED' };
    expect(assessDockerGateAInventory(inventory).errors).toContain('REPORTED_WITHOUT_REFERENCE');
    const duplicate = emptyDockerGateAInventory();
    duplicate.facts[1] = { ...duplicate.facts[1], check: duplicate.facts[0].check };
    expect(assessDockerGateAInventory(duplicate).errors).toContain('DUPLICATE_GATE_A_CHECK');
  });
  it('rejects unauthorized extensions and malformed fixtures', () => {
    for (const input of [
      null, {}, { ...emptyDockerGateAInventory(), authorized: true },
      { ...emptyDockerGateAInventory(), source: 'INDEPENDENTLY_VERIFIED' },
      { ...emptyDockerGateAInventory(), target: 'HOST_NETWORK' },
      { ...emptyDockerGateAInventory(), facts: [] },
      { ...emptyDockerGateAInventory(), facts: [
        ...emptyDockerGateAInventory().facts.slice(0, -1), { x: true }
      ]}
    ]) {
      const result = assessDockerGateAInventory(input);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.executionAuthorized).toBe(false);
    }
  });
});
