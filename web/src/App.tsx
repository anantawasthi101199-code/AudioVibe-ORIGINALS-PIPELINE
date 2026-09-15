/**
 * The shell: sign in, then three pages under each other.
 *
 * HASH ROUTING, AND NO ROUTER. Three routes, one of which carries a run id with
 * a slash in it. A routing library would add a dependency and a pattern syntax
 * to solve a problem that is two string comparisons, and the hash means the
 * static build needs no server rewrite rules to survive a refresh.
 *
 * ONE PLACE DECIDES YOU ARE SIGNED OUT. Any request anywhere in the app that
 * comes back 401 calls back here, so an expired session puts you at the
 * password box once rather than showing four components each rendering its own
 * idea of an error.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, whenSignedOut } from './api';
import { Channel } from './pages/Channel';
import { Lanes } from './pages/Lanes';
import { Queue } from './pages/Queue';
import { Run } from './pages/Run';
import { ErrorNote } from './components/bits';
import './app.css';

const path = (): string => window.location.hash.replace(/^#/, '') || '/';

const SignIn = ({ onIn }: { onIn: () => void }) => {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.signIn(password);
      onIn();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="gate-screen">
      <form className="gate-card stack" onSubmit={submit}>
        <div>
          <div className="eyebrow">AudioVibe Originals</div>
          <h1 style={{ fontSize: '2.2rem' }}>
            The <span style={{ color: 'var(--amber)' }}>Foundry</span>
          </h1>
          <p className="muted" style={{ marginTop: '0.6rem' }}>
            Everything behind this spends money.
          </p>
        </div>

        <input
          className="field"
          type="password"
          autoFocus
          autoComplete="current-password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        <ErrorNote>{error}</ErrorNote>

        <button className="btn spend" type="submit" disabled={busy || !password}>
          {busy ? 'Checking...' : 'Sign in'}
        </button>
      </form>
    </div>
  );
};

export const App = () => {
  const [route, setRoute] = useState(path());
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  const go = useCallback((to: string) => {
    window.location.hash = to;
    window.scrollTo({ top: 0 });
  }, []);

  useEffect(() => {
    const onHash = () => setRoute(path());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    whenSignedOut(() => setSignedIn(false));
    api
      .me()
      .then(() => setSignedIn(true))
      .catch(() => setSignedIn(false));
  }, []);

  if (signedIn === null) return <div className="gate-screen faint">...</div>;
  if (!signedIn) return <SignIn onIn={() => setSignedIn(true)} />;

  const channelMatch = /^\/c\/(.+)$/.exec(route);
  const runMatch = /^\/r\/(.+)$/.exec(route);
  const onQueue = route === '/queue';

  const crumbs: Array<[string, string]> = [['/', 'Lanes']];
  if (onQueue) crumbs.push(['/queue', 'Queue']);
  if (channelMatch) crumbs.push([route, channelMatch[1]!]);
  if (runMatch) {
    const runId = runMatch[1]!;
    crumbs.push([`/c/${runId.split('/')[0]}`, runId.split('/')[0]!]);
    crumbs.push([route, runId.split('/')[1] ?? runId]);
  }

  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href="#/" onClick={() => go('/')}>
          Foundry<span>.</span>
        </a>

        <nav className="crumbs">
          {crumbs.map(([to, label], i) => (
            <span key={to} className="row" style={{ gap: '0.5rem', minWidth: 0 }}>
              {i > 0 && <span className="sep">/</span>}
              {i === crumbs.length - 1 ? (
                <span className="here">{label}</span>
              ) : (
                <a
                  href={`#${to}`}
                  onClick={(e) => {
                    e.preventDefault();
                    go(to);
                  }}
                >
                  {label}
                </a>
              )}
            </span>
          ))}
        </nav>

        <span className="spacer" />
        <a
          className={`btn ghost small${onQueue ? ' on' : ''}`}
          href="#/queue"
          onClick={(e) => {
            e.preventDefault();
            go('/queue');
          }}
        >
          Queue
        </a>
        <button
          className="btn ghost small"
          onClick={() => {
            void api.signOut().finally(() => setSignedIn(false));
          }}
        >
          Sign out
        </button>
      </header>

      {onQueue ? (
        <Queue go={go} />
      ) : runMatch ? (
        <Run id={runMatch[1]!} go={go} />
      ) : channelMatch ? (
        <Channel id={channelMatch[1]!} go={go} />
      ) : (
        <Lanes go={go} />
      )}
    </div>
  );
};
