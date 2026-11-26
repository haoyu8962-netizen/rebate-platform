import type { VendorResponse, VendorTransport } from '../vendors/index.ts';
import { assembleChunks, usageFromChunks, usageOf } from './chunks.ts';
import {
  classifyFailure,
  errorCode,
  isRecord,
  malformed,
  markNotSent,
  ModelProtocolError,
  tokenCount,
} from './errors.ts';
import { fromVendorRequest } from './request.ts';
import { createSseChunkParser } from './sse.ts';
import type { HttpTransportOptions, ModelRequestShape } from './types.ts';

function named(value: unknown, name: string): boolean {
  return value instanceof Error && value.name === name;
}

function cancellation(signal: AbortSignal): ModelProtocolError {
  return new ModelProtocolError(
    named(signal.reason, 'TimeoutError') ? 'timeout' : 'aborted',
    'Model request cancelled',
  );
}

function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) throw cancellation(signal);
}

/** 即使注入端口未响应 signal，也能及时结束等待，并消费迟到的拒绝。 */
function abortable<T>(start: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(cancellation(signal));
      return;
    }
    const abort = (): void => {
      signal.removeEventListener('abort', abort);
      reject(cancellation(signal));
    };
    signal.addEventListener('abort', abort, { once: true });
    let pending: Promise<T>;
    try {
      pending = start();
    } catch (error) {
      signal.removeEventListener('abort', abort);
      reject(error);
      return;
    }
    pending.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        if (signal.aborted) reject(cancellation(signal));
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(signal.aborted ? cancellation(signal) : error);
      },
    );
  });
}

/** 原始 fetch/流异常可能包含凭据；不保留 message、cause 或其他属性。 */
async function network<T>(start: () => Promise<T>, signal: AbortSignal): Promise<T> {
  try {
    return await abortable(start, signal);
  } catch (error) {
    if (signal.aborted) throw cancellation(signal);
    const kind = named(error, 'TimeoutError')
      ? 'timeout'
      : named(error, 'AbortError')
        ? 'aborted'
        : 'network';
    throw new ModelProtocolError(kind, 'Model transport failed');
  }
}

