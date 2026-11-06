// 大淘客开放平台请求底座（B1-04m，D10-486 ①；淘宝订单 / 维权 / 违规的数据源）。
// - 网关：baseUrl（只允许 https，否则 invalid_endpoint，不取凭据、不发请求）+ 调用方给的绝对路径
//   （以单个 / 开头，不含 ? # \ 与 . / .. 段，否则 invalid_dto）。
// - 公共参数：appKey、version（调用方给，空 → invalid_dto）、timer（注入 Clock 的毫秒时间戳）、
//   nonce（每次请求调一次注入随机源 random(1000000)，补零到 6 位；随机源给出非法值 → RangeError）、
//   signRan（见 sign.ts，业务参数不参与）。业务参数与公共参数同名或为非有限数字 → invalid_dto，不发请求。
//   业务参数值 undefined / null / '' 不发送；数字、布尔按字符串形式。
// - GET：全部参数在查询串，无请求体；POST：全部参数在 UTF-8 表单体
//   （application/x-www-form-urlencoded;charset=utf-8），URL 不带查询串。
// - 凭据每次请求经注入的提供者取一次，构造时不取；appSecret 只在内存参与签名，不进 URL、表单、
//   请求头、错误、warn 与对象自身。不读 process.env、不读文件。
// - 经注入的 UnionTransport 发送（platform 'taobao'）；调用方 AbortSignal 与归档上下文原样挂在传输请求上，
//   不上线路（B1-04zzc：归档正文改写函数 archiveBody 同样只挂在传输请求上）。
//   传输抛错（非 UnionError）→ upstream_unavailable（不带原文、不挂 cause）。
// - 响应解包与错误分类见 response.ts；返回 data 对象，不做订单字段映射（B1-04f / B1-04z）。
// - B1-04d：调用方可按接口给出外层 code 细分表（outerCodes），只覆盖表内 code 的分类。
// - B1-04f：exchange 与 request 同样签名、发送、解包与分类，另把传输响应原样交回（订单映射要从原文
//   二次解析 JSON 数字原文，并读归档传输挂在响应上的 raw_payload_id）。
import type { Clock } from '../../../platform/index.ts';
import { UnionError } from '../../domain/types.ts';
import type { ArchiveContext, UnionTransport, UnionTransportResponse } from '../replay.ts';
import { unwrapDataokeResponse, type DataokeCodeMap, type DataokeWarning } from './response.ts';
import { DATAOKE_NONCE_BOUND, dataokeNonce, dataokeSignRan, dataokeTimer } from './sign.ts';

export type { DataokeCodeMap, DataokeWarning } from './response.ts';
export type { DataokeSignInput } from './sign.ts';

/** Application-level key pair; fetched once per request, never stored on the client. */
export interface DataokeCredentials {
  readonly appKey: string;
  readonly appSecret: string;
}

/**
 * Random source for nonce: returns an integer in [0, bound). The client calls it once per request
 * with bound 1000000 (deployment wiring passes node:crypto randomInt; tests pass a fixed value).
 */
export type DataokeRandom = (bound: number) => number;

/** undefined / null / '' are not sent; numbers and booleans go out in their string form. */
export type DataokeParameter = string | number | boolean | null | undefined;
export type DataokeParameters = Readonly<Record<string, DataokeParameter>>;

export type DataokeHttpMethod = 'GET' | 'POST';

export interface DataokeClientOptions {
  readonly credentials: () => Promise<DataokeCredentials>;
  readonly transport: UnionTransport;
  readonly clock: Clock;
  readonly random: DataokeRandom;
  /** Gateway origin from deployment config (https://openapi.dataoke.com); https only. */
  readonly baseUrl: string;
  readonly warn?: (event: DataokeWarning) => void;
}

/** B1-04f: the unwrapped `data` object together with the transport response it came from. */
export interface DataokeExchange {
  readonly data: Readonly<Record<string, unknown>>;
  readonly response: UnionTransportResponse;
}

export interface DataokeRequestOptions {
  /** Interface version given by the caller (orders / refunds / punishments: v1.0.0). */
  readonly version: string;
  readonly signal?: AbortSignal;
  /** Rides on the transport request for the archiving transport only; never on the wire. */
  readonly archive?: ArchiveContext;
  /**
   * B1-04zzc: rides on the transport request as `archiveBody` (the body the archiving transport
   * stores); never on the wire, the caller's response is unchanged.
   */
  readonly archiveBody?: (body: string) => string;
  /**
   * B1-04d: per-interface refinement of non-zero outer codes (string form), e.g. the privilege
   * link's goods-not-promotable codes → item_unavailable. Codes not listed keep the gz-13 grouping.
   */
  readonly outerCodes?: DataokeCodeMap;
}

/** 公共参数名；业务参数不得占用（同名 → invalid_dto，不发请求）。 */
const PUBLIC_PARAMETERS: ReadonlySet<string> = new Set([
  'appKey',
  'version',
  'timer',
  'nonce',
  'signRan',
]);

const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded;charset=utf-8';

function invalidDto(path: string, reason: string): UnionError {
  return new UnionError('invalid_dto', `dataoke ${path}: ${reason}`, 'taobao');
}

/** https origin + path prefix without trailing slashes; anything else is invalid_endpoint. */
function gatewayBase(baseUrl: string): { readonly origin: string; readonly prefix: string } {
  let url: URL | undefined;
  try {
    url = typeof baseUrl === 'string' ? new URL(baseUrl) : undefined;
  } catch {
    url = undefined;
  }
  if (
    url === undefined ||
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new UnionError(
      'invalid_endpoint',
      'dataoke client: gateway URL must be a plain https URL',
      'taobao',
    );
  }
  return { origin: url.origin, prefix: url.pathname.replace(/\/+$/, '') };
}

