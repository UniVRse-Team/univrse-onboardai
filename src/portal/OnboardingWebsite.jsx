import React, { useEffect, useRef, useState } from 'react';
import Icon from './Icon';
import OnboardAiBrand from '../brand/OnboardAiBrand';
import { navigation, supportTeams } from './website-content';
import LoginPage from '../access/LoginPage';
import HrWorkspace from '../access/HrWorkspace';
import ChangePasswordPage from '../access/ChangePasswordPage';
import MyProfilePage from '../access/MyProfilePage';
import EmployeeFootprint from './EmployeeFootprint';
import ActivityPage from './ActivityPage';
import { activityIdFromPath } from './activity-model.mjs';
import useAccountSession from '../access/use-account-session';
import { landingPath, routeDecision } from '../access/account-routing.mjs';
import { readNotes, writeNotes } from './support-notes.mjs';
import './website.css';

const AlyaChatPage = React.lazy(() => import('../avatar/AlyaChatPage'));

function Link({ to, navigate, children, ...props }) {
  return (
    <a
      href={to}
      {...props}
      onClick={(event) => {
        if (
          event.button === 0 &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.shiftKey &&
          !event.altKey
        ) {
          event.preventDefault();
          navigate(to);
        }
      }}
    >
      {children}
    </a>
  );
}
function Brand() {
  return <OnboardAiBrand />;
}
function Label({ children }) {
  return <span className="uv-eyebrow">{children}</span>;
}
function TileIcon({ icon, color = 'pink', size = 22 }) {
  return (
    <span className={'uv-tile-icon ' + color}>
      <Icon name={icon} size={size} />
    </span>
  );
}
function PageHeading({ number, eyebrow, title, description, children }) {
  return (
    <header className="uv-page-heading">
      <div>
        <Label>
          <span className="uv-page-number">{number}</span>
          {eyebrow}
        </Label>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {children}
    </header>
  );
}
function Modal({ title, children, onClose, wide = false }) {
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog.showModal();
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      dialog.close();
      document.body.style.overflow = previous;
    };
  }, []);
  return (
    <dialog
      className={'uv-dialog ' + (wide ? 'wide' : '')}
      ref={ref}
      aria-labelledby="uv-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <div className="uv-dialog-heading">
        <h2 id="uv-dialog-title">{title}</h2>
        <button className="uv-icon-button" aria-label="Close dialog" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      {children}
    </dialog>
  );
}
function Support({ notes, onNote, onDelete, notify, initialTeam }) {
  const [team, setTeam] = useState(initialTeam || 'manager'),
    [text, setText] = useState(''),
    [expanded, setExpanded] = useState(initialTeam || 'manager');
  const formRef = useRef(null);
  useEffect(() => {
    if (initialTeam) {
      setTeam(initialTeam);
      setExpanded(initialTeam);
      formRef.current?.scrollIntoView({ block: 'center' });
    }
  }, [initialTeam]);
  function prepare(id) {
    setTeam(id);
    formRef.current?.scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'instant'
        : 'smooth',
      block: 'center',
    });
    formRef.current?.querySelector('textarea')?.focus({ preventScroll: true });
  }
  function save(event) {
    event.preventDefault();
    if (!text.trim()) return;
    onNote({ id: Date.now().toString(), team, text: text.trim(), date: new Date().toISOString() });
    setText('');
    notify('Note saved on this device. Share it through your company support channel.');
  }
  async function copy(note) {
    try {
      await navigator.clipboard.writeText(note.text);
      notify('Support note copied.');
    } catch {
      notify('Select the note text to copy it manually.');
    }
  }
  return (
    <>
      <PageHeading
        number="02"
        eyebrow="YOUR PEOPLE"
        title={
          <>
            You’ve got questions.
            <br />
            <em>We’ve got people.</em>
          </>
        }
        description="Knowing who to ask makes a new place feel familiar."
      />
      <div className="uv-people-layout">
        <aside className="uv-people-intro">
          <div className="uv-people-symbol" aria-hidden="true">
            <span>U</span>
            <span>+</span>
            <span>US</span>
          </div>
          <Label>START A CONVERSATION</Label>
          <h2>
            A little help.
            <br />A big difference.
          </h2>
          <p>
            Start with your manager or buddy. They can introduce you to the right person and confirm
            current contacts.
          </p>
          <span className="uv-people-status">
            <span className="uv-small-dot mint" /> CONTACTS CONFIRMED BY YOUR TEAM
          </span>
        </aside>
        <div className="uv-directory">
          {supportTeams.map((item, index) => (
            <section
              className={'uv-person ' + (expanded === item.id ? 'expanded' : '')}
              key={item.id}
            >
              <button
                className="uv-person-heading"
                aria-expanded={expanded === item.id}
                aria-controls={'team-' + item.id}
                onClick={() => setExpanded(expanded === item.id ? null : item.id)}
              >
                <span className="uv-person-index">0{index + 1}</span>
                <TileIcon icon={item.icon} color={item.color} />
                <span>
                  <strong>{item.title}</strong>
                  <small>{item.subtitle}</small>
                </span>
                <Icon name={expanded === item.id ? 'close' : 'down'} size={20} />
              </button>
              <div
                id={'team-' + item.id}
                hidden={expanded !== item.id}
                className="uv-person-details"
              >
                <div className="uv-topic-list">
                  {item.topics.map((topic) => (
                    <span key={topic}>{topic}</span>
                  ))}
                </div>
                <p>{item.instruction}</p>
                <button className="uv-text-link" onClick={() => prepare(item.id)}>
                  Prepare your question <Icon name="arrow" size={18} />
                </button>
              </div>
            </section>
          ))}
        </div>
      </div>
      <div className="uv-support-note-grid">
        <section className="uv-support-form" ref={formRef}>
          <Label>A CLEAR QUESTION IS A GOOD START</Label>
          <h2>Put it into words.</h2>
          <p>Save a note here, then share it through the company’s approved support channel.</p>
          <form onSubmit={save}>
            <label>
              Who is this for?
              <select value={team} onChange={(event) => setTeam(event.target.value)}>
                {supportTeams.map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.title}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Your question
              <textarea
                value={text}
                onChange={(event) => setText(event.target.value)}
                rows={4}
                maxLength={1200}
                placeholder="What do you need help with?"
                required
              />
            </label>
            <p className="uv-form-hint">
              <Icon name="shield" size={15} />
              No passwords or private employee information. Notes stay on this device and are not
              sent.
            </p>
            <button className="uv-button primary" disabled={!text.trim()}>
              Save support note <Icon name="arrow" size={18} />
            </button>
          </form>
        </section>
        <aside className="uv-saved-notes">
          <div className="uv-section-heading">
            <h2>Your notes.</h2>
            <span>{notes.length.toString().padStart(2, '0')}</span>
          </div>
          {notes.length ? (
            notes.map((note) => (
              <article className="uv-saved-note" key={note.id}>
                <Label>{supportTeams.find((item) => item.id === note.team)?.title}</Label>
                <p>{note.text}</p>
                <div>
                  <button onClick={() => copy(note)}>
                    <Icon name="copy" size={14} />
                    Copy
                  </button>
                  <button onClick={() => onDelete(note.id)}>Delete</button>
                </div>
              </article>
            ))
          ) : (
            <div className="uv-note-empty">
              <Icon name="chat" size={36} />
              <h3>
                A blank page.
                <br />A fresh conversation.
              </h3>
              <p>Your saved questions will appear here.</p>
            </div>
          )}
        </aside>
      </div>
    </>
  );
}

