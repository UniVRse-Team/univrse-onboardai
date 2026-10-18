import React, { useEffect, useRef, useState } from 'react';
import Icon from '../portal/Icon';
import OnboardAiBrand from '../brand/OnboardAiBrand';
import { alyaPosterUrl } from '../avatar/avatar-poster.mjs';
import { accountApi } from './account-api.mjs';
import './account-access.css';

export function AccessBrand() {
  return <OnboardAiBrand />;
}

export function PasswordField({
  id,
  label,
  confirm = false,
  value,
  onChange,
  autoComplete,
  describedBy,
  invalid = false,
  placeholder,
  minLength,
  maxLength,
  name,
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="access-field">
      <label htmlFor={id}>{label}</label>
      <div className="access-password">
        <input
          id={id}
          name={name || (confirm ? 'confirmPassword' : 'password')}
          type={visible ? 'text' : 'password'}
          autoComplete={
            autoComplete || (confirm || id.includes('signup') ? 'new-password' : 'current-password')
          }
          placeholder={
            placeholder || (confirm ? 'Enter your password again' : 'Enter your password')
          }
          minLength={minLength ?? (id.includes('signup') ? 8 : undefined)}
          maxLength={maxLength ?? 128}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          required
          value={value}
          onChange={onChange}
        />
        <button
          type="button"
          onClick={() => setVisible(!visible)}
          aria-label={(visible ? 'Hide ' : 'Show ') + label.toLowerCase()}
          aria-pressed={visible}
        >
          {visible ? 'Hide' : 'Show'}
        </button>
      </div>
    </div>
  );
}

