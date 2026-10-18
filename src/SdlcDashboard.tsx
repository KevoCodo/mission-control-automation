import { useEffect, useState } from 'react';
import { activeRole, approveEpicPlan, approveRoleHandoff, closureReport, demoEpic, importReport,
  instructions, newSdlc, restoreSdlc, reviewClosure, roles, type ReportInput, type SdlcState } from './sdlcWorkflow';

const key = 'mission-control-m2-sdlc-v1';
const empty: ReportInput = { work: '', commit: '', tests: '', findings: '', pr: '', blockers: '', outcome: 'PASS' };
const initial = (): SdlcState => { try { return restoreSdlc(JSON.parse(localStorage.getItem(key) || 'null')) || newSdlc(); } catch { return newSdlc(); } };
const stepState = (s: SdlcState, role: string) => {
  if (role === 'LEAD ORCHESTRATOR') return s.stage === 'PLAN' ? 'Active' : 'Coordinates closure';
  if (s.stage === role) return 'Active';
  const report = [...s.reports].reverse().find(r => r.role === role && !r.stale);
  return report ? `${report.outcome} claimed` : 'Pending';
};
export function SdlcDashboard() {
  const [state, setState] = useState(initial);
  const [form, setForm] = useState<ReportInput>(empty);
  const [message, setMessage] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(state)); } catch { /* optional local storage */ } }, [state]);
  const role = activeRole(state);
  const roleStage = ['BUILDER','TESTER','PR REVIEWER','MERGER'].includes(state.stage);
  const act = (fn: (s: SdlcState) => SdlcState) => { try { setState(fn(state)); setMessage(''); setCopied(false); } catch (error) { setMessage((error as Error).message); } };
  const submit = () => {
    try { setState(importReport(state, form, new Date().toISOString())); setForm(empty); setMessage('Report recorded as a user-supplied claim.'); setCopied(false); }
    catch (error) { setMessage((error as Error).message); }
  };
  const next = state.stage === 'PLAN' ? 'Review the fictional Epic and approve its plan.' :
    state.stage === 'INTERVENTION' ? 'Correction limit reached. Stop and request human intervention.' :
    state.stage === 'AWAITING_INDEPENDENT_VERIFICATION' ? 'Independently verify the exact PR, merge, child acceptance, and Epic before closing externally.' :
    state.stage === 'CLOSURE' ? 'Review the child completion evidence and closure checklist.' :
    state.handoffApproved ? `Manually launch ${role} outside Mission Control, then import its completion report.` :
    `Review and explicitly approve the ${role} handoff.`;
  return <section className="sdlc-shell" aria-label="Supervised SDLC Epic">
    <div className="sdlc-hero"><div><p className="eyebrow">M2 / Supervised SDLC</p><h2>Epic #{demoEpic.number} · {demoEpic.title}</h2><p>{demoEpic.objective}</p>
      <p className="source-note">{demoEpic.repository} · FICTIONAL LOCAL FIXTURE · No live GitHub connection</p></div>
      <div className="sdlc-counter"><strong>{state.reports.filter(r => !r.stale).length}</strong><span>current role reports<br />user-supplied only</span></div></div>
    <div className="sdlc-steps" aria-label="Role stages">{roles.map((r,i) => <div className={`sdlc-step ${role === r ? 'current' : ''}`} key={r}>
      <span>{String(i + 1).padStart(2,'0')}</span><strong>{r}</strong><small>{stepState(state,r)}</small></div>)}</div>
    <div className="sdlc-grid">
      <section className="workflow-panel"><p className="eyebrow">Epic map</p><h3>One child · ordered work</h3>
        <p><strong>#{demoEpic.children[0].number} {demoEpic.children[0].title}</strong></p>
        <p>Dependencies: none in local fixture. Ordering: plan → Builder → Tester → PR Reviewer → Merger → Lead closure review.</p>
        <dl className="sdlc-facts"><dt>Current stage</dt><dd>{state.stage.replaceAll('_',' ')}</dd><dt>Assigned role</dt><dd>{role}</dd>
          <dt>Commit</dt><dd>{state.currentCommit || 'Unknown'}</dd><dt>Corrections</dt><dd>{state.corrections} / 2</dd>
          <dt>Blockers</dt><dd>{state.stage === 'INTERVENTION' ? 'Correction limit reached' : 'Provider verification unavailable'}</dd></dl>
        <h3>Next human action</h3><p className="warning">{next}</p>
        {state.stage === 'PLAN' && <button className="primary-action" onClick={() => act(approveEpicPlan)}>Approve Epic plan</button>}
        {state.stage === 'CLOSURE' && <button className="primary-action" onClick={() => act(reviewClosure)}>Review child and Epic closure</button>}
        <button className="text-action" onClick={() => { setState(newSdlc()); setForm(empty); setMessage('Local M2 demo reset.'); }}>Reset M2 demo</button>
      </section>
      <section className="workflow-panel"><p className="eyebrow">Manual role handoff</p><h3>{role}</h3>
        <p className="source-note">Handoff version {state.version}. Approval is specific to the current stage and must be repeated after a reload.</p>
        <label htmlFor="m2-instructions">Copy-ready Codex role instructions</label>
        <textarea id="m2-instructions" readOnly rows={14} value={instructions(state)} />
        <div className="button-row"><button disabled={!roleStage || state.handoffApproved} onClick={() => act(approveRoleHandoff)}>Approve {role} handoff</button>
          <button disabled={!roleStage || !state.handoffApproved} onClick={async () => { try { await navigator.clipboard.writeText(instructions(state)); setCopied(true); } catch { setMessage('Clipboard unavailable. Select and copy the instructions manually.'); } }}>Copy instructions</button></div>
        {copied && <p className="notice">Copied for a manual launch. No role was started by Mission Control.</p>}
        {role === 'MERGER' && <p className="warning">Approval checklist: check exact PR head, fresh tests, fresh review, blockers, and human merge approval in an approved GitHub interface. A report here cannot authenticate a merge.</p>}
      </section>
      <section className="workflow-panel"><p className="eyebrow">Evidence import</p><h3>Structured completion report</h3>
        <p className="source-note">All entries are USER-SUPPLIED CLAIMS. Import never verifies GitHub or a Codex run.</p>
        {roleStage ? <><div className="sdlc-form">
          {([['work','Reported work'],['commit','Full commit SHA'],['tests','Test results'],['findings','Findings'],['pr','PR URL'],['blockers','Outstanding blockers']] as const).map(([field,label]) =>
            <label key={field}>{label}<textarea value={form[field]} onChange={e => setForm({ ...form, [field]: e.target.value })} rows={field === 'work' ? 3 : 2} maxLength={5000} /></label>)}
          <label>Outcome<select value={form.outcome} onChange={e => setForm({ ...form, outcome: e.target.value as ReportInput['outcome'] })}><option>PASS</option><option>FAIL</option></select></label></div>
          <button className="primary-action" disabled={!state.handoffApproved} onClick={submit}>Import {role} report</button></> : <p>Evidence import opens after the active role handoff is approved.</p>}
        {message && <p className="notice" role="status">{message}</p>}
      </section>
    </div>
    <div className="sdlc-grid sdlc-bottom"><section className="workflow-panel"><p className="eyebrow">Evidence ledger</p><h3>Recorded handoffs and outcomes</h3>
      {state.reports.length ? <ol className="evidence-list">{state.reports.map((r,i) => <li key={i}><strong>{r.role} · v{r.handoffVersion} · {r.outcome}</strong>
        <span>{r.stale ? 'STALE / superseded' : r.provenance} · {r.timestamp}</span><p>{r.work}</p>
        <p>Commit: {r.commit || 'unknown'} · Tests: {r.tests || 'unavailable'} · PR: {r.pr || 'unavailable'}</p>
        {(r.findings || r.blockers) && <p className="warning">Findings: {r.findings || 'none'} · Blockers: {r.blockers || 'none'}</p>}</li>)}</ol> : <p>No role reports yet. Fixture identity is the only available evidence.</p>}</section>
      <section className="workflow-panel"><p className="eyebrow">Lead completion review</p><h3>Epic closure report</h3><textarea readOnly rows={14} value={closureReport(state)} aria-label="Epic closure report" />
        <p className="warning">VERIFIED COMPLETE is unavailable without independently authenticated provider and child completion evidence. Close issues only through an approved external GitHub interface.</p></section></div>
  </section>;
}
