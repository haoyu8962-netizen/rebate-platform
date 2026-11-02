// Opening the field-encryption keyring when a process entry starts, and handing the opened
// `FieldCrypto` to the other modules (规划/08 BR-ID-33; ADR-0001 §2 鉴权与密钥: 自有 KeyProvider 接口，
// 本地用文件密钥实现，云上用 KMS 实现; 规划/02 §12.3, §12.6「数据加密主密钥 | KMS | 通过信封加密间接使用」;
// 规划/11 §8「真实密钥被本地栈加载」). Contract written by the rule-test author, implemented by B1-01k.
// The rule tests in
// test/spec/platform/crypto/wiring-*.test.ts import this file by path and start entries through
// `createHttpApp` / `createWorkerContext` of apps/api/src/bootstrap.ts; the names, signatures,
// formats, error texts and the wiring written here are the contract. The variables and
// `AppConfig.keyring` are specified in ./keyring.ts. Choices that no document fixes are
// marked 待编排会话确认 (the suggested default is what is written).
//
// 1. Local master key file (FIELD_MASTER_KEY_FILE)
//    - A regular file (a symbolic link to one is fine) whose whole content is exactly 64
//      lowercase hex characters (0-9 a-f), optionally followed by ONE line feed (0x0a): the 32
//      bytes of the master key. Nothing else is accepted: no upper case, no `\r`, no space, no
//      second line feed, no other length. (`openssl rand -hex 32 > file` writes such a file.)
//    - The provider is `new LocalKeyProvider(masterKey, LOCAL_MASTER_KEY_ID)`, so the keyring's
//      `key_id` must be `local`. 待编排会话确认: the fixed key id `local`.
//
// 2. Keyring file (FIELD_KEYRING_FILE)
//    - A regular file (a symbolic link to one is fine) of at most KEYRING_FILE_MAX_BYTES bytes,
//      whose content is the UTF-8 JSON text of a `WrappedKeyring` (../crypto/index.ts): bytes that are not
//      UTF-8 and a leading byte order mark are refused (decode with `fatal: true` and
//      `ignoreBOM: true`, then JSON.parse). Whitespace around the JSON value is allowed (JSON.parse);
//      properties the document does not use are ignored, as `openFieldCrypto` ignores them.
//
// 3. `openConfiguredFieldCrypto(appEnv, keyring)`, in this order; the first failing step decides:
//      a. appEnv `prod` and provider `local`      → reject `local_in_cloud` (no file is read: a
//                                                    hand-built AppConfig that skipped loadConfig
//                                                    still cannot start prod on a local key).
//                                                    staging opens the local provider like local /
//                                                    test (规划仓库 docs/adr/0003, 负责人 2026-10-07)
//      b. provider `kms` without a KMS access     → reject `kms_unavailable` (no file is read, no
//                                                    cloud call is made or faked). With one (B1-30a,
//                                                    KMS_* configured) step c is skipped: the master
//                                                    key stays in KMS, the keyring file is read as in
//                                                    step d and opened with its key provider
//      c. master key file: cannot be opened, is not a regular file (a directory, /dev/null, …)
//         or cannot be read                       → `master_key_unreadable`
//         content not as in §1                    → `master_key_invalid`
//      d. keyring file: cannot be opened, is not a regular file or cannot be read
//                                                 → `keyring_unreadable`
//         more than KEYRING_FILE_MAX_BYTES bytes, not UTF-8 JSON, or `openFieldCrypto` rejects
//         with `invalid_keyring` / `invalid_key` (shape, versions, `key_id` other than `local`)
//                                                 → `keyring_invalid`
//      e. `openFieldCrypto` rejects with `key_provider_failed` (a wrapped key does not
//         authenticate: another master key, an altered wrapped key)
//                                                 → `unwrap_failed`
//      f. otherwise resolve with the `FieldCrypto` that `openFieldCrypto` returned — that very
//         object, not a wrapper, not a Proxy.
//    A file is never read in a way that waits for more data than the limits above (the master
//    key file needs at most 65 bytes; a longer file is `master_key_invalid` without reading on).
//    Every rejection is a `KeyringStartupError` (below). Nothing of the underlying error is kept:
//    file-system errors quote the path, JSON.parse errors quote the file content, and a provider
//    error may quote a key.
//
// 4. Wiring (platform.module.ts, platform/index.ts; also in this task)
//    - Token: `FIELD_CRYPTO = Symbol('FIELD_CRYPTO')`, declared next to the other tokens in
//      platform.module.ts and exported from platform/index.ts. Other modules inject it as
//      `@Inject(FIELD_CRYPTO) fieldCrypto: FieldCrypto`.
//    - `PlatformModule.forRoot(options)` provides AND exports FIELD_CRYPTO exactly when
//      `options.config.keyring !== null`, with an async factory that awaits
//      `openConfiguredFieldCrypto(options.config.appEnv, options.config.keyring)`. Whether
//      `dbHandles` is given changes nothing. When `keyring` is null the token is not provided at
//      all (asking the application for it fails; no placeholder, no lazily opened instance).
//      Exported means: a module of another feature, imported next to PlatformModule, gets it
//      through `inject: [FIELD_CRYPTO]` / `@Inject(FIELD_CRYPTO)` (the rule tests build such a
//      consumer module), not only `app.get(FIELD_CRYPTO)`.
//    - Timing: Nest awaits the factory while it creates the providers, so a failure rejects
//      `createHttpApp` / `createWorkerContext` themselves (for HTTP entries before `app.init()`),
//      with the `KeyringStartupError` itself (the entry runner then logs `startup_failed` and
//      exits 1). Not in `onModuleInit`, `onApplicationBootstrap` or on first use. Once they have
//      resolved, the injected FieldCrypto is open: the files are not read again (changing or
//      deleting them afterwards changes nothing), and every injection gets the same object.
//    - The keyring source is `options.config` only (loadConfig in the entry runner, or the
//      `config` override of bootstrap); never `process.env`.
//    - Same rule for all five entries (api, stream, admin, worker, payout).
//
// 5. What platform/index.ts exports (besides what it exports today; other tasks add more)
//    - from ../crypto/index.ts: `FieldCryptoError`, `FIELD_CRYPTO_MESSAGES`, and the types `FieldCrypto`,
//      `FieldCryptoErrorCode`; plus the token `FIELD_CRYPTO`.
//    - from ../http/index.ts: everything (`export * from './http/index.ts'`): `GovernanceError`,
//      `systemScheduler`, `unionPolicy`, `quotaShares`, `createMemoryQuotaLimiter`,
//      `createGovernor` and the types.
//    - NOT exported (only the platform module opens or rewrites keyrings): `LocalKeyProvider`,
//      `createWrappedKeyring`, `rotateDataKey`, `openFieldCrypto`, `openConfiguredFieldCrypto`,
//      `readKeyringConfig`.
//
// 6. Key material never leaves memory
//    - Errors: exactly as described at `KeyringStartupError`; never the path, the file content,
//      a key, a ciphertext or the underlying error.
//    - Logs: opening logs nothing that holds a path, a file's content or key bytes in any
//      encoding; this holds for every line written while an entry starts or fails to start.
//      `openConfiguredFieldCrypto` itself writes nothing at all: no console, no
//      process.stdout / stderr, no logger of its own, no warnings (the rule tests run it in a
//      plain `node` process and require stdout to be exactly their reply and stderr empty, with
//      synthetic phone numbers, id numbers and key markers inside the files it reads).
//    - Objects: the injected FieldCrypto is the object of `openFieldCrypto` (its shape is the
//      contract of ../crypto/index.ts: exactly `currentKeyVersion` = the keyring's
//      `current_version` and the six methods, each working, `reencrypt` included);
//      `AppConfig` holds only the provider name and the two paths.
//    - Memory: decode the master key into an unpooled buffer (`Buffer.alloc(32)` then fill it;
//      never `Buffer.from(text, 'hex')`, which may land in Node's shared 8 KiB pool), and zero
//      that buffer and the bytes read from the file once the provider has been built.
//
// Rules for the implementation: this file lives in config/, not in crypto/, because the crypto
// directory may import only `node:crypto` and its own files (rule test
// test/spec/platform/crypto/randomness.test.ts). This directory is also compiled by the `test`
// project — erasable syntax only (no parameter properties, no enum, no namespace, no decorators),
// `import type` for type-only imports, relative imports with the `.ts` extension, no NestJS in
// this file, no `process.env`, no logging. Only `node:` modules and files of the platform module
// (`LocalKeyProvider`, `openFieldCrypto`, `FieldCryptoError` of ../crypto/index.ts). The rule
// tests also run this file in a plain `node --conditions=couli-src` process (Node's own type
// stripping, no bundler): at run time it may import only `node:` modules and ../crypto/index.ts;
// anything from ./config.ts or ./keyring.ts is imported with `import type`.
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import {
  FieldCryptoError,
  LocalKeyProvider,
  openFieldCrypto,
  type FieldCrypto,
  type KeyProvider,
  type WrappedKeyring,
} from '../crypto/index.ts';
import type { AppEnv } from './app-env.ts';
import type { KeyringConfig } from './keyring.ts';
import type { KmsAccess } from '../kms/index.ts';

