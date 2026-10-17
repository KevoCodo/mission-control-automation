import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../config.js';
import { fingerprintDispatchPayload, quarantineDispatch, recordDispatchIntent, reconcileDispatchSnapshot } from '../dispatch.js';
import { evaluateDispatchFixture, verifiedDispatchFixture } from './dispatchFixture.js';
import type { DispatchEvidence, DispatchState } from '../types.js';
import { readState } from '../state.js';
import { generateAuditReport, renderAuditReport } from '../report.js';
import { reconcilePendingOperations, recordOperationOutcome } from '../recovery.js';
import { createInitialState, writeStateAtomic } from '../state.js';

const at = new Date('2026-01-01T00:00:00.000Z');
let dir: string;
let statePath: string;
let auditPath: string;
const input = { operationKey: 'assign-7', issueNumber: 7, branch: 'ao/issue-7',
  target: { sessionId: 'intended-7' }, payload: { instruction: 'private content', options: { b: 2, a: 1 } },
  dispatchId: 'dispatch-7', correlationId: 'correlation-7' };
beforeEach(async () => { dir = await mkdtemp(path.join(process.cwd(), '.dispatch-test-'));
  statePath = path.join(dir, 'state.json'); auditPath = path.join(dir, 'audit.jsonl'); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const record = (override: Partial<typeof input> = {}) => recordDispatchIntent(statePath, defaultConfig, { ...input, ...override }, at);
const fixture = (kind: 'acceptance' | 'rejection' | 'retirement' | 'outcome', durable = false) =>
  verifiedDispatchFixture(kind, input.dispatchId, `receipt-${kind}`, at.toISOString(), durable);
async function transitionDispatchFixture(_statePath: string, dispatchId: string, next: DispatchState,
  now = at, evidence?: DispatchEvidence, reason?: 'acknowledgment-lost' | 'reconciliation-blocked' | 'attempt-interrupted') {
  const state = await readState(statePath);
  const index = state.dispatches.findIndex((item) => item.dispatchId === dispatchId);
  const updated = evaluateDispatchFixture(state.dispatches[index], next, now, evidence, reason);
  const dispatches = [...state.dispatches]; dispatches[index] = updated;
  await writeStateAtomic(statePath, { ...state, dispatches, updatedAt: now.toISOString() });
  return updated;
}

describe('durable dispatch identity and recovery', () => {
  it('keeps fixture provider outcomes out of the production entry point even with NODE_ENV=test', async () => {
    const prior = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    try {
      const api = await import('../index.js');
      expect(api).not.toHaveProperty('transitionDispatchFixture');
      expect(api).not.toHaveProperty('verifiedDispatchFixture');
      await record();
      expect((await readState(statePath)).dispatches[0]).toMatchObject({ state: 'INTENT_RECORDED' });
    } finally { process.env.NODE_ENV = prior; }
  });
  it('rejects unsupported JSON payloads at every depth with a typed error', () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    const sparse = Array(2); sparse[0] = 1;
    const accessor = Object.defineProperty({}, 'secret', { enumerable: true, get: () => 'secret' });
    const unsupported = [undefined, () => 1, Symbol('x'), 1n, NaN, Infinity, -Infinity,
      cycle, sparse, new Date(), new Map(), /x/, Object.create(null), { nested: [undefined] }, { nested: { value: 1n } },
      { nested: { value: () => 1 } }, { nested: { value: Symbol('x') } }, accessor,
      { [Symbol('x')]: 'value' }];
    for (const payload of unsupported)
      expect(() => fingerprintDispatchPayload(payload)).toThrowError(expect.objectContaining({ code: 'EDISPATCH_PAYLOAD' }));
    expect(fingerprintDispatchPayload({ b: [1, null, true], a: { y: 'x', z: 0 } }))
      .toBe(fingerprintDispatchPayload({ a: { z: 0, y: 'x' }, b: [1, null, true] }));
  });
  it('returns the same identity across retries and canonical payload order', async () => {
    const first = await record();
    const second = await record({ payload: { options: { a: 1, b: 2 }, instruction: 'private content' } });
    expect(second).toEqual(first);
    expect((await readState(statePath)).dispatches).toHaveLength(1);
    expect(fingerprintDispatchPayload({ a: 1, b: 2 })).toBe(fingerprintDispatchPayload({ b: 2, a: 1 }));
  });
  it('rejects a different payload under the same operation key', async () => {
    await record();
    await expect(record({ payload: { instruction: 'changed' } })).rejects.toMatchObject({ code: 'EDISPATCH_CONFLICT' });
  });
  it('rejects conflicting IDs and duplicate IDs', async () => {
    await record();
    await expect(record({ dispatchId: 'other' })).rejects.toMatchObject({ code: 'EDISPATCH_CONFLICT' });
    await expect(record({ operationKey: 'other', issueNumber: 8, branch: 'ao/issue-8' }))
      .rejects.toMatchObject({ code: 'EDISPATCH_ID_CONFLICT' });
  });
  it('serializes simultaneous issue and branch calls', async () => {
    const results = await Promise.allSettled([record(), record({ operationKey: 'different', dispatchId: 'other' })]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await readState(statePath)).dispatches).toHaveLength(1);
    await expect(record({ operationKey: 'branch', issueNumber: 8, dispatchId: 'branch' }))
      .rejects.toMatchObject({ code: 'EDISPATCH_ACTIVE' });
  });
  it('recovers a persisted intent before transport and never grants a retry', async () => {
    await record();
    const restarted = await readState(statePath);
    expect(restarted.dispatches[0].state).toBe('INTENT_RECORDED');
    expect(reconcileDispatchSnapshot(restarted.dispatches[0])).toMatchObject({ status: 'blocked', observation: 'unavailable' });
    expect(await record()).toEqual(restarted.dispatches[0]);
  });
  it('quarantines an interrupted submitting attempt and survives restart', async () => {
    await record();
    await transitionDispatchFixture(statePath, input.dispatchId, 'SUBMITTING', at);
    const uncertain = await transitionDispatchFixture(statePath, input.dispatchId, 'UNCERTAIN', at, undefined, 'acknowledgment-lost');
    expect(uncertain.quarantineReason).toBe('acknowledgment-lost');
    expect((await record()).state).toBe('UNCERTAIN');
    expect((await readState(statePath)).dispatches[0].state).toBe('UNCERTAIN');
    await expect(transitionDispatchFixture(statePath, input.dispatchId, 'SUBMITTING', at))
      .rejects.toMatchObject({ code: 'EDISPATCH_TRANSITION' });
  });
  it('quarantines a local intent without accepting fixture evidence', async () => {
    await record();
    const quarantined = await quarantineDispatch(statePath, input.dispatchId, 'attempt-interrupted', at);
    expect(quarantined).toMatchObject({ state: 'UNCERTAIN', quarantineReason: 'attempt-interrupted' });
    expect(quarantined.evidence).toBeUndefined();
    expect((await readState(statePath)).dispatches[0]).toEqual(quarantined);
  });
  it('ignores stale and ambiguous session observations', async () => {
    const intent = await record();
    expect(reconcileDispatchSnapshot(intent, { sessionId: 'unrelated', branch: input.branch })).toMatchObject({ status: 'blocked', observation: 'unverified' });
    expect((await readState(statePath)).dispatches[0].state).toBe('INTENT_RECORDED');
  });
  it('requires evidence for provider-result transitions', async () => {
    await record(); await transitionDispatchFixture(statePath, input.dispatchId, 'SUBMITTING', at);
    await expect(transitionDispatchFixture(statePath, input.dispatchId, 'ACCEPTED', at))
      .rejects.toMatchObject({ code: 'EDISPATCH_EVIDENCE' });
    await expect(transitionDispatchFixture(statePath, input.dispatchId, 'ACCEPTED', at,
      verifiedDispatchFixture('acceptance', 'wrong-id', 'receipt', at.toISOString())))
      .rejects.toMatchObject({ code: 'EDISPATCH_EVIDENCE' });
    const accepted = await transitionDispatchFixture(statePath, input.dispatchId, 'ACCEPTED', at, fixture('acceptance'));
    expect(accepted.providerReceiptRef).toBeUndefined();
    expect(accepted.evidence?.providerReceiptRef).toBe('receipt-acceptance');
  });
  it('requires durable matching retirement fixture evidence', async () => {
    await record(); await transitionDispatchFixture(statePath, input.dispatchId, 'UNCERTAIN', at);
    await expect(transitionDispatchFixture(statePath, input.dispatchId, 'RETIRED', at, fixture('retirement')))
      .rejects.toMatchObject({ code: 'EDISPATCH_EVIDENCE' });
    await expect(transitionDispatchFixture(statePath, input.dispatchId, 'RETIRED', at,
      { ...fixture('retirement', true), provenance: 'ao' } as never))
      .rejects.toMatchObject({ code: 'EDISPATCH_EVIDENCE' });
    expect((await readState(statePath)).dispatches[0].state).toBe('UNCERTAIN');
  });
  it('allows delayed matching provider fixtures without inferring from sessions', async () => {
    await record(); await transitionDispatchFixture(statePath, input.dispatchId, 'SUBMITTING', at);
    await transitionDispatchFixture(statePath, input.dispatchId, 'UNCERTAIN', at);
    const accepted = await transitionDispatchFixture(statePath, input.dispatchId, 'ACCEPTED', at, fixture('acceptance'));
    const completed = await transitionDispatchFixture(statePath, input.dispatchId, 'COMPLETED', at, fixture('outcome'));
    expect(accepted.state).toBe('ACCEPTED'); expect(completed.state).toBe('COMPLETED');
  });
  it('models verified rejection and durable retirement as distinct terminal outcomes', async () => {
    await record(); await transitionDispatchFixture(statePath, input.dispatchId, 'SUBMITTING', at);
    const rejected = await transitionDispatchFixture(statePath, input.dispatchId, 'REJECTED', at, fixture('rejection'));
    expect(rejected.state).toBe('REJECTED');
    await expect(transitionDispatchFixture(statePath, input.dispatchId, 'RETIRED', at, fixture('retirement', true)))
      .rejects.toMatchObject({ code: 'EDISPATCH_TRANSITION' });
    const other = { ...input, operationKey: 'assign-8', issueNumber: 8, branch: 'ao/issue-8',
      dispatchId: 'dispatch-8', correlationId: 'correlation-8' };
    await recordDispatchIntent(statePath, defaultConfig, other, at);
    await transitionDispatchFixture(statePath, other.dispatchId, 'UNCERTAIN', at);
    const retired = await transitionDispatchFixture(statePath, other.dispatchId, 'RETIRED', at,
      verifiedDispatchFixture('retirement', other.dispatchId, 'retirement-8', at.toISOString(), true));
    expect(retired.state).toBe('RETIRED');
  });
  it('rejects illegal transitions and forged unverified evidence', async () => {
    await record();
    await expect(transitionDispatchFixture(statePath, input.dispatchId, 'COMPLETED', at, fixture('outcome')))
      .rejects.toMatchObject({ code: 'EDISPATCH_TRANSITION' });
    await transitionDispatchFixture(statePath, input.dispatchId, 'SUBMITTING', at);
    await expect(transitionDispatchFixture(statePath, input.dispatchId, 'REJECTED', at,
      { ...fixture('rejection'), verified: false } as never)).rejects.toMatchObject({ code: 'EDISPATCH_EVIDENCE' });
  });
  it('fails closed on state write failure and keeps no identity', async () => {
    await expect(recordDispatchIntent(dir, defaultConfig, input, at)).rejects.toThrow();
    await expect(readState(dir)).rejects.toThrow();
  });
  it('keeps durable intent when audit append fails and hides instructions', async () => {
    await writeFile(auditPath, '');
    const intent = await recordDispatchIntent(statePath, defaultConfig, input, at, auditPath);
    const raw = await readFile(statePath, 'utf8');
    expect(raw).not.toContain('private content');
    expect((await readFile(auditPath, 'utf8'))).not.toContain('private content');
    expect(intent.providerReceiptRef).toBeUndefined();
    await expect(recordDispatchIntent(path.join(dir, 'state-fail.json'), defaultConfig,
      { ...input, dispatchId: 'different' }, at, dir)).rejects.toThrow();
    expect((await readState(path.join(dir, 'state-fail.json'))).dispatches).toHaveLength(1);
  });
  it('reports local identity and explicitly unverified receipt', async () => {
    await recordDispatchIntent(statePath, defaultConfig, input, at, auditPath);
    const report = await generateAuditReport(auditPath, statePath);
    const json = renderAuditReport(report, 'json');
    const markdown = renderAuditReport(report, 'markdown');
    expect(json).toContain('"providerReceiptStatus": "unverified"');
    expect(markdown).toContain('Dispatch identities');
    expect(json).not.toContain('private content');
    expect(report.limitations).toContain('Dispatches remain quarantined; authoritative dispatch-ID reconciliation is unavailable.');
  });
  it('blocks legacy AO outcome recording and generic session probes', async () => {
    const legacy = { intent: { key: 'legacy-ao', action: 'ao-spawn-worker', targetType: 'issue', targetId: 7 },
      status: 'uncertain' as const, attempts: 1, createdAt: at.toISOString(), updatedAt: at.toISOString() };
    await writeStateAtomic(statePath, { ...createInitialState(defaultConfig, at), operations: [legacy] });
    let probes = 0;
    const result = await reconcilePendingOperations(statePath, async () => { probes++; return { status: 'succeeded' }; });
    expect(probes).toBe(0); expect(result.recovered).toHaveLength(0);
    expect(result.blocked).toMatchObject([{ intent: { key: 'legacy-ao' }, status: 'uncertain' }]);
    await expect(recordOperationOutcome(statePath, 'legacy-ao', 'succeeded', { provider: 'ao', externalId: 'session-7' }))
      .rejects.toMatchObject({ code: 'EAO_RECONCILIATION_BLOCKED' });
    expect((await readState(statePath)).operations[0].status).toBe('uncertain');
  });
  it('keeps persisted fixture outcomes readable and unverified without releasing the identity', async () => {
    await record();
    await transitionDispatchFixture(statePath, input.dispatchId, 'SUBMITTING', at);
    await transitionDispatchFixture(statePath, input.dispatchId, 'REJECTED', at, fixture('rejection'));
    expect((await readState(statePath)).dispatches[0].state).toBe('REJECTED');
    await expect(record({ operationKey: 'another', dispatchId: 'another' }))
      .rejects.toMatchObject({ code: 'EDISPATCH_ACTIVE' });
    await writeFile(auditPath, '');
    const report = await generateAuditReport(auditPath, statePath);
    expect(report.state?.dispatches[0].providerReceiptStatus).toBe('unverified');
    expect(report.limitations).toContain('Dispatches remain quarantined; authoritative dispatch-ID reconciliation is unavailable.');
  });
});
