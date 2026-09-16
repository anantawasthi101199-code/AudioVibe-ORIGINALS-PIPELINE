/**
 * Who may sign in, and what a session proves.
 *
 * THIS IS ABOUT TO FACE THE INTERNET, which is the only reason most of it
 * exists. On loopback a shared password and a plain cookie were the right size;
 * reachable by three people over a tunnel they are not, because a shared
 * password cannot say who published something and a cookie without Secure
 * travels in clear to anybody watching.
 */
import {
  SESSION_HOURS,
  identify,
  isExposed,
  issueSession,
  noteFailure,
  noteSuccess,
  operators,
  sessionCookie,
  sessionUser,
  tooManyAttempts,
} from '../auth';

const withEnv = <T>(env: Record<string, string | undefined>, fn: () => T): T => {
  const before: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    before[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

const SOLO = { FOUNDRY_USERS: undefined, FOUNDRY_ADMIN_PASSWORD: 'a-long-enough-password', FOUNDRY_HOST: undefined };
const TEAM = {
  FOUNDRY_USERS: 'anant:anant-long-password,sam:sam-long-password',
  FOUNDRY_ADMIN_PASSWORD: undefined,
  FOUNDRY_HOST: undefined,
};

describe('operators', () => {
  it('still works with one password and no names', () => {
    // A studio with one person on one laptop should not have to care about any
    // of this.
    withEnv(SOLO, () => {
      expect(operators()).toEqual([{ name: 'operator', password: 'a-long-enough-password' }]);
    });
  });

  it('reads names and passwords for a studio with several people', () => {
    withEnv(TEAM, () => {
      expect(operators().map((o) => o.name)).toEqual(['anant', 'sam']);
    });
  });

  it('refuses a short password ONLY when the server is exposed', () => {
    // A twelve-character minimum on loopback is theatre. On a host anybody can
    // reach it is the difference between a password and a formality.
    withEnv({ ...TEAM, FOUNDRY_USERS: 'sam:short' }, () => {
      expect(() => operators()).not.toThrow();
    });

    withEnv({ ...TEAM, FOUNDRY_USERS: 'sam:short', FOUNDRY_HOST: '0.0.0.0' }, () => {
      expect(() => operators()).toThrow(/under 12 characters/);
    });
  });

  it('says what is wrong with a malformed entry', () => {
    withEnv({ ...TEAM, FOUNDRY_USERS: 'justapassword' }, () => {
      expect(() => operators()).toThrow(/name:password/);
    });
  });

  it('refuses to run with nobody able to sign in', () => {
    withEnv({ FOUNDRY_USERS: undefined, FOUNDRY_ADMIN_PASSWORD: undefined }, () => {
      expect(() => operators()).toThrow(/no way to tell you from anybody else/);
    });
  });
});

describe('identify', () => {
  it('says WHICH person a password belongs to', () => {
    // The whole reason for names: an episode's journal can say who approved it.
    withEnv(TEAM, () => {
      expect(identify('anant-long-password')).toBe('anant');
      expect(identify('sam-long-password')).toBe('sam');
    });
  });

  it('is null for a wrong password, an empty one and a name', () => {
    withEnv(TEAM, () => {
      expect(identify('nope')).toBeNull();
      expect(identify('')).toBeNull();
      expect(identify('anant')).toBeNull();
    });
  });
});

describe('a session', () => {
  it('carries the person, so the server knows who is asking', () => {
    withEnv(TEAM, () => {
      expect(sessionUser(issueSession('sam'))).toBe('sam');
    });
  });

  it('expires', () => {
    withEnv(TEAM, () => {
      const token = issueSession('sam', Date.now());
      const later = Date.now() + (SESSION_HOURS + 1) * 3600_000;
      expect(sessionUser(token, later)).toBeNull();
    });
  });

  it('cannot be forged by editing the name', () => {
    withEnv(TEAM, () => {
      const token = issueSession('sam');
      const [, expires, mac] = token.split('.');
      expect(sessionUser(`anant.${expires}.${mac}`)).toBeNull();
    });
  });

  it('CHANGING ANY PASSWORD SIGNS EVERYBODY OUT', () => {
    // Which is what somebody removing a person from the list is asking for.
    const token = withEnv(TEAM, () => issueSession('sam'));

    withEnv({ ...TEAM, FOUNDRY_USERS: 'anant:anant-long-password' }, () => {
      expect(sessionUser(token)).toBeNull();
    });
  });

  it('rejects rubbish rather than throwing', () => {
    withEnv(TEAM, () => {
      expect(sessionUser(undefined)).toBeNull();
      expect(sessionUser('')).toBeNull();
      expect(sessionUser('nonsense')).toBeNull();
      expect(sessionUser('a.b')).toBeNull();
    });
  });
});

describe('the session cookie', () => {
  it('is Secure once the studio is not on loopback', () => {
    // Without this, a session for a studio reached over the internet travels in
    // clear on any plain-http request to the same host, and whoever reads it
    // can publish as you.
    expect(sessionCookie('x', true)).toContain('Secure');
  });

  it('is NOT Secure on localhost, where the browser would throw it away', () => {
    expect(sessionCookie('x', false)).not.toContain('Secure');
  });

  it('is always HttpOnly and SameSite=Strict', () => {
    for (const exposed of [true, false]) {
      expect(sessionCookie('x', exposed)).toContain('HttpOnly');
      expect(sessionCookie('x', exposed)).toContain('SameSite=Strict');
    }
  });

  it('knows whether the host is loopback', () => {
    withEnv({ FOUNDRY_HOST: undefined }, () => expect(isExposed()).toBe(false));
    withEnv({ FOUNDRY_HOST: '127.0.0.1' }, () => expect(isExposed()).toBe(false));
    withEnv({ FOUNDRY_HOST: '0.0.0.0' }, () => expect(isExposed()).toBe(true));
  });
});

describe('guessing', () => {
  it('slows a source down after enough wrong answers', () => {
    const source = `test-${Math.random()}`;
    expect(tooManyAttempts(source)).toBe(false);

    for (let i = 0; i < 8; i++) noteFailure(source);
    expect(tooManyAttempts(source)).toBe(true);
  });

  it('forgets after the cool-off, rather than locking anybody out for good', () => {
    // A real lockout keyed on the account is a way for a stranger to lock a
    // colleague out. This slows a source and forgets.
    const source = `test-${Math.random()}`;
    const start = Date.now();

    for (let i = 0; i < 8; i++) noteFailure(source, start);
    expect(tooManyAttempts(source, start)).toBe(true);
    expect(tooManyAttempts(source, start + 16 * 60_000)).toBe(false);
  });

  it('forgives a source that gets it right', () => {
    const source = `test-${Math.random()}`;
    for (let i = 0; i < 8; i++) noteFailure(source);

    noteSuccess(source);
    expect(tooManyAttempts(source)).toBe(false);
  });

  it('counts each source separately', () => {
    const a = `test-a-${Math.random()}`;
    const b = `test-b-${Math.random()}`;

    for (let i = 0; i < 8; i++) noteFailure(a);
    expect(tooManyAttempts(a)).toBe(true);
    expect(tooManyAttempts(b)).toBe(false);
  });
});
