/**
 * What a run looks like while it is happening.
 *
 * WHY THIS EXISTS. A run prints sixty to a hundred lines, every one of them
 * indented by two spaces, with the stage repeated as a prefix and no way to see
 * where you are in the whole thing. "checked 40/93 claims" scrolls past
 * identically to "narrowed c39 to what its quote supports", a nine-minute wait
 * looks the same as a nine-second one, and the only way to know what a stage
 * cost was to read the journal afterwards. A listener called it unreadable and
 * was right.
 *
 * So this is a presentation layer and nothing more. It owns no decisions, holds
 * no state the pipeline needs, and can be removed without changing a single
 * output artifact. Everything it knows, it is told.
 *
 * DEGRADES ON PURPOSE. A progress bar that rewrites its own line is right in a
 * terminal and is noise in a log file or a CI job, where every redraw becomes
 * another line. When stdout is not a TTY the bars become one line each at the
 * end, the rules become plain text, and the output stays greppable.
 *
 * NO COLOUR AND NO EMOJI. Colour is the first thing to break when output is
 * piped, redirected or read by somebody using a screen reader, and it carries
 * nothing here that a word does not carry better.
 */

/** Terminal width, clamped so a very wide window does not draw a 300-char rule. */
const width = (): number => Math.min(Math.max(process.stdout.columns ?? 80, 48), 100);

const isTty = (): boolean => Boolean(process.stdout.isTTY);

/** m:ss, which is the only precision a stage timing deserves. */
export const duration = (ms: number): string => {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

export const pence = (p: number): string => (p >= 100 ? `£${(p / 100).toFixed(2)}` : `${Math.round(p)}p`);

/**
 * A progress bar, or the plain truth when there is no terminal to draw in.
 *
 * The filled character is a full block and the empty one a light shade, which
 * read as a bar at any font and carry no meaning of their own.
 */
export const bar = (done: number, total: number, cells = 24): string => {
  if (total <= 0) return '';
  const filled = Math.max(0, Math.min(cells, Math.round((done / total) * cells)));
  return `${'█'.repeat(filled)}${'░'.repeat(cells - filled)}`;
};

/**
 * A line of the shape "40/93" or "3 of 4", which is what a long loop reports.
 *
 * PRESENTATION SUGAR OVER MESSAGES THIS REPO WRITES ITSELF, which is the only
 * reason reading them back is acceptable. A message that does not match simply
 * prints as a line, so a changed wording downstream costs a bar and never a
 * crash or a wrong number.
 */
const COUNTED = /\b(\d+)\s*(?:\/|of)\s*(\d+)\b/;

export interface Progress {
  done: number;
  total: number;
}

export const counted = (message: string): Progress | null => {
  const m = COUNTED.exec(message);
  if (!m) return null;
  const done = Number(m[1]);
  const total = Number(m[2]);
  // A count going the wrong way is a coincidence in prose, not a progress
  // report: "one of three reasons" should print as a sentence.
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 1 || done > total) return null;
  return { done, total };
};

export interface ReporterOptions {
  /** Spend so far, read when a section closes. */
  spentPence?: () => number;
  /** The stages this run will pass through, in order, for "3 of 8". */
  stages?: readonly string[];
  out?: (text: string) => void;
}

/**
 * Prints a run as it happens.
 *
 * One instance per command. Sections open when the stage changes and close when
 * the next one opens or the run ends, so nothing has to remember to close one.
 */
export class Reporter {
  private current: string | null = null;
  private startedAt = 0;
  private spentAtSectionStart = 0;
  private lastWasBar = false;
  private out: (text: string) => void;

  constructor(private opts: ReporterOptions = {}) {
    this.out = opts.out ?? ((text) => process.stdout.write(text));
  }

  private write(line: string): void {
    // A bar left the cursor mid-line. Anything printed after it starts on a
    // fresh one, or it lands inside the bar.
    if (this.lastWasBar) {
      this.out('\n');
      this.lastWasBar = false;
    }
    this.out(`${line}\n`);
  }

  private rule(char = '─'): string {
    return char.repeat(width());
  }

