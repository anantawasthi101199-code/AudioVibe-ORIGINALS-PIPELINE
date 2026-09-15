/**
 * Bringing one channel into existence on the platform.
 *
 * RUN ONCE PER CHANNEL, EVER. After this, the channel has an account, a face, a
 * bio and somewhere to publish into, and every weekly run just signs in with
 * what this recorded.
 *
 * EVERY STEP IS SEPARATELY RESUMABLE, which matters more here than anywhere else
 * in the studio: this is the one operation that touches production, and the
 * failure modes are network ones. A run that creates the account and dies before
 * the avatar must pick up at the avatar rather than fail forever on a 409.
 *
 * NOTHING HERE IS CLEVER. It provisions, signs in, writes a profile, uploads two
 * images and records what happened. The interesting decisions all live one layer
 * down - whether the account carries the AI label, where the artwork comes from,
 * what a bio says - and this file's job is to do them in the right order and
 * write down the result.
 */
import fs from 'fs';
import path from 'path';
import { loadPersona } from '../canon/load';
import { platformUrl, repoRoot } from '../config';
import { artworkFor, GenerateDeps } from '../art/generate';
import {
  Account,
  PlatformAccounts,
  accountSchema,
  loadAccounts,
  makePassword,
  saveAccounts,
} from '../publish/account';

export interface SetupDeps {
  accounts?: PlatformAccounts;
  art?: GenerateDeps;
  log?: (message: string, stage?: string) => void;
  /** Where the channel's artwork is kept, so a rerun reuses rather than remakes. */
  artDir?: string;
}

export interface SetupResult {
  account: Account;
  avatar: string;
  cover: string;
  /** Which images were generated rather than drawn. */
  generated: string[];
  /** True when the account was already there and this repaired it. */
  existed: boolean;
}

/**
 * The email a channel signs in with.
 *
 * A REAL DOMAIN THE STUDIO OWNS, not `.invalid`. The provisioning endpoint will
 * invent `<user>@profiles.audiovibe.invalid` if none is given, and that address
 * can never receive anything - so a password reset, a security notice or a
 * verification mail has nowhere to go, which is a problem the day it matters and
 * never before.
 */
export const emailFor = (username: string): string => `${username}@originals.audiovibe.co`;

export const setUpChannel = async (
  channelId: string,
  adminEmail: string,
  adminPassword: string,
  deps: SetupDeps = {}
): Promise<SetupResult> => {
  const log = deps.log ?? (() => undefined);
  const persona = loadPersona(channelId);
  const platform = platformUrl();
  const api = deps.accounts ?? new PlatformAccounts(platform.url);

  const accounts = loadAccounts();
  const existing = accounts[channelId];

  // --- 1. The account -------------------------------------------------------
  let account: Account;

  if (existing) {
    log(`reusing the account recorded for @${existing.username}`, 'account');
    account = existing;
  } else {
    log('signing in as the studio operator', 'account');
    await api.signInAsAdmin(adminEmail, adminPassword);

    const username = persona.handle;
    const password = makePassword();
    const email = emailFor(username);

    log(`provisioning @${username} as an AI show`, 'account');
    const made = await api.provision({
      username,
      password,
      fullName: persona.name,
      email,
      studioSlug: 'originals',
    });

    // AN ACCOUNT THAT EXISTS WITH A PASSWORD NOBODY RECORDED IS UNUSABLE, and
    // this is the one failure in this file that a person has to resolve rather
    // than a rerun. Saying exactly what to do beats a 409 with no advice.
    if (made === 'exists') {
      throw new Error(
        `@${username} already exists on ${platform.url}, but this studio has no password for it. ` +
          `Either delete the account, or add its credentials to accounts.json by hand.`
      );
    }

    if (!made.isAi) {
      // A 201 with no label is worse than a failure, because the account works
      // and every card it publishes is silently unlabelled.
      throw new Error(
        `@${username} was created but the API did not accept the AI declaration. ` +
          `The platform is probably older than this studio - deploy the provisioning change first.`
      );
    }

    account = accountSchema.parse({
      username,
      email,
      password,
      userId: made.userId,
      createdAt: new Date().toISOString(),
      isAi: true,
      profile: { avatar: false, cover: false },
    });

    accounts[channelId] = account;
    saveAccounts(accounts);
    log(`created @${username} and recorded its credentials`, 'account');
  }

  // --- 2. Sign in as the channel -------------------------------------------
  //
  // Everything from here is done AS THE CHANNEL, through the same endpoints a
  // person uses. Nothing below needs admin.
  log(`signing in as @${account.username}`, 'profile');
  await api.signInAsChannel(account.email, account.password);

  log('writing the profile', 'profile');
  await api.setProfile(persona);

  // --- 3. Its face ----------------------------------------------------------
  const artDir = deps.artDir ?? path.join(repoRoot(), 'art', channelId);

  // REUSED IF IT IS ALREADY THERE. Artwork costs money to generate and a
  // channel's face should not change because somebody re-ran a setup command.
  const avatarPath = path.join(artDir, 'avatar.png');
  const coverPath = path.join(artDir, 'cover.png');
  const haveBoth = fs.existsSync(avatarPath) && fs.existsSync(coverPath);

  let generated: string[] = [];
  if (haveBoth) {
    log('reusing the artwork already on disk', 'artwork');
  } else {
    const art = await artworkFor(persona, artDir, {
      ...deps.art,
      onProgress: (m) => log(m, 'artwork'),
    });
    generated = art.generated;
  }

  log('uploading the avatar', 'artwork');
  await api.uploadAvatar(avatarPath);

  log('uploading the cover', 'artwork');
  await api.uploadCover(coverPath);

  account.profile = { avatar: true, cover: true };
  accounts[channelId] = account;
  saveAccounts(accounts);

  return {
    account,
    avatar: avatarPath,
    cover: coverPath,
    generated,
    existed: Boolean(existing),
  };
};
