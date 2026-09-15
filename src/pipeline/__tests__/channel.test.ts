/**
 * Setting a channel up, which happens once and touches production.
 *
 * WHAT THESE ARE FOR. Every one of them is a way the setup can half-happen:
 * the account exists but the password was lost, the API is older than this
 * studio and dropped the AI label, the network died between provisioning and
 * the avatar. None of those can be discovered by running the command again on
 * a real platform, because by then the account is already there.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PlatformAccounts, loadAccounts, type HttpDeps } from '../../publish/account';
import { emailFor, setUpChannel } from '../channel';

const CHANNEL = 'honest-health';

/** A platform that records what it was asked, and answers as the real one does. */
const fake = (over: { provisionStatus?: number; isAi?: boolean } = {}) => {
  const calls: string[] = [];
  const uploads: string[] = [];
  let body: Record<string, unknown> = {};

  const http: HttpDeps = {
    json: async (method, url, _headers, sent) => {
      calls.push(`${method} ${url.replace('https://api.test', '')}`);

      if (url.endsWith('/api/admin/auth/login')) {
        return { status: 200, json: { data: { token: 'admin-token' } }, text: '' };
      }
      if (url.endsWith('/api/auth/login')) {
        body = sent as Record<string, unknown>;
        return { status: 200, json: { data: { tokens: { accessToken: 'ch' } } }, text: '' };
      }
      if (url.endsWith('/api/admin/provision/users')) {
        if (over.provisionStatus === 409) {
          return { status: 409, json: { message: 'already exists' }, text: '' };
        }
        return {
          status: 201,
          json: { data: { user: { id: 'u1', is_ai: over.isAi !== false } } },
          text: '',
        };
      }
      return { status: 200, json: { data: {} }, text: '' };
    },
    upload: async (url) => {
      uploads.push(url.replace('https://api.test', ''));
      return { status: 200, json: { data: {} }, text: '' };
    },
  };

  return {
    accounts: new PlatformAccounts('https://api.test', http),
    calls,
    uploads,
    signedInAs: () => body,
  };
};

