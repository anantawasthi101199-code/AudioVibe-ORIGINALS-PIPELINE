import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type MixState, type Track } from '../api';

/**
 * Your own music under a finished episode.
 *
 * THE FLOW, top to bottom: pick or upload a track, set the level, mix, listen,
 * adjust and mix again. All of it is free - ffmpeg on this machine. What you
 * hear in the "with music" player is exactly what publishing will send; remove
 * the music and it sends the voice alone.
 */
export const MusicPanel = ({ runId, disabled }: { runId: string; disabled: boolean }) => {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [state, setState] = useState<MixState | null>(null);
  const [track, setTrack] = useState('');
  const [volume, setVolume] = useState(15);
  const [duck, setDuck] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A new mix lands at the same URL; the version makes the player load it.
  const [version, setVersion] = useState(0);
  const file = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const [lib, mix] = await Promise.all([api.musicLibrary(), api.mixState(runId)]);
    setTracks(lib.tracks);
    setState(mix);
    if (mix.mix) {
      setTrack(mix.mix.track);
      setVolume(mix.mix.volume);
      setDuck(mix.mix.duck);
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

  const mix = () =>
    act('mix', async () => {
      setState(await api.mix(runId, { track, volume, duck }));
      setVersion((v) => v + 1);
    });

  const remove = () =>
    act('remove', async () => {
      setState(await api.removeMix(runId));
    });

  const deleteTrack = () =>
    act('delete', async () => {
      await api.removeTrack(track);
      setTrack('');
      await load();
    });

  const current = state?.mix && !state.stale;
  const changed =
    !state?.mix || state.mix.track !== track || state.mix.volume !== volume || state.mix.duck !== duck;
  const off = disabled || busy !== null;

  return (
    <div className="stack mt" style={{ gap: '0.75rem' }}>
      <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <select
          value={track}
          onChange={(e) => setTrack(e.target.value)}
          disabled={off || tracks.length === 0}
          aria-label="Background track">
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
          <button className="btn ghost small" disabled={off} onClick={deleteTrack}>
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
        <input type="checkbox" checked={duck} disabled={off} onChange={(e) => setDuck(e.target.checked)} />
        <span>Lower the music while someone is speaking</span>
      </label>

      <div className="row" style={{ gap: '0.5rem' }}>
        <button className="btn" disabled={off || !track || (!!current && !changed)} onClick={mix}>
          {busy === 'mix' ? 'Mixing...' : state?.mix ? 'Mix again' : 'Mix'}
        </button>
        {state?.mix && (
          <button className="btn ghost" disabled={off} onClick={remove}>
            Remove music
          </button>
        )}
      </div>

      {state?.mix && !state.stale && (
        <div className="player">
          <span className="faint tiny">
            With music: {state.mix.track} at {state.mix.volume}%
            {state.mix.duck ? ', lowered under speech' : ''}
          </span>
          <audio key={version} controls preload="metadata" src={api.mixUrl(runId, version)} />
        </div>
      )}

      <span className="faint tiny">
        {state?.stale
          ? 'The episode was voiced again after this mix, so publishing will send the voice alone. Mix again to add the music back.'
          : current
            ? 'Publishing sends the version with music.'
            : 'No music: publishing sends the voice alone.'}
      </span>
      {error && <span className="fail tiny">{error}</span>}
    </div>
  );
};