function AssistantPage({ navigate, accountId = '' }) {
  return (
    <React.Suspense
      fallback={
        <div className="uv-empty">
          <Icon name="spark" size={30} />
          <h1>Getting Alya ready…</h1>
        </div>
      }
    >
      <AlyaChatPage key={accountId} navigate={navigate} />
    </React.Suspense>
  );
}

function SearchModal({ onClose, navigate }) {
  const [query, setQuery] = useState('');
  const entries = [
    ...navigation.map((item) => ({
      title: item.label,
      type: 'Page',
      icon: item.icon,
      path: item.path,
    })),
  ];
  const results = query.trim()
    ? entries
        .filter((item) =>
          (item.title + ' ' + (item.keywords || ''))
            .toLowerCase()
            .includes(query.toLowerCase().trim()),
        )
        .slice(0, 9)
    : entries.slice(0, 6);
  return (
    <Modal title="Find your next step" onClose={onClose} wide>
      <div className="uv-command-input">
        <Icon name="search" />
        <input
          aria-label="Search pages"
          placeholder="Search your workspace…"
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <p className="uv-search-caption">{query ? 'MATCHING RESULTS' : 'QUICK NAVIGATION'}</p>
      <div className="uv-search-results">
        {results.map((item) => (
          <button key={item.type + item.title} onClick={() => navigate(item.path)}>
            <TileIcon icon={item.icon} />
            <span>
              {item.title}
              <small>{item.type}</small>
            </span>
            <Icon name="arrow" size={17} />
          </button>
        ))}
        {!results.length && (
          <div className="uv-empty">
            <h3>No results for “{query}”</h3>
            <p>Try a short topic such as tools, team or profile.</p>
          </div>
        )}
      </div>
    </Modal>
  );
}

