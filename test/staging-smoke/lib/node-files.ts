// STAGING-SMOKE: the two node-only files of the smoke run (D10-2112), kept on the test node in
// ~/.couli-staging-smoke/ (directory 0700, files 0600, owned by the cron user):
//   target.json  { "env": "staging", "admin_base_url": "https://…", "api_base_url": "https://…" }
//                written by hand once; no credential in it. Both URLs are bare https origins whose
//                host name has a label `staging` (or `staging-…` / `…-staging`); anything else refuses.
//   admin.json   { "username", "password", "totp_secret", "bound" } written only by enroll-admin.ts.
//   member.json  { "phone", "sms_code", ... } the staging test phone copy (D10-2112), by hand once;
//                optional fixtures: see readMemberConfig and README.md.
//   device.json  { "app_id", "device_id", "install_secret", "device_hash" } written only by smoke.ts
//                (the smoke member's registered device, reused across runs; 10402 → registered again).
// Errors name the file and the reason only — never a path beyond the file name, never a value.
import { chmod, lstat, mkdir, open, readFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_DIR = join(homedir(), '.couli-staging-smoke');
let smokeDir = DEFAULT_DIR;
const MAX_BYTES = 4096;

/**
 * Test-only override of the node directory (smoke.ts --node-dir), so the refusal paths can be
 * exercised against a scratch directory without touching the real one. Default: ~/.couli-staging-smoke.
 */
export function useNodeDir(path: string): void {
  smokeDir = path;
}

export class NodeFileError extends Error {}

async function readNodeJson(name: string): Promise<Record<string, unknown> | null> {
  const path = join(smokeDir, name);
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

/** Atomic write: a 0600 temp file in the same directory, fsync, then rename over `name`. */
async function writeNodeJson(name: string, value: Record<string, unknown>): Promise<void> {
  await mkdir(smokeDir, { recursive: true, mode: 0o700 });
  await chmod(smokeDir, 0o700);
  const finalPath = join(smokeDir, name);
  const tempPath = join(smokeDir, `.${name}.${process.pid}.tmp`);
  const body = Buffer.from(JSON.stringify(value), 'utf8');
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

export async function writeAdminCredential(value: AdminCredential): Promise<void> {
  await writeNodeJson('admin.json', {
    username: value.username,
    password: value.password,
    totp_secret: value.totpSecret,
    bound: value.bound,
  });
}

/** The smoke member's alipay payout account, saved again unchanged by case 6 (never a new one). */
export interface MemberPayoutAccount {
  readonly alipayLogonId: string;
  readonly payeeName: string;
}

export interface MemberConfig {
  /** The staging test phone (one of the node's STAGING_TEST_PHONES). */
  readonly phone: string;
  /** The node's fixed 6-digit SMS code of the test phones. */
  readonly smsCode: string;
  /** X-App-Id of the member (default `couli`). */
  readonly appId: string;
  /** X-App-Version to send; null → latest_version of GET /v1/app-versions/check. */
  readonly appVersion: string | null;
  /** The account currently bound to the member; null → case 6 only reads. */
  readonly payoutAccount: MemberPayoutAccount | null;
  /** A product link or share text for case 3; null → case 3 is skipped. */
  readonly parseText: string | null;
  readonly searchPlatform: string;
  readonly searchQuery: string;
}

const PHONE = /^1[3-9][0-9]{9}$/;
const SMS_CODE = /^[0-9]{6}$/;
const APP_ID = /^[a-z0-9_]{1,32}$/;
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const PLATFORMS = [
  'taobao',
  'jd',
  'pdd',
  'meituan',
  'vip',
  'douyin',
  'eleme',
  'kuaishou',
  'suning',
];

function optionalString(raw: Record<string, unknown>, key: string, max: number): string | null {
  const value = raw[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new NodeFileError(`member.json: ${key} invalid`);
  }
  return value;
}

/** member.json is required: without the test phone the smoke cannot log in. */
export async function readMemberConfig(): Promise<MemberConfig> {
  const raw = await readNodeJson('member.json');
  if (raw === null) throw new NodeFileError('member.json: missing (the staging test phone copy)');
  const { phone, sms_code: smsCode } = raw;
  if (typeof phone !== 'string' || !PHONE.test(phone)) {
    throw new NodeFileError('member.json: phone must be a normalised 11-digit mainland number');
  }
  if (typeof smsCode !== 'string' || !SMS_CODE.test(smsCode)) {
    throw new NodeFileError('member.json: sms_code must be 6 digits');
  }
  const appId = optionalString(raw, 'app_id', 32) ?? 'couli';
  if (!APP_ID.test(appId)) throw new NodeFileError('member.json: app_id invalid');
  const appVersion = optionalString(raw, 'app_version', 32);
  if (appVersion !== null && !SEMVER.test(appVersion)) {
    throw new NodeFileError('member.json: app_version must be x.y.z');
  }
  let payoutAccount: MemberPayoutAccount | null = null;
  const account = raw.payout_account;
  if (account !== undefined && account !== null) {
    if (typeof account !== 'object' || Array.isArray(account)) {
      throw new NodeFileError('member.json: payout_account invalid');
    }
    const fields = account as Record<string, unknown>;
    const logon = fields.alipay_logon_id;
    const payee = fields.payee_name;
    if (
      fields.payout_method !== 'alipay' ||
      typeof logon !== 'string' ||
      logon.length === 0 ||
      logon.length > 128 ||
      typeof payee !== 'string' ||
      payee.length === 0 ||
      payee.length > 64
    ) {
      throw new NodeFileError('member.json: payout_account must be an alipay account (see README)');
    }
    payoutAccount = { alipayLogonId: logon, payeeName: payee };
  }
  const searchPlatform = optionalString(raw, 'search_platform', 16) ?? 'taobao';
  if (!PLATFORMS.includes(searchPlatform)) {
    throw new NodeFileError('member.json: search_platform invalid');
  }
  return {
    phone,
    smsCode,
    appId,
    appVersion,
    payoutAccount,
    parseText: optionalString(raw, 'parse_text', 4000),
    searchPlatform,
    searchQuery: optionalString(raw, 'search_q', 100) ?? '抽纸',
  };
}

export interface DeviceCredential {
  readonly appId: string;
  readonly deviceId: string;
  readonly installSecret: string;
  readonly deviceHash: string;
}

export async function readDeviceCredential(): Promise<DeviceCredential | null> {
  const raw = await readNodeJson('device.json');
  if (raw === null) return null;
  const { app_id: appId, device_id: deviceId, install_secret: secret, device_hash: hash } = raw;
  if (
    typeof appId !== 'string' ||
    typeof deviceId !== 'string' ||
    deviceId.length === 0 ||
    typeof secret !== 'string' ||
    secret.length < 16 ||
    typeof hash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(hash)
  ) {
    throw new NodeFileError('device.json: fields invalid (delete it to register a new device)');
  }
  return { appId, deviceId, installSecret: secret, deviceHash: hash };
}

export async function writeDeviceCredential(value: DeviceCredential): Promise<void> {
  await writeNodeJson('device.json', {
    app_id: value.appId,
    device_id: value.deviceId,
    install_secret: value.installSecret,
    device_hash: value.deviceHash,
  });
}
