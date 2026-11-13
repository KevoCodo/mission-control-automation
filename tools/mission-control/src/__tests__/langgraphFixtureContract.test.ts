import { describe, expect, it } from 'vitest';
import { denyLanggraphFixtureRequest, parseLanggraphFixtureRequest } from '../langgraphFixtureContract.js';

const fixture = () => ({
  version: 1, kind: 'CONTROLLER_DECISION_REQUEST_FIXTURE',
  requestId: 'fixture-request-1', issueId: 'fixture-demo', issueNumber: 7,
  repository: { owner: 'demo', name: 'sandbox' },
  planDigest: 'a'.repeat(64), generation: 1, stopEpoch: 0,
  actionScope: 'ASSIGNMENT', agentRole: 'BUILDER', commitSha: null
});
describe('LangGraph fixture contract default deny', () => {
  it('has the same deny response as the Python fixture', () => {
    const value = fixture();
    expect(parseLanggraphFixtureRequest(value)).toEqual(value);
    expect(denyLanggraphFixtureRequest(value)).toEqual({
      version: 1, kind: 'CONTROLLER_DECISION_FIXTURE',
      requestId: 'fixture-request-1', decision: 'DENY',
      authoritative: false, productionAuthorized: false, executable: false,
      reason: 'NO_TRUSTED_CONTROLLER_ADAPTER'
    });
  });
  it('rejects unsupported versions, actions, identities, and extra authority fields', () => {
    for (const [key, newValue] of [
      ['version', 2], ['version', true], ['kind', 'LIVE'], ['requestId', 'live-id'],
      ['issueId', 'live-id'], ['issueNumber', true], ['issueNumber', 0],
      ['planDigest', 'x'], ['generation', true], ['stopEpoch', -1],
      ['actionScope', 'MERGE'], ['agentRole', 'MERGER'],
      ['commitSha', 'wrong'], ['approved', true], ['grant', 'grant-id']
    ] as Array<[string, unknown]>) {
      expect(() => parseLanggraphFixtureRequest({ ...fixture(), [key]: newValue })).toThrow();
    }
  });
  it('requires correct role-action scope and exact review commit', () => {
    for (const value of [
      { ...fixture(), agentRole: 'REVIEWER', actionScope: 'ASSIGNMENT', commitSha: 'f'.repeat(40) },
      { ...fixture(), agentRole: 'TESTER', actionScope: 'REVIEW' },
      { ...fixture(), agentRole: 'ORCHESTRATOR', actionScope: 'CORRECTION' }
    ]) expect(() => parseLanggraphFixtureRequest(value)).toThrow();
    expect(denyLanggraphFixtureRequest({
      ...fixture(), agentRole: 'TESTER', actionScope: 'REVIEW', commitSha: 'f'.repeat(40)
    }).decision).toBe('DENY');
  });
  it('does not use a caller-mutable repository object', () => {
    const original = fixture();
    const parsed = parseLanggraphFixtureRequest(original);
    original.repository.owner = 'changed';
    expect(parsed.repository.owner).toBe('demo');
  });
});
