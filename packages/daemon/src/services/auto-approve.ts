/**
 * Auto-approve token store + macOS password verification.
 *
 * Replaces the osascript dialog (CSO #4) with a phone-supplied macOS password.
 * The dialog required physical presence at the laptop — fine for desktop use,
 * but defeats the entire premise of remote phone control. Now the phone
 * proves knowledge of the macOS user password instead, daemon verifies via
 * `dscl . -authonly`, and mints a per-phone token so subsequent auto-approve
 * sessions need no further prompting.
 *
 * Wire flow:
 *
 *   First time (no token cached on phone):
 *     phone → daemon  : { type: 'session-open', auto: true,
 *                          phoneId, sudoPassword: '<plaintext>' }
 *     daemon          : dscl-verify password
 *                       mint random 32-byte token
 *                       store sha256(token) keyed by phoneId
 *     daemon → phone  : { type: 'auto-approve-granted', phoneId, token }
 *
 *   Subsequent:
 *     phone → daemon  : { type: 'session-open', auto: true,
 *                          phoneId, approveToken: '<cached>' }
 *     daemon          : sha256(token) → lookup phoneId → match
 *
 * Threat model:
 *   - Stolen unlocked phone with the app open: cannot auto-approve unless the
 *     attacker also knows the macOS password. Worst case they get a non-auto
 *     session, which is gated by per-command denylist + permission prompts.
 *   - Lost phone, attacker reads cached token: equivalent to stealing the
 *     phone_secret. Mitigation: revoke the phone via `loopsy phone revoke`,
 *     which also wipes the auto-approve entry.
 *   - Replayed password from network: TLS to relay, relay is yours, so a
 *     well-positioned attacker would need to break TLS or compromise the CF
 *     account. End-to-end encryption is a v2 nice-to-have.
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const STORE_FILE = join(homedir(), '.loopsy', 'auto-approve.json');

interface ApprovalRecord {
  /** sha256 hex of the token. We never persist the raw token. */
  token_hash: string;
  /** ISO timestamp when this approval was minted. */
  granted_at: string;
  /** Optional UA / label echoed back from the phone for `loopsy phone list`. */
  label?: string;
}

type Store = Record<string /* phone_id */, ApprovalRecord>;

async function loadStore(): Promise<Store> {
  try {
    const raw = await fs.readFile(STORE_FILE, 'utf8');
    return JSON.parse(raw) as Store;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

async function saveStore(store: Store): Promise<void> {
  await fs.mkdir(dirname(STORE_FILE), { recursive: true });
  // 0600 — same as ~/.loopsy/config.yaml.
  await fs.writeFile(STORE_FILE, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
}

function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Verify a macOS user password without spawning a UI prompt. Uses Apple's
 * `dscl` Open Directory CLI in -authonly mode — same auth backend as `sudo`.
 *
 * Returns true if the password is valid for the current OS user.
 */
export function verifyMacPassword(password: string): Promise<boolean> {
  if (process.platform !== 'darwin') {
    // Linux fallback would use PAM or `su -c true` with stdin password; not
    // shipping that today. Defer cross-platform to a follow-up.
    return Promise.resolve(false);
  }
  if (!password) return Promise.resolve(false);
  const user = process.env.USER ?? process.env.LOGNAME;
  if (!user) return Promise.resolve(false);
  return new Promise((resolve) => {
    // `dscl . -authonly <user> <password>` exits 0 on success, non-zero on
    // failure. Pass the password as an argv element rather than via stdin
    // because dscl doesn't support stdin password input.
    const proc = spawn('/usr/bin/dscl', ['.', '-authonly', user, password], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      resolve(false);
    }, 8_000);
    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (timedOut) return;
      resolve(code === 0);
    });
    proc.on('error', () => {
      clearTimeout(timeout);
      resolve(false);
    });
  });
}

/**
 * Mint a fresh approval token for a phone after the phone proved knowledge
 * of the macOS password. Stores sha256(token) on disk and returns the raw
 * token to be sent to the phone exactly once.
 */
export async function grantAutoApprove(phoneId: string, label?: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const store = await loadStore();
  store[phoneId] = {
    token_hash: sha256Hex(token),
    granted_at: new Date().toISOString(),
    ...(label ? { label } : {}),
  };
  await saveStore(store);
  return token;
}

/**
 * Constant-time check of an inbound approval token against the stored hash
 * for a given phone. Returns true if the phone has previously been granted
 * auto-approve and the supplied token matches.
 */
export async function checkAutoApprove(phoneId: string, token: string): Promise<boolean> {
  if (!phoneId || !token) return false;
  const store = await loadStore();
  const record = store[phoneId];
  if (!record) return false;
  const want = Buffer.from(record.token_hash, 'hex');
  const got = Buffer.from(sha256Hex(token), 'hex');
  if (want.length !== got.length) return false;
  try {
    return timingSafeEqual(want, got);
  } catch {
    return false;
  }
}

/**
 * Revoke an approval — called when the laptop owner runs `loopsy phone
 * revoke <id>` so a forgotten phone loses both its phone_secret AND its
 * auto-approve token in one step.
 */
export async function revokeAutoApprove(phoneId: string): Promise<void> {
  const store = await loadStore();
  if (!(phoneId in store)) return;
  delete store[phoneId];
  await saveStore(store);
}
