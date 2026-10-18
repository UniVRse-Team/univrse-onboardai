import React, { useEffect, useRef, useState } from 'react';
import Icon from '../portal/Icon';
import { AccessBrand } from './LoginPage';
import { SecretField, useFocusFirstError } from './account-fields';
import { passwordProblem } from './profile-validation.mjs';
import './account-access.css';
import './accounts.css';

// Where a server error code from POST /api/auth/password belongs on this form.
export function passwordChangeErrorTarget(code) {
  if (code === 'CURRENT_PASSWORD_INCORRECT') return 'currentPassword';
  if (code === 'PASSWORD_REJECTED') return 'newPassword';
  return null;
}

export default function ChangePasswordPage({ account, onChangePassword, onSignOut }) {
  const [values, setValues] = useState({ currentPassword: '', newPassword: '', confirmation: '' });
  const [errors, setErrors] = useState({});
  const [summary, setSummary] = useState('');
  const [busy, setBusy] = useState(false);
  const headingRef = useRef(null),
    formRef = useRef(null),
    summaryRef = useRef(null),
    alive = useRef(true);
  useEffect(() => {
    document.title = 'Choose a new password · Onboard.AI';
    headingRef.current?.focus();
    return () => {
      alive.current = false;
    };
  }, []);
  useFocusFirstError(formRef, errors, summaryRef, summary);
  const set = (key) => (value) => setValues((previous) => ({ ...previous, [key]: value }));

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    const { currentPassword, newPassword, confirmation } = values;
    const found = {};
    if (!currentPassword) found.currentPassword = 'Enter your current password.';
    const problem = passwordProblem(newPassword, account.username);
    if (problem) found.newPassword = problem;
    else if (newPassword === currentPassword)
      found.newPassword = 'Choose a password different from your current one.';
    else if (newPassword !== confirmation) found.confirmation = 'The passwords do not match.';
    // Password fields are emptied after every submit.
    setValues({ currentPassword: '', newPassword: '', confirmation: '' });
    setSummary('');
    if (Object.keys(found).length) {
      setErrors(found);
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      await onChangePassword(currentPassword, newPassword);
    } catch (error) {
      if (!alive.current) return;
      const target = passwordChangeErrorTarget(error.code);
      if (target) setErrors({ [target]: error.message });
      else setSummary(error.message);
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  return (
    <main className="account-standalone">
      <header className="account-bar">
        <AccessBrand />
        <div>
          <span className="account-signed-in">
            Signed in as <strong>{account.username}</strong>
          </span>
          <button type="button" className="account-bar-button" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </header>
      <section className="account-card" aria-labelledby="change-password-heading">
        <span className="access-eyebrow">ONE QUICK STEP</span>
        <h1 id="change-password-heading" tabIndex={-1} ref={headingRef}>
          Choose a new password
        </h1>
        <p>
          Your password was set by HR. Choose your own password before you continue. You will use it
          from now on.
        </p>
        <form className="access-form" onSubmit={submit} ref={formRef} noValidate>
          <SecretField
            id="change-current-password"
            label="Current password"
            autoComplete="current-password"
            value={values.currentPassword}
            onChange={set('currentPassword')}
            error={errors.currentPassword}
          />
          <SecretField
            id="change-new-password"
            label="New password"
            autoComplete="new-password"
            value={values.newPassword}
            onChange={set('newPassword')}
            error={errors.newPassword}
            hint="Use at least 8 characters."
          />
          <SecretField
            id="change-confirm-password"
            label="Confirm new password"
            confirm
            autoComplete="new-password"
            value={values.confirmation}
            onChange={set('confirmation')}
            error={errors.confirmation}
          />
          <div
            className="account-error-summary"
            role="alert"
            tabIndex={-1}
            ref={summaryRef}
            hidden={!summary}
          >
            <Icon name="info" size={18} />
            <p>{summary}</p>
          </div>
          <button className="access-submit" type="submit" disabled={busy}>
            <span>{busy ? 'Saving…' : 'Change password'}</span>
            <Icon name="arrow" size={21} />
          </button>
        </form>
      </section>
    </main>
  );
}
