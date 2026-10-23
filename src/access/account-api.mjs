// Browser client for the account routes (server/account-routes.mjs).
// The session is an HttpOnly cookie that same-origin fetch sends by itself:
// nothing here reads, stores or logs a password or token.

import { createEmployeeBody } from './employee-departments.mjs';

export class AccountApiError extends Error {
  constructor({ status = 0, code = '', message = '', fields = [] }) {
    super(message || 'The request could not be completed. Please try again.');
    this.name = 'AccountApiError';
    this.status = status;
    this.code = code;
    this.fields = Array.isArray(fields) ? fields : [];
  }
}

// What the whole app must do for an error from any route, chat included.
// 'sign-in': the session ended. 'change-password': a forced change is pending.
// 'company-account-required' / 'admin-role-required': a role mismatch; the app
// moves the browser to the page that role may use.
export function accountErrorAction({ status, code } = {}) {
  if (status === 401 && code === 'SESSION_EXPIRED') return 'sign-in';
  if (status === 403 && code === 'PASSWORD_CHANGE_REQUIRED') return 'change-password';
  if (status === 403 && code === 'COMPANY_ACCOUNT_REQUIRED') return 'company-account-required';
  if (status === 403 && code === 'ADMIN_ROLE_REQUIRED') return 'admin-role-required';
  return null;
}

const listeners = new Set();
export function subscribeAccountErrors(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
// Called for every failed response, including chat routes, so one handler can
// send the browser back to sign-in or to the change-password screen.
export function reportAccountResponse(status, data) {
  const action = accountErrorAction({ status, code: data?.code });
  if (action) for (const listener of [...listeners]) listener(action);
  return action;
}

let sessionVerifier = null;
export function registerSessionVerifier(verifier) {
  sessionVerifier = verifier;
  return () => {
    if (sessionVerifier === verifier) sessionVerifier = null;
  };
}
// Resolves false when a signed-in browser no longer has a session. Chat calls
// this before sending so a question is never answered anonymously by mistake.
export async function ensureSession() {
  return sessionVerifier ? sessionVerifier() : true;
}

export const signInNotice = 'Your session ended. Sign in again.';

export function networkErrorMessage() {
  return 'Could not reach the server. Check your connection and try again.';
}

export async function accountRequest(
  path,
  {
    method = 'GET',
    body,
    rawBody,
    headers,
    signal,
    report = true,
    fetchImpl = globalThis.fetch,
  } = {},
) {
  let response;
  try {
    response = await fetchImpl(path, {
      method,
      signal,
      credentials: 'same-origin',
      headers:
        rawBody !== undefined
          ? { ...headers }
          : body === undefined
            ? {}
            : { 'Content-Type': 'application/json' },
      body: rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new AccountApiError({ message: networkErrorMessage() });
  }
  if (response.status === 204) return null;
  let data = null;
  try {
    data = await response.json();
  } catch {}
  if (!response.ok) {
    if (report) reportAccountResponse(response.status, data);
    throw new AccountApiError({
      status: response.status,
      code: data?.code || '',
      message: data?.error || '',
      fields: data?.fields,
    });
  }
  return data;
}

const enc = encodeURIComponent;
export const accountApi = {
  config: (options) => accountRequest('/api/config', options),
  session: (options) => {
    const scope =
      options?.scope ||
      (typeof window !== 'undefined' && window.location.pathname.startsWith('/admin')
        ? 'admin'
        : undefined);
    const path = scope ? `/api/auth/session?scope=${scope}` : '/api/auth/session';
    const headers = scope ? { ...options?.headers, 'X-Session-Scope': scope } : options?.headers;
    return accountRequest(path, { ...options, headers });
  },
  signIn: (username, password) =>
    accountRequest('/api/auth/sign-in', { method: 'POST', body: { username, password } }),
  signOut: (options) => {
    const scope =
      options?.scope ||
      (typeof window !== 'undefined' && window.location.pathname.startsWith('/admin')
        ? 'admin'
        : undefined);
    const path = scope ? `/api/auth/sign-out?scope=${scope}` : '/api/auth/sign-out';
    const headers = scope ? { ...options?.headers, 'X-Session-Scope': scope } : options?.headers;
    return accountRequest(path, { method: 'POST', ...options, headers });
  },
  changePassword: (currentPassword, newPassword) =>
    accountRequest('/api/auth/password', {
      method: 'POST',
      body: { currentPassword, newPassword },
    }),
  myProfile: (options) => accountRequest('/api/me/profile', options),
  listEmployees: (options) => accountRequest('/api/hr/employees', options),
  // The server assigns the Employee ID and a temporary password: -> { employee, temporaryPassword }
  createEmployee: (profile) =>
    accountRequest('/api/hr/employees', { method: 'POST', body: createEmployeeBody(profile) }),
  // Raw file bytes, the same pattern as the guest document upload.
  autofillProfile: (file, signal) =>
    accountRequest('/api/hr/employees/autofill', {
      method: 'POST',
      rawBody: file,
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-File-Name': enc(file.name),
      },
      signal,
    }),
  employee: (id, options) => accountRequest('/api/hr/employees/' + enc(id), options),
  saveProfile: (id, profile) =>
    accountRequest('/api/hr/employees/' + enc(id) + '/profile', {
      method: 'PUT',
      body: { profile },
    }),
  resetPassword: (id, temporaryPassword) =>
    accountRequest('/api/hr/employees/' + enc(id) + '/password', {
      method: 'POST',
      body: { temporaryPassword },
    }),
  deleteEmployee: (id) => accountRequest('/api/hr/employees/' + enc(id), { method: 'DELETE' }),
  listDepartments: (options) => accountRequest('/api/hr/departments', options),
  createDepartment: (department) =>
    accountRequest('/api/hr/departments', { method: 'POST', body: department }),
  // body holds only the changed fields: { name?, prefix?, archived? }
  updateDepartment: (id, body) =>
    accountRequest('/api/hr/departments/' + enc(id), { method: 'PATCH', body }),
  setStatus: (id, status) =>
    accountRequest('/api/hr/employees/' + enc(id) + '/status', {
      method: 'PUT',
      body: { status },
    }),
  hrCompany: (options) => accountRequest('/api/hr/company', options),
  publicCompany: (companyId, options) =>
    accountRequest('/api/auth/companies/' + enc(companyId), { report: false, ...options }),
};
