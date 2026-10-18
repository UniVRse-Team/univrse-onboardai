import React, { useCallback, useEffect, useState } from 'react';
import {
  adminApi,
  companyErrorMessage,
  copyHrText,
  oneTimeNote,
  statusLabel,
  splitCreatedHr,
  splitResetHr,
  eventLabel,
  eventSummary,
} from './admin-api.mjs';
import { formatDateTime } from '../access/profile-display.mjs';
import Icon from '../portal/Icon';

export default function AdminCompanyDetail({ companyId, navigate }) {
  const [activeTab, setActiveTab] = useState('details');
  const [company, setCompany] = useState(null);
  const [loadingCompany, setLoadingCompany] = useState(true);
  const [companyError, setCompanyError] = useState('');

  // Details tab state
  const [renameInput, setRenameInput] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState('');
  const [renameSuccess, setRenameSuccess] = useState('');
  const [statusDialog, setStatusDialog] = useState(null); // 'disable' | 'enable' | null
  const [statusUpdating, setStatusUpdating] = useState(false);
  const [statusError, setStatusError] = useState('');

  // HR accounts tab state
  const [hrAccounts, setHrAccounts] = useState(null);
  const [loadingHr, setLoadingHr] = useState(false);
  const [hrError, setHrError] = useState('');
  const [secretModal, setSecretModal] = useState(null); // { title, username, temporaryPassword }
  const [copyFeedback, setCopyFeedback] = useState('');
  const [detailCopyFeedback, setDetailCopyFeedback] = useState('');
  const [settingDefaultHr, setSettingDefaultHr] = useState(false);

  // Activity tab state
  const [events, setEvents] = useState(null);
  const [nextBefore, setNextBefore] = useState(null);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [loadingMoreEvents, setLoadingMoreEvents] = useState(false);
  const [eventsError, setEventsError] = useState('');

  const loadCompany = useCallback(async () => {
    setLoadingCompany(true);
    try {
      const data = await adminApi.company(companyId);
      setCompany(data.company);
      setRenameInput(data.company?.name || '');
      setCompanyError('');
    } catch (err) {
      setCompanyError(companyErrorMessage(err));
    } finally {
      setLoadingCompany(false);
    }
  }, [companyId]);

  useEffect(() => {
    loadCompany();
  }, [loadCompany]);

  // Load HR Accounts
  const loadHrAccounts = useCallback(async () => {
    setLoadingHr(true);
    try {
      const data = await adminApi.hrAccounts(companyId);
      setHrAccounts(data.hrAccounts || []);
      setHrError('');
    } catch (err) {
      setHrError(companyErrorMessage(err));
    } finally {
      setLoadingHr(false);
    }
  }, [companyId]);

  // Load Activity Events
  const loadEvents = useCallback(async () => {
    setLoadingEvents(true);
    try {
      const data = await adminApi.events(companyId, { limit: 50 });
      setEvents(data.events || []);
      setNextBefore(data.nextBefore || null);
      setEventsError('');
    } catch (err) {
      setEventsError(companyErrorMessage(err));
    } finally {
      setLoadingEvents(false);
    }
  }, [companyId]);

  const loadMoreEvents = async () => {
    if (!nextBefore || loadingMoreEvents) return;
    setLoadingMoreEvents(true);
    try {
      const data = await adminApi.events(companyId, { before: nextBefore, limit: 50 });
      setEvents((prev) => [...(prev || []), ...(data.events || [])]);
      setNextBefore(data.nextBefore || null);
    } catch (err) {
      setEventsError(companyErrorMessage(err));
    } finally {
      setLoadingMoreEvents(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'hr-accounts' && !hrAccounts) loadHrAccounts();
    if (activeTab === 'activity' && !events) loadEvents();
  }, [activeTab, hrAccounts, events, loadHrAccounts, loadEvents]);

  // Rename Company
  async function handleRename(e) {
    e.preventDefault();
    if (!renameInput.trim()) return;
    setRenaming(true);
    setRenameError('');
    setRenameSuccess('');
    try {
      const data = await adminApi.renameCompany(companyId, renameInput.trim());
      setCompany(data.company);
      setRenameSuccess('Company name updated.');
    } catch (err) {
      setRenameError(companyErrorMessage(err));
    } finally {
      setRenaming(false);
    }
  }

  // Toggle Status
  async function confirmStatusChange() {
    if (!statusDialog) return;
    const nextStatus = statusDialog === 'disable' ? 'disabled' : 'active';
    setStatusUpdating(true);
    setStatusError('');
    try {
      const data = await adminApi.setStatus(companyId, nextStatus);
      setCompany(data.company);
      setStatusDialog(null);
    } catch (err) {
      setStatusError(companyErrorMessage(err));
    } finally {
      setStatusUpdating(false);
    }
  }

  // HR Account actions
  async function handleCreateHr() {
    setHrError('');
    try {
      const res = await adminApi.createHrAccount(companyId);
      const { hrAccount, secret } = splitCreatedHr(res);
      setSecretModal({
        title: 'HR account created',
        username: secret.username,
        temporaryPassword: secret.temporaryPassword,
      });
      loadHrAccounts();
      loadCompany();
    } catch (err) {
      setHrError(companyErrorMessage(err));
    }
  }

  async function handleResetPassword(account) {
    setHrError('');
    try {
      const res = await adminApi.resetHrPassword(companyId, account.id);
      const { secret } = splitResetHr(res, account.username);
      setSecretModal({
        title: `Password reset for ${account.username}`,
        username: secret.username,
        temporaryPassword: secret.temporaryPassword,
      });
      loadHrAccounts();
    } catch (err) {
      setHrError(companyErrorMessage(err));
    }
  }

  async function handleSetDefaultHr(accountId) {
    setSettingDefaultHr(true);
    setHrError('');
    try {
      await adminApi.setDefaultHr(companyId, accountId);
      loadHrAccounts();
      loadCompany();
    } catch (err) {
      setHrError(companyErrorMessage(err));
    } finally {
      setSettingDefaultHr(false);
    }
  }

  async function copySecretText() {
    if (!secretModal) return;
    try {
      await navigator.clipboard.writeText(
        copyHrText({
          username: secretModal.username,
          temporaryPassword: secretModal.temporaryPassword,
        }),
      );
      setCopyFeedback('Copied to clipboard');
      setTimeout(() => setCopyFeedback(''), 3000);
    } catch {
      setCopyFeedback('Please select and copy manually');
    }
  }

  if (loadingCompany) {
    return (
      <div className="admin-dashboard">
        <p style={{ color: '#526986' }}>Loading company…</p>
      </div>
    );
  }

  if (companyError || !company) {
    return (
      <div className="admin-dashboard">
        <div className="admin-banner error" role="alert">
          <h3>Company not found</h3>
          <p>
            {companyError ||
              'That company does not exist or you do not have permission to view it.'}
          </p>
        </div>
        <button type="button" className="admin-button secondary" onClick={() => navigate('/admin')}>
          ← Return to companies
        </button>
      </div>
    );
  }

  return (
    <div className="admin-company-detail">
      <div style={{ marginBottom: 12 }}>
        <a
          href="/admin"
          className="admin-kicker"
          style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6 }}
          onClick={(e) => {
            e.preventDefault();
            navigate('/admin');
          }}
        >
          ← All companies
        </a>
      </div>

      <header className="admin-heading">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <h1>{company.name}</h1>
            <span className={`admin-badge ${company.status}`}>{statusLabel(company.status)}</span>
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              flexWrap: 'wrap',
              marginTop: 6,
              color: '#46677d',
              fontSize: 14,
            }}
          >
            <span>
              Slug ID: <code>{company.id}</code>
            </span>
            <span>·</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              Company link:{' '}
              <a
                href={`/admin/companies/${company.id}`}
                style={{ color: '#256a91', textDecoration: 'underline' }}
              >
                /admin/companies/{company.id}
              </a>
              <button
                type="button"
                title="Copy company link"
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
                  try {
                    await navigator.clipboard.writeText(
                      `${window.location.origin}/admin/companies/${company.id}`,
                    );
                    setDetailCopyFeedback('Copied!');
                    setTimeout(() => setDetailCopyFeedback(''), 2500);
                  } catch {
                    // ignore
                  }
                }}
              >
                <Icon name="copy" size={14} />
              </button>
              {detailCopyFeedback && (
                <span style={{ fontSize: 11, color: '#166534', fontWeight: 600 }}>
                  {detailCopyFeedback}
                </span>
              )}
            </span>
            <span>·</span>
            <span>Created {formatDateTime(company.createdAt)}</span>
          </div>
        </div>
      </header>

      <nav className="admin-tabs" role="tablist" style={{ marginTop: 24 }}>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'details'}
          className={`admin-tab ${activeTab === 'details' ? 'active' : ''}`}
          onClick={() => setActiveTab('details')}
        >
          Details
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'hr-accounts'}
          className={`admin-tab ${activeTab === 'hr-accounts' ? 'active' : ''}`}
          onClick={() => setActiveTab('hr-accounts')}
        >
          HR accounts
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'activity'}
          className={`admin-tab ${activeTab === 'activity' ? 'active' : ''}`}
          onClick={() => setActiveTab('activity')}
        >
          Activity
        </button>
      </nav>

      {/* TAB 1: DETAILS */}
      {activeTab === 'details' && (
        <div className="admin-tab-content">
          <div className="admin-card">
            <h2 style={{ fontSize: 18, marginBottom: 16 }}>Rename company</h2>
            {renameSuccess && <div className="admin-banner success">{renameSuccess}</div>}
            {renameError && <div className="admin-banner error">{renameError}</div>}
            <form onSubmit={handleRename} style={{ maxWidth: 500 }}>
              <div className="admin-form-group">
                <label htmlFor="company-rename">Company name</label>
                <input
                  id="company-rename"
                  type="text"
                  maxLength={80}
                  value={renameInput}
                  onChange={(e) => setRenameInput(e.target.value)}
                  required
                />
              </div>
              <button
                type="submit"
                className="admin-button primary"
                disabled={renaming || !renameInput.trim() || renameInput.trim() === company.name}
              >
                {renaming ? 'Saving…' : 'Update name'}
              </button>
            </form>
          </div>

          <div className="admin-card" style={{ marginTop: 24 }}>
            <h2 style={{ fontSize: 18, marginBottom: 12 }}>Company status</h2>
            <p style={{ color: '#46677d', fontSize: 14, marginBottom: 16 }}>
              Current status is <strong>{statusLabel(company.status)}</strong>.
              {company.status === 'active'
                ? ' Disabling this company ends every active session and prevents all accounts from signing in.'
                : ' Enabling this company allows its HR administrators and employees to sign in again.'}
            </p>
            {statusError && (
              <div className="admin-banner error" style={{ marginBottom: 16 }}>
                {statusError}
              </div>
            )}
            {company.status === 'active' ? (
              <button
                type="button"
                className="admin-button danger"
                onClick={() => setStatusDialog('disable')}
              >
                Disable company
              </button>
            ) : (
              <button
                type="button"
                className="admin-button primary"
                onClick={() => setStatusDialog('enable')}
              >
                Enable company
              </button>
            )}
          </div>
        </div>
      )}

      {/* TAB 2: HR ACCOUNTS */}

      {activeTab === 'hr-accounts' && (
        <div className="admin-tab-content">
          <div className="admin-card">
            <div className="admin-card-header">
              <div>
                <h2>HR Administrators</h2>
                <p style={{ color: '#526986', fontSize: 13, marginTop: 4 }}>
                  Accounts with HR role for {company.name}.
                </p>
              </div>
              <button type="button" className="admin-button primary" onClick={handleCreateHr}>
                + Create HR account
              </button>
            </div>

            {hrError && (
              <div className="admin-banner error" style={{ marginBottom: 16 }}>
                {hrError}
              </div>
            )}

            {loadingHr ? (
              <p style={{ color: '#526986' }}>Loading HR accounts…</p>
            ) : hrAccounts && hrAccounts.length > 0 ? (
              <table className="admin-companies-table">
                <thead>
                  <tr>
                    <th>HR ID</th>
                    <th>Status</th>
                    <th>Default</th>
                    <th>Created</th>
                    <th>Last sign-in</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {hrAccounts.map((hr) => (
                    <tr key={hr.id}>
                      <td>
                        <strong>{hr.username}</strong>
                      </td>
                      <td>
                        <span className={`admin-badge ${hr.status}`}>{statusLabel(hr.status)}</span>
                        {hr.locked && <span className="admin-badge locked">Locked</span>}
                      </td>
                      <td>
                        {hr.isDefault ? (
                          <span className="admin-badge default-hr">Default HR</span>
                        ) : (
                          <button
                            type="button"
                            className="admin-button secondary"
                            style={{ padding: '3px 8px', fontSize: 11 }}
                            disabled={settingDefaultHr}
                            onClick={() => handleSetDefaultHr(hr.id)}
                          >
                            Make default
                          </button>
                        )}
                      </td>
                      <td style={{ color: '#647992', fontSize: 13 }}>
                        {formatDateTime(hr.createdAt)}
                      </td>
                      <td style={{ color: '#647992', fontSize: 13 }}>
                        {hr.lastSignInAt ? formatDateTime(hr.lastSignInAt) : 'Never'}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="admin-button secondary"
                          style={{ fontSize: 12, padding: '4px 10px' }}
                          onClick={() => handleResetPassword(hr)}
                        >
                          Reset password
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p style={{ color: '#526986' }}>No HR accounts exist yet for this company.</p>
            )}
          </div>
        </div>
      )}

      {/* TAB 4: ACTIVITY */}
      {activeTab === 'activity' && (
        <div className="admin-tab-content">
          <div className="admin-card">
            <h2 style={{ fontSize: 18, marginBottom: 16 }}>Audit Events</h2>
            {eventsError && <div className="admin-banner error">{eventsError}</div>}

            {loadingEvents ? (
              <p style={{ color: '#526986' }}>Loading activity events…</p>
            ) : events && events.length > 0 ? (
              <div className="admin-activity-feed">
                {events.map((ev) => (
                  <div key={ev.id} className="admin-activity-item">
                    <div className="admin-activity-header">
                      <span>{eventLabel(ev.action)}</span>
                      <span className="admin-activity-meta">{formatDateTime(ev.createdAt)}</span>
                    </div>
                    <div className="admin-activity-meta">{eventSummary(ev)}</div>
                    {ev.detail && typeof ev.detail === 'object' && (
                      <div className="admin-activity-detail">
                        <code>{JSON.stringify(ev.detail)}</code>
                      </div>
                    )}
                  </div>
                ))}

                {nextBefore && (
                  <button
                    type="button"
                    className="admin-button secondary"
                    style={{ marginTop: 12, alignSelf: 'center' }}
                    disabled={loadingMoreEvents}
                    onClick={loadMoreEvents}
                  >
                    {loadingMoreEvents ? 'Loading older activity…' : 'Load older events'}
                  </button>
                )}
              </div>
            ) : (
              <p style={{ color: '#526986' }}>No events recorded for this company yet.</p>
            )}
          </div>
        </div>
      )}

      {/* Status Confirmation Modal */}
      {statusDialog && (
        <div className="admin-dialog-backdrop" onClick={() => setStatusDialog(null)}>
          <div className="admin-dialog" onClick={(e) => e.stopPropagation()}>
            <h3 className="admin-dialog-title">
              {statusDialog === 'disable' ? `Disable ${company.name}?` : `Enable ${company.name}?`}
            </h3>
            <p className="admin-dialog-body">
              {statusDialog === 'disable'
                ? 'Its accounts are signed out and cannot sign in.'
                : 'Its accounts will be able to sign in and use the platform again.'}
            </p>
            <div className="admin-dialog-actions">
              <button
                type="button"
                className="admin-button secondary"
                disabled={statusUpdating}
                onClick={() => setStatusDialog(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className={`admin-button ${statusDialog === 'disable' ? 'danger' : 'primary'}`}
                disabled={statusUpdating}
                onClick={confirmStatusChange}
              >
                {statusUpdating
                  ? 'Updating…'
                  : statusDialog === 'disable'
                    ? 'Disable company'
                    : 'Enable company'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* HR Credentials Modal (Created / Password Reset) */}
      {secretModal && (
        <div className="admin-dialog-backdrop" onClick={() => setSecretModal(null)}>
          <div className="admin-dialog" onClick={(e) => e.stopPropagation()}>
            <h3 className="admin-dialog-title">{secretModal.title}</h3>
            <div className="admin-secret-box">
              <div className="admin-secret-row">
                <span>HR ID:</span>
                <span className="admin-secret-val">{secretModal.username}</span>
              </div>
              <div className="admin-secret-row">
                <span>Temporary password:</span>
                <span className="admin-secret-val">{secretModal.temporaryPassword}</span>
              </div>
            </div>
            <p className="admin-dialog-body" style={{ fontSize: 13 }}>
              {oneTimeNote}
            </p>
            {copyFeedback && (
              <span style={{ fontSize: 13, color: '#166534', fontWeight: 600 }}>
                {copyFeedback}
              </span>
            )}
            <div className="admin-dialog-actions">
              <button type="button" className="admin-button secondary" onClick={copySecretText}>
                <Icon name="copy" size={16} /> Copy credentials
              </button>
              <button
                type="button"
                className="admin-button primary"
                onClick={() => setSecretModal(null)}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
