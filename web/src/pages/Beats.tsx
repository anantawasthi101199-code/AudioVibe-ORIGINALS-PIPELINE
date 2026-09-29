/**
 * The synthesiser: two dozen knobs, a description box, and a player per beat.
 *
 * THE FORM IS BUILT FROM THE ENGINE'S OWN CONTROL LIST, not from markup written
 * here. `/api/beats` returns `CONTROLS` exactly as `render/synth.ts` defines it,
 * including every range and every explanation, and this page draws whatever it
 * is given. A knob added to the engine appears here without this file changing,
 * and more importantly a range changed in the engine cannot leave a slider
 * behind that lets somebody set a value the renderer will refuse.
 *
 * THE PLAYER IS STILL THE POINT. A beat's whole value is that somebody listened
 * to it before a show was committed to it.
 *
 * DESCRIBING IS A SEPARATE STEP FROM MAKING, deliberately. A description fills
 * the form in and stops. You can then see every value it chose, change any of
 * them, and only then synthesise. One button going from a sentence straight to
 * audio would make the model the author rather than a starting point, and would
 * hide which of the twenty-four values it actually picked.
 *
 * NOTHING HERE NEEDS THE MODEL. Every control has a default and the form works
 * with the box empty, which is what keeps this usable when the model is down,
 * and is how anybody learns what the knobs do.
 */
import { useEffect, useState } from 'react';
import { api, type Beat, type SynthControl, type SynthSettings } from '../api';
import { ErrorNote } from '../components/bits';
import { Count } from '../components/Info';

/** One knob, drawn from what the engine said it is. */
const Knob = ({
  control,
  value,
  onChange,
}: {
  control: SynthControl;
  value: string | number | string[] | undefined;
  onChange: (v: string | number | string[]) => void;
}) => {
  if (control.kind === 'toggles') {
    const on = Array.isArray(value) ? value : [];
    return (
      <div className="stack tight">
        <label className="eyebrow">{control.label}</label>
        <div className="row" style={{ gap: '0.4rem' }}>
          {(control.options ?? []).map((o) => {
            const isOn = on.includes(o.value);
            return (
              <button
                key={o.value}
                type="button"
                title={o.help}
                className={`btn small ${isOn ? '' : 'ghost'}`}
                onClick={() =>
                  // Never empty: the engine requires at least one instrument, so
                  // the last one on cannot be switched off.
                  onChange(
                    isOn ? (on.length > 1 ? on.filter((v) => v !== o.value) : on) : [...on, o.value]
                  )
                }
              >
                {o.label}
              </button>
            );
          })}
        </div>
        <span className="faint tiny">{control.help}</span>
      </div>
    );
  }

  if (control.kind === 'choice') {
    const current = (control.options ?? []).find((o) => o.value === value);
    return (
      <div className="stack tight">
        <label className="eyebrow">{control.label}</label>
        <select
          className="field"
          style={{ width: 'auto', flex: '0 0 auto' }}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
        >
          {(control.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <span className="faint tiny">{current?.help ?? control.help}</span>
      </div>
    );
  }

  const n = typeof value === 'number' ? value : (control.min ?? 0);
  return (
    <div className="stack tight">
      <div className="row between">
        <label className="eyebrow">{control.label}</label>
        <span className="muted tiny">
          {n}
          {control.unit ? ` ${control.unit}` : ''}
        </span>
      </div>
      <input
        type="range"
        min={control.min}
        max={control.max}
        step={control.step}
        value={n}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: '100%' }}
      />
      <span className="faint tiny">{control.help}</span>
    </div>
  );
};