/** Wire text of a business parameter, or undefined when it is not sent (undefined / null / ''). */
function parameterText(path: string, name: string, value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalidDto(path, `non-finite parameter ${name}`);
    return String(value);
  }
  throw invalidDto(path, `unsupported parameter ${name}`);
}

export class DataokeClient {
  readonly #credentials: () => Promise<DataokeCredentials>;
  readonly #transport: UnionTransport;
  readonly #clock: Clock;
  readonly #random: DataokeRandom;
  readonly #origin: string;
  readonly #prefix: string;
  readonly #warn: ((event: DataokeWarning) => void) | undefined;

  constructor(options: DataokeClientOptions) {
    const { origin, prefix } = gatewayBase(options.baseUrl);
    this.#origin = origin;
    this.#prefix = prefix;
    this.#credentials = options.credentials;
    this.#transport = options.transport;
    this.#clock = options.clock;
    this.#random = options.random;
    this.#warn = options.warn;
  }

  /** Signs and sends one request to baseUrl + path; returns the response `data` object. */
  async request(
    method: DataokeHttpMethod,
    path: string,
    parameters: DataokeParameters,
    options: DataokeRequestOptions,
  ): Promise<Readonly<Record<string, unknown>>> {
    const response = await this.#send(method, path, parameters, options);
    return unwrapDataokeResponse(path, response, this.#warn, {
      ...(options.outerCodes === undefined ? {} : { outerCodes: options.outerCodes }),
    });
  }

  /**
   * B1-04f: same as request (same checks, errors and warnings), but also returns the transport
   * response, so a caller can re-read the body text (JSON number literals) and the archive row id.
   */
  async exchange(
    method: DataokeHttpMethod,
    path: string,
    parameters: DataokeParameters,
    options: DataokeRequestOptions,
  ): Promise<DataokeExchange> {
    const response = await this.#send(method, path, parameters, options);
    return {
      data: unwrapDataokeResponse(path, response, this.#warn, {
        ...(options.outerCodes === undefined ? {} : { outerCodes: options.outerCodes }),
      }),
      response,
    };
  }

  async #send(
    method: DataokeHttpMethod,
    path: string,
    parameters: DataokeParameters,
    { version, signal, archive, archiveBody }: DataokeRequestOptions,
  ): Promise<UnionTransportResponse> {
    // 不需要凭据的同步检查在前：不合格的调用不取凭据、不发请求。
    if (method !== 'GET' && method !== 'POST') throw invalidDto(path, 'unsupported method');
    const url = this.#url(path);
    if (typeof version !== 'string' || version === '') throw invalidDto(path, 'empty version');
    const business = this.#businessEntries(path, parameters);

    const { appKey, appSecret } = await this.#credentials();
    const timer = dataokeTimer(this.#clock.now());
    const nonce = dataokeNonce(this.#random(DATAOKE_NONCE_BOUND));
    // secret 只在这里参与签名；线路上只有 signRan。
    const signRan = dataokeSignRan({ appKey, timer, nonce }, appSecret);
    const fields = new URLSearchParams([
      ['appKey', appKey],
      ['version', version],
      ['timer', timer],
      ['nonce', nonce],
      ['signRan', signRan],
      ...business,
    ]).toString();

    const request =
      method === 'GET'
        ? { url: `${url}?${fields}`, headers: {} }
        : { url, headers: { 'content-type': FORM_CONTENT_TYPE }, body: fields };
    try {
      return await this.#transport({
        platform: 'taobao',
        method,
        ...request,
        ...(signal === undefined ? {} : { signal }),
        ...(archive === undefined ? {} : { archive }),
        ...(archiveBody === undefined ? {} : { archiveBody }),
      });
    } catch (error) {
      if (error instanceof UnionError) throw error;
      // 未知传输错误不带原文与 cause，避免请求内容进入错误信息。
      throw new UnionError('upstream_unavailable', `dataoke ${path}: transport failed`, 'taobao');
    }
  }

  /** baseUrl + a plain absolute path: one leading slash, no ? # \\, no empty / . / .. segment. */
  #url(path: string): string {
    if (
      typeof path !== 'string' ||
      !path.startsWith('/') ||
      /[?#\\]/.test(path) ||
      path
        .slice(1)
        .split('/')
        .some((segment) => segment === '' || segment === '.' || segment === '..')
    ) {
      throw invalidDto(String(path), 'path is not a plain absolute path');
    }
    const url = `${this.#origin}${this.#prefix}${path}`;
    // URL 解析不得改写路径（百分号编码的 . 段、需要转义的字符等一律拒绝）。
    const parsed = new URL(url);
    if (
      parsed.origin !== this.#origin ||
      parsed.pathname !== `${this.#prefix}${path}` ||
      parsed.search !== '' ||
      parsed.hash !== ''
    ) {
      throw invalidDto(path, 'path is not a plain absolute path');
    }
    return url;
  }

  /** Business parameters as wire entries; reserved names and non-finite numbers are refused. */
  #businessEntries(path: string, parameters: DataokeParameters): [string, string][] {
    const entries: [string, string][] = [];
    for (const name of Object.keys(parameters)) {
      if (PUBLIC_PARAMETERS.has(name)) throw invalidDto(path, `reserved parameter ${name}`);
      const text = parameterText(path, name, parameters[name]);
      if (text !== undefined) entries.push([name, text]);
    }
    return entries;
  }
}