function AccountForm({
  role,
  onSignIn,
  onSignOut,
  sessionNotice,
  accounts,
  tenantCompanyId,
  tenantCompany,
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [notice, setNotice] = useState(sessionNotice || '');
  const [isError, setIsError] = useState(false);
  const [busy, setBusy] = useState(false);
  const noticeRef = useRef(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    if (sessionNotice) requestAnimationFrame(() => noticeRef.current?.focus());
    return () => {
      alive.current = false;
    };
  }, []);
  const heading = role === 'hr' ? 'Support a better start.' : 'Welcome back.';
  function announce(message, error = false) {
    setNotice(message);
    setIsError(error);
    requestAnimationFrame(() => noticeRef.current?.focus());
  }
  async function signIn(event) {
    event.preventDefault();
    if (busy || !accounts) return;
    const submitted = password;
    // The password never stays in the form after a submit, whatever the result.
    setPassword('');
    setBusy(true);
    setNotice('');
    try {
      const result = await onSignIn(username.trim(), submitted);
      if (tenantCompanyId && result?.account) {
        if (result.account.role !== 'admin' && result.account.companyId !== tenantCompanyId) {
          if (onSignOut) await onSignOut();
          const targetName = tenantCompany?.name || tenantCompanyId;
          announce(
            `This account belongs to another organization. Please sign in with an account from ${targetName}.`,
            true,
          );
          return;
        }
      }
    } catch (error) {
      if (alive.current) announce(error.message, true);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <>
      <div className="access-form-heading">
        <span className="access-eyebrow">
          {role === 'hr' ? 'HR WORKSPACE' : 'EMPLOYEE WORKSPACE'}
        </span>
        <h1>{heading}</h1>
        <p>
          {role === 'hr'
            ? tenantCompany?.name
              ? `Sign in to ${tenantCompany.name}’s HR workspace.`
              : 'Sign in to your company’s HR workspace.'
            : tenantCompany?.name
              ? `A clearer next step at ${tenantCompany.name} starts here.`
              : 'A clearer next step starts here.'}
        </p>
      </div>
      <form className="access-form" onSubmit={signIn}>
        <div className="access-field">
          <label htmlFor="access-id">{role === 'hr' ? 'HR ID' : 'Employee ID'}</label>
          <input
            id="access-id"
            name={role === 'hr' ? 'hrId' : 'employeeId'}
            type="text"
            autoComplete="username"
            autoCapitalize="off"
            spellCheck={false}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            aria-describedby={isError && notice ? 'access-notice' : undefined}
            aria-invalid={isError && notice ? true : undefined}
            placeholder={role === 'hr' ? 'Enter your HR ID' : 'Enter your employee ID'}
            maxLength={64}
            pattern=".*\S.*"
            title={
              role === 'hr'
                ? 'Enter your company-issued HR ID.'
                : 'Enter your company-issued employee ID.'
            }
            required
          />
        </div>
        <PasswordField
          id="access-password"
          label="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          describedBy={isError && notice ? 'access-notice' : undefined}
          invalid={isError && !!notice}
          maxLength={200}
        />
        <button
          className="access-forgot"
          type="button"
          onClick={() =>
            announce('Ask HR to reset your password. HR will give you a temporary password.')
          }
        >
          Forgot password?
        </button>
        <button
          className="access-submit"
          type="submit"
          disabled={busy || !accounts}
          aria-describedby={!accounts ? 'access-unavailable' : undefined}
        >
          <span>{busy ? 'Signing in…' : 'Sign in as ' + (role === 'hr' ? 'HR' : 'employee')}</span>
          <Icon name="arrow" size={21} />
        </button>
      </form>
      {!accounts && (
        <div className="access-notice" id="access-unavailable" role="status">
          <Icon name="info" size={18} />
          <p>Sign-in is unavailable until the account service is configured.</p>
        </div>
      )}
      <div
        className={'access-notice' + (isError ? ' is-error' : '')}
        id="access-notice"
        role={isError ? 'alert' : 'status'}
        tabIndex={-1}
        ref={noticeRef}
        hidden={!notice}
      >
        <Icon name="info" size={18} />
        <p>{notice}</p>
      </div>
      {role === 'employee' ? (
        <p className="access-hr-note" id="access-ask-hr">
          <strong>Ask HR for your account.</strong> HR creates your Employee ID and a temporary
          password for you.
        </p>
      ) : (
        <p className="access-hr-note">Use the HR ID provided by your company.</p>
      )}
    </>
  );
}

export default function LoginPage({
  navigate,
  accounts = false,
  onSignIn,
  onSignOut,
  sessionNotice = '',
  tenantCompanyId = null,
}) {
  const [role, setRole] = useState('employee');
  const [tenantCompany, setTenantCompany] = useState(null);
  const [companyError, setCompanyError] = useState('');

  useEffect(() => {
    let cancelled = false;
    if (tenantCompanyId) {
      accountApi
        .publicCompany(tenantCompanyId)
        .then((data) => {
          if (!cancelled && data?.company) setTenantCompany(data.company);
        })
        .catch((err) => {
          if (!cancelled) {
            setCompanyError(
              err.status === 404
                ? 'Company workspace not found.'
                : err.status === 403
                  ? 'This company workspace is currently disabled.'
                  : 'Could not load company details.',
            );
          }
        });
    }
    return () => {
      cancelled = true;
    };
  }, [tenantCompanyId]);

  const companyDisplayName =
    tenantCompany?.name || (tenantCompanyId ? tenantCompanyId.toUpperCase() : '');

  return (
    <main className="access-page">
      <a className="access-skip" href="#access-form-area">
        Skip to sign-in options
      </a>
      <section className="access-introduction" aria-label="Welcome to OnboardAi">
        <a
          href="/login"
          onClick={(e) => {
            if (!e.metaKey && !e.ctrlKey) {
              e.preventDefault();
              navigate(tenantCompanyId ? `/companies/${tenantCompanyId}` : '/login');
            }
          }}
          aria-label="OnboardAi welcome"
        >
          <AccessBrand />
        </a>
        <div className="access-intro-copy">
          <span className="access-eyebrow">
            {tenantCompanyId
              ? `${companyDisplayName.toUpperCase()} ONBOARDING WORKSPACE`
              : 'A GOOD START LOOKS DIFFERENT FOR EVERYONE'}
          </span>
          <h2>
            {tenantCompanyId ? (
              <>
                Welcome to
                <br />
                <span>{companyDisplayName}.</span>
              </>
            ) : (
              <>
                Your next chapter.
                <br />
                <span>Your way.</span>
              </>
            )}
          </h2>
          <p>
            {tenantCompanyId
              ? `Meet Alya, your AI onboarding assistant for ${companyDisplayName}. Ask questions, complete tasks, and settle in.`
              : 'Meet Alya. Ask a question, find your next step, and settle in at your own pace.'}
          </p>
        </div>
        <div className="access-alya-scene">
          <div className="access-scene-line" aria-hidden="true" />
          <div className="access-avatar-frame">
            <img src={alyaPosterUrl} alt="Alya, your virtual onboarding companion" />
          </div>
          <div className="access-alya-caption">
            <span className="access-presence-dot" />
            <span>
              Alya<small>Your onboarding companion</small>
            </span>
            <Icon name="chat" size={24} />
          </div>
          <div className="access-scene-note">
            <span>01 / ONE STEP AT A TIME</span>
            <p>
              A little clarity.
              <br />A better beginning.
            </p>
          </div>
        </div>
        <div className="access-intro-footer">
          <span>TEXT. VOICE. VISUAL GUIDANCE.</span>
          <span>
            YOUR NEXT CHAPTER
            <Icon name="arrow" size={15} />
          </span>
        </div>
      </section>
      <section className="access-form-side" id="access-form-area" aria-label="Account access">
        <div className="access-top-note">
          <span className="access-presence-dot" />{' '}
          {tenantCompanyId
            ? `${companyDisplayName.toUpperCase()} WORKSPACE`
            : 'YOUR ONBOARDING SPACE'}
        </div>
        {companyError && (
          <div
            className="access-notice is-error"
            role="alert"
            style={{ margin: '0 24px 16px', display: 'flex' }}
          >
            <Icon name="info" size={18} />
            <p>{companyError} Check your link or contact your company administrator.</p>
          </div>
        )}
        <div className="access-form-container">
          <fieldset className="access-role-options">
            <legend>Choose your workspace</legend>
            {['employee', 'hr'].map((value) => (
              <label key={value} className={role === value ? 'is-selected' : ''}>
                <input
                  type="radio"
                  name="workspace"
                  value={value}
                  checked={role === value}
                  onChange={() => setRole(value)}
                />
                <Icon name={value === 'hr' ? 'people' : 'user'} size={18} />
                <span>{value === 'hr' ? 'HR team' : 'Employee'}</span>
              </label>
            ))}
          </fieldset>
          <AccountForm
            key={role}
            role={role}
            onSignIn={onSignIn}
            onSignOut={onSignOut}
            sessionNotice={sessionNotice}
            accounts={accounts}
            tenantCompanyId={tenantCompanyId}
            tenantCompany={tenantCompany}
          />
        </div>
        <p className="access-form-footer">A space to ask. A way to move forward.</p>
      </section>
    </main>
  );
}
