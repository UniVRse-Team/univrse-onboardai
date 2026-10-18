import React, { useEffect, useId, useRef, useState } from 'react';
import { journeyApi } from './journey-api.mjs';
import {
  countsView,
  filterRequests,
  hrNoteMax,
  requestFilters,
  requestPatch,
  requestSourceTitles,
  requestStatuses,
  requestToForm,
  requestUpdateError,
  statusLabel,
} from './hr-journey.mjs';
import { formatWhen } from './onboarding-view.mjs';

// One support request an employee chose to send, with HR's follow-up controls.
function RequestCard({ request, onSaved }) {
  const id = useId();
  const [form, setForm] = useState(() => requestToForm(request));
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState({});
  const [summary, setSummary] = useState('');
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  // A refresh from the server never overwrites what HR is typing.
  useEffect(() => {
    if (!dirty) setForm(requestToForm(request));
  }, [request.updatedAt]);
  const titles = requestSourceTitles(request);
  const change = (patch) => {
    setForm((current) => ({ ...current, ...patch }));
    setDirty(true);
    setSaved('');
  };
  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    const { errors: found, patch } = requestPatch(request, form);
    setErrors(found);
    setSummary('');
    if (Object.keys(found).length) return;
    if (!Object.keys(patch).length) {
      setSaved('Nothing to save. No changes were made.');
      return;
    }
    setBusy(true);
    try {
      const data = await journeyApi.updateSupportRequest(request.id, patch);
      if (!alive.current) return;
      setDirty(false);
      setForm(requestToForm(data.request));
      setSaved('Saved.');
      onSaved(data.request);
    } catch (error) {
      if (alive.current) setSummary(requestUpdateError(error));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const name = request.employee?.name || request.employee?.username || 'Employee';
  return (
    <article className="hrj-request" aria-labelledby={id + '-name'}>
      <header>
        <div>
          <h3 id={id + '-name'}>{name}</h3>
          <small>
            {request.employee?.username} · sent {formatWhen(request.createdAt)}
            {request.assignedHr?.username ? ` · Assigned to ${request.assignedHr.username}` : ''}
          </small>
        </div>
        <span className={'hrj-status ' + request.status}>{statusLabel(request.status)}</span>
      </header>
      <dl className="hrj-thread">
        {request.assignedHr?.username && (
          <div>
            <dt>Assigned HR</dt>
            <dd>{request.assignedHr.username}</dd>
          </div>
        )}
        <div>
          <dt>Question</dt>
          <dd>{request.question}</dd>
        </div>
        <div>
          <dt>Alya’s answer</dt>
          <dd>{request.alyaAnswer}</dd>
        </div>
        <div>
          <dt>Sources</dt>
          <dd>
            {request.sources?.length ? (
              <ul>
                {request.sources.map((source, index) => (
                  <li key={index}>
                    {source.title}
                    {source.heading && source.heading !== source.title
                      ? ` — ${source.heading}`
                      : ''}
                  </li>
                ))}
              </ul>
            ) : (
              'No company sources were used.'
            )}
          </dd>
        </div>
        {request.employeeNote && (
          <div>
            <dt>Employee’s note</dt>
            <dd>{request.employeeNote}</dd>
          </div>
        )}
      </dl>
      <form className="hrj-form" onSubmit={submit} noValidate>
        <div className="hrj-field">
          <label htmlFor={id + '-status'}>Status</label>
          <select
            id={id + '-status'}
            value={form.status}
            onChange={(event) => change({ status: event.target.value })}
          >
            {requestStatuses.map((status) => (
              <option key={status.value} value={status.value}>
                {status.label}
              </option>
            ))}
          </select>
        </div>
        <fieldset className="hrj-field hrj-briefing" aria-describedby={id + '-briefing-error'}>
          <legend>
            Briefing
            {form.status === 'briefing_scheduled' && (
              <span className="hrj-required"> (required)</span>
            )}
          </legend>
          <div>
            <label htmlFor={id + '-date'}>Date</label>
            <input
              id={id + '-date'}
              type="date"
              value={form.briefingDate}
              aria-invalid={errors.briefing ? true : undefined}
              onChange={(event) => change({ briefingDate: event.target.value })}
            />
          </div>
          <div>
            <label htmlFor={id + '-time'}>Time</label>
            <input
              id={id + '-time'}
              type="time"
              value={form.briefingTime}
              aria-invalid={errors.briefing ? true : undefined}
              onChange={(event) => change({ briefingTime: event.target.value })}
            />
          </div>
          <p className="hrj-error" id={id + '-briefing-error'}>
            {errors.briefing}
          </p>
        </fieldset>
        <div className="hrj-field hrj-wide">
          <label htmlFor={id + '-note'}>Note for HR (the employee does not see it)</label>
          <textarea
            id={id + '-note'}
            rows={2}
            value={form.hrNote}
            aria-invalid={errors.hrNote ? true : undefined}
            aria-describedby={id + '-note-count'}
            onChange={(event) => change({ hrNote: event.target.value })}
          />
          <p className={errors.hrNote ? 'hrj-error' : 'hrj-hint'} id={id + '-note-count'}>
            {errors.hrNote || `${[...form.hrNote].length} / ${hrNoteMax}`}
          </p>
        </div>
        <div className="hrj-field hrj-wide hrj-doc">
          <label className="hrj-check">
            <input
              type="checkbox"
              checked={form.docNeedsUpdate}
              onChange={(event) =>
                change({
                  docNeedsUpdate: event.target.checked,
                  docToUpdate: event.target.checked ? form.docToUpdate || titles[0] || '' : '',
                })
              }
            />
            Doc needs update
          </label>
          {form.docNeedsUpdate && (
            <>
              <label htmlFor={id + '-doc'}>Which document</label>
              <select
                id={id + '-doc'}
                value={form.docToUpdate}
                aria-invalid={errors.docToUpdate ? true : undefined}
                aria-describedby={id + '-doc-error'}
                onChange={(event) => change({ docToUpdate: event.target.value })}
              >
                <option value="">Choose a document</option>
                {titles.map((title) => (
                  <option key={title} value={title}>
                    {title}
                  </option>
                ))}
              </select>
              <p className="hrj-error" id={id + '-doc-error'}>
                {errors.docToUpdate}
              </p>
            </>
          )}
        </div>
        {summary && (
          <p className="hrj-error hrj-wide" role="alert">
            {summary}
          </p>
        )}
        <div className="hrj-actions hrj-wide">
          <button type="submit" className="hrj-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save changes'}
          </button>
          <span role="status" aria-live="polite">
            {saved}
          </span>
        </div>
      </form>
    </article>
  );
}

// People & Support, section 1: requests employees chose to send.
export default function HrSupportRequests({ data, onChanged }) {
  const [filter, setFilter] = useState('all');
  const counts = countsView(data?.counts);
  const requests = filterRequests(data?.requests, filter);
  return (
    <section className="hrj-section" aria-labelledby="hrj-requests-title">
      <div className="hrj-section-heading">
        <div>
          <h2 id="hrj-requests-title">Support requests</h2>
          <p>
            Employees send these themselves, after seeing exactly what you will read. Nothing else
            about an individual is shown here.
          </p>
        </div>
        <div className="hrj-filters" role="group" aria-label="Filter by status">
          {requestFilters.map((item) => (
            <button
              key={item.value}
              type="button"
              aria-pressed={filter === item.value}
              onClick={() => setFilter(item.value)}
            >
              {item.label} <span>{counts[item.value]}</span>
            </button>
          ))}
        </div>
      </div>
      {!data ? (
        <p role="status">Loading requests…</p>
      ) : requests.length ? (
        <div className="hrj-request-list">
          {requests.map((request) => (
            <RequestCard key={request.id} request={request} onSaved={onChanged} />
          ))}
        </div>
      ) : (
        <p className="hrj-empty">
          {data.requests.length
            ? 'No requests with this status.'
            : 'No support requests yet. A new one appears here within seconds of an employee sending it.'}
        </p>
      )}
    </section>
  );
}
