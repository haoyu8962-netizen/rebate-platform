// 淘宝用户级授权码换令牌（B1-04zzzzm，D10-2713 / D10-2716；BR-ID-17 细则「授权方式」web_code）。
// 复用站长授权的 exchange 通路（./site-oauth.ts：POST https://oauth.taobao.com/token，表单
// grant_type=authorization_code、client_id、client_secret、code、redirect_uri，不归档、带超时），只换
// redirect_uri 为用户回调（TAOBAO_USER_OAUTH_REDIRECT_URI）。只交出 access_token：refresh_token、
// 有效期、taobao_user_id、taobao_user_nick 都不返回、不保存、不进日志或错误。
// 失败一律是不带原文、不带 cause 的 UnionError：淘宝拒绝这个授权码（error 字段或 4xx）→
// invalid_identity（bindings 答 credential_invalid）；拿不到答复（传输失败、超时、5xx、答复不可读、
// 没有 access_token）→ upstream_unavailable。
// B1-04zzzzn r2（资金评审 S0）：换令牌与之后的 save 用同一个取消信号（调用方的 ctx.signal）：已取消
// 不发；等待中被取消即按 upstream_unavailable 结束，不再等令牌回来（之后也就不会落备案尝试、不发 save）。
import type { Clock } from '../../../platform/index.ts';
import { UnionError } from '../../domain/types.ts';
import type { UnionTransport } from '../replay.ts';
import { createTaobaoSiteOAuth, TaobaoSiteOAuthError } from './site-oauth.ts';

export interface TaobaoUserTokenInput {
  readonly appKey: string;
  readonly appSecret: string;
  /** TAOBAO_USER_OAUTH_REDIRECT_URI: the redirect_uri the authorize address carried. */
  readonly redirectUri: string;
  /** The single-use authorization code the user brought back; never logged or echoed. */
  readonly code: string;
  readonly transport: UnionTransport;
  readonly clock: Clock;
  /** B1-04zzzzn r2: the call's signal (the same one the save is sent under). */
  readonly signal?: AbortSignal;
}

/** The exchange, given up as upstream_unavailable as soon as `signal` aborts. */
function untilAborted<T>(pending: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return pending;
  // A late settlement of `pending` after the abort is not left unhandled.
  pending.catch(() => undefined);
  return new Promise<T>((resolve, reject) => {
    const cancel = () =>
      reject(
        new UnionError(
          'upstream_unavailable',
          'taobao bindPublisher: token exchange cancelled',
          'taobao',
        ),
      );
    if (signal.aborted) {
      cancel();
      return;
    }
    signal.addEventListener('abort', cancel, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener('abort', cancel);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', cancel);
        reject(error);
      },
    );
  });
}

/** The user's access token for this one call (the session of publisher.info.save / get). */
export async function exchangeTaobaoUserCode(input: TaobaoUserTokenInput): Promise<string> {
  const { appKey, appSecret, redirectUri, code, transport, clock, signal } = input;
  if (signal?.aborted === true) {
    throw new UnionError(
      'upstream_unavailable',
      'taobao bindPublisher: token exchange cancelled',
      'taobao',
    );
  }
  const oauth = createTaobaoSiteOAuth({
    credentials: () => Promise.resolve({ appKey, appSecret }),
    transport,
    clock,
    redirectUri,
  });
  try {
    // appId / unionAccountId are not used by the token request (site-oauth.ts exchange).
    const { accessToken } = await untilAborted(
      oauth.exchange({ appId: '', unionAccountId: '', code }),
      signal,
    );
    return accessToken;
  } catch (error) {
    if (error instanceof TaobaoSiteOAuthError && error.kind === 'refused') {
      throw new UnionError(
        'invalid_identity',
        'taobao bindPublisher: authorization code refused',
        'taobao',
      );
    }
    // Only a fixed text: the cause may quote the request or the answer.
    throw new UnionError(
      'upstream_unavailable',
      'taobao bindPublisher: token exchange failed',
      'taobao',
    );
  }
}