function endpoint(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ModelProtocolError('bad_request', 'Invalid model endpoint');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    /[?#]/.test(baseUrl)
  ) {
    throw new ModelProtocolError('bad_request', 'Invalid model endpoint');
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/chat/completions`;
  return url.href;
}

function close(iterator: AsyncIterator<Uint8Array>): void {
  // 中止时不能等卡住的 iterator.return；真实 fetch 的读取由同一 signal 取消。
  try {
    void iterator.return?.().catch(() => undefined);
  } catch {
    // 清理错误不得覆盖原始分类，也不得泄露供应商返回的文本。
  }
}

export function createHttpTransport(input: HttpTransportOptions): VendorTransport {
  const url = endpoint(input.baseUrl);
  const options: HttpTransportOptions = {
    ...input,
    quirks: { ...input.quirks, contentRefusalCodes: [...input.quirks.contentRefusalCodes] },
  };
  return Object.freeze({
    billable: true,
    async send(request, inputSignal) {
      // B3-09o · BR-AI-16 细则「请求根本没发出去，不计」：在调用 options.fetch 之前抛出的错
      // （已中止、请求形状不对、凭据读不到）都登记为没发出；调用 fetch 之后的任何失败都不登记。
      const handoff = { fetched: false };
      try {
        return await sendHttp(options, url, request, inputSignal, handoff);
      } catch (error) {
        if (!handoff.fetched) markNotSent(error);
        throw error;
      }
    },
  } satisfies VendorTransport);
}

async function sendHttp(
  options: HttpTransportOptions,
  url: string,
  request: Parameters<VendorTransport['send']>[0],
  inputSignal: Parameters<VendorTransport['send']>[1],
  handoff: { fetched: boolean },
): Promise<VendorResponse> {
  const signal = inputSignal ?? new AbortController().signal;
  checkSignal(signal);
  if (request.vendor !== options.vendor) {
    throw new ModelProtocolError('bad_request', 'Request vendor does not match transport');
  }
  const shape = fromVendorRequest(request);
  if (shape.params.stream !== true) throw malformed();
  let body: string;
  try {
    body = JSON.stringify({
      ...shape.params,
      model: shape.model,
      messages: shape.messages,
      tools: shape.tools,
    });
  } catch {
    throw malformed();
  }
  let key: string;
  try {
    key = options.apiKey();
    if (typeof key !== 'string' || key.trim() === '' || /\s/.test(key)) throw malformed();
  } catch {
    throw new ModelProtocolError('auth', 'Model credential unavailable');
  }
  const response = await network(() => {
    handoff.fetched = true;
    return options.fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body,
      signal,
      redirect: 'error',
    });
  }, signal);
  if (response.status < 200 || response.status >= 300) {
    const text = await network(() => response.text(), signal);
    let errorBody: unknown = null;
    try {
      errorBody = JSON.parse(text) as unknown;
    } catch {
      // 非 JSON 正文也按状态码分类。
    }
    const code = errorCode(errorBody);
    // 厂商码只保留短标识符，并剔除回显的当前凭据。
    const vendorCode =
      code !== null && /^[A-Za-z0-9_.-]{1,80}$/.test(code) && !code.includes(key) ? code : null;
    const kind = classifyFailure(
      options.vendor,
      { status: response.status, body: errorBody },
      options.quirks,
    );
    throw new ModelProtocolError(kind, 'Model endpoint rejected request', {
      status: response.status,
      vendorCode,
    });
  }
  if (response.body === null) throw malformed();
  const iterator = response.body[Symbol.asyncIterator]();
  const chunks: unknown[] = [];
  const parser = createSseChunkParser((chunk) => {
    chunks.push(chunk);
  });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let secretTail = '';
  let exhausted = false;
  try {
    while (!parser.finished) {
      const part = await network(() => iterator.next(), signal);
      if (part.done) {
        exhausted = true;
        break;
      }
      bytes += part.value.byteLength;
      if (bytes > 16 * 1024 * 1024) throw malformed();
      let text: string;
      try {
        text = decoder.decode(part.value, { stream: true });
      } catch {
        throw malformed();
      }
      const overlap = secretTail + text;
      if (overlap.includes(key)) throw malformed();
      secretTail = key.length > 1 ? overlap.slice(-(key.length - 1)) : '';
      parser.push(text);
    }
    if (!parser.finished) {
      let tail: string;
      try {
        tail = decoder.decode();
      } catch {
        throw malformed();
      }
      parser.push(tail);
      parser.end();
    }
    checkSignal(signal);
    if (!parser.finished) throw malformed();
    const events = assembleChunks(chunks);
    // JSON 转义不能成为凭据进入返回值/录制的旁路。
    if (containsSecret(chunks, key)) throw malformed();
    return { chunks, usage: usageOf(events) };
  } catch (error) {
    if (error instanceof ModelProtocolError) {
      // 即使参数 JSON 无效或流被中止，已解析的用量也交给上层计量。
      throw new ModelProtocolError(error.kind, error.message, {
        status: error.status,
        vendorCode: error.vendorCode,
        usage: usageFromChunks(chunks),
      });
    }
    throw error;
  } finally {
    if (!exhausted) close(iterator);
  }
}

function containsSecret(value: unknown, key: string): boolean {
  // 使用显式栈，深层 JSON 不得触发递归栈溢出。
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const item = pending.pop();
    if (typeof item === 'string' && item.includes(key)) return true;
    if (Array.isArray(item)) {
      for (const child of item as unknown[]) pending.push(child);
    } else if (isRecord(item)) {
      for (const [name, child] of Object.entries(item)) {
        if (name.includes(key)) return true;
        pending.push(child);
      }
    }
  }
  return false;
}

/** 评测端口的录制未命中异常保留原样，交给 evals 归为 coverage_gap。 */
export function createPortTransport(
  model: (req: ModelRequestShape) => Promise<unknown>,
): VendorTransport {
  return Object.freeze({
    billable: false,
    async send(request, inputSignal) {
      const signal = inputSignal ?? new AbortController().signal;
      checkSignal(signal);
      const response = await abortable(() => model(fromVendorRequest(request)), signal);
      if (
        !isRecord(response) ||
        !Array.isArray(response.chunks) ||
        !isRecord(response.usage) ||
        !tokenCount(response.usage.input_tokens) ||
        !tokenCount(response.usage.output_tokens)
      ) {
        throw malformed();
      }
      try {
        return structuredClone({
          chunks: response.chunks,
          usage: {
            input_tokens: response.usage.input_tokens,
            output_tokens: response.usage.output_tokens,
          },
        }) satisfies VendorResponse;
      } catch {
        throw malformed();
      }
    },
  } satisfies VendorTransport);
}
