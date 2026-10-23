import React, { useCallback, useEffect, useRef, useState } from 'react';
import CheckForm from './CheckForm';
import QuizRunner from './QuizRunner';
import { useCompanyDocuments } from './CompanyDocuments';
import { policyButtonTarget } from './company-documents-model.mjs';
import { journeyApi } from '../access/journey-api.mjs';
import { accountApi } from '../access/account-api.mjs';
import {
  AiReadiness,
  HelpConfirmation,
  PolicyDocumentButton,
  RoleResponsibilitiesChecklist,
  ToolAccessWorkflow,
  WorkingPreferences,
} from './LearningActivities';
import { activityStatus, resolveActivity } from './activity-model.mjs';
import {
  describeLoadError,
  focusStepKey,
  policyDocumentLabel,
  quizStage,
} from './learning-area-model.mjs';
import './learning-areas.css';
import './activity-page.css';

// A dedicated page for one onboarding activity, inside the existing employee
// shell (/onboarding/activity/<id>). It loads the saved onboarding, the served
// content and the saved records, so it works when opened directly or refreshed.
export default function ActivityPage({ activityId, navigate }) {
  const [state, setState] = useState({ status: 'loading' });
  const [data, setData] = useState({ onboarding: null, content: null, records: {}, profile: null });
  const [passedCheck, setPassedCheck] = useState(false);
  const companyDocuments = useCompanyDocuments().documents;
  const guard = useRef(null);

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const [onboarding, content, saved] = await Promise.all([
        journeyApi.onboarding(),
        journeyApi.getPolicyHandbook(),
        journeyApi.getVerifications(),
      ]);
      let profile = null;
      if (activityId === 'role-tools.responsibilities') {
        try {
          profile = (await accountApi.myProfile()).profile;
        } catch {
          profile = null;
        }
      }
      setData({ onboarding, content, records: saved.verifications || {}, profile });
      setState({ status: 'ready' });
    } catch (e) {
      setState({ status: 'error', message: describeLoadError(e) });
    }
  }, [activityId]);
  useEffect(() => {
    load();
  }, [load]);

  const activity =
    state.status === 'ready' ? resolveActivity(activityId, data.onboarding, data.content) : null;
  useEffect(() => {
    document.title = (activity?.title || 'Activity') + ' · Onboard.AI';
  }, [activity?.title]);

  const setRecords = (records) => setData((current) => ({ ...current, records }));
  const setOnboarding = (onboarding) => setData((current) => ({ ...current, onboarding }));
  function back() {
    if (guard.current && !guard.current()) return;
    try {
      if (activity?.step) window.sessionStorage.setItem(focusStepKey, activity.step.id);
    } catch {
      // Without storage the onboarding page simply opens at the top.
    }
    navigate('/onboarding');
  }

  if (state.status === 'loading')
    return (
      <div className="ap2-page">
        <p role="status">Loading this activity…</p>
      </div>
    );
  if (state.status === 'error')
    return (
      <div className="ap2-page">
        <div role="alert" className="fp-inline-error">
          <p>{state.message}</p>
          <button type="button" className="fp-action" onClick={load}>
            Try again
          </button>
          <button type="button" className="fp-action" onClick={() => navigate('/onboarding')}>
            Back to onboarding
          </button>
        </div>
      </div>
    );
  if (!activity)
    return (
      <div className="ap2-page">
        <h1>Activity not found</h1>
        <p>This activity does not exist or is not part of your onboarding.</p>
        <button type="button" className="fp-action main" onClick={() => navigate('/onboarding')}>
          Back to onboarding
        </button>
      </div>
    );

  const { records, content, profile } = data;
  const status = activityStatus(activity, records);
  const step = activity.step;
  const draft = records.drafts?.[`${activity.area}/${activity.activityKey}`];

  return (
    <div className="ap2-page">
      <nav className="ap2-crumbs" aria-label="Breadcrumb">
        <button type="button" className="fp-action" onClick={back}>
          ← Back to onboarding
        </button>
      </nav>
      <header className="ap2-head">
        <small>{activity.areaTitle.toUpperCase()}</small>
        <h1>{activity.title}</h1>
        <div className="ap2-badges">
          <span
            className={
              'verification-badge ' + (activity.mandatory ? 'info-badge' : 'optional-badge')
            }
          >
            {activity.mandatory ? 'REQUIRED' : 'OPTIONAL'}
          </span>
          <span
            className={
              'fp-badge ' + (status === 'Completed' || status === 'Verified' ? 'done' : '')
            }
          >
            {status}
          </span>
        </div>
        {activity.instructions && <p>{activity.instructions}</p>}
        {activity.objectives.length > 0 && (
          <ul className="ap2-objectives" aria-label="What you will learn">
            {activity.objectives.map((o) => (
              <li key={o}>{o}</li>
            ))}
          </ul>
        )}
        {activity.requirement && (
          <p className="ap2-requirement">
            <strong>To complete:</strong> {activity.requirement}
          </p>
        )}
      </header>

      <ActivityBody
        key={activity.id}
        activity={activity}
        records={records}
        content={content}
        profile={profile}
        draft={draft}
        passedCheck={passedCheck}
        onPassedCheck={() => setPassedCheck(true)}
        setRecords={setRecords}
        setOnboarding={setOnboarding}
        back={back}
        registerGuard={(fn) => (guard.current = fn)}
        initialNotes={draft?.notes || ''}
        companyDocuments={companyDocuments}
      />

      {step?.status === 'done' && activity.kind !== 'quiz' && activity.kind !== 'policy' && (
        <div className="ap2-done">
          <p className="learning-confirmed">✓ {status}.</p>
          <button type="button" className="fp-action main" onClick={back}>
            Back to onboarding
          </button>
        </div>
      )}
    </div>
  );
}

