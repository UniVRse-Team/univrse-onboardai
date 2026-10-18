import React, { useEffect, useRef, useState } from 'react';
import Icon from '../portal/Icon';
import { AccessBrand } from './LoginPage';
import { defaultHrSection, hrSections } from './hr-navigation.mjs';
import HrEmployees from './HrEmployees';
import HrCompanyKnowledge from './HrCompanyKnowledge';
import HrSettings from './HrSettings';
import HrCompanyProfile from './HrCompanyProfile';
import HrDocumentSubmissions from '../documents/HrDocumentSubmissions';
import { departmentCache } from './use-departments';
import SignedInPeopleSupport from './SignedInPeopleSupport';
import './account-access.css';
import './hr-workspace.css';
import './accounts.css';
import './hr-screen.css';
import './hr-screen-views.css';

export default function HrWorkspace({ account, onSignOut }) {
  const [view, setView] = useState(() =>
    hrSections.some((s) => s.id === window.location.hash.slice(1))
      ? window.location.hash.slice(1)
      : defaultHrSection(),
  );
  useEffect(() => {
    const update = () =>
      setView(
        hrSections.some((s) => s.id === window.location.hash.slice(1))
          ? window.location.hash.slice(1)
          : defaultHrSection(),
      );
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  const headingRef = useRef(null);
  // A new page view starts with a fresh department list.
  useEffect(() => {
    departmentCache.reset();
  }, []);
  function show(id) {
    setView(id);
    window.location.hash = id;
    requestAnimationFrame(() => headingRef.current?.focus());
  }
  return (
    <div className="hr-preview-page hr-screen hr-screen-flow">
      <header className="hr-screen-header">
        <AccessBrand />
        <nav aria-label="HR workspace sections">
          {hrSections.map((section) => (
            <button
              type="button"
              key={section.id}
              aria-pressed={view === section.id}
              onClick={() => show(section.id)}
            >
              <Icon name={section.icon} size={18} />
              {section.label}
            </button>
          ))}
        </nav>
        <div className="account-session">
          {account?.company?.name && (
            <span className="account-company-name">
              <strong>{account.company.name}</strong>
            </span>
          )}
          <span className="account-signed-in">
            Signed in as <strong>{account.username}</strong>
          </span>
          <button type="button" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </header>
      <main className="hr-screen-main" id="hr-main">
        {view === 'accounts' ? (
          <HrEmployees />
        ) : view === 'submissions' ? (
          <HrDocumentSubmissions />
        ) : view === 'people' ? (
          <SignedInPeopleSupport headingRef={headingRef} />
        ) : view === 'profile' ? (
          <HrCompanyProfile headingRef={headingRef} />
        ) : view === 'settings' ? (
          <HrSettings headingRef={headingRef} />
        ) : (
          <HrCompanyKnowledge headingRef={headingRef} />
        )}
      </main>
    </div>
  );
}