describe('setUpChannel', () => {
  let dir: string;
  let artDir: string;
  let accountsFile: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chan-'));
    artDir = path.join(dir, 'art');
    accountsFile = path.join(dir, 'accounts.json');

    // Artwork already drawn, so these tests never reach an image API. The
    // generate-or-draw decision has its own suite in src/art.
    fs.mkdirSync(artDir, { recursive: true });
    fs.writeFileSync(path.join(artDir, 'avatar.png'), 'png');
    fs.writeFileSync(path.join(artDir, 'cover.png'), 'png');

    process.env.FOUNDRY_ACCOUNTS_FILE = accountsFile;
    process.env.AUDIOVIBE_API_URL = 'https://api.test';
  });

  afterEach(() => {
    delete process.env.FOUNDRY_ACCOUNTS_FILE;
    delete process.env.AUDIOVIBE_API_URL;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates the account, dresses it, and writes down the password', async () => {
    const api = fake();
    const result = await setUpChannel(CHANNEL, 'admin@test', 'pw', {
      accounts: api.accounts,
      artDir,
    });

    expect(result.existed).toBe(false);
    expect(result.account.isAi).toBe(true);
    expect(result.account.email).toBe(emailFor(result.account.username));
    expect(api.uploads).toEqual(['/api/users/avatar', '/api/users/cover']);

    // THE PASSWORD IS THE POINT. An account with one nobody recorded can never
    // be signed into again except by an admin reset.
    const saved = loadAccounts(accountsFile)[CHANNEL]!;
    expect(saved.password).toBe(result.account.password);
    expect(saved.userId).toBe('u1');
    expect(saved.profile).toEqual({ avatar: true, cover: true });
  });

  it('signs in as the studio operator only to create the account', async () => {
    // Everything after provisioning goes through the endpoints a person uses,
    // which is the whole reason this studio has accounts rather than a token.
    const api = fake();
    await setUpChannel(CHANNEL, 'admin@test', 'pw', { accounts: api.accounts, artDir });

    const adminCalls = api.calls.filter((c) => c.includes('/admin/'));
    expect(adminCalls).toEqual(['POST /api/admin/auth/login', 'POST /api/admin/provision/users']);
    expect(api.calls).toContain('PUT /api/users/profile');
  });

  it('re-runs against an existing channel without touching admin at all', async () => {
    // The likeliest reason to run this twice is that something about the
    // channel is wrong, so a rerun must repair rather than fail.
    const first = fake();
    await setUpChannel(CHANNEL, 'admin@test', 'pw', { accounts: first.accounts, artDir });

    const again = fake();
    const result = await setUpChannel(CHANNEL, 'admin@test', 'pw', {
      accounts: again.accounts,
      artDir,
    });

    expect(result.existed).toBe(true);
    expect(again.calls.some((c) => c.includes('/admin/'))).toBe(false);
    expect(again.signedInAs().password).toBe(result.account.password);
    expect(again.uploads).toEqual(['/api/users/avatar', '/api/users/cover']);
  });

  it('stops when the account exists but this studio has no password for it', async () => {
    // The one failure here a rerun cannot fix, so it says what a person has to
    // do rather than reporting a 409.
    const api = fake({ provisionStatus: 409 });
    await expect(
      setUpChannel(CHANNEL, 'admin@test', 'pw', { accounts: api.accounts, artDir })
    ).rejects.toThrow(/no password for it/);

    expect(loadAccounts(accountsFile)).toEqual({});
  });

  it('stops when the API created the account without the AI label', async () => {
    // A 201 with no label is worse than a failure: the account works, and
    // every card it publishes is silently unlabelled.
    const api = fake({ isAi: false });
    await expect(
      setUpChannel(CHANNEL, 'admin@test', 'pw', { accounts: api.accounts, artDir })
    ).rejects.toThrow(/did not accept the AI declaration/);

    // Nothing recorded, because nothing usable was created.
    expect(loadAccounts(accountsFile)).toEqual({});
    expect(api.uploads).toEqual([]);
  });

  it('keeps the artwork a channel already has', async () => {
    // A channel's face should not change because somebody re-ran a command.
    const api = fake();
    const before = fs.readFileSync(path.join(artDir, 'avatar.png'));

    const result = await setUpChannel(CHANNEL, 'admin@test', 'pw', {
      accounts: api.accounts,
      artDir,
    });

    expect(result.generated).toEqual([]);
    expect(fs.readFileSync(path.join(artDir, 'avatar.png'))).toEqual(before);
  });

  it('resumes at the artwork when a previous run died after provisioning', async () => {
    const first = fake();
    await setUpChannel(CHANNEL, 'admin@test', 'pw', { accounts: first.accounts, artDir });

    // What a run interrupted between provisioning and the uploads leaves behind.
    const half = loadAccounts(accountsFile);
    half[CHANNEL]!.profile = { avatar: false, cover: false };
    fs.writeFileSync(accountsFile, JSON.stringify(half, null, 2));

    const again = fake();
    await setUpChannel(CHANNEL, 'admin@test', 'pw', { accounts: again.accounts, artDir });

    expect(again.uploads).toEqual(['/api/users/avatar', '/api/users/cover']);
    expect(loadAccounts(accountsFile)[CHANNEL]!.profile).toEqual({ avatar: true, cover: true });
  });
});

describe('emailFor', () => {
  it('is an address on a domain the studio owns', () => {
    // The provisioning endpoint invents `<user>@profiles.audiovibe.invalid` if
    // none is given, and that address can never receive a password reset or a
    // security notice - a problem the day it matters and never before.
    expect(emailFor('honesthealth')).toBe('honesthealth@originals.audiovibe.co');
    expect(emailFor('x')).not.toMatch(/\.invalid$/);
  });
});
