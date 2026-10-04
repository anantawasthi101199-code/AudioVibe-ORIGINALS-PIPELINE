import { useState } from 'react';
import { api, type RunSummary } from '../api';

/**
 * The final audio - exactly what publishing sends - and what you can do to it
 * from here: download it, or go back to the voice alone.
 *
 * LOCKED ONCE APPROVED. In the Approved tab or published, the music cannot be
 * changed; take it back to To decide first.
 */
export const FinalAudio = ({
  run,
  onChanged,
  player = false,
}: {
  run: RunSummary;
  onChanged: () => void;
  player?: boolean;
}) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const voiceOnly = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.voiceOnly(run.id);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack tight">
      <div className="row" style={{ gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <span className={`pill ${run.music ? 'pass' : ''}`}>
          <span className="dot" />
          {run.music ? `with music: ${run.music.track} at ${run.music.volume}%` : 'voice only'}
        </span>
        <a className="btn ghost small" href={api.downloadUrl(run.id)} download>
          Download final audio
        </a>
        {run.music && !run.musicLock && (
          <button className="btn ghost small" disabled={busy} onClick={voiceOnly}>
            {busy ? 'Changing...' : 'Use voice only'}
          </button>
        )}
      </div>
      {player && (
        <audio controls preload="metadata" key={run.audioKey ?? ''} src={api.audioUrl(run.id, run.audioKey)} />
      )}
      {run.musicLock && <span className="faint tiny">Music is locked: {run.musicLock}</span>}
      {error && <span className="fail tiny">{error}</span>}
    </div>
  );
};
