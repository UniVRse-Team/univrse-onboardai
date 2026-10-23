import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import Icon from './Icon';
import LearningArea from './LearningArea';
import CompanyDocuments, { useCompanyDocuments } from './CompanyDocuments';
import { documentsForArea, otherDocuments } from './company-documents-model.mjs';
import {
  learningAreas,
  focusLearningStep,
  focusStepKey,
  descriptionText,
  resourceLabel,
  taskResources,
} from './learning-area-model.mjs';
import CheckDialog from './CheckDialog';
import { journeyErrorMessage } from '../access/journey-errors.mjs';
import { journeyApi } from '../access/journey-api.mjs';
import {
  actionLabels,
  areaBadge,
  briefingStatus,
  isMainAction,
  areaSummary,
  optionalStepLabel,
  thresholdOf,
  findStep,
  firstDayRows,
  focusAfterStepAction,
  formatWhen,
  myRequestStatus,
  stepActions,
  stepErrorMessage,
  stepStatusLabel,
} from '../access/onboarding-view.mjs';
import { saveHandoff, stepAskHandoff } from '../access/support-flow.mjs';
import './footprint.css';
import {
  documentSectionStatus,
  documentStepState,
  documentTasks,
} from '../documents/document-steps.mjs';
import DashboardDocumentUpload, {
  DocumentSectionNotice,
  useDashboardDocuments,
} from '../documents/DashboardDocumentUpload';

function Ring({ percent }) {
  return (
    <div
      className="uv-progress-ring"
      role="progressbar"
      aria-label="Onboarding progress"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    >
      <svg viewBox="0 0 160 160" aria-hidden="true">
        <circle cx="80" cy="80" r="66" />
        <circle
          className="uv-ring-fill"
          cx="80"
          cy="80"
          r="66"
          pathLength="100"
          strokeDasharray={`${percent} 100`}
        />
      </svg>
      <div>
        <strong>
          {percent}
          <span>%</span>
        </strong>
        <small>YOUR PROGRESS</small>
      </div>
    </div>
  );
}

// A step's buttons. A required step starts with Ask Alya, which opens her
// briefing on her page (#66); once briefed, its completing action also shows
// here as a shortcut, beside "Briefing done".
function StepActions({ step, busy, onAction }) {
  const hintId = useId();
  const actions = stepActions(step);
  const done = briefingStatus(step);
  const submitting = actions.includes('submit');
  return (
    <>
      {done && (
        <span className="fp-briefed">
          <Icon name="check" size={12} />
          {done}
        </span>
      )}
      {actions.map((action) => (
        <button
          key={action}
          type="button"
          className={'fp-action' + (isMainAction(action, actions) ? ' main' : '')}
          disabled={busy}
          aria-label={`${actionLabels[action]}: ${step.title}`}
          aria-describedby={action === 'submit' ? hintId : undefined}
          data-step-action={`${step.id}:${action}`}
          onClick={() => onAction(step, action)}
        >
          {action === 'ask' && <Icon name="chat" size={14} />}
          {actionLabels[action]}
        </button>
      ))}
      {submitting && (
        <span className="fp-action-hint" id={hintId}>
          HR will verify it.
        </span>
      )}
    </>
  );
}

// The button that ran, while the step still offers it; else the step's badge.
function focusTarget(step, stepId, action) {
  const id = CSS.escape(stepId);
  const badge = `[data-step-status="${id}"]`;
  return focusAfterStepAction(step, action) === 'action'
    ? [`[data-step-action="${id}:${CSS.escape(action)}"]`, badge]
    : [badge];
}