/** `keyId` of the LocalKeyProvider built from FIELD_MASTER_KEY_FILE (§1). */
export const LOCAL_MASTER_KEY_ID = 'local';

/** Largest keyring file accepted (§2): 1 MiB. */
export const KEYRING_FILE_MAX_BYTES = 1_048_576;

export type KeyringStartupErrorCode =
  | 'local_in_cloud'
  | 'kms_unavailable'
  | 'master_key_unreadable'
  | 'master_key_invalid'
  | 'keyring_unreadable'
  | 'keyring_invalid'
  | 'unwrap_failed';

/** The one message of each code (the rule tests keep their own copy of this table). */
export const KEYRING_STARTUP_MESSAGES: Readonly<Record<KeyringStartupErrorCode, string>> =
  Object.freeze({
    local_in_cloud: 'the local key provider must not be used when APP_ENV is prod',
    kms_unavailable: 'the KMS key provider is not available',
    master_key_unreadable: 'the master key file cannot be read',
    master_key_invalid: 'the master key file must hold exactly 64 lowercase hex characters',
    keyring_unreadable: 'the keyring file cannot be read',
    keyring_invalid: 'the keyring file is not a valid keyring for this master key',
    unwrap_failed: 'the keyring does not open with this master key',
  });

/**
 * Every rejection of `openConfiguredFieldCrypto`: `name` is 'KeyringStartupError', `code` one of
 * `KeyringStartupErrorCode`, `message` exactly the text of its code in
 * `KEYRING_STARTUP_MESSAGES`. Nothing else is attached (no `cause`, no other own property than
 * stack, message, name and code); the stack is the plain stack of that message.
 */
