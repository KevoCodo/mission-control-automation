import { useEffect, useRef, useState } from 'react';
import { demoIssues } from './data/demoIssues';
import { DashboardHeader } from './components/DashboardHeader';
import { TaskBoard } from './components/TaskBoard';
import { TaskSummary } from './components/TaskSummary';
import { sampleTasks } from './data/tasks';
import { SdlcDashboard } from './SdlcDashboard';
import { approvePlan, cancelHandoff, editPlan, exactPlan, isApproved, newDraft, prepareHandoff,
  recordCopy, requestChanges, restoreDraft, selectIssue, type Draft, type Plan } from './workflow';

const storageKey = 'mission-control-m1-demo-draft-v1';
const fields: { key: keyof Plan; label: string }[] = [
  { key: 'objective', label: 'Objective' }, { key: 'scope', label: 'Scope' },
  { key: 'files', label: 'Likely files or components' }, { key: 'acceptanceCriteria', label: 'Acceptance criteria' },
  { key: 'tests', label: 'Tests and builds' }, { key: 'restrictions', label: 'Restrictions' },
  { key: 'dependencies', label: 'Known dependencies' }, { key: 'assumptions', label: 'Unverified assumptions' }
];

function initialDraft(): Draft | null {
  try { const raw = localStorage.getItem(storageKey); return raw ? restoreDraft(JSON.parse(raw) as unknown) : null; }
  catch { return null; }
}

const actions: Record<Draft['status'], string> = {
  'issue-selected': 'Review the issue and proposed plan.',
  planning: 'Finish the plan, then submit it for approval.',
  'awaiting-approval': 'Approve the exact plan or request changes.',
  approved: 'Prepare the manual Codex handoff.',
  'handoff-prepared': 'Review and copy the handoff.',
  'awaiting-manual-execution': 'Independently verify the worktree, Git baseline and issue facts before manually starting Codex.',
  'changes-requested': 'Revise the plan and submit it again.',
  cancelled: 'Select an issue to start a new draft.'
};

