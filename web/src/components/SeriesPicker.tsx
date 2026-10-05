/**
 * Which series an episode belongs to, changeable until it is published
 * (owner, 2026-10-05: every episode belongs to a series).
 */
import { type ReactNode, useEffect, useState } from 'react';
import { api } from '../api';

export const SeriesPicker = ({
  runId,
  channelId,
  current,
  locked,
  onSaved,
  children,
}: {
  runId: string;
  channelId: string;
  current: string | undefined;
  /** Published: its shelf is fixed. */
  locked: boolean;
  onSaved: () => void;
  /** The series cover, shown in the same panel: one cover for the whole series. */
  children?: ReactNode;
}) => {
  const [titles, setTitles] = useState<string[]>([]);
  const [value, setValue] = useState(current ?? '');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState('');

  const rename = async () => {
    setError(null);
    try {
      await api.renameSeries(channelId, current!, newName.trim());
      setRenaming(false);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    void api
      .channel(channelId)
      .then((d) => setTitles(d.channel.seriesTitles))
      .catch(() => undefined);
  }, [channelId]);

  const save = async (title: string) => {
    setError(null);
    try {
      await api.setRunSeries(runId, title);
      setCreating(false);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section className="panel" style={{ padding: '0.8rem 1rem' }}>
      <div className="row" style={{ gap: '0.75rem', alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span
          className="faint tiny"
          style={{ textTransform: 'uppercase', letterSpacing: '0.06em' }}
        >
          Series
        </span>
        <strong style={{ fontSize: '1.05rem' }}>{current ?? 'None yet'}</strong>
        {current && !locked && !renaming && (
          <button
            className="btn ghost small"
            title="Renames it on every episode in it. Only before the series is on AudioVibe."
            onClick={() => {
              setNewName(current);
              setRenaming(true);
            }}
          >
            Rename series
          </button>
        )}
        {renaming && (
          <span className="row" style={{ gap: '0.4rem' }}>
            <input
              className="field"
              style={{ maxWidth: '18rem' }}
              autoFocus
              maxLength={80}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <button className="btn small" disabled={!newName.trim()} onClick={() => void rename()}>
              Save
            </button>
            <button className="btn ghost small" onClick={() => setRenaming(false)}>
              Cancel
            </button>
          </span>
        )}
        <span className="faint tiny">
          {locked
            ? 'Published into this series on AudioVibe.'
            : 'Publishes into this series on AudioVibe. A new series is created there the first time one of its episodes goes out.'}
        </span>
      </div>
      {!locked && (
        <div className="row mt" style={{ gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="tiny">{current ? 'Move to' : 'Choose'}</span>
          <select
            className="field"
            style={{ maxWidth: '18rem' }}
            value={creating ? '__new__' : (current ?? '')}
            onChange={(e) => {
              if (e.target.value === '__new__') {
                setCreating(true);
                setValue('');
              } else {
                void save(e.target.value);
              }
            }}
          >
            <option value="" disabled>
              Choose the series (required)
            </option>
            {[...new Set([...(current ? [current] : []), ...titles])].map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
            <option value="__new__">New series...</option>
          </select>
          {creating && (
            <>
              <input
                className="field"
                style={{ maxWidth: '18rem' }}
                autoFocus
                placeholder="Name the new series"
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
              <button
                className="btn small"
                disabled={!value.trim()}
                onClick={() => void save(value.trim())}
              >
                Save
              </button>
            </>
          )}
          {!current && !creating && (
            <span className="tiny" style={{ color: 'var(--amber)' }}>
              This episode has no series yet.
            </span>
          )}
          {error && (
            <span className="tiny" style={{ color: 'var(--red, #e5484d)' }}>
              {error}
            </span>
          )}
        </div>
      )}
      {children && <div className="mt">{children}</div>}
    </section>
  );
};
