import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Mix, type MixState, type Track } from '../api';

const describe = (m: Mix) =>
  `${m.track} at ${m.volume}%${m.duck ? ', lowered under speech' : ''}`;

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
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const [lib, mix] = await Promise.all([api.musicLibrary(), api.mixState(runId)]);
    setTracks(lib.tracks);
    setState(mix);
    const last = mix.preview ?? mix.chosen;
    if (last) {
      setTrack(last.track);
      setVolume(last.volume);
      setDuck(last.duck);
    } else {
      setTrack((t) => t || lib.tracks[0]?.name || '');
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
    !preview || preview.track !== track || preview.volume !== volume || preview.duck !== duck;

  return (
    <div className="stack mt" style={{ gap: '1rem' }}>
      {/* --- What gets published. Always on screen, always the truth. --- */}
      <div className="now">
        <div className="now-step">
          <span className={`pill ${chosen ? 'pass' : ''}`}>
            <span className="dot" />
            {chosen ? 'with music' : 'voice only'}
          </span>
          <strong>Publishing will send: {chosen ? `the version with ${describe(chosen)}` : 'the voice alone'}</strong>
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
              Publish voice only
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
            onChange={(e) => setTrack(e.target.value)}
            disabled={off || tracks.length === 0}
            aria-label="Background track"
          >
            {tracks.length === 0 && <option value="">No tracks yet - upload an mp3</option>}
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
          <div className="player">
            <span className="faint tiny">The track on its own</span>
            <audio controls preload="none" src={api.trackUrl(track)} />
          </div>
        )}

        <label className="row" style={{ gap: '0.75rem', alignItems: 'center' }}>
          <span style={{ minWidth: '9rem' }}>Music volume {volume}%</span>
          <input
            type="range"
            min={0}
            max={60}
            step={1}
            value={volume}
            disabled={off}
            onChange={(e) => setVolume(Number(e.target.value))}
            style={{ flex: 1 }}
          />
        </label>
        <label className="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={duck}
            disabled={off}
            onChange={(e) => setDuck(e.target.checked)}
          />
          <span>Lower the music while someone is speaking</span>
        </label>

        <div className="row" style={{ gap: '0.5rem' }}>
          <button
            className="btn"
            disabled={off || !track || !changed}
            onClick={() =>
              act('mix', async () => setState(await api.mix(runId, { track, volume, duck })))
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
