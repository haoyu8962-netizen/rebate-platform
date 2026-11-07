// Recording replay for union adapters (规划/11 §4.5; 规划/09 §0.2 硬规则 3). Layout:
// fixtures/union-recordings/<platform>/<scenario>/{recording.json,provenance.json}. The public
// repository holds only `source: synthetic` samples; real recordings live in the private repo.
// Nothing here listens on a port or opens a socket: the client hands every request to an
// injected transport, and the file replay is such a transport backed by the recording files.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute, sep } from 'node:path';
import type { Clock } from '../../platform/index.ts';
import {
  isRegisteredPlatform,
  UnionError,
  type RegisteredPlatform,
  type UnionEndpoint,
} from '../domain/types.ts';

/** Framework metadata, not an upstream platform response schema. */
export interface UnionRecordingProvenance {
  readonly source: 'probe' | 'doc-derived' | 'synthetic';
  readonly capabilityId: string;
  readonly probeRunId: string | null;
  readonly capturedAt: string;
  readonly originalSha256: string;
  readonly sanitizerVersion: string;
}

export interface UnionReplayRequest {
  readonly method: 'GET' | 'POST';
  /** Relative to the configured base URL, retaining its path prefix. */
  readonly path: string;
  readonly scenario: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

/**
 * B1-04p: who a transport request is made for and why, read only by the archiving transport
 * (archive.ts) to write union_raw_payloads. Never sent upstream.
 */
export interface ArchiveContext {
  readonly appId: string;
  /** order / convert / authority / query (open text, see archive.ts). */
  readonly kind: string;
}

export interface UnionTransportRequest {
  readonly platform: RegisteredPlatform;
  readonly url: string;
  readonly method: 'GET' | 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
  /** B1-04p: archive context; transports never put it on the wire. */
  readonly archive?: ArchiveContext;
  /**
   * B1-04zzc: rewrites the response body before the archiving transport stores it (e.g. the
   * 大淘客 order details drop the rows of other companies' promotion slots). Read only by the
   * archiving transport; the caller still gets the body as received. Kept apart from `archive`.
   * B1-04zzu: may give a promise (the 淘宝 refund archive asks orders which rows are 凑狸's); see
   * archive.ts ArchiveBodyLookupError.
   */
  readonly archiveBody?: (body: string) => string | Promise<string>;
}

export interface UnionTransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /**
   * B1-08e：归档传输插入 union_raw_payloads 成功时的行 id（bigint 的十进制字符串）。归档传输把它
   * 以不可枚举属性挂在 inner 返回的同一个响应对象上；插入失败、无归档上下文或未经归档时没有。
   */
  readonly raw_payload_id?: string;
}

export type UnionTransport = (request: UnionTransportRequest) => Promise<UnionTransportResponse>;

/** Internal replay failures; these are not HTTP contract error codes. */
export type UnionReplayErrorCode =
  | 'invalid_provenance'
  | 'invalid_replay_request'
  | 'recording_missing'
  | 'invalid_recording'
  | 'recording_mismatch';

export interface UnionReplayClient {
  send(platform: RegisteredPlatform, request: UnionReplayRequest): Promise<UnionTransportResponse>;
}

export interface UnionReplayClientOptions {
  readonly endpoints: readonly UnionEndpoint[];
  readonly transport: UnionTransport;
}

export interface UnionLoadedRecording {
  readonly platform: RegisteredPlatform;
  readonly scenario: string;
  readonly directory: string;
  readonly provenance: UnionRecordingProvenance;
  readonly loadedAt: string;
}

export interface UnionReplayReport {
  readonly recordings: readonly UnionLoadedRecording[];
  /** Necessary source check only; probe-run log verification belongs to the external guard. */
  readonly acceptanceEligible: boolean;
}

export interface UnionFileReplay {
  readonly transport: UnionTransport;
  report(): UnionReplayReport;
}

export interface UnionFileReplayOptions {
  /** fixtures/union-recordings root; each <platform>/<scenario> holds both JSON files. */
  readonly directory: string;
  readonly clock: Clock;
}

export class UnionReplayError extends Error {
  readonly code: UnionReplayErrorCode;

  constructor(code: UnionReplayErrorCode, message: string) {
    super(message);
    this.name = 'UnionReplayError';
    this.code = code;
  }
}

