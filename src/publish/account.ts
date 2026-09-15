/**
 * Making a channel exist on the platform, once.
 *
 * WHAT THIS IS NOT. It is not the publish path. Publishing happens weekly with a
 * session this file produced; this runs once per channel, ever, and then the
 * credentials it records are all anybody needs.
 *
 * WHY A SESSION AND NOT AN INGEST TOKEN. The ingest credential exists and works,
 * and it is the right thing for a firehose. But a channel set up this way
 * behaves like every other creator on the platform: it logs in, it has a
 * password, its profile is edited through the same endpoint a person's is, and
 * its uploads go through the same controller. That means a bug in the creator
 * path is a bug this studio finds, rather than one it routes around - and the
 * studio's content sits in exactly the same shape as everybody else's.
 *
 * THE AI LABEL IS NOT PART OF THAT SAMENESS. `is_ai` is declared at provisioning
 * and stays. It renders on every card the channel publishes. A show that reads
 * documents and is honest about what it cannot support should not be coy about
 * what wrote it.
 *
 * IDEMPOTENT WHERE IT CAN BE. Provisioning is not - the API has no create-or-get
 * and a second call returns 409 - so an existing account is detected and reused
 * rather than being a failure. Everything after that is a PUT or an overwrite
 * and can simply be done again, which matters because the most likely reason to
 * run this twice is that something about the channel is wrong.
 */
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { Persona } from '../canon/schema';
import { repoRoot } from '../config';

export class AccountError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'AccountError';
  }
}

export interface HttpDeps {
  json: (
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: unknown
  ) => Promise<{ status: number; json: unknown; text: string }>;
  upload: (
    url: string,
    headers: Record<string, string>,
    field: string,
    filePath: string
  ) => Promise<{ status: number; json: unknown; text: string }>;
}

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

export const nodeHttp: HttpDeps = {
  json: async (method, url, headers, body) => {
    const res = await fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json', ...headers } : headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      // Left null. An HTML error page from a proxy is worth seeing verbatim.
    }
    return { status: res.status, json, text };
  },

  upload: async (url, headers, field, filePath) => {
    const form = new FormData();
    form.append(
      field,
      new Blob([fs.readFileSync(filePath)], {
        type: MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      }),
      path.basename(filePath)
    );
    const res = await fetch(url, { method: 'POST', headers, body: form });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* as above */
    }
    return { status: res.status, json, text };
  },
};

/**
 * What a channel's account is, once it exists.
 *
 * COMMITTED TO THE REPO, and that is a deliberate and uncomfortable decision.
 * These are real credentials for real accounts on production, and the
 * alternative - a password nobody recorded - means a channel that can never be
 * touched again except by an admin reset, which is worse. The file is the same
 * kind of artifact as voices.json: a fact about a channel that has to survive
 * the machine it was created on.
 *
 * It lives at accounts.json and MUST be in .gitignore for any repo that is not
 * private. This one has no remote.
 */
export const accountSchema = z.object({
  username: z.string(),
  email: z.string(),
  password: z.string(),
  userId: z.string(),
  createdAt: z.string(),
  /** Whether the API accepted the AI declaration, checked rather than assumed. */
  isAi: z.boolean(),
  profile: z.object({ avatar: z.boolean(), cover: z.boolean() }).default({
    avatar: false,
    cover: false,
  }),
});

export type Account = z.infer<typeof accountSchema>;

export const accountsSchema = z.record(accountSchema);

export const accountsPath = (): string =>
  process.env.FOUNDRY_ACCOUNTS_FILE ?? path.join(repoRoot(), 'accounts.json');

export const loadAccounts = (file = accountsPath()): Record<string, Account> => {
  if (!fs.existsSync(file)) return {};
  return accountsSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
};

