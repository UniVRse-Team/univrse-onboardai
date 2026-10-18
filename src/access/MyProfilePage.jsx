import React, { useEffect, useRef, useState } from 'react';
import { accountApi } from './account-api.mjs';
import { formatDateTime, profileSections } from './profile-display.mjs';
import './accounts.css';

export default function MyProfilePage({ account }) {
  const [state, setState] = useState({ status: 'loading', profile: null, error: '' });
  const headingRef = useRef(null);
  useEffect(() => {
    const abort = new AbortController();
    accountApi
      .myProfile({ signal: abort.signal })
      .then((data) => setState({ status: 'ready', profile: data.profile, error: '' }))
      .catch((error) => {
        if (error.name !== 'AbortError')
          setState({ status: 'error', profile: null, error: error.message });
      });
    return () => abort.abort();
  }, []);
  useEffect(() => {
    if (state.status !== 'loading') headingRef.current?.focus({ preventScroll: true });
  }, [state.status]);
  return (
    <section className="account-profile" aria-labelledby="my-profile-heading">
      <header className="uv-page-heading">
        <div>
          <span className="uv-eyebrow">
            {account?.company?.name ? `${account.company.name.toUpperCase()} · ` : ''}
            SIGNED IN AS {account.username.toUpperCase()}
          </span>
          <h1 id="my-profile-heading" tabIndex={-1} ref={headingRef}>
            My profile
          </h1>
          <p>Ask HR to update these details.</p>
        </div>
      </header>
      {state.status === 'loading' && <p role="status">Loading your profile…</p>}
      {state.status === 'error' && <p role="alert">{state.error}</p>}
      {state.status === 'ready' && !state.profile && (
        <p className="account-note">
          HR accounts do not have an employee profile. Employee details are kept for employee
          accounts only.
        </p>
      )}
      {state.status === 'ready' && state.profile && (
        <>
          <div className="account-profile-grid">
            {profileSections(state.profile).map((section) => (
              <section key={section.key} aria-labelledby={'my-profile-' + section.key}>
                <h2 id={'my-profile-' + section.key}>{section.title}</h2>
                <dl>
                  {section.rows.map((row) => (
                    <div key={row.key}>
                      <dt>{row.label}</dt>
                      <dd>{row.value || <span className="account-empty">Not provided</span>}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
          {state.profile.updatedAt && (
            <p className="account-note">Last updated {formatDateTime(state.profile.updatedAt)}.</p>
          )}
        </>
      )}
    </section>
  );
}