export default function OnboardingWebsite() {
  const [path, setPath] = useState(window.location.pathname),
    [notes, setNotes] = useState([]),
    [dialog, setDialog] = useState(null),
    [mobile, setMobile] = useState(false),
    [toast, setToast] = useState(''),
    [supportTeam, setSupportTeam] = useState(null);
  const mainRef = useRef(null),
    toastTimer = useRef(null);
  const session = useAccountSession({ onNavigate: (to) => navigate(to) });
  const account = session.account;
  // Private support notes: this browser only, keyed by account (see support-notes.mjs).
  useEffect(() => {
    setNotes(
      readNotes(
        localStorage,
        account?.id,
        supportTeams.map((team) => team.id),
      ),
    );
  }, [account?.id]);
  const navItems =
    account?.role === 'employee'
      ? [...navigation, { path: '/profile', label: 'My profile', short: 'Profile', icon: 'user' }]
      : navigation;
  const decision = routeDecision({
    accounts: session.accounts,
    loading: session.loading,
    account,
    path,
  });
  const assistantPath = path === '/alya';
  const activityId = activityIdFromPath(path);
  const chatPath = '/alya';
  const active = navItems.find(
    (item) => item.path === (assistantPath ? '/alya' : activityId ? '/onboarding' : path),
  );
  useEffect(() => {
    const pop = () => {
      let next = window.location.pathname;
      if (next === '/guide' || next.startsWith('/guide/')) {
        next = '/alya';
        window.history.replaceState({}, '', next);
      }
      if (['/chat', '/avatar-preview', '/about', '/resources'].includes(next)) {
        next = '/alya';
        window.history.replaceState({}, '', next);
      }
      setPath(next);
      setDialog(null);
      setMobile(false);
      setSupportTeam(null);
    };
    window.addEventListener('popstate', pop);
    return () => {
      window.removeEventListener('popstate', pop);
      clearTimeout(toastTimer.current);
    };
  }, []);
  useEffect(() => {
    const accessTitle =
      path === '/' || path === '/login'
        ? 'Welcome'
        : path === '/signup'
          ? 'Create an employee account'
          : path === '/hr'
            ? 'HR workspace'
            : null;
    document.title = (accessTitle || active?.label || 'Page not found') + ' · Onboard.AI';
  }, [path, account?.role]);
  useEffect(() => {
    // Sign-in state decides some landing pages; replace so Back does not loop.
    if (decision.type !== 'redirect' || decision.to === path) return;
    window.history.replaceState({}, '', decision.to);
    setPath(decision.to);
  }, [decision.type, decision.to, path]);
  useEffect(() => {
    const keys = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setDialog({ type: 'search' });
      }
      if (event.key === 'Escape') setMobile(false);
    };
    document.addEventListener('keydown', keys);
    return () => document.removeEventListener('keydown', keys);
  }, []);
  function notify(message) {
    setToast(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 6000);
  }
  function updateNotes(next) {
    setNotes(next);
    if (!writeNotes(localStorage, account?.id, next))
      notify('Your note is visible, but this browser could not save it.');
  }
  function navigate(next) {
    if (next !== path) window.history.pushState({}, '', next);
    setPath(next);
    setMobile(false);
    setDialog(null);
    setSupportTeam(null);
    window.scrollTo({ top: 0, behavior: 'instant' });
    mainRef.current?.focus({ preventScroll: true });
  }
  if (decision.type === 'loading' || decision.type === 'redirect')
    return (
      <main className="uv-empty" aria-busy="true">
        <p role="status">Loading…</p>
      </main>
    );
  if (decision.type === 'change-password')
    return (
      <ChangePasswordPage
        account={account}
        onSignOut={session.signOut}
        onChangePassword={async (current, next) => {
          const updated = await session.changePassword(current, next);
          navigate(landingPath(updated));
        }}
      />
    );
  if (['/', '/login', '/signup'].includes(path))
    return (
      <LoginPage
        accounts={session.accounts === true}
        onSignIn={session.signIn}
        sessionNotice={session.notice}
        navigate={navigate}
      />
    );
  if (path === '/hr') return <HrWorkspace account={account} onSignOut={session.signOut} />;
  return (
    <div className={'uv-portal' + (assistantPath ? ' uv-assistant-workspace' : '')}>
      <a className="uv-skip-link" href="#uv-main">
        Skip to content
      </a>
      <header className="uv-header">
        <div className="uv-header-top">
          <Link
            to="/onboarding"
            navigate={navigate}
            className="uv-brand-link"
            aria-label="Onboard.AI: My onboarding"
          >
            <Brand />
          </Link>
          <span className="uv-header-caption">A NEW CHAPTER. A SHARED UNIVERSE.</span>
          <div className="uv-header-actions">
            <span className="uv-preview-label">
              <span className="uv-small-dot mint" />
              EMPLOYEE
            </span>
            {account ? (
              <>
                <span className="uv-account-id" title={'Signed in as ' + account.username}>
                  <span className="uv-account-prefix">Signed in as </span>
                  <strong>{account.username}</strong>
                </span>
                <button
                  type="button"
                  className="uv-access-link uv-sign-out"
                  onClick={session.signOut}
                >
                  Sign out
                </button>
              </>
            ) : (
              <Link to="/login" navigate={navigate} className="uv-access-link">
                Back to sign in <Icon name="arrow" size={14} />
              </Link>
            )}
            <button
              className="uv-icon-button"
              aria-label="Search your workspace"
              onClick={() => setDialog({ type: 'search' })}
            >
              <Icon name="search" size={21} />
            </button>
            <Link
              to="/profile"
              navigate={navigate}
              className="uv-profile-top"
              aria-label="My profile"
              title="My profile"
            >
              <Icon name="user" size={18} />
            </Link>
            <button
              className="uv-icon-button uv-menu-button"
              aria-label={mobile ? 'Close navigation' : 'Open navigation'}
              aria-expanded={mobile}
              aria-controls="uv-nav"
              onClick={() => setMobile(!mobile)}
            >
              <Icon name={mobile ? 'close' : 'menu'} />
            </button>
          </div>
        </div>
        <nav
          id="uv-nav"
          className={'uv-navigation ' + (mobile ? 'is-open' : '')}
          aria-label="Main navigation"
        >
          {navItems.map((item, index) => (
            <Link
              to={item.path === '/alya' ? chatPath : item.path}
              navigate={navigate}
              key={item.path}
              aria-current={active?.path === item.path ? 'page' : undefined}
              className={'uv-nav-item ' + (active?.path === item.path ? 'active' : '')}
            >
              <span className="uv-nav-number">0{index}</span>
              <span>{item.label}</span>
              {item.soon && <small>SOON</small>}
              <Icon name="arrow" size={15} />
            </Link>
          ))}
          {account && (
            // Where the header has no room, the account and Sign out sit in the menu.
            <div className="uv-nav-account">
              <span className="uv-nav-account-id">
                Signed in as <strong>{account.username}</strong>
              </span>
              <button type="button" className="uv-access-link" onClick={session.signOut}>
                Sign out
              </button>
            </div>
          )}
        </nav>
      </header>
      <main className="uv-main" id="uv-main" tabIndex={-1} ref={mainRef}>
        {path === '/onboarding' ? (
          <EmployeeFootprint navigate={navigate} chatPath={chatPath} account={account} expanded />
        ) : activityId ? (
          <ActivityPage key={activityId} activityId={activityId} navigate={navigate} />
        ) : path === '/support' ? (
          <Support
            notes={notes}
            initialTeam={supportTeam}
            onNote={(note) => updateNotes([note, ...notes].slice(0, 10))}
            onDelete={(id) => {
              updateNotes(notes.filter((note) => note.id !== id));
              notify('Support note deleted.');
            }}
            notify={notify}
          />
        ) : path === '/profile' ? (
          <MyProfilePage account={account} />
        ) : assistantPath ? (
          <AssistantPage navigate={navigate} accountId={account?.id} />
        ) : (
          <div className="uv-empty">
            <Label>404 / UNEXPLORED SPACE</Label>
            <h1>This page hasn’t landed yet.</h1>
            <Link to="/" navigate={navigate} className="uv-button primary">
              Return home <Icon name="arrow" size={18} />
            </Link>
          </div>
        )}
        {!assistantPath && (
          <footer className="uv-footer">
            <Brand />
            <span>YOUR NEXT CHAPTER STARTS WITH YOU.</span>
            <span>Onboard.AI / PREVIEW</span>
          </footer>
        )}
      </main>
      {toast && (
        <div className="uv-toast" role="status">
          <Icon name="check" size={18} />
          <span>{toast}</span>
          <button aria-label="Dismiss notification" onClick={() => setToast('')}>
            <Icon name="close" size={17} />
          </button>
        </div>
      )}
      {dialog?.type === 'search' && (
        <SearchModal onClose={() => setDialog(null)} navigate={navigate} />
      )}
    </div>
  );
}
