import React, { useEffect, useRef, useState, useCallback } from 'react';
import { submissionsApi } from './submissions-api.mjs';
import { ONBOARDING_CHANGED } from '../access/journey-api.mjs';
import { Status, SubmissionDetail, dateLabel } from './SubmissionParts';
import { documentStepState } from './document-steps.mjs';
import { fileProblem, fileSize, fileExtension } from '../../shared/document-submissions.mjs';
import './documents.css';
import './dashboard-documents.css';

export function useDashboardDocuments() {
  const [data, setData] = useState({ submissions: [], available: false });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const live = useRef(false);
  const refresh = useCallback(async () => {
    try {
      const result = await submissionsApi.list(false);
      if (live.current) {
        setData(result);
        setError('');
      }
    } catch (e) {
      if (live.current) setError(e.message);
    } finally {
      if (live.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    live.current = true;
    refresh();
    const visible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    const timer = setInterval(visible, 30000);
    window.addEventListener('focus', visible);
    document.addEventListener('visibilitychange', visible);
    return () => {
      live.current = false;
      clearInterval(timer);
      window.removeEventListener('focus', visible);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [refresh]);
  return { ...data, error, loading, refresh };
}

export function DocumentSectionNotice({ documents }) {
  const [detail, setDetail] = useState(null);
  const earlier = documents.submissions.filter((item) => !item.stepId);
  return (
    <div className="fp-doc-notice">
      <p>
        {documents.loading
          ? 'Loading document submissions…'
          : documents.available
            ? 'Complete the tasks below one at a time. A task is complete once your document is saved.'
            : 'Uploads are unavailable until private document storage is configured.'}
      </p>
      {documents.error && <p role="alert">{documents.error}</p>}
      {documents.error && (
        <button type="button" className="fp-action" onClick={documents.refresh}>
          Try again
        </button>
      )}
      {!!earlier.length && (
        <details>
          <summary>Other documents you saved ({earlier.length})</summary>
          {earlier.map((item) => (
            <button
              type="button"
              className="fp-action"
              key={item.id}
              onClick={() => setDetail(item)}
            >
              {item.title}
            </button>
          ))}
        </details>
      )}
      {detail && <SubmissionDetail item={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

export default function DashboardDocumentUpload({
  step,
  documents,
  isNext = false,
  locked = false,
  onSaved,
}) {
  const records = documents.submissions.filter((item) => item.stepId === step.id);
  const [editing, setEditing] = useState(false);
  const [file, setFile] = useState(null);
  const state = documentStepState(step, documents.submissions, editing || Boolean(file));
  const latest = state.latest;
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState(null);
  const input = useRef(null);
  function select(candidate) {
    setMessage('');
    const problem = fileProblem(candidate || { name: '', size: 0 });
    setError(problem || '');
    setFile(problem ? null : candidate);
  }
  async function submit(e) {
    e.preventDefault();
    if (!file || busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await submissionsApi.submit(
        {
          stepId: step.id,
          title: step.title,
          type:
            step.id === 'documentation.tax-id-documents'
              ? 'Identification Document'
              : 'Employment Documents',
        },
        file,
      );
      setFile(null);
      setEditing(false);
      setMessage('Saved. This task is completed.');
      await documents.refresh();
      // The area's progress bar comes from the saved onboarding record: reload it too.
      await onSaved?.();
      // Alya's checklist reads the same saved progress.
      window.dispatchEvent(new Event(ONBOARDING_CHANGED));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="fp-document" data-document-step={step.id}>
      <div className="fp-document-header">
        <div>
          <small>SUPPORTING DOCUMENT</small>
          {latest ? (
            <>
              <strong>{latest.fileName}</strong>
              <span>
                {dateLabel(latest.submittedAt)} · {fileSize(latest.bytes)}
              </span>
            </>
          ) : (
            <span>No document saved yet</span>
          )}
        </div>
        <span className={'fp-document-state fp-document-' + state.key}>
          {state.done ? '✓ ' : ''}
          {state.label}
        </span>
        {latest && (
          <button type="button" className="fp-action" onClick={() => setDetail(latest)}>
            View document
          </button>
        )}
        {!editing && !state.done && (
          <button
            type="button"
            className="fp-action main"
            disabled={documents.loading || !documents.available || locked}
            onClick={() => {
              setEditing(true);
              setMessage('');
            }}
          >
            {state.action}
          </button>
        )}
      </div>
      <p className="fp-document-next">
        {documents.loading
          ? 'Loading your progress…'
          : state.done
            ? 'This task is completed.'
            : locked
              ? 'Finish the previous task first.'
              : !documents.available
                ? 'Uploads are unavailable until private document storage is configured.'
                : isNext
                  ? 'Do this next: upload this document.'
                  : 'Upload this document to complete the task.'}
      </p>
      {editing && (
        <form onSubmit={submit} aria-label={'Upload for ' + step.title}>
          <div
            className="fp-document-drop"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (!busy) {
                if (e.dataTransfer.files.length !== 1) setError('Choose one file at a time.');
                else select(e.dataTransfer.files[0]);
              }
            }}
          >
            <label>
              Choose a file or drop it here
              <input
                ref={input}
                type="file"
                accept=".pdf,.docx,.jpg,.jpeg,.png"
                disabled={busy}
                onChange={(e) => {
                  if (e.target.files[0]) select(e.target.files[0]);
                }}
              />
            </label>
            <small>PDF, DOCX, JPG or PNG · Up to 5 MB per file</small>
            {file && (
              <div className="fp-selected-file">
                <strong>{file.name}</strong>
                <span>
                  {fileExtension(file.name).toUpperCase()} · {fileSize(file.size)}
                </span>
                <button
                  type="button"
                  className="fp-action"
                  disabled={busy}
                  onClick={() => input.current.click()}
                >
                  Replace
                </button>
                <button
                  type="button"
                  className="fp-action"
                  disabled={busy}
                  onClick={() => {
                    setFile(null);
                    input.current.value = '';
                  }}
                >
                  Remove
                </button>
              </div>
            )}
          </div>
          <div className="fp-document-buttons">
            <button className="fp-action main" disabled={!file || busy}>
              {busy ? 'Uploading…' : 'Save and complete task'}
            </button>
            <button
              type="button"
              className="fp-action"
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setFile(null);
                setError('');
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {error && (
        <p className="fp-inline-error" role="alert">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {detail && <SubmissionDetail item={detail} onClose={() => setDetail(null)} plain />}
    </div>
  );
}