export class KeyringStartupError extends Error {
  readonly code: KeyringStartupErrorCode;

  constructor(code: KeyringStartupErrorCode) {
    super(KEYRING_STARTUP_MESSAGES[code]);
    this.name = 'KeyringStartupError';
    this.code = code;
  }
}

/**
 * Opens the configured keyring (§3). Called by the FIELD_CRYPTO factory of PlatformModule while
 * Nest creates the providers.
 */
export async function openConfiguredFieldCrypto(
  appEnv: AppEnv,
  keyring: KeyringConfig,
  kms?: KmsAccess | null,
): Promise<FieldCrypto> {
  if (appEnv === 'prod' && keyring.provider === 'local') {
    throw new KeyringStartupError('local_in_cloud');
  }
  let provider: KeyProvider;
  if (keyring.provider === 'kms') {
    if (kms === null || kms === undefined) throw new KeyringStartupError('kms_unavailable');
    provider = kms.keyProvider;
  } else {
    provider = await readLocalKeyProvider(keyring.masterKeyFile);
  }
  const keyringBytes = await readBoundedFile(
    keyring.keyringFile,
    KEYRING_FILE_MAX_BYTES,
    'keyring_unreadable',
    'keyring_invalid',
  );
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(keyringBytes);
    const document = JSON.parse(text) as WrappedKeyring;
    return await openFieldCrypto(document, provider);
  } catch (error) {
    throw new KeyringStartupError(
      error instanceof FieldCryptoError && error.code === 'key_provider_failed'
        ? 'unwrap_failed'
        : 'keyring_invalid',
    );
  } finally {
    keyringBytes.fill(0);
  }
}

/**
 * Step c of §3: reads the master key file (§1) and builds the LocalKeyProvider with key id
 * `local`. Rejects with `master_key_unreadable` / `master_key_invalid` only. Also used by
 * apps/api/scripts/keyring-init.ts, so both accept exactly the same master key files.
 */
export async function readLocalKeyProvider(masterKeyFile: string): Promise<LocalKeyProvider> {
  const bytes = await readBoundedFile(
    masterKeyFile,
    65,
    'master_key_unreadable',
    'master_key_invalid',
  );
  const masterKey = Buffer.alloc(32);
  let provider: LocalKeyProvider;
  try {
    if (bytes.length !== 64 && !(bytes.length === 65 && bytes[64] === 10)) {
      throw new KeyringStartupError('master_key_invalid');
    }
    // Decode bytes directly: no immutable string or pooled copy of the master key.
    for (const [index, byte] of bytes.subarray(0, 64).entries()) {
      const nibble =
        byte >= 48 && byte <= 57 ? byte - 48 : byte >= 97 && byte <= 102 ? byte - 87 : -1;
      if (nibble === -1) throw new KeyringStartupError('master_key_invalid');
      const position = index >> 1;
      masterKey[position] = (masterKey[position] ?? 0) * 16 + nibble;
    }
    provider = new LocalKeyProvider(masterKey, LOCAL_MASTER_KEY_ID);
  } finally {
    masterKey.fill(0);
    bytes.fill(0);
  }
  return provider;
}

/**
 * Check and read the same descriptor; nonblocking open also rejects FIFOs without waiting. Also
 * used by ./keyring-prior-identity.ts, so both keyrings accept exactly the same files.
 */
export async function readBoundedFile(
  path: string,
  limit: number,
  unreadable: KeyringStartupErrorCode,
  invalid: KeyringStartupErrorCode,
): Promise<Buffer> {
  let buffer: Buffer | undefined;
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new KeyringStartupError(unreadable);
      if (stat.size > limit) throw new KeyringStartupError(invalid);
      buffer = Buffer.alloc(limit);
      let offset = 0;
      while (offset < limit) {
        const { bytesRead } = await file.read(buffer, offset, limit - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      // A file growing during the read must not turn a valid prefix into accepted content.
      if ((await file.stat()).size > limit) throw new KeyringStartupError(invalid);
      return buffer.subarray(0, offset);
    } finally {
      await file.close();
    }
  } catch (error) {
    buffer?.fill(0);
    throw new KeyringStartupError(error instanceof KeyringStartupError ? error.code : unreadable);
  }
}
