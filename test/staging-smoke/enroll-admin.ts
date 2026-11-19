// STAGING-SMOKE one-time enrolment of the staging smoke admin account (be-admin-account-plan.md,
// D10-2112). Run once on the test node, in an interactive terminal, by whoever holds the initial
// password the owner was shown when creating `smoke-staging` in the staging console:
//
//   node test/staging-smoke/enroll-admin.ts
//
// It pastes nothing anywhere: the initial password is read from the terminal without echo, then
// the script itself does the first login → sets a random new password → fetches the authenticator
// secret → binds it with a computed code → writes { password, secret } to
// ~/.couli-staging-smoke/admin.json (0600) → proves the stored values with a fresh login + logout.
// Nobody, the operator included, learns the final password or the secret. Lost file: the owner
// resets the account's password / authenticator in the console and this is run again.
//
// Hard off outside staging (target.json env must be "staging"; see lib/node-files.ts). Output is
// step names, HTTP status and business codes only — never a password, ticket, token, secret or code.
// One wrong code stops the run (5 consecutive failures lock the account for 30 minutes).
import { randomBytes } from 'node:crypto';
import { createCodeSource } from './lib/totp.ts';
import {
  NodeFileError,
  readAdminCredential,
  readTarget,
  writeAdminCredential,
} from './lib/node-files.ts';

const USERNAME = 'smoke-staging';

class StepError extends Error {
  /** Business code of the answer that failed the step, when there was one. */
  readonly code: number | null;
  constructor(message: string, code: number | null = null) {
    super(message);
    this.code = code;
  }
}

interface Envelope {
  readonly status: number;
  readonly code: number | null;
  readonly data: Record<string, unknown> | null;
}

async function post(
  base: string,
  path: string,
  body: Record<string, unknown> | null,
  step: string,
  bearer?: string,
): Promise<Envelope> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== null) headers['content-type'] = 'application/json';
  if (bearer !== undefined) headers.authorization = `Bearer ${bearer}`;
  let response: Response;
  try {
    const init: RequestInit = {
      method: 'POST',
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    };
    if (body !== null) init.body = JSON.stringify(body);
    response = await fetch(`${base}${path}`, init);
  } catch (error) {
    throw new StepError(`${step}: request failed (${(error as Error).name})`);
  }
  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    /* non-JSON answer: reported by status below */
  }
  const envelope = (parsed ?? {}) as { code?: unknown; data?: unknown };
  const code = typeof envelope.code === 'number' ? envelope.code : null;
  const data =
    envelope.data !== null && typeof envelope.data === 'object'
      ? (envelope.data as Record<string, unknown>)
      : null;
  return { status: response.status, code, data };
}

function expectOk(result: Envelope, step: string): Record<string, unknown> {
  if (result.status !== 200 || result.code !== 0 || result.data === null) {
    throw new StepError(
      `${step}: HTTP ${result.status}, code ${result.code ?? 'none'}`,
      result.code,
    );
  }
  return result.data;
}

function field(data: Record<string, unknown>, name: string, step: string): string {
  const value = data[name];
  if (typeof value !== 'string' || value.length === 0) throw new StepError(`${step}: no ${name}`);
  return value;
}

async function readHidden(prompt: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) throw new StepError('run this in an interactive terminal (no pipes)');
  process.stdout.write(prompt);
  input.setRawMode(true);
  input.resume();
  input.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          done();
          resolve(value);
          return;
        }
        if (char === '\u0003') {
          done();
          reject(new StepError('cancelled'));
          return;
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    };
    const done = () => {
      input.off('data', onData);
      input.setRawMode(false);
      input.pause();
      process.stdout.write('\n');
    };
    input.on('data', onData);
  });
}

/** 32 alphanumeric characters (staging node passwords are alphanumeric only; policy 10..128). */
function newPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = randomBytes(64);
  let out = '';
  for (const byte of bytes) {
    if (byte < 248) out += alphabet[byte % alphabet.length];
    if (out.length === 32) break;
  }
  if (out.length !== 32) throw new StepError('password generation failed');
  return out;
}

async function login(base: string, password: string, step: string) {
  const data = expectOk(
    await post(base, '/admin/v1/auth/login', { username: USERNAME, password }, step),
    step,
  );
  return { next: field(data, 'next', step), ticket: field(data, 'login_ticket', step) };
}