export function App() {
  const [draft, setDraft] = useState<Draft | null>(initialDraft);
  const [handoff, setHandoff] = useState('');
  const [notice, setNotice] = useState('');
  const [showDashboard, setShowDashboard] = useState(false);
  const workflowRevision = useRef(0);
  const issue = draft ? demoIssues.find((item) => item.number === draft.issueNumber && item.repository === draft.repository) : undefined;

  useEffect(() => {
    try { if (draft) localStorage.setItem(storageKey, JSON.stringify(draft)); else localStorage.removeItem(storageKey); }
    catch { /* local persistence is optional */ }
  }, [draft]);

  function choose(value: string) {
    workflowRevision.current += 1;
    setHandoff(''); setNotice('');
    if (!value) { setDraft(null); return; }
    try { setDraft(newDraft(selectIssue(Number(value), 'demo/manual-handoff-lab'))); }
    catch (error) { setDraft(null); setNotice((error as Error).message); }
  }

  function revise(key: keyof Plan, value: string) {
    if (!draft) return;
    workflowRevision.current += 1;
    setHandoff(''); setNotice('Approval cleared because the plan changed.');
    setDraft(editPlan(draft, { ...draft.plan, [key]: value }));
  }

  function act(action: 'approve' | 'changes' | 'cancel' | 'prepare' | 'submit') {
    if (!draft) return;
    workflowRevision.current += 1;
    setNotice('');
    try {
      if (action === 'approve') setDraft(approvePlan(draft));
      if (action === 'changes') { setHandoff(''); setDraft(requestChanges(draft)); }
      if (action === 'cancel') { setHandoff(''); setDraft(cancelHandoff(draft)); }
      if (action === 'submit') { setHandoff(''); setDraft({ ...draft, status: 'awaiting-approval', approval: undefined }); }
      if (action === 'prepare') { const result = prepareHandoff(draft); setDraft(result.draft); setHandoff(result.text); }
    } catch (error) { setNotice((error as Error).message); }
  }

  async function copy() {
    if (!draft || !handoff || draft.status !== 'handoff-prepared' || !isApproved(draft)) return;
    const copiedDraft = draft;
    const copiedHandoff = handoff;
    const startedAtRevision = workflowRevision.current;
    try {
      await navigator.clipboard.writeText(copiedHandoff);
      if (workflowRevision.current !== startedAtRevision) return;
      workflowRevision.current += 1;
      setDraft((current) => current && current.status === 'handoff-prepared' &&
        isApproved(current) && current.issueNumber === copiedDraft.issueNumber &&
        current.repository === copiedDraft.repository && current.planVersion === copiedDraft.planVersion &&
        exactPlan(current) === exactPlan(copiedDraft) &&
        current.approval?.exactPlan === copiedDraft.approval?.exactPlan
        ? recordCopy(current) : current);
      setNotice('Copied. No worker has been launched or verified.');
    } catch {
      if (workflowRevision.current === startedAtRevision)
        setNotice('Clipboard unavailable. Select and copy the text manually.');
    }
  }

  function reset() { workflowRevision.current += 1; setDraft(null); setHandoff(''); setNotice('Demo draft reset.'); }

  return <main className="app-shell">
    <header className="mvp-header"><div><p className="eyebrow">AI Delivery Lab / Mission Control</p><h1>Supervised delivery</h1>
      <p>One fictional Epic, five human-controlled roles, and a visible evidence trail.</p></div>
      <span className="demo-badge">LOCAL DEMO DATA · NO LIVE GITHUB</span></header>
    <div className="safety-banner">Planning in this browser grants no production execution permission. Mission Control never launches Codex or AO.</div>
    <SdlcDashboard />
    <h2 className="m1-heading">M1 · Single issue planning</h2>
    <div className="workflow-grid">
      <section className="workflow-panel" aria-label="Issue selection">
        <div className="panel-heading"><span className="step">01</span><div><p className="eyebrow">Select</p><h2>Development issue</h2></div></div>
        <label htmlFor="issue-select">Local demonstration issue</label>
        <select id="issue-select" value={draft?.issueNumber ?? ''} onChange={(event) => choose(event.target.value)}>
          <option value="">Choose an issue</option>
          {demoIssues.map((item) => <option value={item.number} key={item.number}>#{item.number} · {item.title}</option>)}
        </select>
        {issue ? <div className="issue-details"><p className="identity">{issue.repository}#{issue.number}</p><h3>{issue.title}</h3><p>{issue.description}</p>
          <dl><dt>Status</dt><dd>{issue.status} · fixture only</dd><dt>Dependencies</dt>
            <dd>{issue.dependencies.length ? issue.dependencies.map((number) => `#${number} · completion unverified`).join(', ') : 'None listed in local fixture'}</dd>
            <dt>Evidence</dt><dd>Local demo fixture; GitHub state unknown</dd></dl>
          {issue.dependencies.length > 0 && <p className="warning">Approval is blocked until dependency completion has independent evidence.</p>}
        </div> : <p className="empty-copy">Choose a fictional issue to assemble a template plan.</p>}
        <button className="text-action" type="button" onClick={reset}>Reset demo workflow</button>
      </section>
      <section className="workflow-panel plan-panel" aria-label="Implementation plan">
        <div className="panel-heading"><span className="step">02</span><div><p className="eyebrow">Plan</p><h2>Implementation plan</h2></div></div>
        {draft && issue ? <><p className="source-note">Template derived from local fixture · version {draft.planVersion}. Edit any field before approval.</p>
          <div className="plan-fields">{fields.map(({ key, label }) => <label key={key}>{label}
            <textarea value={draft.plan[key]} onChange={(event) => revise(key, event.target.value)} disabled={draft.status === 'cancelled'} rows={key === 'scope' || key === 'assumptions' ? 3 : 2} maxLength={5000} />
          </label>)}</div>
          <div className="button-row">
            <button type="button" onClick={() => act('submit')} disabled={draft.status === 'cancelled'}>Submit for approval</button>
            <button className="primary-action" type="button" onClick={() => act('approve')} disabled={draft.status !== 'awaiting-approval'}>Approve plan</button>
            <button type="button" onClick={() => act('changes')} disabled={draft.status === 'cancelled'}>Request changes</button>
            <button className="danger-action" type="button" onClick={() => act('cancel')} disabled={draft.status === 'cancelled'}>Cancel handoff</button>
          </div></> : <p className="empty-copy">The plan appears after issue selection.</p>}
      </section>
      <section className="workflow-panel status-panel" aria-label="Workflow status">
        <div className="panel-heading"><span className="step">03</span><div><p className="eyebrow">Handoff</p><h2>Workflow status</h2></div></div>
        <p className="status-pill">{draft ? draft.status.replaceAll('-', ' ') : 'No issue selected'}</p>
        <h3>Next human action</h3><p>{draft ? actions[draft.status] : 'Select a local demonstration issue.'}</p>
        {draft && <p className="source-note">Approval: {isApproved(draft) ? `exact plan version ${draft.planVersion}` : 'none'}. Worker execution: not started or verified.</p>}
        <button className="primary-action" type="button" onClick={() => act('prepare')} disabled={!draft || !isApproved(draft) || draft.status === 'cancelled'}>Prepare handoff</button>
        {handoff && draft && isApproved(draft) && <div className="handoff-block"><label htmlFor="handoff-text">Copy-ready Codex instructions</label>
          <textarea id="handoff-text" readOnly value={handoff} rows={16} /><button type="button" onClick={() => void copy()}>Copy handoff</button></div>}
        {notice && <p className="notice" role="status">{notice}</p>}
        <p className="footnote">Copying is a local UI action. Verify the separate worktree and Git baseline before any manual execution.</p>
      </section>
    </div>
    <section className="legacy-dashboard"><button type="button" className="text-action" onClick={() => setShowDashboard(!showDashboard)} aria-expanded={showDashboard}>Existing task board {showDashboard ? '−' : '+'}</button>
      {showDashboard && <><DashboardHeader /><TaskSummary tasks={sampleTasks} /><TaskBoard tasks={sampleTasks} /></>}</section>
  </main>;
}
