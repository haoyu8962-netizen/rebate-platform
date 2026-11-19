// STAGING-SMOKE (QA-04b): the console side of the withdrawal loop, with the smoke admin account
// enrolled by enroll-admin.ts (be-admin-account-plan.md; rulings D10-2112, D10-2119).
//
// - Login: password → authenticator code (POST /admin/v1/auth/login → /admin/v1/auth/totp).
// - Step-up: POST /admin/v1/auth/step-up {tier: totp, code} before each operation that needs it
//   (withdraw.review, payout.execute: totp tier); the token goes in X-Step-Up-Token and is spent by
//   that operation's success.
// - Every code comes from one createCodeSource, so each use waits for a fresh 30 s time step (the
//   server accepts each step once per account, admin_users.totp_last_step).
// - A refused code (20002) or a locked account (10009) stops the whole console part at once: no
//   code is ever retried (5 consecutive failures lock the account for 30 minutes).
// - 10403 with data.reason=admin_ip_not_allowed → yellow: the node's egress IP may have changed.
import { randomUUID } from 'node:crypto';
import { call, okData, reasonOf, type CallResult } from './http.ts';
import type { AdminCredential } from './node-files.ts';
import { Fail, registerSecret, Yellow } from './report.ts';
import { createCodeSource } from './totp.ts';

export interface AdminRequest {
  readonly label: string;
  readonly body?: unknown;
  readonly idempotencyKey?: string;
  readonly stepUpToken?: string;
}

export class AdminClient {
  readonly #base: string;
  readonly #credential: AdminCredential;
  readonly #codes: { next(): Promise<string> };
  #token: string | null = null;
  #stopped: string | null = null;

  constructor(base: string, credential: AdminCredential) {
    if (credential.totpSecret === null || !credential.bound) {
      throw new Fail('admin.json: enrolment not finished (run enroll-admin.ts first)');
    }
    registerSecret(credential.password);
    registerSecret(credential.totpSecret);
    this.#base = base;
    this.#credential = credential;
    this.#codes = createCodeSource(credential.totpSecret);
  }

  get loggedIn(): boolean {
    return this.#token !== null;
  }

  #assertUsable(): void {
    if (this.#stopped !== null) throw new Fail(`console part stopped earlier: ${this.#stopped}`);
  }

  /** Stops the console part for the rest of the run and fails the current step. */
  #stop(reason: string): never {
    this.#stopped = reason;
    throw new Fail(reason);
  }

  async #post(path: string, options: AdminRequest, bearer: boolean): Promise<CallResult> {
    const headers: Record<string, string> = { 'X-Trace-Id': randomUUID() };
    let body: Buffer | undefined;
    if (options.body !== undefined) {
      body = Buffer.from(JSON.stringify(options.body), 'utf8');
      headers['content-type'] = 'application/json';
    }
    if (bearer) {
      if (this.#token === null) throw new Fail(`${options.label}: console not logged in`);
      headers.authorization = `Bearer ${this.#token}`;
    }
    if (options.idempotencyKey !== undefined) headers['Idempotency-Key'] = options.idempotencyKey;
    if (options.stepUpToken !== undefined) headers['X-Step-Up-Token'] = options.stepUpToken;
    const result = await call(this.#base, 'POST', path, {
      label: options.label,
      headers,
      ...(body === undefined ? {} : { body }),
    });
    this.#checkIp(result);
    return result;
  }

  #checkIp(result: CallResult): void {
    if (result.code === 10403 && reasonOf(result) === 'admin_ip_not_allowed') {
      this.#stopped = 'admin_ip_not_allowed';
      throw new Yellow(
        '后台 10403 admin_ip_not_allowed：测试机出口 IP 可能变了（不在 ADMIN_IP_ALLOWLIST）',
      );
    }
  }

  #codeAnswer(result: CallResult, step: string): void {
    if (result.code === 20002)
      this.#stop(`${step}: authenticator code refused (20002); not retried`);
    if (result.code === 10009) this.#stop(`${step}: console account locked (10009); not retried`);
  }

  async login(): Promise<void> {
    this.#assertUsable();
    const first = await this.#post(
      '/admin/v1/auth/login',
      {
        label: 'POST /admin/v1/auth/login',
        body: { username: this.#credential.username, password: this.#credential.password },
      },
      false,
    );
    if (first.code === 10008) this.#stop('console login: password refused (10008); not retried');
    this.#codeAnswer(first, 'console login');
    const data = okData(first, 'console login');
    const ticket = data.login_ticket;
    if (data.next !== 'totp' || typeof ticket !== 'string') {
      this.#stop('console login: next step is not totp (account needs the owner)');
    }
    registerSecret(ticket);
    const code = await this.#codes.next();
    registerSecret(code);
    const second = await this.#post(
      '/admin/v1/auth/totp',
      { label: 'POST /admin/v1/auth/totp', body: { login_ticket: ticket, code } },
      false,
    );
    this.#codeAnswer(second, 'console totp');
    const session = okData(second, 'console totp');
    const token = session.admin_token;
    if (typeof token !== 'string' || token.length === 0) this.#stop('console totp: no admin_token');
    registerSecret(token);
    this.#token = token;
  }

  /** A fresh totp-tier step-up token (waits for a new time step). */
  async stepUp(): Promise<string> {
    this.#assertUsable();
    const code = await this.#codes.next();
    registerSecret(code);
    const result = await this.#post(
      '/admin/v1/auth/step-up',
      { label: 'POST /admin/v1/auth/step-up', body: { tier: 'totp', code } },
      true,
    );
    this.#codeAnswer(result, 'console step-up');
    const data = okData(result, 'console step-up');
    const token = data.step_up_token;
    if (typeof token !== 'string' || token.length === 0 || data.tier !== 'totp') {
      throw new Fail('console step-up: no totp-tier step_up_token');
    }
    registerSecret(token);
    return token;
  }

  async post(path: string, options: AdminRequest): Promise<CallResult> {
    this.#assertUsable();
    return this.#post(path, options, true);
  }

  async get(path: string, label: string): Promise<CallResult> {
    this.#assertUsable();
    if (this.#token === null) throw new Fail(`${label}: console not logged in`);
    const result = await call(this.#base, 'GET', path, {
      label,
      headers: { authorization: `Bearer ${this.#token}`, 'X-Trace-Id': randomUUID() },
    });
    this.#checkIp(result);
    return result;
  }

  async logout(): Promise<CallResult | null> {
    if (this.#token === null) return null;
    const result = await this.#post(
      '/admin/v1/auth/logout',
      { label: 'POST /admin/v1/auth/logout' },
      true,
    );
    this.#token = null;
    return result;
  }
}
