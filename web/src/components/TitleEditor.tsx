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

  // CLOSED: the title and the description as listeners will read them, each
  // labelled, with the button on its own line. It used to show only the
  // description, squeezed beside the button, so the title was nowhere.
  if (!open) {
    return (
      <div className="listing">
        <div className="listing-field">
          <span className="listing-label">Title</span>
          <strong className="listing-title">{script.title}</strong>
        </div>
        <div className="listing-field">
          <span className="listing-label">
            Description <span className="faint">· {wordsIn(script.description)} words</span>
          </span>
          <p className="listing-text">{script.description}</p>
        </div>
        <button
          className="btn ghost small listing-edit"
          onClick={() => {
            setTitle(script.title);
            setDescription(script.description);
            setOpen(true);
          }}
        >
          {locked ? 'Edit on AudioVibe' : 'Edit title and description'}
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
    <div className="listing editing">
      <div className="stack tight">
        <label className="listing-label">Title, as listeners see it</label>
        <input
          className="field"
          maxLength={100}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <label className="listing-label">
          Short description: {wordsIn(description)} of {MAX_WORDS} words
          {wordsIn(description) > MAX_WORDS && (
            <span style={{ color: 'var(--amber)' }}> (too long)</span>
          )}
        </label>
        <textarea
          className="field"
          rows={5}
          maxLength={1000}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
          <button
            className="btn small"
            disabled={
              busy || !title.trim() || !description.trim() || wordsIn(description) > MAX_WORDS
            }
            onClick={() => void save()}
          >
            {busy ? 'Saving...' : 'Save'}
          </button>
          <button className="btn ghost small" disabled={busy} onClick={() => setOpen(false)}>
            Cancel
          </button>
        </div>
        <span className="faint tiny">
            {locked
              ? 'Published: this changes it on AudioVibe straight away. The audio is untouched.'
              : 'Changing these never touches the voiced audio.'}
        </span>
        {error && (
          <span className="tiny" style={{ color: 'var(--red, #e5484d)' }}>
            {error}
          </span>
        )}
      </div>
    </div>
  );
};