async function bind(base: string, ticket: string, password: string): Promise<string> {
  const secretData = expectOk(
    await post(base, '/admin/v1/auth/totp/secret', { login_ticket: ticket }, 'totp secret'),
    'totp secret',
  );
  const secret = field(secretData, 'totp_secret', 'totp secret');
  // Saved before binding: a failed bind can be resumed with the stored password.
  await writeAdminCredential({ username: USERNAME, password, totpSecret: secret, bound: false });
  const codes = createCodeSource(secret);
  const session = expectOk(
    await post(
      base,
      '/admin/v1/auth/totp/bind',
      { login_ticket: ticket, code: await codes.next() },
      'totp bind',
    ),
    'totp bind',
  );
  await writeAdminCredential({ username: USERNAME, password, totpSecret: secret, bound: true });
  await logout(base, field(session, 'admin_token', 'totp bind'));
  return secret;
}

async function logout(base: string, token: string): Promise<void> {
  const result = await post(base, '/admin/v1/auth/logout', null, 'logout', token);
  if (result.status !== 200 && result.status !== 204) {
    throw new StepError(`logout: HTTP ${result.status}, code ${result.code ?? 'none'}`);
  }
}

/** Proves the stored values: password → totp step with a code of a fresh time step → logout. */
async function prove(base: string, password: string, secret: string): Promise<void> {
  const first = await login(base, password, 'check login');
  if (first.next !== 'totp') throw new StepError(`check login: next is ${first.next}, not totp`);
  const codes = createCodeSource(secret);
  await codes.next(); // burn the step the bind used: replay protection takes each step once
  const session = expectOk(
    await post(
      base,
      '/admin/v1/auth/totp',
      { login_ticket: first.ticket, code: await codes.next() },
      'check totp',
    ),
    'check totp',
  );
  await logout(base, field(session, 'admin_token', 'check totp'));
}

async function main(): Promise<void> {
  const { adminBaseUrl: base } = await readTarget();
  const stored = await readAdminCredential();
  if (stored?.bound === true) {
    throw new StepError('admin.json already holds a bound account; delete it first to re-enrol');
  }
  let password: string;
  let ticket: string;
  if (stored !== null) {
    // Resume after a failed bind: the password was already changed and stored.
    password = stored.password;
    // One attempt, never retried (5 consecutive failures lock the account for 30 minutes).
    let step;
    try {
      step = await login(base, password, 'resume login');
    } catch (error) {
      const code = error instanceof StepError ? error.code : null;
      const advice =
        code === 10008
          ? 'the stored password was refused, so the earlier run did not get the password change ' +
            'through: delete admin.json and run again with the initial password'
          : code === 10009
            ? 'the account is locked: keep admin.json and run again as is after the lock ends'
            : 'keep admin.json and run again as is later; if it keeps failing, ask the owner to reset the account';
      throw new StepError(`${(error as Error).message}. ${advice} (not retried automatically).`);
    }
    if (step.next === 'totp' && stored.totpSecret !== null) {
      // The bind went through on the server but its answer was lost: prove the stored values.
      await prove(base, password, stored.totpSecret);
      await writeAdminCredential({ ...stored, bound: true });
      process.stdout.write('enrolled: earlier bind confirmed, admin.json marked bound\n');
      return;
    }
    if (step.next !== 'bind_totp') {
      throw new StepError(
        `resume login: next is ${step.next}; ask the owner to reset the account (do not delete admin.json first)`,
      );
    }
    ticket = step.ticket;
  } else {
    const initial = await readHidden(`initial password of ${USERNAME}: `);
    const first = await login(base, initial, 'first login');
    if (first.next !== 'change_password') {
      throw new StepError(
        `first login: next is ${first.next}; ask the owner to reset the account's initial password`,
      );
    }
    password = newPassword();
    // Stored before the change: if the answer is lost, the next run resumes with this password.
    await writeAdminCredential({ username: USERNAME, password, totpSecret: null, bound: false });
    const changed = expectOk(
      await post(
        base,
        '/admin/v1/auth/password',
        { login_ticket: first.ticket, new_password: password },
        'change password',
      ),
      'change password',
    );
    if (field(changed, 'next', 'change password') !== 'bind_totp') {
      throw new StepError('change password: next step is not bind_totp');
    }
    ticket = field(changed, 'login_ticket', 'change password');
  }
  const secret = await bind(base, ticket, password);
  await prove(base, password, secret);
  process.stdout.write('enrolled: admin.json written and checked (login + totp + logout)\n');
}

main().catch((error: unknown) => {
  const known = error instanceof StepError || error instanceof NodeFileError;
  const text = known ? (error as Error).message : `unexpected error (${(error as Error).name})`;
  process.stderr.write(`enroll-admin: ${text}\n`);
  process.exitCode = 1;
});
