/**
 * Who is allowed to spend money, and which one of them it was.
 *
 * THIS USED TO BE ONE ACCOUNT, and the comment here said that was the right
 * size: one operator, one laptop, one password. It was right while the studio
 * only ever answered on loopback. The moment it is reachable by three people
 * over the internet, a single shared password stops being simplicity and starts
 * being the reason the journal cannot say who published something.
 *
 * SO: NAMED PEOPLE, STILL NO USER TABLE. Each person is a name and a password
 * in one environment variable. There is no registration, no reset flow and no
 * roles, because none of those are problems anybody here has - and every one of
 * them would be another place to get authentication wrong. What the names buy
 * is the one thing a shared password cannot: an episode's journal saying which
 * person approved it.
 *
 * THE SESSION IS A SIGNED STATEMENT, NOT A LOOKUP. A cookie carrying a name, an
 * expiry and an HMAC over both is enough: the server can tell whether it issued
 * the cookie and whether it has expired, without storing anything. A session
 * table in memory would sign everybody out on every restart, and this process
 * restarts whenever a file changes.
 *
 * WHAT THIS IS NOT. It is not a login for the platform, it has no bearing on
 * listener accounts, and it does not federate with the admin dashboard. It
 * guards one server that can start a run and publish to production - which is
 * precisely why it is worth guarding properly once it leaves the laptop.
 */
import crypto from 'crypto';

export const SESSION_COOKIE = 'foundry_session';

/** How long a session lasts before it has to be re-entered. */
export const SESSION_HOURS = 12;

export class AuthNotConfigured extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'AuthNotConfigured';
  }
}

export interface Operator {
  name: string;
  password: string;
}

/**
 * Everybody who may sign in.
 *
 * FOUNDRY_USERS is `name:password` pairs separated by commas, and it is what a
 * studio with more than one person uses:
 *
 *   FOUNDRY_USERS=anant:something-long,sam:something-else
 *
 * FOUNDRY_ADMIN_PASSWORD still works on its own and signs you in as "operator",
 * because a studio with one person on one laptop should not have to care about
 * any of this.
 */
export const operators = (): Operator[] => {
  const list = (process.env.FOUNDRY_USERS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const at = entry.indexOf(':');
      if (at < 1) {
        throw new AuthNotConfigured(
          `FOUNDRY_USERS entry "${entry}" is not name:password. ` +
            `Write it as FOUNDRY_USERS=anant:secret,sam:other-secret`
        );
      }
      return { name: entry.slice(0, at).trim(), password: entry.slice(at + 1) };
    });

  const solo = process.env.FOUNDRY_ADMIN_PASSWORD;
  if (solo && solo.trim()) list.push({ name: 'operator', password: solo });

  if (!list.length) {
    throw new AuthNotConfigured(
      'Neither FOUNDRY_USERS nor FOUNDRY_ADMIN_PASSWORD is set, so the server has no way to ' +
        'tell you from anybody else who can reach this port. Set one in .env and start again.'
    );
  }

  const weak = list.filter((o) => o.password.length < 12);
  if (weak.length && process.env.FOUNDRY_HOST && process.env.FOUNDRY_HOST !== '127.0.0.1') {
    // ONLY WHEN IT IS EXPOSED. A twelve-character minimum on a loopback server
    // is theatre; on one anybody can reach it is the difference between a
    // password and a formality.
    throw new AuthNotConfigured(
      `This server is bound to ${process.env.FOUNDRY_HOST}, where anybody can try to sign in, ` +
        `and ${weak.map((o) => o.name).join(', ')} ${weak.length === 1 ? 'has' : 'have'} ` +
        `a password under 12 characters. Lengthen them before exposing this.`
    );
  }

  return list;
};

/**
 * A secret for signing sessions, derived from every password at once.
 *
 * Derived rather than configured separately, so there is one thing to set. It
 * also means changing ANY password invalidates every existing session, which is
 * the behaviour somebody removing a person is asking for.
 */
