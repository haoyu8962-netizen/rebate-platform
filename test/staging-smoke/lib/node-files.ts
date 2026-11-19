// STAGING-SMOKE: the two node-only files of the smoke run (D10-2112), kept on the test node in
// ~/.couli-staging-smoke/ (directory 0700, files 0600, owned by the cron user):
//   target.json  { "env": "staging", "admin_base_url": "https://…", "api_base_url": "https://…" }
//                written by hand once; no credential in it. Both URLs are bare https origins whose
//                host name has a label `staging` (or `staging-…` / `…-staging`); anything else refuses.
//   admin.json   { "username", "password", "totp_secret", "bound" } written only by enroll-admin.ts.
// Errors name the file and the reason only — never a path beyond the file name, never a value.
import { chmod, lstat, mkdir, open, readFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const SMOKE_DIR = join(homedir(), '.couli-staging-smoke');
const MAX_BYTES = 4096;

export class NodeFileError extends Error {}

async function readNodeJson(name: string): Promise<Record<string, unknown> | null> {
  const path = join(SMOKE_DIR, name);
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new NodeFileError(`${name}: unreadable`);
  }
  if (!info.isFile()) throw new NodeFileError(`${name}: not a regular file`);
  if ((info.mode & 0o077) !== 0) throw new NodeFileError(`${name}: mode must be 0600`);
  if (info.size > MAX_BYTES) throw new NodeFileError(`${name}: too large`);
  const buffer = await readFile(path);
  try {
    const parsed: unknown = JSON.parse(buffer.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new NodeFileError(`${name}: not a JSON object`);
  } finally {
    buffer.fill(0);
  }
}

export interface Target {
  readonly adminBaseUrl: string;
  readonly apiBaseUrl: string;
}

/** Hard off outside staging: no target file, or env other than "staging", refuses to run. */
export async function readTarget(): Promise<Target> {
  const raw = await readNodeJson('target.json');
  if (raw === null)
    throw new NodeFileError('target.json: missing (smoke runs only on the test node)');
  if (raw.env !== 'staging') throw new NodeFileError('target.json: env must be "staging"');
  const urls = [raw.admin_base_url, raw.api_base_url].map((value) => {
    if (typeof value !== 'string') throw new NodeFileError('target.json: base url missing');
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new NodeFileError('target.json: base url invalid');
    }
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
      throw new NodeFileError('target.json: base url must be https without credentials');
    }
    // A bare origin only: a path, query or fragment is refused, not silently dropped (D10-2119 b).
    if (value !== url.origin && value !== `${url.origin}/`) {
      throw new NodeFileError(
        'target.json: base url must be a bare origin (no path, query or fragment)',
      );
    }
    // Second, independent hard-off besides env (D10-2119 a): a host name with a staging label.
    if (!url.hostname.split('.').some((label) => /(^|-)staging(-|$)/.test(label))) {
      throw new NodeFileError('target.json: base url host must carry a staging label');
    }
    return url.origin;
  });
  return { adminBaseUrl: urls[0]!, apiBaseUrl: urls[1]! };
}

export interface AdminCredential {
  readonly username: string;
  readonly password: string;
  readonly totpSecret: string | null;
  readonly bound: boolean;
}

export async function readAdminCredential(): Promise<AdminCredential | null> {
  const raw = await readNodeJson('admin.json');
  if (raw === null) return null;
  const { username, password, totp_secret: totpSecret, bound } = raw;
  if (
    typeof username !== 'string' ||
    typeof password !== 'string' ||
    !(
      totpSecret === null ||
      (typeof totpSecret === 'string' && /^[A-Z2-7]+=*$/.test(totpSecret))
    ) ||
    typeof bound !== 'boolean'
  ) {
    throw new NodeFileError('admin.json: fields invalid');
  }
  return { username, password, totpSecret, bound };
}

/** Atomic write: a 0600 temp file in the same directory, fsync, then rename over admin.json. */
export async function writeAdminCredential(value: AdminCredential): Promise<void> {
  await mkdir(SMOKE_DIR, { recursive: true, mode: 0o700 });
  await chmod(SMOKE_DIR, 0o700);
  const finalPath = join(SMOKE_DIR, 'admin.json');
  const tempPath = join(SMOKE_DIR, `.admin.json.${process.pid}.tmp`);
  const body = Buffer.from(
    JSON.stringify({
      username: value.username,
      password: value.password,
      totp_secret: value.totpSecret,
      bound: value.bound,
    }),
    'utf8',
  );
  const handle = await open(tempPath, 'wx', 0o600);
  try {
    await handle.writeFile(body);
    await handle.sync();
  } finally {
    body.fill(0);
    await handle.close();
  }
  await rename(tempPath, finalPath);
}