export const saveAccounts = (accounts: Record<string, Account>, file = accountsPath()): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(accounts, null, 2)}\n`, 'utf8');
};

/**
 * A password a channel can keep.
 *
 * The API wants 8-128 characters with upper, lower and a digit. Generated
 * rather than derived from the channel name, because a password anybody could
 * guess from the handle is not a password - and nobody types these, so there is
 * no reason for them to be memorable.
 */
export const makePassword = (random = () => Math.random()): string => {
  const pick = (chars: string, n: number): string =>
    Array.from({ length: n }, () => chars[Math.floor(random() * chars.length)]).join('');

  return (
    pick('ABCDEFGHJKLMNPQRSTUVWXYZ', 4) +
    pick('abcdefghijkmnopqrstuvwxyz', 10) +
    pick('23456789', 4) +
    '_' +
    pick('abcdefghijkmnopqrstuvwxyz', 6)
  );
};

export class PlatformAccounts {
  private token: string | null = null;

  constructor(
    private baseUrl: string,
    private http: HttpDeps = nodeHttp
  ) {}

  private auth(): Record<string, string> {
    if (!this.token) throw new AccountError(401, 'not signed in');
    return { authorization: `Bearer ${this.token}` };
  }

  private async call(
    method: string,
    path: string,
    body?: unknown,
    withAuth = true
  ): Promise<Record<string, unknown>> {
    const res = await this.http.json(
      method,
      `${this.baseUrl}${path}`,
      withAuth ? this.auth() : {},
      body
    );

    if (res.status < 200 || res.status >= 300) {
      const message =
        (res.json as { message?: string; error?: { message?: string } } | null)?.message ??
        (res.json as { error?: { message?: string } } | null)?.error?.message ??
        res.text.slice(0, 200);
      throw new AccountError(res.status, `${method} ${path}: ${message}`);
    }
    return (res.json as { data?: Record<string, unknown> } | null)?.data ?? {};
  }

  /** Sign in as the studio operator, which is the only way to create a channel. */
  async signInAsAdmin(email: string, password: string): Promise<void> {
    const data = await this.call('POST', '/api/admin/auth/login', { email, password }, false);
    const token = data.token as string | undefined;
    if (!token) throw new AccountError(500, 'admin login returned no token');
    this.token = token;
  }

  async signInAsChannel(email: string, password: string): Promise<string> {
    const data = await this.call('POST', '/api/auth/login', { email, password }, false);
    const tokens = data.tokens as { accessToken?: string } | undefined;
    if (!tokens?.accessToken) throw new AccountError(500, 'login returned no token');
    this.token = tokens.accessToken;
    return this.token;
  }

  /**
   * Create the channel's account, declared as an AI show.
   *
   * A 409 IS NOT A FAILURE HERE. It means the account already exists, which is
   * the normal state of affairs on every run after the first, and the caller
   * decides whether that is a problem. Throwing would make re-running this
   * command impossible, and the most likely reason to re-run it is that
   * something about the channel needs fixing.
   */
  async provision(input: {
    username: string;
    password: string;
    fullName: string;
    email: string;
    studioSlug: string;
  }): Promise<{ userId: string; isAi: boolean } | 'exists'> {
    try {
      const data = await this.call('POST', '/api/admin/provision/users', {
        username: input.username,
        password: input.password,
        full_name: input.fullName,
        email: input.email,
        is_ai: true,
        studio_slug: input.studioSlug,
      });

      const user = data.user as { id?: string; is_ai?: boolean } | undefined;
      if (!user?.id) throw new AccountError(500, 'provisioning returned no user');

      // CHECKED RATHER THAN ASSUMED. An older API that ignores the flag would
      // return 201 and a perfectly good account with no label on it, and the
      // first anybody would know is a published card without the badge.
      return { userId: user.id, isAi: user.is_ai === true };
    } catch (err) {
      if (err instanceof AccountError && err.status === 409) return 'exists';
      throw err;
    }
  }

  /** Everything about the channel a listener reads before pressing play. */
  async setProfile(persona: Persona): Promise<void> {
    await this.call('PUT', '/api/users/profile', {
      full_name: persona.name,
      bio: bioFor(persona),
      is_private: false,
    });
  }

  async uploadAvatar(file: string): Promise<void> {
    await this.image('/api/users/avatar', 'avatar', file);
  }

  async uploadCover(file: string): Promise<void> {
    await this.image('/api/users/cover', 'cover', file);
  }

  private async image(path: string, field: string, file: string): Promise<void> {
    if (!fs.existsSync(file)) throw new AccountError(400, `no such image: ${file}`);

    const res = await this.http.upload(`${this.baseUrl}${path}`, this.auth(), field, file);
    if (res.status < 200 || res.status >= 300) {
      throw new AccountError(res.status, `POST ${path}: ${res.text.slice(0, 200)}`);
    }
  }
}

/**
 * The bio, written from the show's own thesis.
 *
 * NOT GENERATED. A bio is two sentences that already exist in the persona file,
 * and a model call to rewrite them would produce something that drifts from the
 * show every time either changes. It also says plainly that the show is made by
 * a machine - the label on the card says it, and the profile should not be
 * where somebody first has to work it out.
 */
export const bioFor = (persona: Persona): string => {
  const thesis = persona.thesis.trim().replace(/\s+/g, ' ');
  const made =
    'An AudioVibe Originals show. Written and voiced by AI, from documents you can check: ' +
    'every episode lists what it read.';

  // The API caps a bio, and a truncated final sentence reads as a bug rather
  // than as brevity. The thesis is dropped whole if both will not fit.
  const full = `${thesis} ${made}`;
  return full.length <= 500 ? full : made;
};
