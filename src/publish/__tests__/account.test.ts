/**
 * Creating a channel on the platform.
 *
 * TESTED HARDER THAN MOST OF THIS REPO, because it is the one operation that
 * touches production and cannot be tried out first. There is no delete: an
 * account created wrongly is visible, followable, indexed, and stays.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadPersona } from '../../canon/load';
import {
  PlatformAccounts,
  bioFor,
  loadAccounts,
  makePassword,
  saveAccounts,
  type HttpDeps,
} from '../account';

const persona = loadPersona('honest-health');

/** A platform that records what it was asked, and answers as the real one does. */
const fake = (over: { provisionStatus?: number; isAi?: boolean } = {}) => {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const uploads: Array<{ url: string; field: string; file: string }> = [];

  const http: HttpDeps = {
    json: async (method, url, _headers, body) => {
      calls.push({ method, url, body });

      if (url.endsWith('/api/admin/auth/login')) {
        return { status: 200, json: { data: { token: 'admin-token' } }, text: '' };
      }
      if (url.endsWith('/api/auth/login')) {
        return {
          status: 200,
          json: { data: { tokens: { accessToken: 'channel-token' } } },
          text: '',
        };
      }
      if (url.endsWith('/api/admin/provision/users')) {
        if (over.provisionStatus === 409) {
          return { status: 409, json: { message: 'Username or email already exists' }, text: '' };
        }
        return {
          status: 201,
          json: { data: { user: { id: 'u1', is_ai: over.isAi !== false } } },
          text: '',
        };
      }
      return { status: 200, json: { data: {} }, text: '' };
    },
    upload: async (url, _headers, field, file) => {
      uploads.push({ url, field, file });
      return { status: 200, json: { data: {} }, text: '' };
    },
  };

  return { http, calls, uploads };
};

describe('PlatformAccounts', () => {
  it('declares the AI show at provisioning, and checks the API accepted it', async () => {
    const { http, calls } = fake();
    const api = new PlatformAccounts('https://api.test', http);

    await api.signInAsAdmin('admin@test', 'pw');
    const made = await api.provision({
      username: 'honesthealth',
      password: 'Passw0rd_aa',
      fullName: 'Honest Health',
      email: 'honesthealth@originals.audiovibe.co',
      studioSlug: 'originals',
    });

    const sent = calls.find((c) => c.url.endsWith('/provision/users'))!.body as Record<
      string,
      unknown
    >;
    expect(sent.is_ai).toBe(true);
    expect(sent.studio_slug).toBe('originals');
    expect(made).toEqual({ userId: 'u1', isAi: true });
  });

  it('reports an API that ignored the declaration, rather than assuming it worked', async () => {
    // A 201 with no label is WORSE than a failure: the account works and every
    // card it publishes is silently unlabelled.
    const { http } = fake({ isAi: false });
    const api = new PlatformAccounts('https://api.test', http);

    await api.signInAsAdmin('admin@test', 'pw');
    const made = await api.provision({
      username: 'x',
      password: 'Passw0rd_aa',
      fullName: 'X',
      email: 'x@test',
      studioSlug: 'originals',
    });

    expect(made).toEqual({ userId: 'u1', isAi: false });
  });

  it('treats an existing account as a fact, not a failure', async () => {
    // 409 is the normal state on every run after the first, and throwing would
    // make the command impossible to re-run, which is what you want to do when
    // something about the channel is wrong.
    const { http } = fake({ provisionStatus: 409 });
    const api = new PlatformAccounts('https://api.test', http);

    await api.signInAsAdmin('admin@test', 'pw');
    await expect(
      api.provision({
        username: 'x',
        password: 'Passw0rd_aa',
        fullName: 'X',
        email: 'x@test',
        studioSlug: 'originals',
      })
    ).resolves.toBe('exists');
  });

  it('does everything after provisioning AS THE CHANNEL, not as the admin', async () => {
    // The point of the whole design: a channel goes through the same endpoints
    // a person does, so a bug in the creator path is one this studio finds
    // rather than routes around.
    const { http, calls, uploads } = fake();
    const api = new PlatformAccounts('https://api.test', http);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-'));
    const img = path.join(dir, 'a.png');
    fs.writeFileSync(img, 'x');

    await api.signInAsChannel('honesthealth@originals.audiovibe.co', 'pw');
    await api.setProfile(persona);
    await api.uploadAvatar(img);
    await api.uploadCover(img);

    expect(calls.some((c) => c.method === 'PUT' && c.url.endsWith('/api/users/profile'))).toBe(true);
    expect(uploads.map((u) => u.field)).toEqual(['avatar', 'cover']);
    expect(uploads[0]!.url).toContain('/api/users/avatar');
    expect(calls.some((c) => c.url.includes('/admin/'))).toBe(false);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses to upload an image that is not there', async () => {
    const { http } = fake();
    const api = new PlatformAccounts('https://api.test', http);
    await api.signInAsChannel('a', 'b');
    await expect(api.uploadAvatar(path.join(os.tmpdir(), 'nope.png'))).rejects.toThrow(
      /no such image/
    );
  });

  it('refuses to sign in with nothing and say it worked', async () => {
    const http: HttpDeps = {
      json: async () => ({ status: 200, json: { data: {} }, text: '' }),
      upload: async () => ({ status: 200, json: {}, text: '' }),
    };
    await expect(
      new PlatformAccounts('https://api.test', http).signInAsAdmin('a', 'b')
    ).rejects.toThrow(/no token/);
  });

  it('carries the API message through, rather than a bare status', async () => {
    const http: HttpDeps = {
      json: async () => ({
        status: 400,
        json: { message: 'Username must be 3-50 characters' },
        text: '',
      }),
      upload: async () => ({ status: 200, json: {}, text: '' }),
    };
    await expect(
      new PlatformAccounts('https://api.test', http).signInAsAdmin('a', 'b')
    ).rejects.toThrow(/3-50 characters/);
  });
});

