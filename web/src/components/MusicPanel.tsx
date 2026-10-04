import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Mix, type MixState, type Track } from '../api';
import { Trimmer, type Loop } from './Trimmer';

const clockS = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

const describe = (m: Mix) => {
  const speed = m.speed && m.speed !== 1 ? `, episode at ${m.speed}x` : '';
  if (!m.track) return `no music${speed}`;
  return describeMusic(m) + speed;
};

const describeMusic = (m: Mix) =>
  `${m.track}${
    m.loop
      ? ` (${clockS(m.loop.start)} to ${clockS(m.loop.end)}, repeating${
          m.loop.speed && m.loop.speed !== 1 ? `, ${m.loop.speed}x` : ''
        })`
      : ''
  } at ${m.volume}%${
    m.duck ? ', lowered under speech' : ''
  }`;

const sameLoop = (a: Loop | null | undefined, b: Loop | null | undefined) =>
  (!a && !b) ||
  (!!a &&
    !!b &&
    Math.abs(a.start - b.start) < 0.05 &&
    Math.abs(a.end - b.end) < 0.05 &&
    (a.speed ?? 1) === (b.speed ?? 1));

/**
 * Your own music under a finished episode.
 *
 * TRYING IS NOT DECIDING. Mixing makes a preview to listen to and changes
 * nothing else. Only "Use this version for publishing" changes what goes out,
 * and the top of the panel always says what that is. All of it is ffmpeg on
 * this machine, so it costs nothing.
 */
