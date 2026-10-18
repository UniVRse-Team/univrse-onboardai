import React, { useCallback, useEffect, useState } from 'react';
import Icon from './Icon';
import { journeyApi } from '../access/journey-api.mjs';
import { accountApi } from '../access/account-api.mjs';
import {
  ActivityLauncher,
  PolicyDocumentButton,
  ToolAccessWorkflow,
  VerificationGuide,
} from './LearningActivities';
import { saveHandoff, stepAskHandoff } from '../access/support-flow.mjs';
import { RESPONSIBILITIES_ACTIVITY, activityPath } from './activity-model.mjs';
import {
  learningSummary,
  primaryAction,
  quizStage,
  taskStatusLabel,
  describeLoadError,
  taskResources,
  descriptionText,
  resourceLabel,
} from './learning-area-model.mjs';
import './learning-areas.css';

function LearningTask({
  step,
  areaId,
  content,
  contentState,
  records,
  onRecords,
  onUpdated,
  navigate,
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const ai = step.id === 'role-tools.ai-readiness-training';
  const accessSteps = content?.toolAccessSteps || [];
  const access = areaId === 'role-tools' && accessSteps.includes(step.id);
  const verified = areaId === 'policies' || areaId === 'alignment';
  const tool = records?.roleTools?.tools?.[step.id];
  const slug = step.id.replace('alignment.', '');
  const policyRecord = records?.policies?.[step.id];
  const alignRecord = records?.alignment?.[slug];
  // Work that has begun (an acknowledgement or an attempt) reads "In Progress".
  const started = Boolean(
    policyRecord?.acknowledgedAt || policyRecord?.quiz?.attempts || alignRecord?.attempts,
  );
  const quiz = quizStage({
    record: areaId === 'policies' ? policyRecord?.quiz : alignRecord,
    session:
      records?.sessions?.[areaId === 'policies' ? `policies/${step.id}` : `alignment/${slug}`],
  });
  const shown = started && !step.briefed ? { ...step, briefed: true } : step;
  // Without the served content we cannot tell an access step from a plain setup
  // step, so no button is offered rather than a wrong one.
  const unknownKind = areaId === 'role-tools' && !content && !ai;
  const primary = unknownKind
    ? null
    : primaryAction(shown, areaId, {
        accessStepIds: accessSteps,
        hasQuiz: Boolean(content?.policies?.[step.id]?.quiz),
        acknowledged: Boolean(policyRecord?.acknowledgedAt),
        quiz,
        tool,
      });

  // Alya opens on this task: its briefing or question is handed over, as on the Documentation tasks.
  function askAlya() {
    const handoff = stepAskHandoff(step);
    if (handoff) saveHandoff(window.sessionStorage, handoff);
    navigate('/alya');
  }

  async function run(task, success) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const updated = await task();
      if (updated) onUpdated(updated);
      if (success) setMessage(success);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const confirmSetup = () =>
    run(async () => {
      if (step.briefingRequired && !step.briefed) await journeyApi.recordBriefing(step.id, 'read');
      return journeyApi.completeStep(step.id);
    }, 'Saved as employee-confirmed. This is your own confirmation; nothing was checked by a system.');

  return (
    <details className="learning-task" id={'learning-' + step.id}>
      <summary>
        <span>
          <small>
            {step.required === false ? 'OPTIONAL · DOES NOT AFFECT PROGRESS' : 'REQUIRED'}
          </small>
          <strong>{step.title}</strong>
        </span>
        <span className={'fp-badge ' + (step.status === 'done' ? 'done' : '')}>
          {taskStatusLabel(shown, areaId, accessSteps, tool)}
        </span>
        <Icon name="down" size={15} />
      </summary>
      <div className="learning-task-body">
        <p>{descriptionText(step)}</p>
        <VerificationGuide step={step} areaId={areaId} accessStepIds={accessSteps} />
        {step.briefing && (
          <section className="learning-resource">
            <h4>Read the essentials</h4>
            <p>{step.briefing.text}</p>
            {step.briefing.sourceTitle && (
              <details>
                <summary>View resource information</summary>
                <p>Source: {step.briefing.sourceTitle}</p>
                <p>
                  This is the summary provided by your existing onboarding plan. A full document
                  link has not been supplied here; ask your onboarding coordinator for the current
                  resource.
                </p>
              </details>
            )}
          </section>
        )}
        {taskResources(step).map((url) => (
          <a className="fp-action" key={url} href={url} target="_blank" rel="noopener noreferrer">
            {resourceLabel(step, url)}
          </a>
        ))}
        {areaId === 'role-tools' && !ai && !access && (
          <p className="fp-muted">
            Confirm completion only after you have tried the required access or setup yourself. This
            is your own confirmation; it does not provision or independently verify tool access.
          </p>
        )}
        {areaId === 'team-support' && step.id.includes('personality') && (
          <p className="fp-muted">
            No personality results or sensitive information are collected here. Confirm with HR
            whether this activity applies to you.
          </p>
        )}
        {access && tool && <ToolAccessWorkflow step={step} record={tool} onRecords={onRecords} />}
        {unknownKind && contentState?.status === 'error' && (
          <div role="alert" className="fp-inline-error">
            <p>{contentState.message}</p>
            <button type="button" className="fp-action" onClick={contentState.retry}>
              Try again
            </button>
          </div>
        )}
        {unknownKind && contentState?.status === 'loading' && (
          <p role="status" className="fp-muted">
            Loading this task…
          </p>
        )}
        <div className="activity-actions">
          {areaId === 'policies' && (
            <PolicyDocumentButton
              stepId={step.id}
              document={content?.policies?.[step.id]?.document}
            />
          )}
          {primary && (
            <button
              type="button"
              className={'fp-action' + (primary.quiet ? '' : ' main')}
              disabled={busy}
              onClick={
                primary.mode === 'confirm' ? confirmSetup : () => navigate(activityPath(step.id))
              }
            >
              {busy ? 'Saving…' : primary.label}
            </button>
          )}
          <button type="button" className="fp-action" onClick={askAlya}>
            <Icon name="chat" size={14} /> Ask Alya
          </button>
        </div>
        {step.status === 'done' && (
          <p className="learning-confirmed">
            ✓ {access ? 'Verified by your coordinator.' : 'Completed.'} You can review this
            information whenever you need it.
          </p>
        )}
        {!verified &&
          !access &&
          step.id !== 'team-support.working-preferences' &&
          !ai &&
          step.status === 'done' &&
          step.completion === 'self' && (
            <button
              className="fp-action"
              disabled={busy}
              onClick={() => run(() => journeyApi.reopenStep(step.id), 'Task reopened.')}
            >
              Reopen task
            </button>
          )}
        {error && (
          <p role="alert" className="fp-inline-error">
            {error}
          </p>
        )}
        {message && <p role="status">{message}</p>}
      </div>
    </details>
  );
}

export default function LearningArea({ area, onUpdated, firstDay, expanded, navigate }) {
  const summary = learningSummary(area);
  const [profile, setProfile] = useState(null),
    [profileError, setProfileError] = useState(''),
    [content, setContent] = useState(null),
    [records, setRecords] = useState({}),
    [contentState, setContentState] = useState({ status: 'loading' });
  const loadVerification = useCallback(async () => {
    setContentState({ status: 'loading' });
    try {
      const [material, saved] = await Promise.all([
        journeyApi.getPolicyHandbook(),
        journeyApi.getVerifications(),
      ]);
      setContent(material);
      setRecords(saved.verifications || {});
      setContentState({ status: 'ready' });
    } catch (e) {
      setContentState({ status: 'error', message: describeLoadError(e) });
    }
  }, []);
  useEffect(() => {
    loadVerification();
  }, [loadVerification]);
  const stateWithRetry = { ...contentState, retry: loadVerification };
  useEffect(() => {
    if (area.id === 'policies') return;
    const abort = new AbortController();
    accountApi
      .myProfile({ signal: abort.signal })
      .then((data) => setProfile(data.profile))
      .catch((e) => {
        if (e.name !== 'AbortError')
          setProfileError(
            'Your profile could not be loaded. Ask HR to confirm your assigned role and contacts.',
          );
      });
    return () => abort.abort();
  }, [area.id]);
  const job = profile?.job;
  return (
    <details className="fp-area learning-area" open={expanded || undefined}>
      <summary>
        <span className="fp-area-title">
          <span className="fp-area-number" aria-hidden="true">
            {area.icon}
          </span>
          <span>
            <strong>{area.title}</strong>
            <small>
              {summary.done} of {summary.total} required tasks completed
            </small>
          </span>
        </span>
        <span
          className="fp-bar"
          role="progressbar"
          aria-label={area.title + ' progress'}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={area.percent}
        >
          <span style={{ width: area.percent + '%' }} />
        </span>
        <span className="fp-percent">{area.percent}%</span>
        <Icon name="down" size={15} />
      </summary>
      <div className="learning-area-content">
        <div className="learning-intro">
          <p>{descriptionText(area)}</p>
          {taskResources(area).map((url) => (
            <a key={url} className="fp-action" href={url} target="_blank" rel="noopener noreferrer">
              Open the guide ↗
            </a>
          ))}
        </div>
        {!summary.next && (
          <p className="learning-confirmed" role="status">
            All required tasks in this area are complete. Optional activities do not affect your
            progress.
          </p>
        )}
        {profileError && <p role="alert">{profileError}</p>}
        {area.id === 'team-support' && (
          <div className="learning-columns learning-contacts">
            <article>
              <small>YOUR MANAGER · EMPLOYEE PROFILE</small>
              <h4>{job?.manager || 'Not assigned yet'}</h4>
              <p>
                Use your existing team channel to get in touch. No direct contact link is configured
                here.
              </p>
            </article>
            <article>
              <small>FIRST-DAY CONTACT · PROVIDED BY HR</small>
              <h4>{firstDay?.firstDay?.hostName || 'Not assigned yet'}</h4>
              <p>
                {firstDay?.firstDay?.hostContact || 'Ask HR to confirm your onboarding contact.'}
              </p>
              {firstDay?.firstDay?.notes && <p>{firstDay.firstDay.notes}</p>}
            </article>
          </div>
        )}
        {contentState.status === 'error' && (
          <div role="alert" className="fp-inline-error">
            <p>{contentState.message}</p>
            <button type="button" className="fp-action" onClick={loadVerification}>
              Try again
            </button>
          </div>
        )}
        {contentState.status === 'loading' &&
          (area.id === 'role-tools' || area.id === 'team-support') && (
            <p role="status" className="fp-muted">
              Loading activities…
            </p>
          )}
        {area.id === 'role-tools' && content && (
          <ActivityLauncher
            id={'learning-' + RESPONSIBILITIES_ACTIVITY}
            title="Roles & Responsibilities"
            done={Boolean(records.roleTools?.responsibilities?.acknowledgedAt)}
            status={
              records.roleTools?.responsibilities?.acknowledgedAt ? 'Acknowledged' : 'Not Started'
            }
            label="Complete Checklist"
            onOpen={() => navigate(activityPath(RESPONSIBILITIES_ACTIVITY))}
          />
        )}
        {area.id === 'team-support' && (
          <>
            {content?.verifiedDirectory?.contacts?.length > 0 && (
              <div className="support-channels-directory">
                {content.verifiedDirectory.contacts.map((contact) => (
                  <div key={contact.name} className="channel-card">
                    <small>{contact.name.toUpperCase()}</small>
                    {contact.email && <strong>{contact.email}</strong>}
                    <p>{contact.purpose}</p>
                  </div>
                ))}
              </div>
            )}
            <p className="fp-muted">
              Chat-group invitations come from your onboarding coordinator. Further team contacts
              have not been added yet (content requirement). Your requests to HR are listed below.
            </p>
          </>
        )}
        {area.steps.map((step) => (
          <LearningTask
            key={step.id}
            step={step}
            areaId={area.id}
            content={content}
            contentState={stateWithRetry}
            records={records}
            onRecords={setRecords}
            onUpdated={onUpdated}
            navigate={navigate}
          />
        ))}
      </div>
    </details>
  );
}