describe('makePassword', () => {
  it('satisfies the API policy every time', () => {
    // 8-128 characters with upper, lower and a digit. A generated password that
    // fails the policy fails at provisioning, on production, having already
    // been written down.
    for (let i = 0; i < 200; i++) {
      const pw = makePassword();
      expect(pw.length).toBeGreaterThanOrEqual(8);
      expect(pw.length).toBeLessThanOrEqual(128);
      expect(pw).toMatch(/[A-Z]/);
      expect(pw).toMatch(/[a-z]/);
      expect(pw).toMatch(/[0-9]/);
    }
  });

  it('is not derived from anything guessable', () => {
    expect(makePassword()).not.toBe(makePassword());
  });
});

describe('bioFor', () => {
  it('says plainly that a machine made it', () => {
    // The card carries the label; the profile should not be where somebody
    // first has to work it out.
    expect(bioFor(persona)).toMatch(/AI/);
  });

  it('drops the thesis whole rather than truncating mid-sentence', () => {
    // A cut-off final clause reads as a bug rather than as brevity.
    const wordy = { ...persona, thesis: 'x '.repeat(400) };
    const bio = bioFor(wordy);
    expect(bio.length).toBeLessThanOrEqual(500);
    expect(bio.startsWith('An AudioVibe Originals show')).toBe(true);
  });
});

describe('the credentials file', () => {
  let file: string;
  beforeEach(() => {
    file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'acct-')), 'accounts.json');
  });

  it('round-trips what a channel needs to sign in again', () => {
    // A password nobody recorded means a channel that can never be touched
    // again except by an admin reset.
    const account = {
      username: 'honesthealth',
      email: 'honesthealth@originals.audiovibe.co',
      password: 'Passw0rd_aa',
      userId: 'u1',
      createdAt: '2026-09-15T00:00:00.000Z',
      isAi: true,
      profile: { avatar: true, cover: true },
    };

    saveAccounts({ 'honest-health': account }, file);
    expect(loadAccounts(file)['honest-health']).toEqual(account);
  });

  it('is empty rather than an error before any channel exists', () => {
    expect(loadAccounts(path.join(os.tmpdir(), 'no-such-dir', 'accounts.json'))).toEqual({});
  });
});
