import { useCallback, useEffect, useRef, useState } from 'react';
import {
  accountApi,
  registerSessionVerifier,
  signInNotice,
  subscribeAccountErrors,
} from './account-api.mjs';
import { afterAccountAction, sessionCheckOutcome } from './account-routing.mjs';
import { shouldNavigateAfterSignOut, signedOutPath } from './sign-out-destination.mjs';

export function filterAccountByPath(
  account,
  pathname = typeof window !== 'undefined' ? window.location.pathname : '',
) {
  if (!account) return null;
  const isAdminPath = pathname.startsWith('/admin');
  if (isAdminPath && account.role !== 'admin') return null;
  if (!isAdminPath && account.role === 'admin') return null;
  return account;
}

// Account state for the whole site. `accounts` is null until /api/config answers.
// With accounts off (or unreachable) nothing else is ever requested.
export default function useAccountSession({ onNavigate }) {
  const [state, setState] = useState({ accounts: null, loading: true, account: null, notice: '' });
  const navigateRef = useRef(onNavigate);
  navigateRef.current = onNavigate;
  const accountRef = useRef(null);
  accountRef.current = state.account;

  useEffect(() => {
    let live = true;
    const unsubscribe = subscribeAccountErrors((action) => {
      const result = afterAccountAction(action, accountRef.current);
      if (action === 'sign-in' && !accountRef.current) return;
      setState((s) => ({
        ...s,
        account: result.account,
        notice: result.notice ? signInNotice : s.notice,
      }));
      if (result.to) {
        navigateRef.current(action === 'sign-in' ? signedOutPath(accountRef.current) : result.to);
      }
    });
    (async () => {
      let accounts = false;
      try {
        accounts = (await accountApi.config()).accounts === true;
      } catch {}
      if (!accounts) {
        if (live) setState({ accounts: false, loading: false, account: null, notice: '' });
        return;
      }
      try {
        const res = await accountApi.session({ report: false });
        const account = filterAccountByPath(res.account);
        if (live) setState({ accounts: true, loading: false, account, notice: '' });
      } catch (error) {
        if (live)
          setState({
            accounts: true,
            loading: false,
            account: null,
            notice: error.code === 'SESSION_EXPIRED' ? signInNotice : '',
          });
      }
    })();
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  // While the page believes it is signed in, confirm the cookie still works on
  // focus and before chat sends, so a vanished cookie is not mistaken for a session.
  useEffect(() => {
    let checking = null;
    async function verify() {
      const current = accountRef.current;
      if (!current) return true;
      if (!checking)
        checking = (async () => {
          let result;
          try {
            result = await accountApi.session({ report: false });
            if (result?.account) {
              result = { ...result, account: filterAccountByPath(result.account) };
            }
          } catch (error) {
            result = error.name === 'AbortError' || !error.status ? { network: true } : { error };
          }
          const outcome = result.network ? { type: 'ok' } : sessionCheckOutcome(current, result);
          if (outcome.type === 'expired') {
            setState((s) => ({ ...s, account: null, notice: signInNotice }));
            navigateRef.current(signedOutPath(current));
          } else if (outcome.type === 'update')
            setState((s) => ({ ...s, account: outcome.account }));
          return outcome.type !== 'expired';
        })().finally(() => {
          checking = null;
        });
      return checking;
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') verify();
    };
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    const unregister = registerSessionVerifier(verify);
    return () => {
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
      unregister();
    };
  }, []);

  // Chat reads /api/config itself; fetching it here keeps `accounts` current.
  const refreshConfig = useCallback(async () => {
    try {
      const config = await accountApi.config();
      setState((s) => ({ ...s, accounts: config.accounts === true }));
    } catch {}
  }, []);

  const signIn = useCallback(
    async (username, password) => {
      setState((s) => ({ ...s, notice: '' }));
      const { account } = await accountApi.signIn(username, password);
      setState((s) => ({ ...s, account: filterAccountByPath(account), notice: '' }));
      refreshConfig();
      return account;
    },
    [refreshConfig],
  );
  const changePassword = useCallback(
    async (currentPassword, newPassword) => {
      const { account } = await accountApi.changePassword(currentPassword, newPassword);
      setState((s) => ({ ...s, account }));
      refreshConfig();
      return account;
    },
    [refreshConfig],
  );
  const signOut = useCallback(async (options) => {
    const previous = accountRef.current;
    try {
      await accountApi.signOut();
    } catch {}
    setState((s) => ({ ...s, account: null, notice: '' }));
    if (shouldNavigateAfterSignOut(options)) navigateRef.current(signedOutPath(previous));
  }, []);
  // Ends a session the sign-in page itself rejected, staying put to show why.
  const discardSignIn = useCallback(() => signOut({ navigate: false }), [signOut]);

  return { ...state, signIn, changePassword, signOut, discardSignIn };
}