  /**
   * Wrap to the terminal, hanging the continuation under the text.
   *
   * A topic is a sentence and a brief's angle is a paragraph, and both were
   * running off the right edge into whatever the terminal chose to do about it.
   * Wrapping on words with the continuation indented keeps the label column
   * readable down the left.
   */
  private wrap(text: string, indent: number): string[] {
    const room = Math.max(20, width() - indent - 1);
    const lines: string[] = [];
    let line = '';

    for (const word of text.split(/\s+/).filter(Boolean)) {
      if (!line.length) line = word;
      else if (line.length + 1 + word.length <= room) line += ` ${word}`;
      else {
        lines.push(line);
        line = word;
      }
    }
    if (line.length) lines.push(line);
    return lines.length ? lines : [''];
  }

  /** The block at the top: what is being made, and under what constraints. */
  header(title: string, rows: Array<[string, string]>): void {
    this.write('');
    this.write(this.rule('━'));
    this.write(`  ${title}`);
    this.write(this.rule('━'));

    const pad = Math.max(...rows.map(([k]) => k.length));
    for (const [k, v] of rows) {
      const [first, ...rest] = this.wrap(v, pad + 5);
      this.write(`  ${k.padEnd(pad)}   ${first}`);
      for (const line of rest) this.write(`  ${' '.repeat(pad)}   ${line}`);
    }
    this.write('');
  }

  /**
   * Open a stage. Closes the previous one, with what it cost and how long.
   *
   * Called with the same stage twice in a row does nothing, so a caller can
   * announce the stage on every message without checking.
   */
  section(stage: string): void {
    if (stage === this.current) return;
    this.closeSection();

    this.current = stage;
    this.startedAt = Date.now();
    this.spentAtSectionStart = this.opts.spentPence?.() ?? 0;

    const stages = this.opts.stages ?? [];
    const index = stages.indexOf(stage);
    const position = index >= 0 ? `${index + 1}/${stages.length}  ` : '';
    const label = `${position}${stage.toUpperCase()}`;

    // A rule that runs to the edge, with the label sitting in it.
    const tail = Math.max(0, width() - label.length - 5);
    this.write(`┌─ ${label} ${this.rule().slice(0, tail)}`);
  }

  private closeSection(): void {
    if (!this.current) return;

    const spent = (this.opts.spentPence?.() ?? 0) - this.spentAtSectionStart;
    const took = duration(Date.now() - this.startedAt);
    const cost = spent >= 0.5 ? `${pence(spent)} · ` : '';

    this.write(`└─ ${cost}${took}`);
    this.write('');
    this.current = null;
  }

  /**
   * One line inside the current stage, drawn as a bar when it carries a count.
   *
   * In a terminal the bar rewrites its own line, so ninety-three claims are one
   * line that fills rather than ten that scroll. Anywhere else it prints once
   * per call like any other line.
   */
  line(message: string): void {
    const progress = counted(message);
    if (!progress || !isTty()) {
      for (const line of this.wrap(message, 3)) this.write(`   ${line}`);
      return;
    }

    const { done, total } = progress;
    const text = `   ${bar(done, total)}  ${message}`;
    this.out(`\r${text.slice(0, width() - 1).padEnd(width() - 1)}`);
    this.lastWasBar = true;

    // The last update leaves the line finished rather than waiting for the next
    // thing printed to push it up.
    if (done >= total) {
      this.out('\n');
      this.lastWasBar = false;
    }
  }

  /** A result worth setting apart from the running commentary. */
  result(message: string): void {
    const [first, ...rest] = this.wrap(message, 5);
    this.write(`   → ${first}`);
    for (const line of rest) this.write(`     ${line}`);
  }

  /** Something to run next, printed outside any stage. */
  next(lines: string[]): void {
    this.closeSection();
    for (const line of lines) this.write(`  ${line}`);
    this.write('');
  }

  /** Close whatever is open and print the closing block. */
  finish(rows: Array<[string, string]> = []): void {
    this.closeSection();
    if (!rows.length) return;

    const pad = Math.max(...rows.map(([k]) => k.length));
    for (const [k, v] of rows) {
      const [first, ...rest] = this.wrap(v, pad + 5);
      this.write(`  ${k.padEnd(pad)}   ${first}`);
      for (const line of rest) this.write(`  ${' '.repeat(pad)}   ${line}`);
    }
    this.write('');
  }
}
