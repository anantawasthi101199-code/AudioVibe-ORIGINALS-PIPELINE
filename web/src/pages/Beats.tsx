/**
 * The beat library: make a background loop, hear it, keep the one that works.
 *
 * THE PLAYER IS THE POINT. A beat's whole value is that somebody LISTENED to it
 * before a show was committed to it, and on the command line that means finding
 * the file and opening it yourself, which nobody does. An audio element beside
 * each row is the difference between a library that gets used and a directory
 * of files.
 *
 * MAKING ONE COSTS NOTHING, AND THE PAGE SAYS SO. Every other button in this
 * studio that starts work spends money, so the one that does not has to be
 * marked or it inherits the hesitation that belongs to the others.
 *
 * NO DELETE. A beat an episode was rendered against is part of how that episode
 * sounds, and a button that can quietly change what a published show sounded
 * like is not worth the two seconds it saves. Remove the files by hand.
 */
import { useEffect, useState } from 'react';
import { api, type Beat } from '../api';
import { ErrorNote } from '../components/bits';
import { Count } from '../components/Info';

const DESCRIBE: Record<string, string> = {
  piano: 'Struck and decaying. The quietest of the three, and the one that stays out of the way.',
  strings: 'Slow swell, no attack. Warmest under a voice, and the default for a reason.',
  epic: 'Strings with a low drum under them. For a cold open, not for fifteen minutes.',
};

export const Beats = () => {
  const [styles, setStyles] = useState<string[]>([]);
  const [keys, setKeys] = useState<string[]>([]);
  const [beats, setBeats] = useState<Beat[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [style, setStyle] = useState('strings');
  const [key, setKey] = useState('a');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () =>
    api
      .beats()
      .then((d) => {
        setBeats(d.beats);
        setStyles(d.styles);
        setKeys(d.keys);
      })
      .catch((e: Error) => setError(e.message));

  useEffect(() => {
    void load();
  }, []);

  const existing = beats?.some((b) => b.name === name.trim());

  const make = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.makeBeat({ name: name.trim(), style, key, note: note.trim() });
      await load();
      setName('');
      setNote('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // A beat name becomes a filename, so the page enforces what the server does
  // rather than letting somebody find out after pressing the button.
  const nameOk = /^[a-z0-9-]+$/.test(name.trim());

  return (
    <div className="page">
      <div className="row between" style={{ marginBottom: '0.3rem' }}>
        <h1 className="headline">Beats</h1>
        <span className="muted tiny">Background loops, made once and reused</span>
      </div>

      <p className="muted" style={{ maxWidth: '54rem', marginBottom: '1.4rem' }}>
        Without a named beat, a phrase is synthesised from the episode's topic for every part
        separately and thrown away, so a show sounds different every week. A beat here is chosen
        once and used with <code>--bed</code>, and it costs nothing to make.
      </p>

      <ErrorNote>{error}</ErrorNote>

      {beats && (
        <div className="counts" style={{ marginBottom: '1.7rem' }}>
          <Count n={beats.length} label="beats" />
          <Count n={beats.filter((b) => b.rendered).length} label="playable" />
        </div>
      )}

      <form className="card stack" onSubmit={make} style={{ marginBottom: '2rem' }}>
        <div className="eyebrow">Make one</div>

        <div className="row" style={{ gap: '0.8rem', flexWrap: 'wrap' }}>
          <input
            className="field"
            style={{ flex: '1 1 14rem', width: 'auto' }}
            placeholder="name, like night-piano"
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase())}
          />
          <select className="field" value={style} onChange={(e) => setStyle(e.target.value)}>
            {styles.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select className="field" value={key} onChange={(e) => setKey(e.target.value)}>
            {keys.map((k) => (
              <option key={k} value={k}>
                key of {k}
              </option>
            ))}
          </select>
        </div>

        <input
          className="field"
          placeholder="a line on what it is for, so you can choose between two later"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />

        <p className="muted tiny" style={{ margin: 0 }}>
          {DESCRIBE[style]} Every key is low, because this sits under a speaking voice.
        </p>

        {name.trim() && !nameOk && (
          <p className="tiny" style={{ margin: 0, color: 'var(--amber)' }}>
            A name becomes a filename: lowercase letters, digits and hyphens only.
          </p>
        )}
        {existing && (
          <p className="tiny" style={{ margin: 0, color: 'var(--amber)' }}>
            This replaces the beat already called {name.trim()}, including its audio.
          </p>
        )}

        <button className="btn" type="submit" disabled={busy || !nameOk}>
          {busy ? 'Synthesising...' : existing ? 'Replace it' : 'Make it (free)'}
        </button>
      </form>

      {!beats && !error && <p className="faint">...</p>}

      {beats && beats.length === 0 && (
        <p className="faint">Nothing yet. Make one above and it appears here to listen to.</p>
      )}

      <div className="stack tight">
        {(beats ?? []).map((b) => (
          <div key={b.name} className="card">
            <div className="row between" style={{ gap: '1rem', flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0 }}>
                <strong>{b.name}</strong>
                <span className="muted tiny" style={{ marginLeft: '0.6rem' }}>
                  {b.style}, key of {b.key}
                </span>
                {b.note && (
                  <div className="muted tiny" style={{ marginTop: '0.25rem' }}>
                    {b.note}
                  </div>
                )}
                <div className="faint tiny" style={{ marginTop: '0.35rem' }}>
                  <code>--bed {b.name}</code>
                </div>
              </div>

              {b.rendered ? (
                <audio controls preload="none" src={api.beatAudio(b.name)} style={{ height: '2.2rem' }} />
              ) : (
                <span className="muted tiny">
                  not rendered yet, make it again to build the audio
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
