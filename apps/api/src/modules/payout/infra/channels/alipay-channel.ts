// B2-06b: the Alipay transfer channel (规划/09 CAP-X-06: alipay.fund.trans.uni.transfer with
// product_code TRANS_ACCOUNT_NO_PWD / biz_scene DIRECT_TRANSFER, alipay.fund.trans.common.query by
// out_biz_no). Rules: credentials are injected by the payout entry and never read from the
// environment here (BR-WDR-13: only the payout process holds the key); every transfer sends the
// payee name (BR-WDR-22); one request per call with a 10 s deadline (BR-WDR-13 ⑤), never a retry
// (BR-WDR-14); the response node is verified on its original bytes with the Alipay public key and
// judged only by the configured lists (BR-WDR-28, D10-230); transport-class outcomes (network,
// timeout, HTTP error, unparsable or unverified body) are unknown without pausing the queue, a
// non-success business code is unknown and pauses it. Logs carry out_biz_no, code, sub_code and
// latency_ms with the logon id masked (first 3 and last 2 kept), never the payee name or the key.
//
// B2-06j: two key modes. Certificate mode (all three serial numbers configured: app_cert_sn,
// alipay_root_cert_sn and the Alipay public-key certificate's alipay_cert_sn) sends app_cert_sn and
// alipay_root_cert_sn on every request, inside the signed parameters, and accepts a response only
// when it carries alipay_cert_sn equal to the configured one and its node verifies with the
// configured Alipay public key (the one inside that certificate); otherwise it is an unverified
// response like any other (unknown, no pause, no second request, BR-WDR-14). Public-key mode (none
// of the three) is unchanged. Only some of the three is a configuration error: the constructor
// throws PayoutChannelNotConfiguredError, so nothing is ever sent.
import { formatFen } from '@couli/money';
import type { Logger } from 'pino';

import type { Clock } from '../../../platform/index.ts';
import { judgeQuery, judgeTransfer, type JudgementLists } from '../../application/judgement.ts';
import {
  PayoutAmountInvalidError,
  PayoutBillUnavailableError,
  PayoutChannelNotConfiguredError,
  PayoutPayeeNameRequiredError,
  type ChannelBillLine,
  type ChannelRaw,
  type QueryResult,
  type TransferResult,
} from '../../domain/channel-result.ts';
import { signAlipayParams, verifyAlipayResponse } from './alipay-sign.ts';
import type { ChannelJudgement, PayoutChannel, TransferRequest } from './payout-channel.ts';

export type ChannelTransport = (
  url: string,
  options: {
    method: 'POST';
    body: string;
    headers: Readonly<Record<string, string>>;
    signal: AbortSignal;
  },
) => Promise<{ status: number; body: string }>;

/** Node built-in fetch uses undici; the signal covers the response body as well. */
export async function undiciTransport(
  url: string,
  options: Parameters<ChannelTransport>[1],
): ReturnType<ChannelTransport> {
  const response = await fetch(url, options);
  return { status: response.status, body: await response.text() };
}

export interface AlipayChannelOptions {
  credentials: {
    appId: string;
    privateKey: string;
    alipayPublicKey: string;
    gatewayUrl: string;
    appCertSn?: string;
    alipayRootCertSn?: string;
    /** The serial number of the Alipay public-key certificate (B2-06j, certificate mode). */
    alipayCertSn?: string;
  };
  bizScene: string;
  lists: JudgementLists;
  clock: Clock;
  logger: Pick<Logger, 'info' | 'warn'>;
  /** Defaults to undiciTransport; tests always inject a transport or mock built-in fetch. */
  transport?: ChannelTransport;
}

const TRANSFER_METHOD = 'alipay.fund.trans.uni.transfer';
const QUERY_METHOD = 'alipay.fund.trans.common.query';
const TRANSFER_NODE = 'alipay_fund_trans_uni_transfer_response';
const QUERY_NODE = 'alipay_fund_trans_common_query_response';
const PRODUCT_CODE = 'TRANS_ACCOUNT_NO_PWD';
const BIZ_SCENE = 'DIRECT_TRANSFER';
const ORDER_TITLE = '佣金报酬提现';
/** BR-WDR-13 ⑤: the request deadline. */
const TIMEOUT_MS = 10_000;
/** Alipay times are Beijing local time without an offset. */
const CHINA_OFFSET_MS = 8 * 3_600_000;

