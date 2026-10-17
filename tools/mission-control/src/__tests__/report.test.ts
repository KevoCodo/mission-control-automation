import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendAuditEvent, parseAuditLog } from '../audit.js';
import { runCli } from '../cli.js';
import { defaultConfig } from '../config.js';
import { generateAuditReport, renderAuditReport } from '../report.js';
import { createInitialState } from '../state.js';

let directory: string;
beforeEach(async () => { directory = await mkdtemp(path.join(process.cwd(), '.issue12-report-test-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe('audit reporting', () => {
  it('versions new events, retains legacy events, and produces deterministic redacted reports', async () => {
    const auditPath = path.join(directory, 'audit.jsonl');
    await writeFile(auditPath, `${JSON.stringify({ type: 'legacy', timestamp: '2026-01-01T00:00:00.000Z', data: { ok: true } })}\n`);
    await appendAuditEvent(auditPath, {
      type: 'prTracking.completed', timestamp: '2026-01-02T00:00:00.000Z',
      provenance: { source: 'fixture', evidenceId: 'fixture-1', observedAt: '2026-01-02T00:00:00.000Z' },
      data: { token: 'ghp_exposed', message: 'password=hunter2', nested: [{ authorization: 'Bearer abc.def' }] }
    });
    const raw = await readFile(auditPath, 'utf8');
    expect(raw).toContain('"version":2');
    expect(raw).not.toContain('hunter2');
    const first = await generateAuditReport(auditPath);
    const second = await generateAuditReport(auditPath);
    expect(renderAuditReport(first, 'json')).toBe(renderAuditReport(second, 'json'));
    expect(renderAuditReport(first, 'markdown')).toBe(renderAuditReport(second, 'markdown'));
    expect(first.events.map((event) => event.version)).toEqual([0, 2]);
    expect(first.summary.provenance).toEqual({ fixture: 1, unavailable: 1 });
    expect(first.limitations).toContain('Some events lack explicit evidence provenance.');
    expect(renderAuditReport(first, 'markdown')).not.toContain('hunter2');
  });

  it('fails closed on malformed, truncated, and unsupported audit lines', async () => {
    const auditPath = path.join(directory, 'audit.jsonl');
    const event = { type: 'test', timestamp: '2026-01-01T00:00:00.000Z', data: {} };
    expect(() => parseAuditLog(`${JSON.stringify({ ...event, version: 2 })}\n`)).toThrow(/line 1/);
    expect(() => parseAuditLog(`${JSON.stringify(event)}\n{`)).toThrow(/incomplete final line/);
    expect(() => parseAuditLog(`${JSON.stringify(event)}\n\n`)).toThrow(/empty line/);
    await writeFile(auditPath, `${JSON.stringify({ ...event, version: 2 })}\n`);
    await expect(generateAuditReport(auditPath)).rejects.toThrow(/line 1/);
    expect(() => parseAuditLog(`${JSON.stringify({ ...event, provenance: { source: 'verified-human' } })}\n`)).toThrow(/line 1/);
    expect(() => parseAuditLog(`${JSON.stringify({ ...event, version: 2, eventId: '' })}\n`)).toThrow(/line 1/);
  });

  it('redacts nested environment credentials while retaining useful evidence', async () => {
    const auditPath = path.join(directory, 'audit.jsonl');
    const event = { version: 2, eventId: 'safe-id', type: 'review|<svg onload=alert(1)>',
      timestamp: '2026-01-01T00:00:00.000Z', actor: { id: 'human', provenance: 'self-asserted' },
      authorization: 'verified', provenance: { source: 'caller' },
      data: { env: { GITHUB_TOKEN: 'ghp_CANARY_GITHUB', API_KEY: 'CANARY_ENV' },
        nested: [{ credential: 'CANARY_NESTED' }], evidence: 'check passed',
        body: '[click](javascript:alert(1))\n| cell | <script>alert(1)</script>\nBearer CANARY_BEARER' } };
    await writeFile(auditPath, `${JSON.stringify(event)}\n`);
    const report = await generateAuditReport(auditPath);
    const json = renderAuditReport(report, 'json');
    const markdown = renderAuditReport(report, 'markdown');
    for (const canary of ['CANARY_GITHUB', 'CANARY_ENV', 'CANARY_NESTED', 'CANARY_BEARER']) {
      expect(json).not.toContain(canary);
      expect(markdown).not.toContain(canary);
    }
    expect(json).toContain('check passed');
    expect(report.events[0]?.authority).toBe('unverified');
    expect(report.events[0]?.authorization).toBe('claimed-verified; unauthenticated');
    expect(markdown).not.toContain('<script>');
    expect(markdown).not.toContain('<svg');
    expect(markdown).not.toContain('](javascript:');
  });

  it('CLI emits JSON and Markdown without changing the audit file', async () => {
    const auditPath = path.join(directory, 'audit.jsonl');
    const statePath = path.join(directory, 'missing-state.json');
    await writeFile(auditPath, `${JSON.stringify({ type: 'test', timestamp: '2026-01-01T00:00:00.000Z', data: { ok: true } })}\n`);
    const before = await readFile(auditPath, 'utf8');
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(await runCli(['report', '--audit', auditPath, '--state', statePath])).toBe(0);
      expect(JSON.parse(String(output.mock.calls.at(-1)?.[0])).summary.eventCount).toBe(1);
      expect(await runCli(['report', '--audit', auditPath, '--state', statePath, '--format', 'markdown'])).toBe(0);
      expect(String(output.mock.calls.at(-1)?.[0])).toContain('# Mission Control engineering history');
    } finally { output.mockRestore(); }
    expect(await readFile(auditPath, 'utf8')).toBe(before);
  });

  it('projects a state snapshot from the exact bytes it hashes', async () => {
    const auditPath = path.join(directory, 'audit.jsonl');
    const statePath = path.join(directory, 'state.json');
    await writeFile(auditPath, '');
    const state = createInitialState(defaultConfig, new Date('2026-01-01T00:00:00.000Z'));
    await writeFile(statePath, JSON.stringify(state));
    const report = await generateAuditReport(auditPath, statePath);
    expect(report.repository).toBe('KevoCodo/ai-delivery-lab');
    expect(report.state).toMatchObject({ version: 4, discoveryCount: 0, stopActive: true });
    expect(report.input.stateSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(renderAuditReport(report, 'markdown')).toContain('### PR observations');
  });
});
