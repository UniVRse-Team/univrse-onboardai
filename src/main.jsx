import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles/theme.css';
import OnboardingWebsite from './portal/OnboardingWebsite';
import { legacyRedirect } from './access/legacy-paths.mjs';
import './styles/workspace-palette.css';
import './styles/light-theme.css';

// Old preview URLs now lead to the current website sections.
const target = legacyRedirect(window.location.pathname);
if (target) {
  const { search, hash } = window.location;
  window.history.replaceState({}, '', `${target}${search}${hash}`);
}
createRoot(document.getElementById('root')).render(<OnboardingWebsite />);