const SOURCES: readonly UnionRecordingProvenance['source'][] = [
  'probe',
  'doc-derived',
  'synthetic',
];
const PROVENANCE_KEYS = new Set([
  'source',
  'capabilityId',
  'probeRunId',
  'capturedAt',
  'originalSha256',
  'sanitizerVersion',
]);
const SHA256 = /^[0-9a-f]{64}$/;
const INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(\.\d{1,9})?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
/** One directory name: no separators, dots or encodings, so it cannot leave <platform>/. */
const SCENARIO = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const METHODS: readonly string[] = ['GET', 'POST'];
const SCENARIO_HEADER = 'X-Scenario';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function badProvenance(message: string): UnionReplayError {
  return new UnionReplayError('invalid_provenance', message);
}

function isInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = INSTANT.exec(value);
  if (match === null || Number.isNaN(Date.parse(value))) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  // Date.parse rolls 02-31 over to March; the calendar day must exist as written.
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return days !== undefined && day >= 1 && day <= days;
}

/** Metadata validation does not certify that a probe was run by the owner. */
export function parseUnionRecordingProvenance(input: unknown): UnionRecordingProvenance {
  if (!isRecord(input)) throw badProvenance('provenance must be an object');
  const extra = Object.keys(input).filter((key) => !PROVENANCE_KEYS.has(key));
  if (extra.length > 0) throw badProvenance(`provenance has unsupported keys: ${extra.join(', ')}`);
  for (const key of PROVENANCE_KEYS) {
    if (!(key in input)) throw badProvenance(`provenance.${key} is required`);
  }
  const { source, capabilityId, probeRunId, capturedAt, originalSha256, sanitizerVersion } = input;
  if (typeof source !== 'string' || !(SOURCES as readonly string[]).includes(source)) {
    throw badProvenance(`provenance.source must be one of ${SOURCES.join(', ')}`);
  }
  if (!isNonBlank(capabilityId)) throw badProvenance('provenance.capabilityId must be non-empty');
  if (source === 'probe') {
    if (!isNonBlank(probeRunId)) throw badProvenance('probe provenance needs a probeRunId');
  } else if (probeRunId !== null) {
    // Only a probe has a probe run; a run id on other sources would blur the source check.
    throw badProvenance('provenance.probeRunId must be null unless source is probe');
  }
  if (!isInstant(capturedAt)) throw badProvenance('provenance.capturedAt must be an ISO instant');
  if (typeof originalSha256 !== 'string' || !SHA256.test(originalSha256)) {
    throw badProvenance('provenance.originalSha256 must be 64 lowercase hex digits');
  }
  if (!isNonBlank(sanitizerVersion)) {
    throw badProvenance('provenance.sanitizerVersion must be non-empty');
  }
  return Object.freeze({
    source: source as UnionRecordingProvenance['source'],
    capabilityId,
    probeRunId: probeRunId as string | null,
    capturedAt,
    originalSha256,
    sanitizerVersion,
  });
}

function badRequest(message: string): UnionReplayError {
  return new UnionReplayError('invalid_replay_request', message);
}

function checkScenario(scenario: unknown): string {
  if (typeof scenario !== 'string' || !SCENARIO.test(scenario)) {
    throw badRequest('scenario must be a single safe directory name');
  }
  return scenario;
}

/** The X-Scenario value, matched case-insensitively; absent or ambiguous values are refused. */
function scenarioHeader(headers: Readonly<Record<string, string>> | undefined): string {
  const values = Object.entries(headers ?? {})
    .filter(([name]) => name.toLowerCase() === SCENARIO_HEADER.toLowerCase())
    .map(([, value]) => value);
  if (values.length !== 1) throw badRequest(`exactly one ${SCENARIO_HEADER} header is required`);
  return checkScenario(values[0]);
}

interface RecordingEnvelope {
  readonly request: { readonly method: string; readonly path: string; readonly body?: string };
  readonly response: UnionTransportResponse;
}

function badRecording(message: string): UnionReplayError {
  return new UnionReplayError('invalid_recording', message);
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[], where: string): void {
  const extra = Object.keys(value).filter((key) => !keys.includes(key));
  if (extra.length > 0) throw badRecording(`${where} has unsupported keys: ${extra.join(', ')}`);
}