export const Beats = () => {
  const [controls, setControls] = useState<SynthControl[]>([]);
  const [beats, setBeats] = useState<Beat[] | null>(null);
  const [settings, setSettings] = useState<SynthSettings>({});
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [describe, setDescribe] = useState('');
  const [busy, setBusy] = useState<'making' | 'asking' | null>(null);
  const [made, setMade] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const load = () =>
    api
      .beats()
      .then((d) => {
        setBeats(d.beats);
        setControls(d.controls);
        setSettings((was) => (Object.keys(was).length ? was : d.defaults));
      })
      .catch((e: Error) => setError(e.message));

  useEffect(() => {
    void load();
  }, []);

  const set = (id: string, v: string | number | string[]) =>
    setSettings((was) => ({ ...was, [id]: v }));

  const existing = beats?.some((b) => b.name === name.trim());
  const nameOk = /^[a-z0-9-]+$/.test(name.trim());
  const groups = [...new Set(controls.map((c) => c.group))];

  const ask = async () => {
    if (!describe.trim()) return;
    setBusy('asking');
    setFormError(null);
    try {
      const d = await api.suggestBeat(describe.trim());
      setSettings(d.settings);
      setReading(d.reading);
      // Opened so the values it chose are visible rather than hidden behind a
      // collapsed panel, which would make the model the author again.
      setOpen(true);
      if (!note.trim()) setNote(d.reading);
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const make = async (e: React.FormEvent) => {
    e.preventDefault();
    const wanted = name.trim();
    setBusy('making');
    setError(null);
    setFormError(null);
    setMade(null);
    try {
      await api.makeBeat({ name: wanted, note: note.trim(), settings });
      await load();
      setMade(wanted);
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page">
      <div className="row between" style={{ marginBottom: '0.3rem' }}>
        <h1 className="headline">Beats</h1>
        <span className="muted tiny">Background loops, made once and reused</span>
      </div>

      <p className="muted" style={{ maxWidth: '54rem', marginBottom: '1.4rem' }}>
        Describe what you want and the settings are filled in, or set them yourself. Either way the
        loop is synthesised here and costs nothing to make. Every beat comes out at the same
        loudness, so swapping one for another changes the sound and not the level.
      </p>

      <ErrorNote>{error}</ErrorNote>

      {beats && (
        <div className="counts" style={{ marginBottom: '1.7rem' }}>
          <Count n={beats.length} label="beats" />
          <Count n={beats.filter((b) => b.rendered).length} label="playable" />
          <Count n={controls.length} label="controls" />
        </div>
      )}

      <form className="card stack" onSubmit={make} style={{ marginBottom: '2rem' }}>
        <div className="eyebrow">Make one</div>

        <input
          className="field"
          placeholder="name, like night-piano"
          value={name}
          onChange={(e) => setName(e.target.value.toLowerCase())}
        />

        <div className="row" style={{ gap: '0.8rem', flexWrap: 'wrap' }}>
          <input
            className="field"
            style={{ flex: '1 1 20rem', width: 'auto' }}
            placeholder="describe it: tired, three in the morning, nothing happening"
            value={describe}
            onChange={(e) => setDescribe(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void ask();
              }
            }}
          />
          <button
            type="button"
            className="btn ghost"
            style={{ flex: '0 0 auto' }}
            disabled={!describe.trim() || busy !== null}
            onClick={() => void ask()}
          >
            {busy === 'asking' ? 'Asking...' : 'Fill in the settings'}
          </button>
        </div>

        {reading && (
          <p className="tiny muted" style={{ margin: 0 }}>
            Read as: {reading}. Every value is below, and yours to change.
          </p>
        )}

        <input
          className="field"
          placeholder="a line on what it is for, so you can choose between two later"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />

        <button type="button" className="btn ghost small" onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide the controls' : `Show the ${controls.length} controls`}
        </button>

        {open && (
          <div className="stack">
            {groups.map((g) => (
              <div key={g} className="stack tight">
                <div className="eyebrow" style={{ opacity: 0.6 }}>
                  {g}
                </div>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(16rem, 1fr))',
                    gap: '1rem',
                  }}
                >
                  {controls
                    .filter((c) => c.group === g)
                    .map((c) => (
                      <Knob
                        key={c.id}
                        control={c}
                        value={settings[c.id]}
                        onChange={(v) => set(c.id, v)}
                      />
                    ))}
                </div>
              </div>
            ))}
          </div>
        )}

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

        <button className="btn" type="submit" disabled={busy !== null || !nameOk}>
          {busy === 'making' ? 'Synthesising...' : existing ? 'Replace it' : 'Make it (free)'}
        </button>

        {busy === 'making' && (
          <p className="muted tiny" style={{ margin: 0 }}>
            Building the notes, the room and the level with ffmpeg. A few seconds.
          </p>
        )}
        {formError && (
          <p className="tiny" style={{ margin: 0, color: 'var(--fail, #f87171)' }}>
            {formError}
          </p>
        )}
        {made && busy === null && (
          <p className="tiny" style={{ margin: 0 }}>
            Made <strong>{made}</strong>. It is in the list below, with a player.
          </p>
        )}
      </form>

      {!beats && !error && <p className="faint">...</p>}

      {beats && beats.length === 0 && (
        <p className="faint">Nothing yet. Make one above and it appears here to listen to.</p>
      )}

      <div className="stack tight">
        {(beats ?? []).map((b) => (
          <div
            key={b.name}
            className="card"
            style={b.name === made ? { borderColor: 'var(--amber)' } : undefined}
          >
            <div className="row between" style={{ gap: '1rem', flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0 }}>
                <strong>{b.name}</strong>
                <span className="muted tiny" style={{ marginLeft: '0.6rem' }}>
                  {b.summary}
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

              <div className="row" style={{ gap: '0.5rem' }}>
                {/* Loading a beat into the form is how you make a variation of
                    one you liked, which is most of what anybody does here. */}
                <button
                  type="button"
                  className="btn ghost small"
                  onClick={() => {
                    setSettings(b.settings);
                    setName(b.name);
                    setNote(b.note);
                    setReading(null);
                    setOpen(true);
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                >
                  Edit
                </button>
                {b.rendered ? (
                  <audio
                    controls
                    preload="none"
                    src={api.beatAudio(b.name)}
                    style={{ height: '2.2rem' }}
                  />
                ) : (
                  <span className="muted tiny">not rendered yet</span>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
