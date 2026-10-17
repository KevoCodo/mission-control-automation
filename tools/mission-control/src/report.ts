import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseAuditLog, redactSecrets, type AuditEvent } from './audit.js';
import { parseState } from './state.js';
import type { ControllerState } from './types.js';

const missing = 'unavailable';
type EventRow = { sequence: number; version: number; eventId: string; type: string; timestamp: string;
  correlationId: string; operationKey: string; actor: string; actorProvenance: string; authority: string;
  source: string; evidenceRef: string; issueNumber: number | null; sessionId: string; pullRequestNumber: number | null;
  headSha: string; authorization: string; category: string; outcome: string; retryOf: string; data: unknown };
type HistoryRow = { issueNumber: number; epic: string; title: string; session: string; branch: string; worktree: string;
  pullRequest: string; head: string; ci: string; nativeReview: string; githubApproval: string;
  permissions: { builderAssignment: string; prPublication: string; nativeAoReview: string;
    correctionDispatch: string; githubMerge: string; githubIssueClosure: string };
  securityDecision: string; recovery: string; usage: string; issueClosure: string;
  action: string; verifiedOutcome: string; completion: 'unverified'; blockers: string[] };
export interface AuditReport {
  version: 2;
  input: { auditSha256: string; stateSha256?: string };
  repository: string;
  summary: { eventCount: number; eventTypes: Record<string, number>; provenance: Record<string, number> };
  events: EventRow[];
  history: HistoryRow[];
  state?: { version: number; updatedAt: string; operationStatuses: Record<string, number>; discoveryCount: number;
    stopActive: boolean; pullRequests: Array<{ number: number; issueNumber: number; headSha: string; generation: number; status: string; source: string; observedAt: string }>;
    dispatches: Array<{ dispatchId: string; operationKey: string; issueNumber: number; branch: string; localState: string;
      payloadSha256: string; correlationId: string; providerReceiptStatus: string; providerReceiptRef: string;
      evidenceProvenance: string; quarantineReason: string }>;
    authorization?: { revocationEpoch: number; consumedGrantCount: number; grants: Array<{ grantId: string;
      action: string; actorId: string; target: string; status: string; expiresAt: string; revoked: boolean;
      correlationId: string; verificationProvenance: string }> };
    nativeReviews: Array<{ number: number; issueNumber: number; headSha: string; decision: string; githubApproval: string; independentReviewer: boolean; findingsComplete: boolean; threadsComplete: boolean; observedAt: string; stale: boolean; unavailable: boolean }> };
  limitations: string[];
}
export async function generateAuditReport(auditPath: string, statePath?: string): Promise<AuditReport> {
  const raw = await readFile(auditPath, 'utf8');
  const audit = parseAuditLog(raw);
  let state: ControllerState | undefined;
  let stateRaw: string | undefined;
  if (statePath) {
    try { stateRaw = await readFile(statePath, 'utf8'); state = parseState(JSON.parse(stateRaw) as unknown); }
    catch (error) { if (!isMissingFile(error)) throw error; }
  }
  const events = audit.map(normalize);
  const limitations = [
    'Local audit and state are observations, not authenticated provider truth or action permission.',
    'Audit and state are read separately; hashes identify bytes but cannot prove a common atomic snapshot.',
    'Plans and intents do not prove execution; recorded success does not prove provider outcome.',
    'Merge eligibility, merge execution, issue closure, and verified completion are distinct.'
  ];
  if (!state) limitations.push('Missing state snapshot; verified completion is unavailable.');
  if (!audit.length) limitations.push('Missing audit history.');
  if (audit.some((event) => !event.provenance)) limitations.push('Some events lack explicit evidence provenance.');
  if (audit.some((event) => !event.actor?.provenance)) limitations.push('Unknown actor provenance exists.');
  const ids = audit.map((event) => event.eventId).filter((id): id is string => Boolean(id));
  if (new Set(ids).size !== ids.length) limitations.push('Duplicate event IDs exist; replay cannot be ruled out.');
  if (events.some((event) => event.outcome === 'uncertain' || event.outcome === 'pending')) limitations.push('Audit contains pending or uncertain outcomes.');
  if (state?.operations.some((op) => op.status === 'uncertain' || op.status === 'pending')) limitations.push('Uncertain or pending operations require provider reconciliation.');
  if (state?.dispatches.length)
    limitations.push('Dispatches remain quarantined; authoritative dispatch-ID reconciliation is unavailable.');
  if (state?.authorization.grants.length)
    limitations.push('Stored authorization records and claims do not prove trusted issuance or grant execution permission.');
  if (state?.pullRequestTracking.some((pr) => pr.stale || pr.unavailable) || state?.nativeReviewTracking.some((review) => review.stale || review.unavailable)) limitations.push('Stale or unavailable observations exist.');
  if (state?.pullRequestTracking.some((pr) => pr.dataSource !== 'github') || state?.nativeReviewTracking.some((review) => !review.capabilityVerified || !review.findingsComplete || !review.threadsComplete)) limitations.push('Incomplete provider evidence exists.');
  return redactSecrets({ version: 2, input: { auditSha256: hash(raw), ...(stateRaw === undefined ? {} : { stateSha256: hash(stateRaw) }) },
    repository: state ? safe(`${state.repository.owner}/${state.repository.name}`) : missing,
    summary: { eventCount: audit.length, eventTypes: counts(events.map((e) => e.type)), provenance: counts(events.map((e) => e.source)) },
    events, history: history(state, events), ...(state ? { state: project(state) } : {}), limitations }) as AuditReport;
}
function normalize(event: AuditEvent, index: number): EventRow {
  const data = rec(event.data);
  return { sequence: index + 1, version: event.version ?? 0, eventId: safe(event.eventId), type: safe(event.type),
    timestamp: event.timestamp, correlationId: safe(event.correlationId), operationKey: safe(event.operationKey ?? rec(data.intent).key),
    actor: safe(event.actor?.id), actorProvenance: safe(event.actor?.provenance), authority: 'unverified',
    source: safe(event.provenance?.source), evidenceRef: safe(event.evidenceRef ?? event.provenance?.evidenceId),
    issueNumber: number(event.issueNumber ?? data.issueNumber), sessionId: safe(event.sessionId ?? data.sessionId),
    pullRequestNumber: number(event.pullRequestNumber ?? data.pullRequestNumber), headSha: safe(event.headSha ?? data.headSha),
    authorization: event.authorization === 'verified' ? 'claimed-verified; unauthenticated' : safe(event.authorization),
    category: safe(event.category), outcome: safe(event.outcome), retryOf: safe(event.retryOf), data: redactSecrets(event.data) };
}
function history(state: ControllerState | undefined, events: EventRow[]): HistoryRow[] {
  const numbers = new Set<number>([...(state?.identities.issues.map((i) => i.number) ?? []),
    ...(state?.dispatches.map((d) => d.issueNumber) ?? []),
    ...(state?.pullRequestTracking.map((p) => p.issueNumber) ?? []),
    ...(state?.nativeReviewTracking.map((r) => r.issueNumber) ?? []),
    ...events.flatMap((e) => e.issueNumber === null ? [] : [e.issueNumber])]);
  return [...numbers].sort((a, b) => a - b).map((issueNumber) => {
    const issue = state?.identities.issues.find((i) => i.number === issueNumber);
    const graph = state?.discoveries.flatMap((d) => d.dependencyGraph?.nodes ?? []).find((n) => n.number === issueNumber);
    const epic = state?.discoveries.map((d) => d.dependencyGraph?.epicIssueNumber).find((n) => n !== undefined);
    const session = state?.identities.sessions.find((s) => s.issueNumber === issueNumber);
    const pr = state?.pullRequestTracking.filter((p) => p.issueNumber === issueNumber).at(-1);
    const review = pr ? state?.nativeReviewTracking.filter((r) => r.pullRequestNumber === pr.pullRequestNumber && r.headSha === pr.headSha).at(-1) : undefined;
    const ops = state?.operations.filter((o) => (o.intent.targetType === 'issue' && o.intent.targetId === issueNumber) ||
      (o.intent.targetType === 'pullRequest' && o.intent.targetId === pr?.pullRequestNumber)) ?? [];
    const related = events.filter((e) => e.issueNumber === issueNumber || (pr && e.pullRequestNumber === pr.pullRequestNumber));
    const blockers: string[] = [];
    if (!state) blockers.push('missing state');
    if (!related.length) blockers.push('missing related audit history');
    if (!graph) blockers.push('missing dependency/completion evidence');
    if (!session) blockers.push('missing AO session/worktree identity');
    if (!pr) blockers.push('missing PR and exact-head CI observation');
    else if (pr.status !== 'successful' || pr.stale || pr.unavailable || !pr.requiredChecksComplete || pr.dataSource !== 'github') blockers.push('CI stale, unsuccessful, unavailable, or provider evidence incomplete');
    if (!review) blockers.push('missing exact-head independent review');
    else {
      if (review.nativeReviewDecision !== 'approved' || !review.independentReviewer || !review.findingsComplete || !review.threadsComplete || review.stale || review.unavailable) blockers.push('native review incomplete, stale, or unapproved');
      if (review.githubRequiredApproval !== 'approved') blockers.push('GitHub-required approval missing');
      if (review.stale || review.unavailable) blockers.push('GitHub approval observation stale or unavailable');
    }
    if (ops.some((o) => o.status === 'pending' || o.status === 'uncertain')) blockers.push('pending or uncertain operation');
    if (state?.dispatches.some((d) => d.issueNumber === issueNumber))
      blockers.push('dispatch quarantined; provider reconciliation blocked');
    if (state?.nativeReviewControl.stopActive) blockers.push('controller STOP active');
    blockers.push('authenticated authorization and verified provider outcome unavailable');
    const actionEvents = related.filter(isRecordedActionEvent);
    const actionEvidence = [
      ...actionEvents.map((e) => `Recorded action event: ${e.type} (event ${e.eventId}); provider unverified`),
      ...[...ops].sort((a, b) => a.intent.key.localeCompare(b.intent.key)).map((o) =>
        `Controller operation ${o.status}: ${o.intent.action} (${o.intent.key}); provider verification unavailable`)
    ];
    const permissions = {
      builderAssignment: auditPermission(related, (e) => /^assignment\./.test(e.type)),
      prPublication: auditPermission(related, (e) => /^(?:pr|pullRequest)\.(?:published|created)$/.test(e.type)),
      nativeAoReview: reviewPermission(review?.triggerAuthorization, review?.observedAt,
        auditPermission(related, (e) => /^nativeReview\./.test(e.type))),
      correctionDispatch: reviewPermission(review?.correctionAuthorization, review?.observedAt,
        auditPermission(related, (e) => /^correction\./.test(e.type))),
      githubMerge: auditPermission(related, (e) => /^merge\./.test(e.type)),
      githubIssueClosure: auditPermission(related, (e) => /^issue\.closed$/.test(e.type))
    };
    return { issueNumber, epic: epic === undefined ? missing : `#${epic}`, title: safe(issue?.title ?? graph?.title),
      session: safe(session?.id ?? pr?.sessionId), branch: safe(session?.branch ?? pr?.branch), worktree: safe(session?.worktreePath),
      pullRequest: pr ? `#${pr.pullRequestNumber}` : missing, head: safe(pr?.headSha),
      ci: pr ? safe(`${pr.status} (${pr.dataSource}; ${pr.observedAt})`) : missing,
      nativeReview: review ? safe(`stored controller observation: ${review.nativeReviewDecision} (${review.observedAt})`) : missing,
      githubApproval: review ? safe(`stored controller observation: ${review.githubRequiredApproval}; ${review.stale ? 'stale; ' : ''}${review.unavailable ? 'unavailable; ' : ''}observed at ${review.observedAt}; head ${review.headSha}; current GitHub verification unavailable`) : missing,
      permissions,
      securityDecision: state?.nativeReviewControl.stopActive ? 'controller STOP active; action blocked' : 'controller STOP inactive; no grant implied',
      recovery: related.filter((e) => e.category === 'recovery' || /recover|retry/i.test(e.type))
        .map((e) => `${e.type}: ${e.outcome}; retry of ${e.retryOf}`).join('; ') || missing,
      usage: related.map((e) => rec(e.data).usage ?? rec(e.data).aiUsage).filter((v) => v !== undefined)
        .map((v) => JSON.stringify(redactSecrets(v))).join('; ') || missing,
      issueClosure: safe(graph?.completionStatus),
      action: actionEvidence.join('; ') || 'No action evidence available',
      verifiedOutcome: missing,
      completion: 'unverified', blockers };
  });
}
export function renderAuditReport(report: AuditReport, format: 'json' | 'markdown'): string {
  if (format === 'json') return `${JSON.stringify(report, null, 2)}\n`;
  const lines = ['# Mission Control engineering history', '', `- Schema: ${report.version}`,
    `- Repository: ${md(report.repository)}`, `- Events: ${report.summary.eventCount}`,
    `- Audit SHA-256: ${report.input.auditSha256}`, `- State SHA-256: ${report.input.stateSha256 ?? missing}`,
    '', '## Workflow history', ''];
  for (const row of report.history) {
    lines.push(`### Issue #${row.issueNumber}`, '',
      ...(['epic', 'title', 'session', 'branch', 'worktree', 'pullRequest', 'head', 'ci', 'nativeReview',
        'githubApproval'] as const).map((key) => `- ${key}: ${md(row[key])}`),
      '- Authorization evidence:',
      ...([
        ['Builder assignment', row.permissions.builderAssignment],
        ['PR publication', row.permissions.prPublication],
        ['Native AO review', row.permissions.nativeAoReview],
        ['Correction dispatch', row.permissions.correctionDispatch],
        ['GitHub merge', row.permissions.githubMerge],
        ['GitHub issue closure', row.permissions.githubIssueClosure]
      ] as const).map(([label, value]) => `  - ${label}: ${md(value)}`),
      ...(['securityDecision', 'recovery', 'usage', 'issueClosure',
        'action', 'verifiedOutcome', 'completion'] as const).map((key) => `- ${key}: ${md(row[key])}`),
      '- Blockers:', ...row.blockers.map((b) => `  - ${md(b)}`), '');
  }
  lines.push('## Event types', '', '| Type | Count |', '| --- | ---: |',
    ...Object.entries(report.summary.eventTypes).map(([k, v]) => `| ${md(k)} | ${v} |`), '',
    '## Evidence provenance', '', '| Source | Count |', '| --- | ---: |',
    ...Object.entries(report.summary.provenance).map(([k, v]) => `| ${md(k)} | ${v} |`), '', '## Events', '');
  for (const e of report.events) lines.push(`### ${e.sequence}. ${md(e.type)}`, '',
    ...(['eventId', 'version', 'timestamp', 'correlationId', 'operationKey', 'actor', 'actorProvenance', 'authority',
      'source', 'evidenceRef', 'issueNumber', 'sessionId', 'pullRequestNumber', 'headSha', 'authorization',
      'category', 'outcome', 'retryOf'] as const).map((key) => `- ${key}: ${md(String(e[key] ?? missing))}`),
    '', 'Data:', '', '~~~json', ...JSON.stringify(e.data, null, 2).split('\n').map(md), '~~~', '');
  if (report.state) lines.push('## State snapshot', '', `- Version: ${report.state.version}`,
    `- Updated at: ${md(report.state.updatedAt)}`, `- Discovery records: ${report.state.discoveryCount}`,
    `- Controller STOP active: ${report.state.stopActive}`, `- PR observations: ${report.state.pullRequests.length}`,
    `- Native review observations: ${report.state.nativeReviews.length}`, '',
    '### Dispatch identities', '', '| Dispatch ID | Operation key | Issue | Branch | Local state | Payload SHA-256 | Correlation ID | Receipt status | Receipt reference | Evidence provenance | Quarantine reason |',
    '| --- | --- | ---: | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.state.dispatches.map((d) => `| ${md(d.dispatchId)} | ${md(d.operationKey)} | ${d.issueNumber} | ${md(d.branch)} | ${md(d.localState)} | ${md(d.payloadSha256)} | ${md(d.correlationId)} | ${md(d.providerReceiptStatus)} | ${md(d.providerReceiptRef)} | ${md(d.evidenceProvenance)} | ${md(d.quarantineReason)} |`), '',
    '### Operation statuses', '', '| Status | Count |', '| --- | ---: |',
    ...Object.entries(report.state.operationStatuses).map(([k, v]) => `| ${md(k)} | ${v} |`), '',
    '### PR observations', '', '| PR | Issue | Head | Generation | Status | Source | Observed at |', '| ---: | ---: | --- | ---: | --- | --- | --- |',
    ...report.state.pullRequests.map((p) => `| ${p.number} | ${p.issueNumber} | ${md(p.headSha)} | ${p.generation} | ${md(p.status)} | ${md(p.source)} | ${md(p.observedAt)} |`), '',
    '### Native review observations', '', '| PR | Issue | Head | Native decision | Stored GitHub approval observation | Stale | Unavailable | Independent reviewer | Findings complete | Threads complete | Observed at |',
    '| ---: | ---: | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.state.nativeReviews.map((r) => `| ${r.number} | ${r.issueNumber} | ${md(r.headSha)} | ${md(r.decision)} | ${md(r.githubApproval)} | ${r.stale} | ${r.unavailable} | ${r.independentReviewer} | ${r.findingsComplete} | ${r.threadsComplete} | ${md(r.observedAt)} |`), '');
  lines.push('## Limitations', '', ...report.limitations.map((l) => `- ${md(l)}`), '');
  return `${lines.join('\n')}\n`;
}
function project(s: ControllerState): NonNullable<AuditReport['state']> {
  return { version: s.version, updatedAt: s.updatedAt, operationStatuses: counts(s.operations.map((o) => o.status)),
    discoveryCount: s.discoveries.length, stopActive: s.nativeReviewControl.stopActive,
    ...(s.authorization.grants.length || s.authorization.revocations.length ? { authorization: {
      revocationEpoch: s.authorization.revocationEpoch, consumedGrantCount: s.authorization.consumedGrantIds.length,
      grants: s.authorization.grants.map((g) => ({ grantId: safe(g.grantId), action: g.action, actorId: safe(g.actorId),
        target: `${g.target.kind}:${g.target.number}`, status: g.status, expiresAt: g.expiresAt,
        revoked: g.status === 'REVOKED' || s.authorization.revocations.some((r) => r.grantId === g.grantId),
        correlationId: safe(g.correlationId), verificationProvenance: 'unverified' })) } } : {}),
    dispatches: s.dispatches.map((d) => ({ dispatchId: safe(d.dispatchId), operationKey: safe(d.operationKey),
      issueNumber: d.issueNumber, branch: safe(d.branch), localState: d.state, payloadSha256: d.payloadSha256,
      correlationId: safe(d.correlationId), providerReceiptStatus: 'unverified',
      providerReceiptRef: safe(d.providerReceiptRef), evidenceProvenance: safe(d.evidence?.provenance),
      quarantineReason: safe(d.quarantineReason) })),
    pullRequests: s.pullRequestTracking.map((p) => ({ number: p.pullRequestNumber, issueNumber: p.issueNumber,
      headSha: safe(p.headSha), generation: p.generation, status: safe(p.status), source: safe(p.dataSource), observedAt: safe(p.observedAt) })),
    nativeReviews: s.nativeReviewTracking.map((r) => ({ number: r.pullRequestNumber, issueNumber: r.issueNumber,
      headSha: safe(r.headSha), decision: safe(r.nativeReviewDecision), githubApproval: safe(r.githubRequiredApproval),
      independentReviewer: r.independentReviewer, findingsComplete: r.findingsComplete, threadsComplete: r.threadsComplete,
      observedAt: safe(r.observedAt), stale: r.stale, unavailable: r.unavailable })) };
}
function isRecordedActionEvent(event: EventRow): boolean {
  return event.category === 'action' || /^(?:assignment\.spawned|assignment\.spawn\.uncertain|pr\.published|pr\.created|merge\.executed|issue\.closed)$/.test(event.type);
}
function auditPermission(events: EventRow[], applies: (event: EventRow) => boolean): string {
  const claim = events.filter((event) => applies(event) && event.authorization !== missing && event.authorization !== 'unknown').at(-1);
  return claim ? `recorded audit claim: ${claim.authorization} (event ${claim.eventId}); authority unverified` : missing;
}
function reviewPermission(
  observation: { humanAuthorized: boolean; source: string } | undefined,
  observedAt: string | undefined,
  auditClaim: string
): string {
  if (observation && observation.source !== 'missing') {
    return safe(`stored controller observation: ${observation.source}; humanAuthorized ${observation.humanAuthorized}; observed at ${observedAt ?? missing}; authority unverified`);
  }
  return auditClaim;
}
function rec(v: unknown): Record<string, unknown> { return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}; }
function number(v: unknown): number | null { return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null; }
function safe(v: unknown): string { return typeof v === 'string' && v.trim() ? redactSecrets(v) : missing; }
function counts(v: string[]): Record<string, number> { const m = new Map<string, number>(); for (const x of v) m.set(x, (m.get(x) ?? 0) + 1); return Object.fromEntries([...m].sort(([a], [b]) => a.localeCompare(b))); }
function hash(v: string): string { return createHash('sha256').update(v, 'utf8').digest('hex'); }
function md(v: string): string { return v.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '&#124;').replace(/[`\[\]!]/g, (c) => `&#${c.charCodeAt(0)};`); }
function isMissingFile(e: unknown): boolean { return e instanceof Error && 'code' in e && e.code === 'ENOENT'; }
