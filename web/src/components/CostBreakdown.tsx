/**
 * Where the money went (owner, 2026-10-09): the run's total as one bar, split
 * by colour into research, writing, the tag pass and the voice, with the voice
 * split again into the first voicing, voicing again, regenerations and
 * re-takes. Every number comes from the run's own records (server/costs.ts).
 */
import { money, type CostBreakdown as Breakdown } from '../api';

export const COST_COLOUR: Record<string, string> = {
  research: '#6f9ef0',
  writing: '#3fb98a',
  tagPass: '#c07ad8',
  voiceFirst: '#f0a831',
  voiceAgain: '#f07a3a',
  voiceRegenerate: '#e8615f',
  voiceRetake: '#d4459c',
  voiceUnlogged: '#b8902f',
  other: '#5d6b8c',
};

export const CostBreakdown = ({ costs }: { costs: Breakdown }) => {
  const total = Math.max(costs.totalPence, 0.01);
  if (!costs.segments.length) return null;
  return (
    <div className="breakdown">
      <div className="breakdown-bar" role="img" aria-label="What the money went on">
        {costs.segments.map((s) => (
          <span
            key={s.key}
            style={{ width: `${(s.pence / total) * 100}%`, background: COST_COLOUR[s.key] ?? '#5d6b8c' }}
            title={`${s.label}: ${money(s.pence)}`}
          />
        ))}
      </div>
      <ul className="breakdown-key">
        {costs.segments.map((s) => (
          <li key={s.key}>
            <i style={{ background: COST_COLOUR[s.key] ?? '#5d6b8c' }} />
            <span className="breakdown-label">{s.label}</span>
            <span className="mono">{money(s.pence)}</span>
          </li>
        ))}
      </ul>
      {costs.findings.length > 0 && (
        <ul className="breakdown-findings">
          {costs.findings.map((f, i) => (
            <li key={i}>{f}</li>
          ))}
        </ul>
      )}
    </div>
  );
};

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const pence = (p: number) => (p < 1 && p > 0 ? `${p.toFixed(1)}p` : money(p));

/** Every voicing and every call to the engine, with what it carried and cost. */
export const VoiceLog = ({ costs }: { costs: Breakdown }) => {
  const sessions = costs.voice.sessions;
  if (!sessions.length) {
    return (
      <p className="faint tiny" style={{ margin: 0 }}>
        Nothing voiced since the voice log began. Every voicing from now on is listed here, call by call.
      </p>
    );
  }
  return (
    <div className="stack tight">
      <p className="faint tiny" style={{ margin: 0 }}>
        The voice is charged by the character: {costs.voice.ratePer1k.elevenlabs}p per 1,000 on ElevenLabs,{' '}
        {costs.voice.ratePer1k.openai}p on GPT. Tags are characters too (about 10 each). A part that is voiced again,
        or re-taken, is paid for again in full.
      </p>
      {sessions.map((s, n) => (
        <div key={s.at} className="voice-session">
          <div className="voice-session-head">
            <strong>Voicing {n + 1}</strong>
            <span className="faint tiny">
              {when(s.at)} · {s.engine === 'elevenlabs' ? 'ElevenLabs' : s.engine === 'openai' ? 'GPT' : s.engine} · {s.reason}
            </span>
            <span className="spacer" />
            <span className="mono">{pence(s.pence)}</span>
          </div>
          <table className="runs voice-calls">
            <thead>
              <tr>
                <th>Part</th>
                <th>What</th>
                <th className="right">Words</th>
                <th className="right">Characters</th>
                <th className="right">Tags</th>
                <th className="right">Cost</th>
              </tr>
            </thead>
            <tbody>
              {s.calls.map((c, i) => (
                <tr key={i} className={c.attempt}>
                  <td className="mono">{c.beats.join(' + ')}</td>
                  <td title={c.note}>
                    {c.attempt === 'voiced' ? 'voiced' : c.attempt === 'retake' ? 're-take (paid again)' : 'unchanged, reused free'}
                  </td>
                  <td className="right num">{c.words}</td>
                  <td className="right num">{c.chars.toLocaleString()}</td>
                  <td className="right num">{c.tags ? `${c.tags} (${c.tagChars} ch)` : '-'}</td>
                  <td className="right num">{c.attempt === 'reused' ? '-' : pence(c.pence)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
};
