import React, { useState } from 'react';
import { adminHome } from '../access/account-routing.mjs';
import { AccessBrand } from '../access/LoginPage';
import Icon from '../portal/Icon';
import './admin.css';

export default function AdminSignIn({ onSignIn, onSignOut, navigate }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  async function handleSubmit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setNotice('');
    try {
      const res = await onSignIn(username.trim(), password);
      const signedAccount = res?.account;
      if (signedAccount && signedAccount.role !== 'admin') {
        if (onSignOut) await onSignOut();
        setNotice(
          'This sign-in is for platform administrators only. Please use your company sign-in link.',
        );
        return;
      }
      navigate(adminHome);
    } catch (error) {
      setNotice(error.message || 'Invalid administrator ID or password.');
    } finally {
      setBusy(false);
      setPassword('');
    }
  }

  return (
    <div className="admin-page admin-signin-page">
      <header className="admin-header">
        <div className="admin-header-brand">
          <a
            href={adminHome}
            onClick={(e) => {
              e.preventDefault();
              navigate(adminHome);
            }}
          >
            <AccessBrand />
          </a>
          <span className="admin-role-badge">PLATFORM ADMIN</span>
        </div>
      </header>

      <main className="admin-main admin-signin-container">
        <div className="admin-card admin-signin-card">
          <div className="admin-card-header admin-signin-header">
            <span className="admin-kicker">SYSTEM ADMINISTRATION</span>
            <h2>Platform Administrator Sign In</h2>
            <p>
              Sign in with your platform administrator credentials to manage tenant workspaces and
              HR accounts.
            </p>
          </div>

          {notice && (
            <div className="admin-banner error" role="alert" style={{ marginBottom: 20 }}>
              <Icon name="info" size={16} />
              <span>{notice}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="admin-signin-form">
            <div className="admin-form-group">
              <label htmlFor="admin-id">Admin ID</label>
              <input
                id="admin-id"
                name="adminId"
                type="text"
                autoComplete="username"
                autoCapitalize="off"
                spellCheck={false}
                placeholder="e.g. ADMIN-0001"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
              />
            </div>

            <div className="admin-form-group">
              <label htmlFor="admin-password">Password</label>
              <div className="access-password">
                <input
                  id="admin-password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  placeholder="Enter admin password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? 'Hide' : 'Show'}
                </button>
              </div>
            </div>

            <div style={{ marginTop: 24 }}>
              <button
                type="submit"
                className="admin-button primary"
                disabled={busy}
                style={{ width: '100%', justifyContent: 'center', padding: '12px 20px' }}
              >
                <span>{busy ? 'Signing in…' : 'Sign in to Admin Dashboard'}</span>
                <Icon name="arrow" size={18} />
              </button>
            </div>
          </form>
        </div>
      </main>
    </div>
  );
}
