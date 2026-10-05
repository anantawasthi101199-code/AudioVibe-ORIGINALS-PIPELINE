/**
 * Which series an episode belongs to, changeable until it is published
 * (owner, 2026-10-05: every episode belongs to a series).
 */
import { useEffect, useState } from 'react';
import { api } from '../api';

export const SeriesPicker = ({
  runId,
  channelId,
  current,
  locked,
  onSaved,
}: {
  runId: string;
  channelId: string;
  current: string | undefined;
  /** Published: its shelf is fixed. */
  locked: boolean;
  onSaved: () => void;
}) => {
  const [titles, setTitles] = useState<string[]>([]);
  const [value, setValue] = useState(current ?? '');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  if (locked) {
    return <span className="faint tiny">Series: {current ?? 'none'}</span>;
  }

  return (
    <div className="row" style={{ gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
      <strong className="tiny">Series</strong>
      <select
        className="field"
        style={{ maxWidth: '18rem' }}
        value={creating ? '__new__' : current ?? ''}
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
          <button className="btn small" disabled={!value.trim()} onClick={() => void save(value.trim())}>
            Save
          </button>
        </>
      )}
      {!current && !creating && (
        <span className="tiny" style={{ color: 'var(--amber)' }}>
          This episode has no series yet.
        </span>
      )}
      {error && <span className="tiny" style={{ color: 'var(--red, #e5484d)' }}>{error}</span>}
    </div>
  );
};
