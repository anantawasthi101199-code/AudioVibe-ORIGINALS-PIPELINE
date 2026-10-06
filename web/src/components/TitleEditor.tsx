/**
 * The title and short description a listener sees on AudioVibe (owner,
 * 2026-10-05/06). Editable before AND after publishing: once published the
 * change goes to AudioVibe first and is saved here only if it took. The
 * script's words are never touched, so the voiced audio stays.
 */
import { useState } from 'react';
import { api, type Script } from '../api';

/** The studio enforces the same limit. */
const MAX_WORDS = 50;
const wordsIn = (text: string) => text.split(/\s+/).filter(Boolean).length;

export const TitleEditor = ({
  runId,
  script,
  locked,
  onSaved,
}: {
  runId: string;
  script: Script;
  /** Published: changes go to AudioVibe too. */
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
        <button
          className="btn ghost small"
          onClick={() => {
            setTitle(script.title);
            setDescription(script.description);
            setOpen(true);
          }}
        >
          {locked ? 'Edit title and description on AudioVibe' : 'Edit title and description'}
        </button>
      </div>
    );
  }

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      // The words go back unchanged, so the audio stays.
      await api.setListing(runId, { title: title.trim(), description: description.trim() });
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
          maxLength={100}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <label className="tiny faint">
          Short description: {wordsIn(description)} of {MAX_WORDS} words
          {wordsIn(description) > MAX_WORDS && (
            <span style={{ color: 'var(--amber)' }}> (too long)</span>
          )}
        </label>
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
            disabled={
              busy || !title.trim() || !description.trim() || wordsIn(description) > MAX_WORDS
            }
            onClick={() => void save()}
          >
            {busy ? 'Saving...' : 'Save'}
          </button>
          <button className="btn ghost" disabled={busy} onClick={() => setOpen(false)}>
            Cancel
          </button>
          <span className="faint tiny">
            {locked
              ? 'Published: this changes it on AudioVibe straight away. The audio is untouched.'
              : 'Changing these never touches the voiced audio.'}
          </span>
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
