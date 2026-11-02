// B1-30a (FU-KMS-ADAPTER): reading secrets from and wrapping keys with Aliyun KMS (规划/02 §12.6,
// BR-PAY-08 ②; docs-mirror/aliyun-kms/pages/). Rule tests: test/spec/platform/kms/**.
//
// ./sdk.ts is imported dynamically, when the client is first needed: a process without KMS (local,
// test, or KMS_* unset) never loads it, and kmsAccessOf itself imports nothing and sends nothing. One
// client per KmsAccess, also when several factories use it for the first time at once.
//
// Secrets are named couli/<appEnv>/<logical name> and must be of type text. Every failure is a
// KmsError or, in the key provider, a fixed Error: nothing of the SDK's error is kept (it may quote
// the request). Nothing here logs.
import type { AppEnv } from '../config/app-env.ts';
import type { KmsConfig } from '../config/kms.ts';
import type { KeyProvider } from '../crypto/index.ts';
import type { KmsSdkClient } from './sdk.ts';

export type KmsErrorCode = 'kms_read_failed' | 'secret_invalid';

export type KmsSecretName =
  | 'pay/wechat/merchant-private-key'
  | 'pay/wechat/apiv3-key'
  | 'pay/wechat/platform-public-key'
  | 'pay/alipay/app-private-key'
  | 'pay/alipay/public-key'
  | 'pay/alipay/app-cert'
  | 'pay/alipay/public-cert'
  | 'pay/alipay/root-cert'
  | 'union/pdd/client-secret'
  | 'union/taobao/app-secret'
  | 'union/jd/app-secret'
  | 'union/dataoke/app-secret';

export const KMS_SECRETS = Object.freeze({
  pay: Object.freeze({
    wechatMerchantPrivateKey: 'pay/wechat/merchant-private-key',
    wechatApiV3Key: 'pay/wechat/apiv3-key',
    wechatPlatformPublicKey: 'pay/wechat/platform-public-key',
    alipayAppPrivateKey: 'pay/alipay/app-private-key',
    alipayPublicKey: 'pay/alipay/public-key',
    alipayAppCert: 'pay/alipay/app-cert',
    alipayPublicCert: 'pay/alipay/public-cert',
    alipayRootCert: 'pay/alipay/root-cert',
  }),
  union: Object.freeze({
    pddClientSecret: 'union/pdd/client-secret',
    taobaoAppSecret: 'union/taobao/app-secret',
    jdAppSecret: 'union/jd/app-secret',
    dataokeAppSecret: 'union/dataoke/app-secret',
  }),
} as const);

const MESSAGES: Readonly<Record<KmsErrorCode, string>> = Object.freeze({
  kms_read_failed: 'the secret cannot be read from KMS',
  secret_invalid: 'the KMS secret is empty or not a valid secret',
});

/** A fixed text and the code: never the SDK's text, a secret value or a `cause`. */
export class KmsError extends Error {
  readonly code: KmsErrorCode;

  constructor(code: KmsErrorCode) {
    super(MESSAGES[code]);
    this.name = 'KmsError';
    this.code = code;
  }
}

export interface KmsAccess {
  readonly keyProvider: KeyProvider;
  readSecret(logicalName: KmsSecretName, maxBytes: number): Promise<string>;
}