export const MusicPanel = ({
  runId,
  disabled,
  onChanged,
}: {
  runId: string;
  disabled: boolean;
  /** The final audio changed: everything showing it should reload. */
  onChanged?: () => void;
}) => {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [state, setState] = useState<MixState | null>(null);
  const [track, setTrack] = useState('');
  const [volume, setVolume] = useState(15);
  const [duck, setDuck] = useState(true);
  // The whole episode's speed, voice and music together, pitch kept.
  const [speed, setSpeed] = useState(1);
  // This episode's section of the track. Starts as the track's saved loop.
  const [loop, setLoop] = useState<Loop | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const [lib, mix] = await Promise.all([api.musicLibrary(), api.mixState(runId)]);
    setTracks(lib.tracks);
    setState(mix);
    const last = mix.preview ?? mix.chosen;
    if (last) {
      setTrack(last.track ?? '');
      setVolume(last.volume);
      setDuck(last.duck);
      setLoop(last.loop ?? null);
      setSpeed(last.speed ?? 1);
    } else {
      const first = lib.tracks[0];
      setTrack((t) => {
        const name = t || first?.name || '';
        setLoop(lib.tracks.find((x) => x.name === name)?.loop ?? null);
        return name;
      });
    }
  }, [runId]);

  useEffect(() => {
    void load().catch((e) => setError((e as Error).message));
  }, [load]);

  const act = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const upload = (f: File) =>
    act('upload', async () => {
      const { track: added } = await api.uploadTrack(f.name, f);
      await load();
      setTrack(added.name);
      setLoop(null);
    });

  const off = disabled || busy !== null;
  // Approved or published: the music is fixed until it is back in To decide.
  const locked = Boolean(state?.lock);
  const preview = state?.preview && !state.previewStale ? state.preview : null;
  const chosen = state?.chosen && !state.chosenStale ? state.chosen : null;
  // The preview is already the published version: nothing to save.
  const previewIsChosen = Boolean(preview && chosen && preview.file === chosen.file);
  // The sliders no longer match the preview, so the preview is not what they say.
  const changed =
    !preview ||
    (preview.track ?? '') !== track ||
    (preview.speed ?? 1) !== speed ||
    preview.volume !== volume ||
    preview.duck !== duck ||
    !sameLoop(preview.loop, loop);
  const saved = tracks.find((t) => t.name === track)?.loop ?? null;

  return (
    <div className="stack mt" style={{ gap: '1rem' }}>
      {/* --- What gets published. Always on screen, always the truth. --- */}
      <div className="now">
        <div className="now-step">
          <span className={`pill ${chosen ? 'pass' : ''}`}>
            <span className="dot" />
            {chosen ? (chosen.track ? 'with music' : 'adjusted') : 'voice only'}
          </span>
          <strong>
            Publishing will send: {chosen ? `the mixed version (${describe(chosen)})` : 'the plain voice'}
          </strong>
        </div>
        {state?.lock && <span className="faint tiny">Music is locked: {state.lock}</span>}
        {state?.chosenStale && (
          <span className="tiny" style={{ color: 'var(--amber)' }}>
            The episode was voiced again after you chose a music version, so it is not used. Mix and
            choose again to add music back.
          </span>
        )}
        {chosen && (
          <div className="row" style={{ gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <audio controls preload="none" src={api.mixUrl(runId, 'chosen', chosen.file)} />
            <button
              className="btn ghost small"
              disabled={off || locked}
              onClick={() =>
                act('voice', async () => {
                  setState(await api.voiceOnly(runId));
                  onChanged?.();
                })
              }
            >
              Back to the plain voice
            </button>
          </div>
        )}
      </div>

      {/* --- Trying music. Nothing below changes what publishes. --- */}
      <div className="stack" style={{ gap: '0.75rem' }}>
        <h3 style={{ margin: 0 }}>Try music</h3>
        <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <select
            value={track}
            onChange={(e) => {
              setTrack(e.target.value);
              setLoop(tracks.find((t) => t.name === e.target.value)?.loop ?? null);
            }}
            disabled={off}
            aria-label="Background track"
          >
            <option value="">{tracks.length === 0 ? 'No music (upload an mp3 to add some)' : 'No music'}</option>
            {tracks.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
              </option>
            ))}
          </select>
          <button className="btn small" disabled={off} onClick={() => file.current?.click()}>
            {busy === 'upload' ? 'Uploading...' : 'Upload mp3'}
          </button>
          {track && (
            <button
              className="btn ghost small"
              disabled={off}
              onClick={() =>
                act('delete', async () => {
                  await api.removeTrack(track);
                  setTrack('');
                  await load();
                })
              }
            >
              Delete track
            </button>
          )}
          <input
            ref={file}
            type="file"
            accept="audio/mpeg,.mp3"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void upload(f);
            }}
          />
        </div>

        {track && (
          <div className="trim-box stack tight">
            <span className="faint tiny">
              The section that repeats under the episode. Drag the bars, play it on loop, then mix.
            </span>
            <Trimmer
              src={api.trackUrl(track)}
              previewUrl={(l) => api.loopPreviewUrl(track, l)}
              value={loop}
              onChange={setLoop}
              disabled={off}
            />
            <div className="row mt" style={{ gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <button
                className="btn ghost small"
                disabled={off || sameLoop(saved, loop)}
                onClick={() =>
                  act('saveloop', async () => {
                    await api.setTrackLoop(track, loop);
                    await load();
                  })
                }
              >
                {busy === 'saveloop' ? 'Saving...' : "Save as this track's loop"}
              </button>
              <span className="faint tiny">
                {sameLoop(saved, loop)
                  ? saved
                    ? "This is the track's saved loop, used by every episode by default."
                    : 'Whole track. Saving a loop makes it the default for every episode.'
                  : 'Changed for this episode only, until you save it to the track.'}
              </span>
            </div>
          </div>
        )}

        <label className="row" style={{ gap: '0.75rem', alignItems: 'center' }}>
          <span style={{ minWidth: '9rem' }}>Episode speed {speed.toFixed(2)}x</span>
          <input
            type="range"
            min={0.75}
            max={1.5}
            step={0.05}
            value={speed}
            disabled={off}
            onChange={(e) => setSpeed(Number(e.target.value))}
            style={{ flex: 1 }}
          />
          <button className="btn ghost small" disabled={off || speed === 1} onClick={() => setSpeed(1)}>
            1x
          </button>
        </label>
        <span className="faint tiny" style={{ marginTop: '-0.4rem' }}>
          The whole episode, voice and music together, pitch kept. Works with no music too.
        </span>

        <label className="row" style={{ gap: '0.75rem', alignItems: 'center' }}>
          <span style={{ minWidth: '9rem' }}>Music volume {volume}%</span>
          <input
            type="range"
            min={0}
            max={60}
            step={1}
            value={volume}
            disabled={off || !track}
            onChange={(e) => setVolume(Number(e.target.value))}
            style={{ flex: 1 }}
          />
        </label>
        <label className="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={duck}
            disabled={off || !track}
            onChange={(e) => setDuck(e.target.checked)}
          />
          <span>Lower the music while someone is speaking</span>
        </label>

        <div className="row" style={{ gap: '0.5rem' }}>
          <button
            className="btn"
            disabled={off || (!track && speed === 1) || !changed}
            onClick={() =>
              act('mix', async () =>
                setState(
                  await api.mix(runId, {
                    track: track || null,
                    speed: speed !== 1 ? speed : undefined,
                    volume,
                    duck,
                    loop: track ? loop : undefined,
                  })
                )
              )
            }
          >
            {busy === 'mix' ? 'Mixing...' : preview ? 'Mix preview again' : 'Mix preview'}
          </button>
        </div>

        {preview && (
          <div className="player">
            <span className="faint tiny">
              Preview: {describe(preview)}
              {changed ? ' (the settings above have changed since; mix again to hear them)' : ''}
            </span>
            <audio
              key={preview.file}
              controls
              preload="metadata"
              src={api.mixUrl(runId, 'preview', preview.file)}
            />
            <div className="row mt" style={{ gap: '0.5rem', alignItems: 'center' }}>
              <button
                className="btn spend"
                disabled={off || previewIsChosen || locked}
                onClick={() =>
                  act('use', async () => {
                    setState(await api.useMix(runId));
                    onChanged?.();
                  })
                }
              >
                {previewIsChosen ? 'This version will be published' : 'Use this version for publishing'}
              </button>
              {!previewIsChosen && (
                <span className="faint tiny">Until you press this, publishing is unchanged.</span>
              )}
            </div>
          </div>
        )}
        {state?.previewStale && (
          <span className="faint tiny">
            The last preview was made before the episode was voiced again. Mix a new one.
          </span>
        )}
      </div>

      {error && <span className="fail tiny">{error}</span>}
    </div>
  );
};
