import React, { useEffect, useState } from 'react';
import UvDialog from '../portal/UvDialog';
import Icon from '../portal/Icon';
import { submissionsApi } from './submissions-api.mjs';
import { fileSize } from '../../shared/document-submissions.mjs';

export const dateLabel = (value) =>
  new Date(value).toLocaleDateString(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
export function Status({ status }) {
  return (
    <span className={'ds-status ds-status-' + status.toLowerCase().replaceAll(' ', '-')}>
      <span />
      {status}
    </span>
  );
}
export function Notice({ error, children }) {
  return children ? (
    <div className={'ds-notice ' + (error ? 'ds-error' : '')} role={error ? 'alert' : 'status'}>
      {children}
    </div>
  ) : null;
}
export function Empty({ filtered = false }) {
  return (
    <div className="ds-empty">
      <Icon name="book" size={30} />
      <h3>{filtered ? 'No matching submissions' : 'No submissions yet'}</h3>
      <p>
        {filtered
          ? 'Try another search or clear the filters.'
          : 'Submitted documents will appear here with their review status.'}
      </p>
    </div>
  );
}

export function SubmissionDetail({
  item,
  hr = false,
  plain = false,
  onClose,
  onUpdated,
  onResubmit,
}) {
  const [record, setRecord] = useState(item),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [remarks, setRemarks] = useState(item.remarks),
    [status, setStatus] = useState(item.status === 'Pending Review' ? 'Under Review' : item.status),
    [preview, setPreview] = useState('');
  useEffect(() => {
    let live = true;
    submissionsApi
      .detail(hr, item.id)
      .then(({ submission }) => {
        if (live) {
          setRecord(submission);
          setRemarks(submission.remarks);
          setStatus(submission.status === 'Pending Review' ? 'Under Review' : submission.status);
        }
      })
      .catch((e) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [hr, item.id]);
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );
  async function openFile(show = false) {
    setBusy(true);
    setError('');
    try {
      const blob = await submissionsApi.file(hr, record.id);
      const url = URL.createObjectURL(blob);
      if (show) setPreview(url);
      else {
        const a = document.createElement('a');
        a.href = url;
        a.download = record.fileName;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function review(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { submission } = await submissionsApi.review(record.id, {
        status,
        remarks,
        revision: record.revision,
      });
      onUpdated(submission);
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <UvDialog
      title="Submission details"
      onClose={busy ? () => {} : onClose}
      wide
      className="ds-dialog"
    >
      <div className="ds-dialog-body">
        <div className="ds-detail-title">
          <div>
            <span className="ds-eyebrow">{record.type}</span>
            <h3>{record.title}</h3>
          </div>
          {!plain && <Status status={record.status} />}
        </div>
        <Notice error>{error}</Notice>
        {loading && <p role="status">Loading latest details…</p>}
        <dl className="ds-detail-grid">
          {[
            ['Employee', record.employeeName],
            ['Employee ID', record.employeeId],
            ['Department', record.department],
            ...(record.stepTitle ? [['Documentation step', record.stepTitle]] : []),
            [plain ? 'Saved' : 'Submitted', new Date(record.submittedAt).toLocaleString()],
            ['File name', record.fileName],
            ['File size', fileSize(record.bytes)],
          ].map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        {record.resubmissionOf && !plain && (
          <p className="ds-muted">
            This is a resubmission. The earlier review remains in the submission history.
          </p>
        )}
        <div className="ds-file-bar">
          <Icon name="book" />
          <div>
            <strong>{record.fileName}</strong>
            <small>
              {record.mime.split('/').pop() === 'pdf'
                ? 'PDF'
                : record.fileName.split('.').pop().toUpperCase()}{' '}
              · {fileSize(record.bytes)}
            </small>
          </div>
          <button className="ds-button" onClick={() => openFile()} disabled={busy || loading}>
            Download
          </button>
          {record.mime.startsWith('image/') && (
            <button className="ds-button" onClick={() => openFile(true)} disabled={busy || loading}>
              Preview image
            </button>
          )}
        </div>
        {preview && (
          <img
            className="ds-image-preview"
            src={preview}
            alt={'Uploaded document: ' + record.fileName}
          />
        )}
        {!record.mime.startsWith('image/') && (
          <p className="ds-muted">
            Download this document to view it in your PDF or Word application.
          </p>
        )}
        {hr ? (
          <form className="ds-review" onSubmit={review}>
            <h3>Review document</h3>
            <label>
              Review status
              <select value={status} onChange={(e) => setStatus(e.target.value)}>
                {['Under Review', 'Approved', 'Rejected'].map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
            <label>
              HR remarks {status === 'Rejected' ? '(required)' : '(optional)'}
              <textarea
                value={remarks}
                maxLength={2000}
                required={status === 'Rejected'}
                onChange={(e) => setRemarks(e.target.value)}
                placeholder="Explain your decision or tell the employee what needs to change."
                rows={3}
              />
            </label>
            <p className="ds-muted">Your remarks are visible to this employee.</p>
            <div className="ds-actions">
              <button type="button" className="ds-button" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button className="ds-button ds-primary" disabled={busy || loading}>
                {busy ? 'Saving…' : 'Save review'}
              </button>
            </div>
          </form>
        ) : plain ? null : (
          <div className="ds-remarks">
            <h3>HR remarks</h3>
            <p>{record.remarks || 'No remarks yet. HR will review your submission.'}</p>
            {record.reviewedAt && <small>Last reviewed {dateLabel(record.reviewedAt)}</small>}
            {record.status === 'Rejected' && onResubmit && (
              <button
                className="ds-button ds-primary"
                disabled={busy}
                onClick={() => {
                  onResubmit(record);
                  onClose();
                }}
              >
                Resubmit document
              </button>
            )}
          </div>
        )}
      </div>
    </UvDialog>
  );
}
