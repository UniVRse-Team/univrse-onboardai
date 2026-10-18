import React from 'react';
import { FieldError } from './account-fields';
import { departmentCache } from './use-departments';
import {
  departmentOptions,
  departmentPlaceholder,
  idFormatHint,
  selectedDepartment,
} from './employee-departments.mjs';

// Department <select>. `departments` come from the API (null while loading).
// `legacy` is the stored text of an employee being edited (shown as an extra
// "(current)" option when it is not an active department).
// `showIdHint` adds the "IDs look like PE-0001" hint on the add form.
export default function DepartmentField({
  id,
  label,
  value,
  onChange,
  error,
  required,
  departments = null,
  loadError = '',
  legacy = '',
  showIdHint = false,
  fromDocument = false,
  note = '',
}) {
  const hint = showIdHint ? idFormatHint(departments, value) : '';
  const hintId = hint ? id + '-hint' : '';
  const errorId = error ? id + '-error' : '';
  const markId = fromDocument ? id + '-mark' : '';
  const noteId = note ? id + '-note' : '';
  const described = [hintId, errorId, markId, noteId].filter(Boolean).join(' ') || undefined;
  return (
    <div className="access-field account-field">
      <label htmlFor={id}>
        {label}
        {required && <span className="account-required"> (required)</span>}
      </label>
      <select
        id={id}
        name={id}
        className="account-select"
        value={selectedDepartment(departments, value, legacy)}
        onChange={(event) => onChange(event.target.value)}
        aria-required={required || undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={described}
        disabled={!departments}
      >
        <option value="">
          {departments
            ? departments.length === 0
              ? 'Add a department in Settings first'
              : departmentPlaceholder
            : loadError
              ? 'Departments unavailable'
              : 'Loading departments…'}
        </option>
        {departmentOptions(departments, legacy).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {loadError && (
        <p className="account-field-error" role="alert">
          {loadError}{' '}
          <button
            type="button"
            className="account-link-button"
            onClick={() => departmentCache.invalidate()}
          >
            Try again
          </button>
        </p>
      )}
      {hint && (
        <p className="account-field-hint" id={hintId}>
          {hint}
        </p>
      )}
      <FieldError id={errorId} message={error} />
      {fromDocument && (
        <p className="account-field-mark" id={markId}>
          From document, please check
        </p>
      )}
      {note && (
        <p className="account-field-note" id={noteId}>
          {note}
        </p>
      )}
    </div>
  );
}
