import React from 'react';

export default function OnboardAiBrand() {
  return (
    <span className="onboard-brand" aria-label="Onboard.AI">
      <svg className="onboard-brand-mark" viewBox="0 0 64 64" fill="none" aria-hidden="true">
        <circle cx="32" cy="32" r="31" fill="currentColor" />
        <path d="M18 56V18l29-9v44l-6-4V19l-17 5v32Z" fill="var(--brand-cutout, #f7fafd)" />
        <circle cx="32" cy="32" r="6" fill="var(--brand-cutout, #f7fafd)" />
        <path d="M24 58V47a8 8 0 0 1 16 0v9l8 4Z" fill="var(--brand-cutout, #f7fafd)" />
      </svg>
      <span className="onboard-brand-name">
        Onboard.<span>AI</span>
      </span>
    </span>
  );
}
