import React, { useEffect, useState } from 'react';
import { accountRequest } from '../access/account-api.mjs';
import { journeyApi } from '../access/journey-api.mjs';
import { accessState, policyDocumentLabel, verificationGuide } from './learning-area-model.mjs';

// Optional. Saved only to the employee's own record when they choose Save; HR
// and managers cannot read it, and it never affects progress.
// The link to a policy's full document. The Employee Handbook always has its button;
// until an approved document is linked it says so instead of opening something made up.
export function PolicyDocumentButton({ stepId, document }) {
  const [note, setNote] = useState(false);
  if (document)
    return (
      <a className="fp-action" href={document.url} target="_blank" rel="noopener noreferrer">
        {policyDocumentLabel(stepId, document)}
      </a>
    );
  if (stepId !== 'policies.employee-handbook') return null;
  return (
    <>
      <button
        type="button"
        className="fp-action"
        aria-expanded={note}
        onClick={() => setNote(!note)}
      >
        View Employee Handbook
      </button>
      {note && (
        <p role="status" className="fp-muted" style={{ flexBasis: '100%' }}>
          The full Employee Handbook has not been added to this workspace yet. Ask HR to add it. The
          summary on this page is the approved text from your onboarding plan.
        </p>
      )}
    </>
  );
}

export function WorkingPreferences({ record, onRecords }) {
  const [draft, setDraft] = useState(record?.text || '');
  const [loaded, setLoaded] = useState(Boolean(record));
  const { busy, error, run } = useSubmit();
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (record && !loaded) {
      setDraft(record.text);
      setLoaded(true);
    }
  }, [record, loaded]);
  async function save(text) {
    setMessage('');
    const res = await run(() =>
      journeyApi.submitVerification('team-support', 'working-preferences', { text }),
    );
    if (!res) return;
    onRecords(res.verifications);
    if (!text) setDraft('');
    setMessage(text ? 'Saved privately.' : 'Removed.');
  }
  return (
    <div className="learning-activity">
      <p>
        Optional. If you save this, it is stored only in your own onboarding record. HR, your
        manager and teammates cannot see it, and you can remove it at any time. Share it yourself
        only if you choose to.
      </p>
      <label>
        How do you prefer to collaborate?
        <textarea
          maxLength={600}
          rows={3}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="For example: written meeting agendas or time for focused work."
        />
      </label>
      <p className="fp-muted">
        Keep it about everyday work. Do not include medical, personal or other sensitive
        information. Skipping this never affects your progress.
      </p>
      <button
        className="fp-action main"
        disabled={busy || !draft.trim() || draft.trim() === record?.text}
        onClick={() => save(draft.trim())}
      >
        {busy ? 'Saving…' : 'Save privately'}
      </button>
      {record && (
        <button className="fp-action" disabled={busy} onClick={() => save('')}>
          Remove my answer
        </button>
      )}
      {error && (
        <p role="alert" className="fp-inline-error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
    </div>
  );
}

export function AiReadiness({ onUpdated }) {
  const [data, setData] = useState(null),
    [level, setLevel] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const [confidence, setConfidence] = useState(''),
    [need, setNeed] = useState('');
  const load = () =>
    accountRequest('/api/me/ai-proficiency').then((result) => {
      setData(result);
      setLevel(result.aiProficiency.level?.toString() || '');
    });
  useEffect(() => {
    let live = true;
    accountRequest('/api/me/ai-proficiency')
      .then((result) => {
        if (live) {
          setData(result);
          setLevel(result.aiProficiency.level?.toString() || '');
        }
      })
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, []);
  async function save(training = false) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await accountRequest(
        '/api/me/ai-proficiency' + (training ? '/complete-training' : ''),
        {
          method: training ? 'POST' : 'PUT',
          body: training
            ? {}
            : level
              ? { status: 'assessed', level: Number(level) }
              : { status: 'not_sure' },
        },
      );
      setData(result);
      if (result.onboarding) onUpdated(result.onboarding);
      setMessage(
        training ? 'Practice completion saved.' : 'Assessment saved. Your learning path is ready.',
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  if (!data)
    return (
      <div className="learning-activity">
        <p role={error ? 'alert' : 'status'}>{error || 'Loading your AI learning path…'}</p>
        {error && (
          <button className="fp-action" onClick={() => load().catch((e) => setError(e.message))}>
            Retry
          </button>
        )}
      </div>
    );
  const result = data.aiProficiency;
  // 0 is "not sure yet / skip rating"; 1 to 10 are the levels.
  const sliderLevel = Number(level) || 0;
  const sliderText =
    sliderLevel === 0
      ? '0 — Not sure yet / skip rating'
      : `${sliderLevel} — ${data.levels.find((item) => item.level === sliderLevel)?.description ?? ''}`;
  return (
    <div className="learning-activity">
      <p>
        Your experience rating and training completion are saved to your onboarding record and
        available to HR. Confidence and training interests below are private reflections for this
        visit only.
      </p>
      <div className="ai-slider-field">
        <label htmlFor="ai-experience">AI experience</label>
        <input
          id="ai-experience"
          className="ai-slider"
          type="range"
          min={0}
          max={10}
          step={1}
          value={sliderLevel}
          onChange={(e) => setLevel(e.target.value === '0' ? '' : e.target.value)}
          aria-valuetext={sliderText}
        />
        <div className="ai-slider-scale" aria-hidden="true">
          {Array.from({ length: 11 }, (_, n) => (
            <span key={n} className={n === sliderLevel ? 'is-selected' : ''}>
              {n}
            </span>
          ))}
        </div>
        <p className="ai-slider-text" role="status">
          {sliderText}
        </p>
      </div>
      <div className="learning-columns">
        <label>
          Confidence (optional)
          <select value={confidence} onChange={(e) => setConfidence(e.target.value)}>
            <option value="">Choose if useful</option>
            <option>Would like guided practice</option>
            <option>Comfortable with help</option>
            <option>Confident working independently</option>
          </select>
        </label>
        <label>
          Training interest (optional)
          <select value={need} onChange={(e) => setNeed(e.target.value)}>
            <option value="">Choose if useful</option>
            <option>Safe use and privacy</option>
            <option>Writing clearer prompts</option>
            <option>Checking AI answers</option>
            <option>Workflow design</option>
          </select>
        </label>
      </div>
      {(confidence || need) && (
        <p>
          Use your practice exercise to focus on {need || 'the skills you want to improve'}.{' '}
          {confidence === 'Would like guided practice'
            ? 'Ask your onboarding coordinator for guided practice.'
            : 'Review the result carefully before using it at work.'}
        </p>
      )}
      <button className="fp-action main" disabled={busy} onClick={() => save()}>
        {busy ? 'Saving…' : 'Save assessment & show learning path'}
      </button>
      <section className="learning-resource">
        <h4>{result.learningPath.title}</h4>
        <p>{result.learningPath.focus}</p>
        <strong>Practice exercise (optional)</strong>
        <p>{result.practiceTask}</p>
        <p>
          Use sample or public information. Your saved assessment already completes this task; the
          practice exercise is extra and is recorded separately.
        </p>
        {result.trainingCompleted ? (
          <p role="status">Training completed. You can revisit this exercise any time.</p>
        ) : (
          <button
            className="fp-action main"
            disabled={busy || result.status === 'unanswered'}
            onClick={() => save(true)}
          >
            I completed the practice exercise
          </button>
        )}
      </section>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
    </div>
  );
}
// ----------------------------------------------------------------------------
// Task verification (policies, alignment, role & tools, people & support)
// ----------------------------------------------------------------------------

// Short, plain statement of how a task is verified (visible), with the rest
// folded away so the task stays easy to scan.
export function VerificationGuide({ step, areaId, accessStepIds }) {
  const guide = verificationGuide(step, areaId, accessStepIds);
  return (
    <section className="verification-guide" aria-label="How this task is verified">
      <span className={'verification-badge ' + (guide.mandatory ? 'info-badge' : 'optional-badge')}>
        {guide.mandatory ? 'REQUIRED' : 'OPTIONAL'} · {guide.method.toUpperCase()}
      </span>
      <p>
        <strong>To complete:</strong> {guide.toComplete}
      </p>
      <details>
        <summary>If you get stuck, and what is saved</summary>
        <p>
          <strong>If you do not pass or need help:</strong> {guide.ifStuck}
        </p>
        <p>
          <strong>Saved:</strong> {guide.saved}
        </p>
      </details>
    </section>
  );
}

function useSubmit() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function run(task) {
    setBusy(true);
    setError('');
    try {
      return await task();
    } catch (e) {
      setError(e.message || 'Could not save. Please try again.');
      return null;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}

// Area 3: an acknowledgement, not an assessment. Detailed role duties are not
// supplied by the profile, so the items are actions to take with the manager.
export function RoleResponsibilitiesChecklist({ profile, content, record, onRecords }) {
  const job = profile?.job;
  const items =
    content?.responsibilities?.byDepartment?.[job?.department] ||
    content?.responsibilities?.default ||
    [];
  const [checked, setChecked] = useState({});
  const { busy, error, run } = useSubmit();
  const saved = Boolean(record?.acknowledgedAt);
  const all = items.length > 0 && items.every((_, i) => checked[i]);
  return (
    <div className="role-responsibilities-checklist">
      <h4>Your role checklist</h4>
      <p>
        {job
          ? [job.jobTitle || 'Role not assigned yet', job.department].filter(Boolean).join(' · ')
          : 'Loading your role…'}
        {job?.manager ? ' · Manager: ' + job.manager : ''}
      </p>
      {!content?.responsibilities?.byDepartment?.[job?.department] && (
        <p className="fp-muted">
          Detailed responsibilities for your role have not been added yet (content requirement).
          Your manager confirms them with you; this checklist records that you did.
        </p>
      )}
      <div className="checklist-items">
        {items.map((item, i) => (
          <label key={item} className="checkbox-item">
            <input
              type="checkbox"
              disabled={saved}
              checked={saved || Boolean(checked[i])}
              onChange={(e) => setChecked({ ...checked, [i]: e.target.checked })}
            />
            <span>{item}</span>
          </label>
        ))}
      </div>
      {saved ? (
        <p className="learning-confirmed">
          ✓ Acknowledged on {new Date(record.acknowledgedAt).toLocaleDateString()}
        </p>
      ) : (
        <button
          className="fp-action main"
          disabled={busy || !all}
          onClick={async () => {
            const res = await run(() =>
              journeyApi.submitVerification('role-tools', 'responsibilities', {
                department: job?.department || '',
                checkedItems: Object.keys(checked).filter((k) => checked[k]),
              }),
            );
            if (res) onRecords(res.verifications);
          }}
        >
          {busy ? 'Saving…' : 'Save my checklist'}
        </button>
      )}
      {error && (
        <p role="alert" className="fp-inline-error">
          {error}
        </p>
      )}
    </div>
  );
}

// Area 3: tool access is proven by the onboarding coordinator, not by ticking a box.
export function ToolAccessWorkflow({ step, record, onRecords }) {
  const state = accessState(step, record);
  const [email, setEmail] = useState('');
  const { busy, error, run } = useSubmit();
  if (state === 'done')
    return <p className="learning-confirmed">✓ Access confirmed by your onboarding coordinator.</p>;
  if (state === 'awaiting')
    return (
      <div className="tool-access-workflow-box">
        <p role="status" className="learning-confirmed">
          ⏳ Confirmation requested for {record.workEmail}. Your onboarding coordinator will
          confirm; this task completes then. Nothing more to do unless you cannot open the tool, in
          which case ask them for the invitation.
        </p>
      </div>
    );
  return (
    <form
      className="tool-access-workflow-box workflow-form"
      onSubmit={async (event) => {
        event.preventDefault();
        const res = await run(() =>
          journeyApi.submitVerification('role-tools', 'tool-access', {
            workEmail: email,
            toolId: step.id,
          }),
        );
        if (res) onRecords(res.verifications);
      }}
    >
      <p>
        Try to open the tool first. Then enter the work or Google account you used, so your
        coordinator can confirm it. Ticking a box does not prove access, so this task stays open
        until they confirm.
      </p>
      <label>
        Account you use for this tool
        <input
          type="email"
          required
          maxLength={254}
          placeholder="name@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </label>
      <button className="fp-action main" type="submit" disabled={busy || !email}>
        {busy ? 'Sending…' : 'Request access confirmation'}
      </button>
      {error && (
        <p role="alert" className="fp-inline-error">
          {error}
        </p>
      )}
    </form>
  );
}

// "I know where to find help": a separate confirmation, never a quiz.
export function HelpConfirmation({ confirmedHelpAt, onRecords }) {
  const { busy, error, run } = useSubmit();
  return (
    <div className="help-confirmation">
      {confirmedHelpAt ? (
        <p className="learning-confirmed">
          ✓ You confirmed on {new Date(confirmedHelpAt).toLocaleDateString()} that you know where to
          find help.
        </p>
      ) : (
        <button
          type="button"
          className="fp-action main"
          disabled={busy}
          onClick={async () => {
            const res = await run(() =>
              journeyApi.submitVerification('team-support', 'confirm-help', {}),
            );
            if (res) onRecords(res.verifications);
          }}
        >
          {busy ? 'Saving…' : 'I know where to find help'}
        </button>
      )}
      {error && (
        <p role="alert" className="fp-inline-error">
          {error}
        </p>
      )}
    </div>
  );
}

// An area-level activity (no task of its own): its status and one primary button
// that opens the activity page.
export function ActivityLauncher({ title, status, done, label, onOpen }) {
  return (
    <section className="activity-card">
      <header>
        <strong>{title}</strong>
        <span className={'fp-badge ' + (done ? 'done' : '')}>{status}</span>
        <button type="button" className={'fp-action' + (done ? '' : ' main')} onClick={onOpen}>
          {done ? 'Review' : label}
        </button>
      </header>
    </section>
  );
}