// The signed-in employee's onboarding footprint (GET /api/me/onboarding).
export default function EmployeeFootprint({ navigate, chatPath, account, expanded = false }) {
  const documents = useDashboardDocuments();
  const companyDocuments = useCompanyDocuments();
  const [onboarding, setOnboarding] = useState(null);
  const [error, setError] = useState('');
  const [firstDay, setFirstDay] = useState(null);
  const [requests, setRequests] = useState(null);
  const [busyStep, setBusyStep] = useState('');
  const [stepErrors, setStepErrors] = useState({});
  const [check, setCheck] = useState(null);
  const [announce, setAnnounce] = useState('');
  const headingRef = useRef(null);
  const alive = useRef(true);
  // Selectors to try, in order, after the next render (a finished step action).
  const focusNext = useRef(null);
  useEffect(() => {
    if (!focusNext.current || busyStep) return;
    const selectors = focusNext.current;
    focusNext.current = null;
    for (const selector of selectors) {
      const target = document.querySelector(selector);
      if (target) return target.focus();
    }
  });

  const load = useCallback(async () => {
    try {
      const data = await journeyApi.onboarding();
      if (!alive.current) return;
      setOnboarding(data);
      setError('');
    } catch (err) {
      if (alive.current) setError(journeyErrorMessage(err));
    }
    journeyApi
      .firstDay()
      .then((data) => alive.current && setFirstDay(data))
      .catch(() => {});
    journeyApi
      .mySupportRequests()
      .then((data) => alive.current && setRequests(data.requests || []))
      .catch(() => {});
  }, []);
  // A task chosen in the checklist beside Alya opens here once progress has loaded.
  useEffect(() => {
    if (!onboarding) return;
    let id = null;
    try {
      id = window.sessionStorage.getItem(focusStepKey);
      if (id) window.sessionStorage.removeItem(focusStepKey);
    } catch {
      return;
    }
    if (id) setTimeout(() => focusLearningStep(id), 50);
  }, [!onboarding]);
  useEffect(() => {
    alive.current = true;
    load();
    const visible = () => {
      if (document.visibilityState === 'visible') load();
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      alive.current = false;
      document.removeEventListener('visibilitychange', visible);
    };
  }, [load]);

  async function run(step, action) {
    if (action === 'ask') {
      // A step with a briefing hands over that briefing; others, their question.
      const handoff = stepAskHandoff(step);
      if (handoff) saveHandoff(window.sessionStorage, handoff);
      navigate(chatPath);
      return;
    }
    if (action === 'check') {
      setCheck(step);
      return;
    }
    setBusyStep(step.id);
    setStepErrors((current) => ({ ...current, [step.id]: '' }));
    try {
      const undo = action === 'reopen' || action === 'withdraw';
      const next = undo
        ? await journeyApi.reopenStep(step.id)
        : await journeyApi.completeStep(step.id);
      if (!alive.current) return;
      setOnboarding(next);
      focusNext.current = focusTarget(findStep(next, step.id)?.step, step.id, action);
      setAnnounce(
        action === 'complete'
          ? `Marked “${step.title}” as completed.`
          : action === 'submit'
            ? `Marked “${step.title}” as submitted. HR will verify it.`
            : `Moved “${step.title}” back to to do.`,
      );
    } catch (err) {
      if (!alive.current) return;
      setStepErrors((current) => ({ ...current, [step.id]: stepErrorMessage(err) }));
      focusNext.current = focusTarget(step, step.id, action);
      if (['STEP_LOCKED', 'STEP_NOT_FOUND', 'BRIEFING_REQUIRED'].includes(err.code)) load();
    } finally {
      if (alive.current) setBusyStep('');
    }
  }

  if (error && !onboarding)
    return (
      <section className="fp" aria-labelledby="fp-title">
        <h1 id="fp-title">Your onboarding footprint.</h1>
        <div className="fp-inline-error" role="alert">
          <p>{error}</p>
          <button type="button" className="fp-action main" onClick={load}>
            Try again
          </button>
        </div>
      </section>
    );
  if (!onboarding)
    return (
      <section className="fp" aria-labelledby="fp-title" aria-busy="true">
        <h1 id="fp-title">Your onboarding footprint.</h1>
        <p role="status">Getting your steps ready…</p>
      </section>
    );

  const rows = firstDayRows(firstDay?.firstDay);
  const docStatus = documentSectionStatus(
    onboarding.areas.find((item) => item.id === 'documentation')?.steps || [],
    documents.submissions,
  );
  return (
    <section className="fp" aria-labelledby="fp-title">
      <header className="fp-hero">
        <div>
          <span className="uv-eyebrow">
            {account?.company?.name
              ? `${account.company.name.toUpperCase()} ONBOARDING FOOTPRINT`
              : 'YOUR ONBOARDING FOOTPRINT'}
          </span>
          <h1 id="fp-title" tabIndex={-1} ref={headingRef}>
            {onboarding.complete ? 'Onboarding complete.' : 'One step at a time.'}
          </h1>
          {onboarding.complete && (
            <p className="fp-complete">
              Onboarding complete. The remaining steps are still worth finishing when you can.
            </p>
          )}
          <div className="fp-hero-actions">
            <button type="button" className="uv-button primary" onClick={() => navigate(chatPath)}>
              Ask Alya
              <Icon name="arrow" size={18} />
            </button>
          </div>
        </div>
        <Ring percent={onboarding.percent} />
      </header>

      <div className="fp-live" role="status" aria-live="polite">
        {announce}
      </div>

      <div className="fp-areas">
        {onboarding.areas.map((area, index) =>
          learningAreas.includes(area.id) ? (
            <LearningArea
              key={area.id}
              area={area}
              onUpdated={setOnboarding}
              firstDay={firstDay}
              expanded={expanded}
              navigate={navigate}
              companyDocuments={companyDocuments}
            />
          ) : (
            <details className="fp-area" key={area.id} open={expanded || index === 0 || undefined}>
              <summary>
                <span className="fp-area-title">
                  <span className="fp-area-number" aria-hidden="true">
                    {area.icon || '0' + (index + 1)}
                  </span>
                  <span>
                    <strong>{area.title}</strong>
                    <small>
                      {area.id === 'documentation'
                        ? documentSectionStatus(area.steps, documents.submissions).text
                        : areaSummary(area)}
                    </small>
                    {(area.id === 'documentation'
                      ? documentSectionStatus(area.steps, documents.submissions).completed &&
                        'Completed'
                      : areaBadge(area, onboarding)) && (
                      <span className="fp-badge done">
                        <Icon name="check" size={12} />
                        {area.id === 'documentation' ? 'Completed' : areaBadge(area, onboarding)}
                      </span>
                    )}
                  </span>
                </span>
                <span
                  className="fp-bar"
                  role="progressbar"
                  aria-label={`${area.title} progress`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={area.percent}
                >
                  <span style={{ width: area.percent + '%' }} />
                  <i
                    className="fp-marker"
                    style={{ left: thresholdOf(onboarding) + '%' }}
                    title={thresholdOf(onboarding) + '% marker'}
                  />
                </span>
                <span className="fp-percent">{area.percent}%</span>
                <Icon name="down" size={15} />
              </summary>
              {area.description && <p className="fp-area-description">{area.description}</p>}
              {area.id === 'documentation' && <DocumentSectionNotice documents={documents} />}
              {area.id === 'documentation' &&
                (() => {
                  const status = documentSectionStatus(area.steps, documents.submissions);
                  return status.completed ? (
                    <p className="fp-doc-complete" role="status">
                      ✓ {status.completionMessage}
                    </p>
                  ) : null;
                })()}
              {area.id === 'documentation' && (
                <CompanyDocuments
                  documents={documentsForArea(companyDocuments.documents, area.id)}
                />
              )}
              <ul className="fp-steps">
                {area.steps.map((step) => (
                  <li
                    key={step.id}
                    id={'learning-' + step.id}
                    tabIndex={-1}
                    className={
                      'fp-step ' +
                      step.status +
                      (area.id === 'documentation' && step.id === docStatus.nextStepId
                        ? ' is-current'
                        : '')
                    }
                  >
                    <div className="fp-step-copy">
                      <strong>{step.title}</strong>
                      {descriptionText(step) && <p>{descriptionText(step)}</p>}
                      {taskResources(step).map((url) => (
                        <a
                          key={url}
                          className="fp-action"
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {resourceLabel(step, url)}
                        </a>
                      ))}
                      {optionalStepLabel(step) && (
                        <p className="fp-optional">{optionalStepLabel(step)}</p>
                      )}
                      {/* A Documentation task shows its one status inside its own card below. */}
                      {area.id !== 'documentation' && (
                        <span
                          className={'fp-badge ' + step.status}
                          tabIndex={-1}
                          data-step-status={step.id}
                        >
                          {step.status === 'done' && <Icon name="check" size={12} />}
                          {stepStatusLabel(step)}
                        </span>
                      )}
                    </div>
                    <div className="fp-step-actions">
                      <StepActions step={step} busy={busyStep === step.id} onAction={run} />
                    </div>
                    {area.id === 'documentation' && (
                      <DashboardDocumentUpload
                        step={step}
                        documents={documents}
                        onSaved={load}
                        isNext={docStatus.nextStepId === step.id}
                        locked={Boolean(
                          documentTasks(area.steps, documents.submissions).find(
                            (task) => task.step.id === step.id,
                          )?.locked,
                        )}
                      />
                    )}
                    {stepErrors[step.id] && (
                      <p className="fp-inline-error" role="alert">
                        {stepErrors[step.id]}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          ),
        )}
      </div>
      {otherDocuments(companyDocuments.documents).length > 0 && (
        <div className="fp-other-documents">
          <CompanyDocuments
            title="Other company documents"
            documents={otherDocuments(companyDocuments.documents)}
          />
        </div>
      )}

      <div className="fp-cards">
        {rows && (
          <section className="fp-card" aria-labelledby="fp-first-day">
            <span className="uv-mini-label">FROM HR</span>
            <h2 id="fp-first-day">Your first day</h2>
            {firstDay?.startDate && (
              <p className="fp-muted">Starts {formatDay(firstDay.startDate)}</p>
            )}
            <dl>
              {rows.map((row) => (
                <div key={row.label}>
                  <dt>{row.label}</dt>
                  <dd>{row.value}</dd>
                </div>
              ))}
            </dl>
          </section>
        )}
        <section className="fp-card" aria-labelledby="fp-requests">
          <span className="uv-mini-label">SUPPORT</span>
          <h2 id="fp-requests">Your requests to HR</h2>
          {requests === null ? (
            <p className="fp-muted" role="status">
              Loading…
            </p>
          ) : requests.length ? (
            <ul className="fp-requests">
              {requests.map((request) => (
                <li key={request.id}>
                  <strong>{request.question}</strong>
                  <span className="fp-badge">{myRequestStatus(request)}</span>
                  <small>Sent {formatWhen(request.createdAt)}</small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="fp-muted">
              Nothing sent yet. If Alya can’t help, you can choose to ask HR from the chat. You see
              exactly what is shared first.
            </p>
          )}
        </section>
      </div>
      {check && (
        <CheckDialog
          step={check}
          onClose={() => setCheck(null)}
          onPassed={(next) => {
            if (next) setOnboarding(next);
            setAnnounce(`Check passed. “${check.title}” is done.`);
          }}
        />
      )}
    </section>
  );
}

function formatDay(value) {
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? value + 'T00:00:00Z' : value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}
