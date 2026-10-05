/**
 * The title and description a listener sees on AudioVibe, editable until the
 * run is published (owner, 2026-10-05). Saved with the script's words exactly
 * as they are, so changing a title never discards the voiced audio.
 */
import { useState } from 'react';
import { api, type Script } from '../api';

export const TitleEditor = ({
  runId,
  script,
  locked,
  onSaved,
}: {
  runId: string;
  script: Script;
  /** Published: what went out is fixed. */
  locked: boolean;
  onSaved: () => void;
}) => {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(script.title);
  const [description, setDescription] = useState(script.description);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <div
        className="row"
        style={{ gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '0.75rem' }}
      >
        <span className="muted tiny" style={{ flex: 1, minWidth: 0 }}>
          {script.description}
        </span>
        {!locked && (
          <button
            className="btn ghost small"
            onClick={() => {
              setTitle(script.title);
              setDescription(script.description);
              setOpen(true);
            }}
          >
            Edit title and description
          </button>
        )}
      </div>
    );
  }

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      // The words go back unchanged, so the audio stays.
      await api.saveScript(runId, {
        title: title.trim(),
        description: description.trim(),
        beats: script.beats,
      });
      setOpen(false);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel" style={{ padding: '0.8rem 1rem', marginBottom: '0.75rem' }}>
      <div className="stack tight">
        <label className="tiny faint">Title, as listeners see it</label>
        <input
          className="field"
          maxLength={120}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <label className="tiny faint">Description</label>
        <textarea
          className="field"
          rows={3}
          maxLength={1000}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <div className="row" style={{ gap: '0.5rem' }}>
          <button
            className="btn"
            disabled={busy || !title.trim() || !description.trim()}
            onClick={() => void save()}
          >
            {busy ? 'Saving...' : 'Save'}
          </button>
          <button className="btn ghost" disabled={busy} onClick={() => setOpen(false)}>
            Cancel
          </button>
          <span className="faint tiny">Changing these never touches the voiced audio.</span>
        </div>
        {error && (
          <span className="tiny" style={{ color: 'var(--red, #e5484d)' }}>
            {error}
          </span>
        )}
      </div>
    </section>
  );
};