type Method = 'transfer' | 'query';

/** Certificate mode's three serial numbers; absent in public-key mode. */
interface CertSerials {
  readonly appCertSn: string;
  readonly alipayRootCertSn: string;
  readonly alipayCertSn: string;
}

const given = (value: string | undefined): value is string =>
  typeof value === 'string' && value !== '';

/**
 * All three serial numbers → certificate mode; none → public-key mode (null); only some of them
 * (an empty string counts as not given) → PayoutChannelNotConfiguredError.
 */
function certSerialsOf(c: AlipayChannelOptions['credentials']): CertSerials | null {
  const { appCertSn, alipayRootCertSn, alipayCertSn } = c;
  const count = [appCertSn, alipayRootCertSn, alipayCertSn].filter(given).length;
  if (count === 0) return null;
  if (!given(appCertSn) || !given(alipayRootCertSn) || !given(alipayCertSn)) {
    throw new PayoutChannelNotConfiguredError();
  }
  return { appCertSn, alipayRootCertSn, alipayCertSn };
}

/** The logon id with the first 3 and last 2 characters kept; shorter ids are fully masked. */
export function maskLogonId(identity: string): string {
  const chars = [...identity];
  if (chars.length <= 5) return '*'.repeat(chars.length);
  return `${chars.slice(0, 3).join('')}${'*'.repeat(chars.length - 5)}${chars.slice(-2).join('')}`;
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

/** `yyyy-MM-dd HH:mm:ss` in Beijing time (the gateway's timestamp format). */
function shiftToChina(at: Date): Date {
  // structuredClone + setTime: no `new Date` outside platform/clock (repository rule 2).
  const t = structuredClone(at);
  t.setTime(at.getTime() + CHINA_OFFSET_MS);
  return t;
}

function alipayTimestamp(at: Date): string {
  const t = shiftToChina(at);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`;
}

/** ISO-8601 with the explicit +08:00 offset (milliseconds only when non-zero). */
function isoChina(at: Date): string {
  const t = shiftToChina(at);
  const base = `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`;
  const ms = t.getUTCMilliseconds();
  return `${base}${ms === 0 ? '' : `.${ms.toString().padStart(3, '0')}`}+08:00`;
}

/** An Alipay `yyyy-MM-dd HH:mm:ss` time read as Beijing time; null when it does not parse. */
function providerTime(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (m === null) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+08:00`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

/**
 * The exact text of the top-level member `"<name>":{…}` in a JSON document: the balanced object
 * following the key, skipping over string literals (escapes included). Null when absent.
 */
function rawNode(body: string, name: string): string | null {
  const key = JSON.stringify(name);
  let from = 0;
  for (;;) {
    const at = body.indexOf(key, from);
    if (at === -1) return null;
    let i = at + key.length;
    while (i < body.length && /\s/.test(body[i]!)) i += 1;
    if (body[i] !== ':') {
      from = at + key.length;
      continue;
    }
    i += 1;
    while (i < body.length && /\s/.test(body[i]!)) i += 1;
    if (body[i] !== '{') return null;
    let depth = 0;
    let inString = false;
    for (let j = i; j < body.length; j += 1) {
      const c = body[j]!;
      if (inString) {
        if (c === '\\') j += 1;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === '{') depth += 1;
      else if (c === '}') {
        depth -= 1;
        if (depth === 0) return body.slice(i, j + 1);
      }
    }
    return null;
  }
}

interface Verified {
  node: Record<string, unknown>;
  raw: ChannelRaw;
  status: string | undefined;
}

/** A transport-class outcome: unknown, never pausing the queue. */
type Transport = { kind: 'transport'; code: string } | { kind: 'verified'; verified: Verified };

export class AlipayChannel implements PayoutChannel {
  private readonly options: AlipayChannelOptions;
  private readonly transport: ChannelTransport;
  private readonly certSerials: CertSerials | null;

  constructor(options: AlipayChannelOptions) {
    const c = options.credentials;
    if (
      c.appId === '' ||
      c.privateKey === '' ||
      c.alipayPublicKey === '' ||
      c.gatewayUrl === '' ||
      options.bizScene === ''
    ) {
      throw new PayoutChannelNotConfiguredError();
    }
    this.certSerials = certSerialsOf(c);
    this.options = options;
    this.transport = options.transport ?? undiciTransport;
  }

  async transfer(request: TransferRequest, judgement?: ChannelJudgement): Promise<TransferResult> {
    if (request.payee.name.replace(/\s/g, '') === '') throw new PayoutPayeeNameRequiredError();
    // Money arithmetic and formatting only through @couli/money; a non-positive amount never leaves.
    if (typeof request.netFen !== 'bigint' || request.netFen <= 0n)
      throw new PayoutAmountInvalidError();
    const started = this.options.clock.now();
    const bizContent = {
      out_biz_no: request.outBizNo,
      trans_amount: formatFen(request.netFen),
      product_code: PRODUCT_CODE,
      biz_scene: BIZ_SCENE,
      order_title: ORDER_TITLE,
      transfer_scene_name:
        judgement?.bizScene !== undefined && judgement.bizScene !== ''
          ? judgement.bizScene
          : this.options.bizScene,
      payee_info: {
        identity_type: 'ALIPAY_LOGON_ID',
        identity: request.payee.identity,
        name: request.payee.name,
      },
    };
    const outcome = await this.call(
      'transfer',
      TRANSFER_METHOD,
      bizContent,
      started,
      request.outBizNo,
    );
    const latencyMs = Math.max(0, this.options.clock.now().getTime() - started.getTime());
    const masked = maskLogonId(request.payee.identity);
    if (outcome.kind === 'transport') {
      const raw: ChannelRaw = { code: outcome.code };
      this.options.logger.warn(
        { out_biz_no: request.outBizNo, code: raw.code, latency_ms: latencyMs, payee: masked },
        'alipay_transfer_unknown',
      );
      return { kind: 'unknown', raw, latencyMs };
    }
    const { node, raw, status } = outcome.verified;
    const judged = judgeTransfer(raw, status, judgement?.lists ?? this.options.lists);
    const result: TransferResult = { ...judged, latencyMs };
    if (typeof node['order_id'] === 'string') result.channelOrderId = node['order_id'];
    if (judged.kind === 'success') {
      result.paidAt = providerTime(node['trans_date']) ?? isoChina(this.options.clock.now());
    }
    this.options.logger.info(
      {
        out_biz_no: request.outBizNo,
        code: raw.code,
        sub_code: raw.subCode ?? null,
        kind: judged.kind,
        pause_queue: judged.pauseQueue === true,
        latency_ms: latencyMs,
        payee: masked,
      },
      'alipay_transfer',
    );
    return result;
  }

  async query(outBizNo: string, judgement?: ChannelJudgement): Promise<QueryResult> {
    const started = this.options.clock.now();
    const bizContent = { out_biz_no: outBizNo, product_code: PRODUCT_CODE, biz_scene: BIZ_SCENE };
    const outcome = await this.call('query', QUERY_METHOD, bizContent, started, outBizNo);
    const latencyMs = Math.max(0, this.options.clock.now().getTime() - started.getTime());
    if (outcome.kind === 'transport') {
      this.options.logger.warn(
        { out_biz_no: outBizNo, code: outcome.code, latency_ms: latencyMs },
        'alipay_query_unknown',
      );
      return { kind: 'unknown', raw: { code: outcome.code } };
    }
    const { node, raw, status } = outcome.verified;
    const result: QueryResult = judgeQuery(raw, status, judgement?.lists ?? this.options.lists);
    if (status !== undefined) result.status = status;
    if (typeof node['order_id'] === 'string') result.channelOrderId = node['order_id'];
    if (result.kind === 'success') {
      result.paidAt = providerTime(node['pay_date']) ?? isoChina(this.options.clock.now());
    }
    this.options.logger.info(
      {
        out_biz_no: outBizNo,
        code: raw.code,
        sub_code: raw.subCode ?? null,
        status: status ?? null,
        kind: result.kind,
        latency_ms: latencyMs,
      },
      'alipay_query',
    );
    return result;
  }

  /**
   * B2-07b TODO (BR-WDR-22 ⑧, 规划/09 CAP-X-06): the daily bill download has not been run in the
   * sandbox and nothing is recorded — neither the API, nor the bill format, nor whether a line
   * carries out_biz_no is known. Until a recorded sample exists this rejects with
   * PayoutBillUnavailableError without any gateway call; no bill format is assumed or made up.
   * TODO(规划/11 §2.3): download and normalise the daily bill — blocked on 规划/09 账单下载实测与录制.
   */
  billDetails(appId: string, billDate: string): Promise<readonly ChannelBillLine[]> {
    void appId;
    void billDate;
    return Promise.reject(new PayoutBillUnavailableError());
  }

  /** One signed gateway call; the outcome is either transport-class or a verified business node. */
  private async call(
    method: Method,
    apiMethod: string,
    bizContent: Record<string, unknown>,
    started: Date,
    outBizNo: string,
  ): Promise<Transport> {
    const c = this.options.credentials;
    const params: Record<string, string> = {
      app_id: c.appId,
      method: apiMethod,
      format: 'JSON',
      charset: 'utf-8',
      sign_type: 'RSA2',
      timestamp: alipayTimestamp(started),
      version: '1.0',
      biz_content: JSON.stringify(bizContent),
    };
    // Certificate mode: both serial numbers are signed parameters.
    const serials = this.certSerials;
    if (serials !== null) {
      params['app_cert_sn'] = serials.appCertSn;
      params['alipay_root_cert_sn'] = serials.alipayRootCertSn;
    }
    params['sign'] = signAlipayParams(params, c.privateKey);
    const body = new URLSearchParams(params).toString();
    let response: { status: number; body: string };
    try {
      response = await this.transport(c.gatewayUrl, {
        method: 'POST',
        body,
        headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      // Only the error's kind is logged: a transport message may echo the request.
      return { kind: 'transport', code: transportCode(error) };
    }
    if (response.status < 200 || response.status >= 300) {
      return { kind: 'transport', code: `HTTP_${response.status}` };
    }
    return this.verify(method, response.body, outBizNo);
  }

  private verify(method: Method, body: string, outBizNo: string): Transport {
    const name = method === 'transfer' ? TRANSFER_NODE : QUERY_NODE;
    let envelope: unknown;
    try {
      envelope = JSON.parse(body);
    } catch {
      return { kind: 'transport', code: 'UNPARSEABLE_RESPONSE' };
    }
    if (typeof envelope !== 'object' || envelope === null) {
      return { kind: 'transport', code: 'UNPARSEABLE_RESPONSE' };
    }
    const sign = (envelope as Record<string, unknown>)['sign'];
    const text = rawNode(body, name);
    if (typeof sign !== 'string' || text === null) {
      return { kind: 'transport', code: 'UNSIGNED_RESPONSE' };
    }
    // Certificate mode: the response names the certificate it was signed with; only the configured
    // one is accepted (a missing or different serial is an unverified response).
    if (
      this.certSerials !== null &&
      (envelope as Record<string, unknown>)['alipay_cert_sn'] !== this.certSerials.alipayCertSn
    ) {
      return { kind: 'transport', code: 'CERT_SN_MISMATCH' };
    }
    if (!verifyAlipayResponse(text, sign, this.options.credentials.alipayPublicKey)) {
      return { kind: 'transport', code: 'SIGNATURE_INVALID' };
    }
    // The result is read from the very text the signature covered (money r1 S2): a second,
    // unsigned node with the same name elsewhere in the envelope cannot replace it.
    let node: unknown;
    try {
      node = JSON.parse(text);
    } catch {
      return { kind: 'transport', code: 'UNPARSEABLE_RESPONSE' };
    }
    if (typeof node !== 'object' || node === null) {
      return { kind: 'transport', code: 'UNPARSEABLE_RESPONSE' };
    }
    const n = node as Record<string, unknown>;
    if (typeof n['code'] !== 'string') return { kind: 'transport', code: 'UNPARSEABLE_RESPONSE' };
    if (typeof n['out_biz_no'] === 'string' && n['out_biz_no'] !== outBizNo) {
      return { kind: 'transport', code: 'RESPONSE_MISMATCH' };
    }
    const raw: ChannelRaw = { code: n['code'] };
    if (typeof n['sub_code'] === 'string') raw.subCode = n['sub_code'];
    if (typeof n['msg'] === 'string') raw.msg = n['msg'];
    return {
      kind: 'verified',
      verified: { node: n, raw, status: typeof n['status'] === 'string' ? n['status'] : undefined },
    };
  }
}

function transportCode(error: unknown): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'TIMEOUT';
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z_]{3,32}$/.test(code)) return `NETWORK_${code}`;
    if ((error as { name?: unknown }).name === 'AbortError') return 'TIMEOUT';
  }
  return 'NETWORK_ERROR';
}