/** One call to KMS, loading the client included. */
const CALL_TIMEOUT_MS = 10_000;
const WRAPPED_PREFIX = 'kms1.';
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Rejects after the timeout; the late answer of a call that lost the race is dropped. */
async function withinTimeout<T>(call: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('kms call timed out')), CALL_TIMEOUT_MS);
  });
  try {
    return await Promise.race([call(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function createKmsAccess(appEnv: AppEnv, config: KmsConfig): KmsAccess {
  const context = Object.freeze({ couli_key_id: config.keyId });
  let client: Promise<KmsSdkClient> | undefined;
  const clientOf = (): Promise<KmsSdkClient> => {
    client ??= import('./sdk.ts')
      .then((sdk) => sdk.createKmsSdkClient(config))
      .catch((error: unknown) => {
        // Not kept: the next startup factory may try again.
        client = undefined;
        throw error;
      });
    return client;
  };
  const keyProvider: KeyProvider = Object.freeze({
    keyId: config.keyId,
    async wrapKey(plainKey: Uint8Array): Promise<string> {
      const { ciphertextBlob } = await withinTimeout(async () =>
        (await clientOf()).encrypt({
          keyId: config.keyId,
          plaintext: Buffer.from(plainKey).toString('base64'),
          encryptionContext: { ...context },
        }),
      );
      if (ciphertextBlob === undefined || ciphertextBlob === '') {
        throw new Error('kms encrypt answered no ciphertext');
      }
      return `${WRAPPED_PREFIX}${ciphertextBlob}`;
    },
    async unwrapKey(wrappedKey: string): Promise<Uint8Array> {
      const ciphertextBlob = wrappedKey.startsWith(WRAPPED_PREFIX)
        ? wrappedKey.slice(WRAPPED_PREFIX.length)
        : '';
      if (ciphertextBlob === '') throw new Error('not a key wrapped by this provider');
      const { plaintext } = await withinTimeout(async () =>
        (await clientOf()).decrypt({ ciphertextBlob, encryptionContext: { ...context } }),
      );
      if (plaintext === undefined || plaintext === '' || !BASE64.test(plaintext)) {
        throw new Error('kms decrypt answered no plaintext');
      }
      // Copied out and wiped: a short Buffer.from may land in Node's shared pool.
      const decoded = Buffer.from(plaintext, 'base64');
      const key = new Uint8Array(decoded);
      decoded.fill(0);
      return key;
    },
  });
  return Object.freeze({
    keyProvider,
    async readSecret(logicalName: KmsSecretName, maxBytes: number): Promise<string> {
      let answer: Awaited<ReturnType<KmsSdkClient['getSecretValue']>>;
      try {
        answer = await withinTimeout(async () =>
          (await clientOf()).getSecretValue({ secretName: `couli/${appEnv}/${logicalName}` }),
        );
      } catch {
        throw new KmsError('kms_read_failed');
      }
      if (answer.secretDataType !== 'text' || typeof answer.secretData !== 'string') {
        throw new KmsError('secret_invalid');
      }
      // One line end at most, as ./../config/startup-secret-file.ts.
      let text = answer.secretData;
      if (text.endsWith('\r\n')) text = text.slice(0, -2);
      else if (text.endsWith('\n')) text = text.slice(0, -1);
      if (text === '' || Buffer.byteLength(text, 'utf8') > maxBytes) {
        throw new KmsError('secret_invalid');
      }
      return text;
    },
  });
}

const accesses = new WeakMap<object, KmsAccess>();

/** Null without KMS; the same object for the same config object. */
export function kmsAccessOf(config: {
  readonly appEnv: AppEnv;
  readonly kms?: KmsConfig | null | undefined;
}): KmsAccess | null {
  if (config.kms === null || config.kms === undefined) return null;
  let access = accesses.get(config);
  if (access === undefined) {
    access = createKmsAccess(config.appEnv, config.kms);
    accesses.set(config, access);
  }
  return access;
}

/**
 * A startup secret of a union adapter in prod: a read failure maps to the adapter's kms_unavailable,
 * a bad secret to its secret_invalid.
 */
export async function readStartupKmsSecret(
  kms: KmsAccess,
  logicalName: KmsSecretName,
  maxBytes: number,
  fail: (code: 'kms_unavailable' | 'secret_invalid') => Error,
): Promise<string> {
  try {
    return await kms.readSecret(logicalName, maxBytes);
  } catch (error) {
    throw fail(
      error instanceof KmsError && error.code === 'secret_invalid'
        ? 'secret_invalid'
        : 'kms_unavailable',
    );
  }
}
