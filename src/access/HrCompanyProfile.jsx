import React, { useCallback, useEffect, useRef, useState } from 'react';
import { accountApi } from './account-api.mjs';
import { ScreenAlert, ScreenFooter, ScreenHeading } from './HrScreenParts';
import { formatDateTime } from './profile-display.mjs';
import { textFields, listFields, lineListFields } from '../admin/company-profile-form.mjs';
import './hr-screen-views.css';
import './account-access.css';

// Read-only Company profile view for HR (Contract #86 §4.4, §8).
export default function HrCompanyProfile({ headingRef }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [updated, setUpdated] = useState(null);
  const sequence = useRef(0);
  const abortRef = useRef(null);

  const load = useCallback(async (quiet = false) => {
    const token = ++sequence.current;
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    if (!quiet) setRefreshing(true);
    try {
      const response = await accountApi.hrCompany({ signal: abort.signal });
      if (token !== sequence.current) return;
      setData(response);
      setError('');
      setUpdated(Date.now());
    } catch (err) {
      if (err.name !== 'AbortError' && token === sequence.current)
        setError(err.message || 'Could not load company profile.');
    } finally {
      if (token === sequence.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
    return () => {
      sequence.current++;
      abortRef.current?.abort();
    };
  }, [load]);

  const profile = data?.profile || {};
  const hasFacts =
    textFields.some((f) => profile[f.key]?.trim?.()) ||
    listFields.some((f) => Array.isArray(profile[f.key]) && profile[f.key].length > 0) ||
    lineListFields.some((f) => Array.isArray(profile[f.key]) && profile[f.key].length > 0);

  return (
    <>
      <ScreenHeading
        headingRef={headingRef}
        kicker="COMPANY PROFILE"
        title={data?.company?.name || 'Company profile'}
        text="Company facts used by Alya to guide onboarding. Platform administrators manage these details in the admin portal."
      >
        {data?.company && (
          <dl className="hr-screen-totals">
            <div>
              <dt>Default HR</dt>
              <dd>{data.defaultHr?.username || 'None'}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{data.company.status === 'disabled' ? 'Disabled' : 'Active'}</dd>
            </div>
          </dl>
        )}
      </ScreenHeading>

      <ScreenAlert message={error} onRetry={() => load()} />

      <div className="hr-profile-view">
        {data && (
          <div className="account-profile-grid">
            <section className="hr-profile-card">
              <h2>Company details</h2>
              <dl>
                <div>
                  <dt>Company name</dt>
                  <dd>{data.company?.name}</dd>
                </div>
                <div>
                  <dt>Company ID</dt>
                  <dd>
                    <code>{data.company?.id}</code>
                  </dd>
                </div>
                <div>
                  <dt>Default HR account</dt>
                  <dd>
                    {data.defaultHr?.username
                      ? `HR ID: ${data.defaultHr.username}`
                      : 'No default HR assigned'}
                  </dd>
                </div>
                {data.updatedAt && (
                  <div>
                    <dt>Profile version</dt>
                    <dd>
                      Version {data.version} · Last updated {formatDateTime(data.updatedAt)}
                      {data.updatedBy?.username ? ` by ${data.updatedBy.username}` : ''}
                    </dd>
                  </div>
                )}
              </dl>
            </section>

            {!hasFacts ? (
              <p className="account-note">
                No corporate profile details have been saved for this company yet. Ask a platform
                administrator to update the company profile.
              </p>
            ) : (
              <>
                {textFields.map((field) => {
                  const val = profile[field.key];
                  if (!val || !val.trim()) return null;
                  return (
                    <section key={field.key} className="hr-profile-card">
                      <h2>{field.label}</h2>
                      <p style={{ whiteSpace: 'pre-wrap' }}>{val}</p>
                    </section>
                  );
                })}

                {listFields.map((field) => {
                  const items = Array.isArray(profile[field.key]) ? profile[field.key] : [];
                  if (!items.length) return null;
                  return (
                    <section key={field.key} className="hr-profile-card">
                      <h2>{field.label}</h2>
                      <div className="hr-profile-items">
                        {items.map((item, idx) => (
                          <div key={idx} className="hr-profile-item">
                            {field.fields.map((part) => {
                              const v = item[part.key];
                              if (!v) return null;
                              return (
                                <div key={part.key}>
                                  <strong>{part.label}: </strong>
                                  <span style={{ whiteSpace: 'pre-wrap' }}>{v}</span>
                                </div>
                              );
                            })}
                          </div>
                        ))}
                      </div>
                    </section>
                  );
                })}

                {lineListFields.map((field) => {
                  const items = Array.isArray(profile[field.key]) ? profile[field.key] : [];
                  if (!items.length) return null;
                  return (
                    <section key={field.key} className="hr-profile-card">
                      <h2>{field.label}</h2>
                      <ul>
                        {items.map((item, idx) => (
                          <li key={idx}>{item}</li>
                        ))}
                      </ul>
                    </section>
                  );
                })}
              </>
            )}
          </div>
        )}
      </div>

      <ScreenFooter
        updated={updated}
        refreshing={refreshing}
        onRefresh={() => load()}
        scope={data?.company?.name || 'Company profile'}
        retention="Read-only view · Managed by platform administrator"
      />
    </>
  );
}