function parseEnvelope(input: unknown): RecordingEnvelope {
  if (!isRecord(input)) throw badRecording('recording must be an object');
  onlyKeys(input, ['request', 'response'], 'recording');
  const { request, response } = input;
  if (!isRecord(request)) throw badRecording('recording.request must be an object');
  onlyKeys(request, ['method', 'path', 'body'], 'recording.request');
  if (typeof request['method'] !== 'string' || !METHODS.includes(request['method'])) {
    throw badRecording(`recording.request.method must be one of ${METHODS.join(', ')}`);
  }
  const path = request['path'];
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
    throw badRecording('recording.request.path must be an absolute URL path');
  }
  const body = request['body'];
  if (body !== undefined && typeof body !== 'string') {
    throw badRecording('recording.request.body must be a string when present');
  }
  if (!isRecord(response)) throw badRecording('recording.response must be an object');
  onlyKeys(response, ['status', 'headers', 'body'], 'recording.response');
  const status = response['status'];
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) {
    throw badRecording('recording.response.status must be an HTTP status code');
  }
  const headers = response['headers'];
  if (!isRecord(headers) || Object.values(headers).some((value) => typeof value !== 'string')) {
    throw badRecording('recording.response.headers must map names to strings');
  }
  if (typeof response['body'] !== 'string') {
    throw badRecording('recording.response.body must be a string');
  }
  return {
    request: {
      method: request['method'],
      path,
      ...(body === undefined ? {} : { body }),
    },
    response: { status, headers: headers as Record<string, string>, body: response['body'] },
  };
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error['code'] === 'string' ? error['code'] : undefined;
}

/** Each component must exist as the expected kind and must not be a symbolic link. */
async function checkComponent(path: string, kind: 'directory' | 'file'): Promise<void> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') {
      throw new UnionReplayError('recording_missing', `no recording at ${path}`);
    }
    throw error;
  }
  if (stats.isSymbolicLink()) throw badRequest('recordings must not be reached through links');
  if (kind === 'directory' ? !stats.isDirectory() : !stats.isFile()) {
    throw new UnionReplayError('recording_missing', `no recording at ${path}`);
  }
}

/** Reads a regular file without following a link swapped in after the lstat check. */
async function readNoFollow(path: string): Promise<string> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (errorCode(error) === 'ELOOP') throw badRequest('recordings must not be links');
    if (errorCode(error) === 'ENOENT') {
      throw new UnionReplayError('recording_missing', `no recording at ${path}`);
    }
    throw error;
  }
  try {
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

function parseJson(text: string, code: 'invalid_recording' | 'invalid_provenance'): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new UnionReplayError(code, 'file is not valid JSON');
  }
}

function matches(envelope: RecordingEnvelope, request: UnionTransportRequest): boolean {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    throw badRequest('request url must be absolute');
  }
  return (
    envelope.request.method === request.method &&
    `${url.pathname}${url.search}` === envelope.request.path &&
    url.hash === '' &&
    envelope.request.body === request.body
  );
}

/**
 * recording.json is a framework envelope: { request: { method, path, body? }, response:
 * { status, headers, body } }. The request path is the URL pathname plus query string; the
 * host is not compared, so any configured base URL replays the same files.
 * provenance.json carries UnionRecordingProvenance; payload bodies remain opaque strings.
 * Synthetic examples use scenario synthetic-smoke and no upstream field names.
 * A recording enters the report as soon as both files were read and validated, before request
 * matching or cancellation, so a mismatched or aborted load still counts. The same
 * <platform>/<scenario> is listed again whenever its files changed. Once any non-probe source
 * was loaded the report stays ineligible as acceptance evidence (规划/11 §4.5).
 */
