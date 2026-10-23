import React, { useCallback, useEffect, useRef, useState } from 'react';
import { journeyApi } from '../access/journey-api.mjs';
import { hasWordFile } from './company-documents-model.mjs';

// Loads the signed-in company's documents once for the page that calls it.
// An empty list is not an error; a failed load can be retried.
export function useCompanyDocuments() {
  const [state, setState] = useState({ status: 'loading', documents: [] });
  const alive = useRef(true);
  const load = useCallback(() => {
    setState((s) => ({ ...s, status: 'loading' }));
    journeyApi
      .companyDocuments()
      .then((data) => {
        if (alive.current)
          setState({
            status: 'ready',
            documents: Array.isArray(data?.documents) ? data.documents : [],
          });
      })
      .catch(() => alive.current && setState({ status: 'error', documents: [] }));
  }, []);
  useEffect(() => {
    alive.current = true;
    load();
    return () => {
      alive.current = false;
    };
  }, [load]);
  return { ...state, retry: load };
}

// A block of document links. Renders nothing while loading or when there are none.
export default function CompanyDocuments({ title = 'Company documents', documents, state, retry }) {
  if (state === 'error' && retry)
    return (
      <p role="status" className="fp-muted">
        Company documents could not be loaded.{' '}
        <button type="button" className="fp-action" onClick={retry}>
          Try again
        </button>
      </p>
    );
  if (!documents?.length) return null;
  return (
    <section className="learning-resource" aria-label={title}>
      <h4>{title}</h4>
      <ul className="company-documents">
        {documents.map((doc) => (
          <li key={doc.id}>
            <span>{doc.title}</span>{' '}
            <a
              className="fp-action"
              href={doc.viewUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={'View ' + doc.title}
            >
              View
            </a>
          </li>
        ))}
      </ul>
      {hasWordFile(documents) && (
        <p className="fp-muted">Word files download; PDFs open in a new tab.</p>
      )}
    </section>
  );
}