const signingKey = (): Buffer =>
  crypto
    .createHash('sha256')
    .update(`foundry-session:${operators().map((o) => `${o.name}:${o.password}`).join('|')}`)
    .digest();

/** Compare in constant time, so an attempt leaks neither length nor content. */
const matches = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
};

/**
 * Which person this password belongs to, if any.
 *
 * EVERY CANDIDATE IS CHECKED, even after one matches. Stopping early makes the
 * time taken depend on the order of the list, which over enough attempts says
 * which name a password belongs to.
 */
export const identify = (attempt: string): string | null => {
  let found: string | null = null;
  for (const operator of operators()) {
    if (matches(operator.password, attempt ?? '')) found = operator.name;
  }
  return found;
};

/**
 * How many wrong guesses before a source is made to wait, and for how long.
 *
 * NOT A REAL LOCKOUT. A lockout keyed on the account is a way for anybody to
 * lock a colleague out; this slows a source down and forgets about it, which is
 * what stops a password being guessed without letting a stranger deny anyone
 * access. Pointless on loopback and necessary the moment it is not.
 */
const MAX_ATTEMPTS = 8;
const COOL_OFF_MS = 15 * 60_000;

const attempts = new Map<string, { count: number; first: number }>();

export const tooManyAttempts = (source: string, now = Date.now()): boolean => {
  const record = attempts.get(source);
  if (!record) return false;
  if (now - record.first > COOL_OFF_MS) {
    attempts.delete(source);
    return false;
  }
  return record.count >= MAX_ATTEMPTS;
};

export const noteFailure = (source: string, now = Date.now()): void => {
  const record = attempts.get(source);
  if (!record || now - record.first > COOL_OFF_MS) {
    attempts.set(source, { count: 1, first: now });
    return;
  }
  record.count += 1;
};

export const noteSuccess = (source: string): void => {
  attempts.delete(source);
};

export const issueSession = (name: string, now = Date.now()): string => {
  const expires = now + SESSION_HOURS * 60 * 60 * 1000;
  const body = `${encodeURIComponent(name)}.${expires}`;
  const mac = crypto.createHmac('sha256', signingKey()).update(body).digest('hex');
  return `${body}.${mac}`;
};

/** The person this session belongs to, or null if it is not one we issued. */
export const sessionUser = (token: string | undefined, now = Date.now()): string | null => {
  if (!token) return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [name, expiresRaw, mac] = parts as [string, string, string];
  const expires = Number(expiresRaw);
  if (!Number.isFinite(expires) || expires < now) return null;

  const expected = crypto
    .createHmac('sha256', signingKey())
    .update(`${name}.${expiresRaw}`)
    .digest('hex');

  if (!matches(expected, mac)) return null;
  return decodeURIComponent(name);
};

/** Read one cookie out of a request header, without a cookie library. */
export const readCookie = (header: string | undefined, name: string): string | undefined => {
  for (const part of (header ?? '').split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
};

/**
 * The Set-Cookie header for a session.
 *
 * SECURE WHENEVER THIS IS NOT LOOPBACK, and that is not a detail: without it a
 * session cookie for a studio reached over the internet travels in clear on any
 * plain-http request to the same host, and whoever reads it can publish as you.
 * It is left off for localhost only because a Secure cookie there is one the
 * browser throws away, which would make the studio impossible to sign into on
 * the machine it runs on.
 */
export const sessionCookie = (token: string | null, exposed = isExposed()): string => {
  const base =
    `${SESSION_COOKIE}=${token ?? ''}; HttpOnly; SameSite=Strict; Path=/` +
    (exposed ? '; Secure' : '');
  return token ? `${base}; Max-Age=${SESSION_HOURS * 3600}` : `${base}; Max-Age=0`;
};

/** Whether this server is answering anywhere other than the machine it is on. */
export const isExposed = (): boolean => {
  const host = process.env.FOUNDRY_HOST;
  return Boolean(host && host !== '127.0.0.1' && host !== 'localhost');
};
