import React, { useCallback, useEffect, useState } from 'react';
import {
  adminApi,
  countsLabel,
  statusLabel,
  validateNewCompany,
  companyErrorMessage,
  companyFieldErrors,
} from './admin-api.mjs';
import { formatDateTime } from '../access/profile-display.mjs';
import Icon from '../portal/Icon';

export default function AdminDashboard({ navigate }) {
  const [companies, setCompanies] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showNewModal, setShowNewModal] = useState(false);
  const [newForm, setNewForm] = useState({ name: '', id: '' });
  const [formErrors, setFormErrors] = useState({});
  const [submitError, setSubmitError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [showAdvancedId, setShowAdvancedId] = useState(false);
  const [copiedCompanyId, setCopiedCompanyId] = useState(null);

  const openCompanyInNewTab = (companyId, e) => {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    const url = `/admin/companies/${companyId}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const loadCompanies = useCallback(async () => {
    setLoading(true);
    try {
      const data = await adminApi.companies();
      setCompanies(data.companies || []);
      setError('');
    } catch (err) {
      setError(companyErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCompanies();
  }, [loadCompanies]);

  async function handleCreate(e) {
    e.preventDefault();
    const clientErrors = validateNewCompany(newForm);
    if (Object.keys(clientErrors).length > 0) {
      setFormErrors(clientErrors);
      return;
    }
    setFormErrors({});
    setSubmitError('');
    setSubmitting(true);
    try {
      const res = await adminApi.createCompany({
        name: newForm.name.trim(),
        id: showAdvancedId && newForm.id.trim() ? newForm.id.trim() : undefined,
      });
      setShowNewModal(false);
      setNewForm({ name: '', id: '' });
      if (res.company?.id) {
        navigate(`/admin/companies/${res.company.id}`);
      } else {
        loadCompanies();
      }
    } catch (err) {
      if (err.fields) {
        setFormErrors(companyFieldErrors(err.fields));
      } else {
        setSubmitError(companyErrorMessage(err));
      }
    } finally {
      setSubmitting(false);
    }
  }

  const [editCompany, setEditCompany] = useState(null);
  const [editName, setEditName] = useState('');
  const [editError, setEditError] = useState('');
  const [editing, setEditing] = useState(false);

  function openEditModal(company) {
    setEditCompany(company);
    setEditName(company.name || '');
    setEditError('');
  }

  async function handleRenameSubmit(e) {
    e.preventDefault();
    const trimmed = editName.trim();
    if (!trimmed) {
      setEditError('Enter the company name.');
      return;
    }
    if (trimmed.length > 80) {
      setEditError('Keep the name to 80 characters or fewer.');
      return;
    }
    setEditError('');
    setEditing(true);
    try {
      const res = await adminApi.renameCompany(editCompany.id, trimmed);
      const updated = res.company;
      setCompanies((prev) =>
        prev ? prev.map((c) => (c.id === updated.id ? { ...c, ...updated } : c)) : [updated],
      );
      setEditCompany(null);
    } catch (err) {
      setEditError(companyErrorMessage(err));
    } finally {
      setEditing(false);
    }
  }

  return (
    <div className="admin-dashboard">
      <header className="admin-heading">
        <div>
          <span className="admin-kicker">Platform Administration</span>
          <h1>Companies</h1>
          <p>Manage company tenants, HR administrators, and corporate profiles.</p>
        </div>
        <button
          type="button"
          className="admin-button primary"
          onClick={() => {
            setNewForm({ name: '', id: '' });
            setFormErrors({});
            setSubmitError('');
            setShowNewModal(true);
          }}
        >
          <Icon name="spark" size={16} /> New company
        </button>
      </header>

      {error && (
        <div className="admin-banner error" role="alert">
          <span>{error}</span>
          <button
            type="button"
            className="admin-button secondary"
            style={{ width: 'fit-content', marginTop: 8 }}
            onClick={loadCompanies}
          >
            Try again
          </button>
        </div>
      )}

      <div className="admin-card" style={{ marginTop: 24 }}>
        <div className="admin-card-header">
          <h2>All Companies {companies ? `(${companies.length})` : ''}</h2>
        </div>

        {loading ? (
          <p style={{ color: '#526986' }}>Loading companies…</p>
        ) : companies && companies.length > 0 ? (
          <table className="admin-companies-table">
            <thead>
              <tr>
                <th>Company</th>
                <th>Slug ID</th>
                <th>Company Link</th>
                <th>Status</th>
                <th>Default HR</th>
                <th>Accounts</th>
                <th>Created</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {companies.map((company) => (
                <tr key={company.id}>
                  <td className="admin-company-name-cell">
                    <a
                      href={`/admin/companies/${company.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => openCompanyInNewTab(company.id, e)}
                    >
                      {company.name}
                    </a>
                  </td>
                  <td className="admin-company-id-cell">
                    <code>{company.id}</code>
                  </td>
                  <td className="admin-company-link-cell">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <a
                        href={`/companies/${company.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => openCompanyInNewTab(company.id, e, '/companies/')}
                        title={`Open ${company.name} in new tab`}
                        style={{ fontSize: 13, color: '#256a91', textDecoration: 'underline' }}
                      >
                        /companies/{company.id}
                      </a>
                      <button
                        type="button"
                        title="Open company in new tab"
                        aria-label={`Open ${company.name} in new tab`}
                        style={{
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          padding: 2,
                          color: '#526986',
                          display: 'inline-flex',
                          alignItems: 'center',
                        }}
                        onClick={(e) => openCompanyInNewTab(company.id, e, '/companies/')}
                      >
                        <Icon name="arrow" size={14} />
                      </button>
                      <button
                        type="button"
                        title="Copy company link"
                        aria-label={`Copy link for ${company.name}`}
                        style={{
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          padding: 2,
                          color: '#526986',
                          display: 'inline-flex',
                          alignItems: 'center',
                        }}
                        onClick={async () => {
                          const fullUrl = `${window.location.origin}/companies/${company.id}`;
                          try {
                            await navigator.clipboard.writeText(fullUrl);
                            setCopiedCompanyId(company.id);
                            setTimeout(() => setCopiedCompanyId(null), 2500);
                          } catch {
                            // ignore fallback
                          }
                        }}
                      >
                        <Icon name="copy" size={14} />
                      </button>
                      {copiedCompanyId === company.id && (
                        <span style={{ fontSize: 11, color: '#166534', fontWeight: 600 }}>
                          Copied!
                        </span>
                      )}
                    </div>
                  </td>
                  <td>
                    <span className={`admin-badge ${company.status}`}>
                      {statusLabel(company.status)}
                    </span>
                  </td>
                  <td>
                    {company.defaultHr?.username ? (
                      <code>{company.defaultHr.username}</code>
                    ) : (
                      <span style={{ color: '#829bb0' }}>None</span>
                    )}
                  </td>
                  <td style={{ color: '#46677d', fontSize: 13 }}>{countsLabel(company.counts)}</td>
                  <td style={{ color: '#647992', fontSize: 13 }}>
                    {formatDateTime(company.createdAt)}
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        type="button"
                        className="admin-button secondary"
                        onClick={() => openEditModal(company)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="admin-button secondary"
                        onClick={() => navigate(`/admin/companies/${company.id}`)}
                      >
                        Manage
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p style={{ color: '#526986' }}>No companies found.</p>
        )}
      </div>

      {showNewModal && (
        <div className="admin-dialog-backdrop" onClick={() => setShowNewModal(false)}>
          <div className="admin-dialog" onClick={(e) => e.stopPropagation()}>
            <h3 className="admin-dialog-title">Create new company</h3>
            <p className="admin-dialog-body">
              Add a new tenant to the platform. Default departments will be seeded automatically.
            </p>

            {submitError && (
              <div className="admin-banner error" role="alert">
                {submitError}
              </div>
            )}

            <form onSubmit={handleCreate}>
              <div className="admin-form-group">
                <label htmlFor="company-name">Company name (required)</label>
                <input
                  id="company-name"
                  type="text"
                  maxLength={80}
                  value={newForm.name}
                  onChange={(e) => setNewForm((prev) => ({ ...prev, name: e.target.value }))}
                  placeholder="e.g. Acme Corporation"
                  autoFocus
                  required
                />
                {formErrors.name && <span className="admin-form-error">{formErrors.name}</span>}
              </div>

              <div style={{ marginBottom: 16 }}>
                <button
                  type="button"
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#256a91',
                    fontSize: 13,
                    cursor: 'pointer',
                    padding: 0,
                    textDecoration: 'underline',
                  }}
                  onClick={() => setShowAdvancedId((prev) => !prev)}
                >
                  {showAdvancedId ? 'Hide advanced ID' : 'Advanced: Custom company ID'}
                </button>
              </div>

              {showAdvancedId && (
                <div className="admin-form-group">
                  <label htmlFor="company-id">Custom company ID (optional slug)</label>
                  <input
                    id="company-id"
                    type="text"
                    maxLength={32}
                    value={newForm.id}
                    onChange={(e) =>
                      setNewForm((prev) => ({ ...prev, id: e.target.value.toLowerCase() }))
                    }
                    placeholder="e.g. acme"
                  />
                  <span className="admin-form-hint">
                    Lowercase letters, numbers, and hyphens (3–32 chars). If omitted, an ID will be
                    derived from the name.
                  </span>
                  {formErrors.id && <span className="admin-form-error">{formErrors.id}</span>}
                </div>
              )}

              <div className="admin-dialog-actions">
                <button
                  type="button"
                  className="admin-button secondary"
                  disabled={submitting}
                  onClick={() => setShowNewModal(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="admin-button primary"
                  disabled={submitting || !newForm.name.trim()}
                >
                  {submitting ? 'Creating…' : 'Create company'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {editCompany && (
        <div className="admin-dialog-backdrop" onClick={() => setEditCompany(null)}>
          <div className="admin-dialog" onClick={(e) => e.stopPropagation()}>
            <h3 className="admin-dialog-title">Edit company</h3>
            <p className="admin-dialog-body">
              Update the display name for <strong>{editCompany.name}</strong> (Slug ID:{' '}
              <code>{editCompany.id}</code>).
            </p>

            {editError && (
              <div className="admin-banner error" role="alert">
                {editError}
              </div>
            )}

            <form onSubmit={handleRenameSubmit}>
              <div className="admin-form-group">
                <label htmlFor="edit-company-name">Company name (required)</label>
                <input
                  id="edit-company-name"
                  type="text"
                  maxLength={80}
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  autoFocus
                  required
                />
              </div>

              <div className="admin-dialog-actions">
                <button
                  type="button"
                  className="admin-button secondary"
                  onClick={() => setEditCompany(null)}
                  disabled={editing}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="admin-button primary"
                  disabled={editing || !editName.trim() || editName.trim() === editCompany.name}
                >
                  {editing ? 'Saving…' : 'Save changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