function ActivityBody({
  activity,
  records,
  content,
  profile,
  draft,
  passedCheck,
  onPassedCheck,
  setRecords,
  setOnboarding,
  back,
  registerGuard,
  initialNotes,
  companyDocuments,
}) {
  const [notes, setNotes] = useState(initialNotes);
  const [ackBusy, setAckBusy] = useState(false);
  const [ackError, setAckError] = useState('');
  const [quizStarted, setQuizStarted] = useState(
    () => activity.kind !== 'policy' || Boolean(records.sessions?.[`policies/${activity.id}`]),
  );
  const { kind, step } = activity;
  const policyTarget = activity.policy
    ? policyButtonTarget({
        stepId: step?.id,
        document: activity.policy.document,
        documents: companyDocuments,
      })
    : null;

  if (kind === 'policy' || kind === 'quiz') {
    const policyRecord = kind === 'policy' ? records.policies?.[activity.id] : null;
    const record =
      kind === 'policy'
        ? policyRecord?.quiz
        : activity.area === 'team-support'
          ? records.teamSupport?.routing
          : records.alignment?.[activity.activityKey];
    const passed = step
      ? step.status === 'done' || Boolean(record?.passed)
      : Boolean(record?.passed);

    if (kind === 'policy') {
      if (!activity.policy)
        return (
          <p role="status" className="fp-muted">
            No approved activity has been configured for this policy yet (content requirement). Ask
            HR to add it.
          </p>
        );
      if (!activity.policy.quiz && !policyRecord?.acknowledgedAt && step.status !== 'done')
        return (
          <section className="qr-card">
            <h2>Read the policy</h2>
            <p>{step.briefing?.text}</p>
            <p className="fp-muted">Source: {activity.policy.sourceTitle}.</p>
            {policyTarget ? (
              <a
                className="fp-action"
                href={
                  policyTarget.kind === 'uploaded' ? policyTarget.url : policyTarget.document.url
                }
                target="_blank"
                rel="noopener noreferrer"
              >
                {policyTarget.kind === 'uploaded'
                  ? policyTarget.label
                  : policyDocumentLabel(step.id, policyTarget.document)}
              </a>
            ) : (
              <p className="fp-muted">
                The full policy document has not been linked yet (content requirement); the summary
                above is the approved text from your onboarding plan.
              </p>
            )}
            <p>Acknowledging completes this task.</p>
            {ackError && (
              <p role="alert" className="fp-inline-error">
                {ackError}
              </p>
            )}
            <div className="qr-actions">
              <button type="button" className="fp-action" onClick={back}>
                Back to onboarding
              </button>
              <button
                type="button"
                className="fp-action main"
                disabled={ackBusy}
                onClick={async () => {
                  setAckBusy(true);
                  setAckError('');
                  try {
                    const res = await journeyApi.submitVerification('policies', activity.id, {
                      action: 'acknowledge',
                    });
                    setRecords(res.verifications);
                    if (res.onboarding) setOnboarding(res.onboarding);
                  } catch (e) {
                    setAckError(e.message);
                  } finally {
                    setAckBusy(false);
                  }
                }}
              >
                {ackBusy ? 'Saving…' : 'Read and Confirm Acknowledgement'}
              </button>
            </div>
          </section>
        );
      if (activity.policy.quiz && !quizStarted && !(step.status === 'done' && !policyRecord?.quiz))
        return (
          <section className="qr-card">
            <h2>{activity.policy.title}</h2>
            <p>{step.briefing?.text}</p>
            <p className="fp-muted">Source: {activity.policy.sourceTitle}.</p>
            {!policyTarget && (
              <p className="fp-muted">
                The full document has not been linked yet (content requirement); the summary above
                is the approved text from your onboarding plan.
              </p>
            )}
            <div className="qr-actions">
              <PolicyDocumentButton
                stepId={step.id}
                document={activity.policy.document}
                companyDocuments={companyDocuments}
              />
              <button type="button" className="fp-action main" onClick={() => setQuizStarted(true)}>
                {passed ? 'Practise Quiz' : record?.attempts ? 'Retry Quiz' : 'Start Quiz'}
              </button>
              <button type="button" className="fp-action" onClick={back}>
                Back to onboarding
              </button>
            </div>
          </section>
        );
      if (!activity.policy.quiz)
        return (
          <div className="ap2-done">
            <p className="learning-confirmed">
              ✓ Acknowledged on {new Date(policyRecord.acknowledgedAt).toLocaleDateString()}. No
              quiz is configured for this policy.
            </p>
            <button type="button" className="fp-action main" onClick={back}>
              Back to onboarding
            </button>
          </div>
        );
    }

    const area = activity.area;
    const key = activity.activityKey;
    return (
      <QuizRunner
        key={activity.id}
        questions={activity.questions}
        passingScore={activity.passingScore}
        session={records.sessions?.[`${area}/${key}`] || null}
        alreadyPassed={passed && !records.sessions?.[`${area}/${key}`]}
        summary={
          record
            ? `Best score ${record.score}% after ${record.attempts} attempt${record.attempts === 1 ? '' : 's'}.`
            : null
        }
        // Each answer is checked and locked by the server, then its feedback shows.
        onAnswer={(questionId, answer) =>
          journeyApi.submitVerification(area, key, { action: 'answer', questionId, answer })
        }
        // The server grades the locked answers; the score and pass are its result.
        onFinish={async () => {
          const res = await journeyApi.submitVerification(area, key, { action: 'finish', notes });
          setRecords(res.verifications);
          if (res.onboarding) setOnboarding(res.onboarding);
          return res;
        }}
        onExit={back}
        registerGuard={registerGuard}
      >
        {activity.notesPrompt && (
          <label className="ap2-notes">
            {activity.notesPrompt}
            <textarea
              rows={3}
              maxLength={600}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </label>
        )}
        {activity.area === 'team-support' && (
          <HelpConfirmation
            confirmedHelpAt={records.teamSupport?.confirmedHelpAt}
            onRecords={setRecords}
          />
        )}
      </QuizRunner>
    );
  }

  if (kind === 'access')
    return (
      <section className="qr-card">
        <ToolAccessWorkflow
          step={step}
          record={records.roleTools?.tools?.[activity.id]}
          onRecords={setRecords}
        />
        <div className="qr-actions">
          <button type="button" className="fp-action" onClick={back}>
            Back to onboarding
          </button>
        </div>
      </section>
    );
  if (kind === 'ai')
    return (
      <section className="qr-card">
        <AiReadiness onUpdated={setOnboarding} />
        <div className="qr-actions">
          <button type="button" className="fp-action main" onClick={back}>
            Back to onboarding
          </button>
        </div>
      </section>
    );
  if (kind === 'check')
    return (
      <section className="qr-card">
        {step.status === 'done' || passedCheck ? (
          <p className="learning-confirmed">✓ Passed. This task is complete.</p>
        ) : (
          <CheckForm
            step={step}
            onCancel={back}
            onPassed={(next) => {
              if (next) setOnboarding(next);
              onPassedCheck();
            }}
          />
        )}
        <div className="qr-actions">
          <button type="button" className="fp-action main" onClick={back}>
            Back to onboarding
          </button>
        </div>
      </section>
    );
  if (kind === 'checklist')
    return (
      <section className="qr-card">
        <RoleResponsibilitiesChecklist
          profile={profile}
          content={content}
          record={records.roleTools?.responsibilities}
          onRecords={setRecords}
        />
        <div className="qr-actions">
          <button type="button" className="fp-action" onClick={back}>
            Back to onboarding
          </button>
        </div>
      </section>
    );
  if (kind === 'prefs')
    return (
      <section className="qr-card">
        <WorkingPreferences
          record={records.teamSupport?.workingPreferences}
          onRecords={setRecords}
        />
        <div className="qr-actions">
          <button type="button" className="fp-action" onClick={back}>
            Back to onboarding
          </button>
        </div>
      </section>
    );
  return null;
}
