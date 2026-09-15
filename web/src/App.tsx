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
import { api, whenSignedOut, type Platform } from './api';
import { Channel } from './pages/Channel';
import { Lanes } from './pages/Lanes';
import { Queue } from './pages/Queue';
import { Schedule } from './pages/Schedule';
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
  const [platform, setPlatform] = useState<Platform | null>(null);

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
      .then(() => {
        setSignedIn(true);
        return api.platform().then(setPlatform);
      })
      .catch(() => setSignedIn(false));
  }, []);

  if (signedIn === null) return <div className="gate-screen faint">...</div>;
  if (!signedIn) return <SignIn onIn={() => setSignedIn(true)} />;

  const channelMatch = /^\/c\/(.+)$/.exec(route);
  const runMatch = /^\/r\/(.+)$/.exec(route);
  const onChannels = route === '/channels';
  const onSchedule = route === '/schedule';

  // THE QUEUE IS HOME. The question asked of this studio most often is "does
  // anything need me", and the answer should be the thing that loads.
  //
  // TABS RATHER THAN A HIDDEN BUTTON. Channels used to be a ghost button in the
  // corner with the same weight as Sign out, so the front page looked like a
  // status board with no way into anything. Two tabs, always visible, with the
  // current one marked.
  const tab = onSchedule
    ? 'schedule'
    : channelMatch || runMatch || onChannels
      ? 'channels'
      : 'queue';

  // Breadcrumbs only once you are deeper than a tab, where they earn their
  // space by being the way back up.
  const crumbs: Array<[string, string]> = [];
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

        <nav className="tabs">
          <a
            className={`tab${tab === 'queue' ? ' on' : ''}`}
            href="#/"
            onClick={(e) => {
              e.preventDefault();
              go('/');
            }}
          >
            Queue
          </a>
          <a
            className={`tab${tab === 'schedule' ? ' on' : ''}`}
            href="#/schedule"
            onClick={(e) => {
              e.preventDefault();
              go('/schedule');
            }}
          >
            Publishing
          </a>
          <a
            className={`tab${tab === 'channels' ? ' on' : ''}`}
            href="#/channels"
            onClick={(e) => {
              e.preventDefault();
              go('/channels');
            }}
          >
            Channels
          </a>
        </nav>

        {crumbs.length > 0 && (
          <nav className="crumbs">
            {crumbs.map(([to, label], i) => (
              <span key={to} className="row" style={{ gap: '0.5rem', minWidth: 0 }}>
                <span className="sep">/</span>
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
        )}

        <span className="spacer" />

        {/* WHERE THIS IS POINTED, ON EVERY SCREEN. Publishing somewhere you did
            not mean to is the one mistake here that cannot be taken back. */}
        {platform?.configured && (
          <span className={`where${platform.isProduction ? ' live' : ''}`}>
            <span className="dot" />
            {platform.isProduction ? 'production' : new URL(platform.url!).hostname}
          </span>
        )}

        <button
          className="btn ghost small"
          onClick={() => {
            void api.signOut().finally(() => setSignedIn(false));
          }}
        >
          Sign out
        </button>
      </header>

      {onSchedule ? (
        <Schedule go={go} />
      ) : runMatch ? (
        <Run id={runMatch[1]!} go={go} />
      ) : channelMatch ? (
        <Channel id={channelMatch[1]!} go={go} />
      ) : onChannels ? (
        <Lanes go={go} />
      ) : (
        <Queue go={go} />
      )}
    </div>
  );
};