export function createUnionFileReplay(options: UnionFileReplayOptions): UnionFileReplay {
  const { directory, clock } = options;
  const loaded: UnionLoadedRecording[] = [];
  /** Content fingerprints of `loaded`, index for index: platform, scenario and both files. */
  const fingerprints: string[] = [];
  let sawNonProbe = false;

  function register(
    platform: RegisteredPlatform,
    scenario: string,
    folder: string,
    provenance: UnionRecordingProvenance,
    fingerprint: string,
  ): void {
    if (provenance.source !== 'probe') sawNonProbe = true;
    if (fingerprints.includes(fingerprint)) return;
    fingerprints.push(fingerprint);
    loaded.push(
      Object.freeze({
        platform,
        scenario,
        directory: folder,
        provenance,
        loadedAt: clock.now().toISOString(),
      }),
    );
  }

  async function load(
    platform: RegisteredPlatform,
    scenario: string,
  ): Promise<{
    folder: string;
    envelope: RecordingEnvelope;
    provenance: UnionRecordingProvenance;
    fingerprint: string;
  }> {
    const platformDir = join(directory, platform);
    const folder = join(platformDir, scenario);
    const files = {
      recording: join(folder, 'recording.json'),
      provenance: join(folder, 'provenance.json'),
    };
    await checkComponent(directory, 'directory');
    await checkComponent(platformDir, 'directory');
    await checkComponent(folder, 'directory');
    await checkComponent(files.recording, 'file');
    await checkComponent(files.provenance, 'file');
    // Belt and braces against a link anywhere above: the resolved folder stays under the root.
    const [realRoot, realFolder] = await Promise.all([realpath(directory), realpath(folder)]);
    if (!isInside(realRoot, realFolder)) throw badRequest('recording escapes the recordings root');
    const [provenanceText, recordingText] = await Promise.all([
      readNoFollow(files.provenance),
      readNoFollow(files.recording),
    ]);
    const provenance = parseUnionRecordingProvenance(
      parseJson(provenanceText, 'invalid_provenance'),
    );
    const envelope = parseEnvelope(parseJson(recordingText, 'invalid_recording'));
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([platform, scenario, provenanceText, recordingText]))
      .digest('hex');
    return { folder, envelope, provenance, fingerprint };
  }

  const transport: UnionTransport = async (request) => {
    if (!isRecord(request) || !isRegisteredPlatform(request.platform)) {
      throw badRequest('request platform is not registered');
    }
    if (!METHODS.includes(request.method)) throw badRequest('request method is not supported');
    const scenario = scenarioHeader(request.headers);
    request.signal?.throwIfAborted();
    const { folder, envelope, provenance, fingerprint } = await load(request.platform, scenario);
    // Register before matching or the abort check: the source was read, so it must be reported.
    register(request.platform, scenario, folder, provenance, fingerprint);
    if (!matches(envelope, request)) {
      throw new UnionReplayError(
        'recording_mismatch',
        `request does not match ${request.platform}/${scenario}`,
      );
    }
    request.signal?.throwIfAborted();
    return {
      status: envelope.response.status,
      headers: { ...envelope.response.headers },
      body: envelope.response.body,
    };
  };

  return {
    transport,
    report(): UnionReplayReport {
      const recordings = Object.freeze([...loaded]);
      return Object.freeze({
        recordings,
        acceptanceEligible:
          recordings.length > 0 &&
          !sawNonProbe &&
          recordings.every((entry) => entry.provenance.source === 'probe'),
      });
    },
  };
}

/** Reject anything that could leave the configured base: schemes, roots, dot segments, hashes. */
function resolveUrl(baseUrl: string, path: unknown): string {
  if (typeof path !== 'string' || path === '') throw badRequest('path must be a relative path');
  if (
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('#') ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path)
  ) {
    throw badRequest('path must be relative to the configured base URL');
  }
  const pathname = path.split('?', 1)[0] ?? '';
  const segments = pathname.split('/').map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      throw badRequest('path has an invalid percent encoding');
    }
  });
  if (segments.some((segment) => segment === '.' || segment === '..' || segment.includes('/'))) {
    throw badRequest('path must not contain dot segments');
  }
  const base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  const url = new URL(path, base);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname) || url.hash !== '') {
    throw badRequest('path must stay under the configured base URL');
  }
  return url.href;
}

// TODO(规划/11 §4.5): WireMock 接入 — blocked on infra 任务
export function createUnionReplayClient(options: UnionReplayClientOptions): UnionReplayClient {
  const byPlatform = new Map<RegisteredPlatform, UnionEndpoint>();
  for (const endpoint of options.endpoints) {
    if (byPlatform.has(endpoint.platform)) {
      throw new UnionError('invalid_endpoint', `duplicate endpoint for ${endpoint.platform}`);
    }
    byPlatform.set(endpoint.platform, endpoint);
  }
  const { transport } = options;

  return {
    async send(platform, request) {
      const endpoint = isRegisteredPlatform(platform) ? byPlatform.get(platform) : undefined;
      if (endpoint === undefined) {
        throw new UnionError('invalid_endpoint', 'no endpoint configured for platform');
      }
      // Only replay goes through here: demo has no upstream, live is not reached by replay code.
      if (endpoint.mode !== 'replay' || endpoint.baseUrl === null) {
        throw new UnionError(
          'unsafe_mode',
          `replay client refuses ${endpoint.platform}=${endpoint.mode}`,
          endpoint.platform,
        );
      }
      if (!METHODS.includes(request.method)) throw badRequest('request method is not supported');
      const scenario = checkScenario(request.scenario);
      const url = resolveUrl(endpoint.baseUrl, request.path);
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers ?? {})) {
        if (name.toLowerCase() !== SCENARIO_HEADER.toLowerCase()) headers[name] = value;
      }
      headers[SCENARIO_HEADER] = scenario;
      return transport({
        platform: endpoint.platform,
        url,
        method: request.method,
        headers,
        ...(request.body === undefined ? {} : { body: request.body }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    },
  };
}
