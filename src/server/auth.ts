/**
 * Who is allowed to spend money.
 *
 * ONE ACCOUNT, AND THAT IS THE RIGHT SIZE FOR THIS. The Foundry has exactly one
 * operator, every button in it costs real money, and there is nothing in here
 * that two people need different views of. A user table, roles and a password
 * reset flow would be infrastructure built for a problem nobody has, and every
 * line of it would be another place to get authentication wrong.
 *
 * WHAT THIS IS NOT. It is not a login for the platform, it has no bearing on
 * listener accounts, and it does not federate with the admin dashboard. It
 * guards one local server that can start a run.
 *
 * THE SESSION IS A SIGNED STATEMENT, NOT A LOOKUP. A cookie carrying an expiry
 * and an HMAC of that expiry is enough: the server can tell whether it issued
 * the cookie and whether it has expired, without storing anything. That matters
 * more than it sounds - a session table in memory would silently sign everybody
 * out on every restart, and this process restarts whenever a file changes.
 */
import crypto from 'crypto';

export const SESSION_COOKIE = 'foundry_session';

/** How long a session lasts before it has to be re-entered. */
export const SESSION_HOURS = 12;

export class AuthNotConfigured extends Error {
  constructor() {
    super(
      'FOUNDRY_ADMIN_PASSWORD is not set, so the server has no way to tell you from ' +
        'anybody else who can reach this port. Set it in .env and start again.'
    );
    this.name = 'AuthNotConfigured';
  }
}

const password = (): string => {
  const value = process.env.FOUNDRY_ADMIN_PASSWORD;
  if (!value || !value.trim()) throw new AuthNotConfigured();
  return value;
};

/**
 * A secret for signing sessions, derived from the password.
 *
 * Derived rather than configured separately, so there is one thing to set. It
 * also means changing the password invalidates every existing session, which is
 * the behaviour somebody changing a password is asking for.
 */
const signingKey = (): Buffer =>
  crypto.createHash('sha256').update(`foundry-session:${password()}`).digest();

/**
 * Compare in constant time.
 *
 * A plain `===` on a password leaks its length and, over enough attempts, its
 * contents. This is a local server and the attack is unlikely; it is also two
 * lines, and the version of this that skips it is the version somebody copies
 * into something exposed.
 */
export const passwordMatches = (attempt: string): boolean => {
  const expected = Buffer.from(password());
  const given = Buffer.from(attempt ?? '');
  if (expected.length !== given.length) return false;
  return crypto.timingSafeEqual(expected, given);
};

export const issueSession = (now = Date.now()): string => {
  const expires = now + SESSION_HOURS * 60 * 60 * 1000;
  const mac = crypto.createHmac('sha256', signingKey()).update(String(expires)).digest('hex');
  return `${expires}.${mac}`;
};

export const sessionIsValid = (token: string | undefined, now = Date.now()): boolean => {
  if (!token) return false;

  const [expiresRaw, mac] = token.split('.');
  if (!expiresRaw || !mac) return false;

  const expires = Number(expiresRaw);
  if (!Number.isFinite(expires) || expires < now) return false;

  const expected = crypto.createHmac('sha256', signingKey()).update(expiresRaw).digest('hex');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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
 * HttpOnly and SameSite=Strict, because nothing in the browser needs to read
 * this and no other site should be able to make a request carrying it. Not
 * Secure, deliberately: this serves http://localhost, and a Secure cookie there
 * is a cookie the browser throws away. See serve() for what happens when the
 * server is bound to something other than loopback.
 */
export const sessionCookie = (token: string | null): string => {
  const base = `${SESSION_COOKIE}=${token ?? ''}; HttpOnly; SameSite=Strict; Path=/`;
  return token ? `${base}; Max-Age=${SESSION_HOURS * 3600}` : `${base}; Max-Age=0`;
};
