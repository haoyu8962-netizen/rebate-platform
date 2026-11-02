// The second field keyring: the independent data keys of the isolated store of prior identities
// (规划/08 BR-ID-25 细则「旧身份留存」:「隔离存储用独立的数据密钥」; 规划/04 §3.2「实名更正旧身份」行:
// 「与 tax_archive 同等保护的隔离存储，独立数据密钥」; ADR-0001 §2 鉴权与密钥、配置校验; 规划/11 §8).
// Contract written by the rule-test author of B1-27e; identity's realname correction (B1-27a)
// only receives the opened second FieldCrypto. The rule tests in
// test/spec/platform/prior-identity-keyring/** call `loadConfig` of ./config.ts, import this file
// by path and start entries through apps/api/src/bootstrap.ts; the variable names, problem texts,
// error codes and messages, the `AppConfig.priorIdentityKeyring` shape and the wiring written here
// are the contract. The main keyring (FIELD_KEY_PROVIDER / FIELD_KEYRING_FILE /
// FIELD_MASTER_KEY_FILE) is specified in ./keyring.ts and ./keyring-startup.ts and does not change.
//
// 1. Variables (read by `loadConfig(env)` of ./config.ts, never from `process.env`; '' counts as
//    unset). Same meaning and formats as the FIELD_* group, for a second, separate keyring:
//
//      PRIOR_IDENTITY_KEY_PROVIDER     `local` | `kms`
//      PRIOR_IDENTITY_KEYRING_FILE     absolute path of the stored keyring (JSON text of a
//                                      `WrappedKeyring`, ../crypto/index.ts)
//      PRIOR_IDENTITY_MASTER_KEY_FILE  absolute path of the local master key file (provider
//                                      `local` only), the format of ./keyring-startup.ts §1
//
//    In local / test either group may be set without the other; in staging / prod both are
//    required (§2). The prior identity master key file may be the same file as
//    FIELD_MASTER_KEY_FILE (only the data keys must differ, §4 g). No .env file names them (the
//    deployment of staging / prod is the owner's).
//
// 2. Which APP_ENV needs it.
//
//      APP_ENV      group unset                           local                kms
//      local, test  allowed: a keyring generated in       allowed              refused
//                   memory is opened (§4 a)
//      staging      refused by loadConfig (§3), like      allowed              allowed (opening
//                   an unset FIELD_KEY_PROVIDER                                refuses, §4 c)
//      prod         as staging                            refused              as staging
//
//    The one exception: when FIELD_KEY_PROVIDER itself is unset in staging / prod, loadConfig
//    reports only that problem of ./keyring.ts §3 and no missing prior identity provider (the other
//    problems of this group, §3, are still listed). A hand-built AppConfig (not from loadConfig)
//    without `priorIdentityKeyring`, or with null, counts as unset and is not refused (§5).
//
// 3. Problems (`ConfigError.problems`). Never a value of any variable. They come right after the
//    FIELD_* keyring problems of ./keyring.ts §3 (before every problem loadConfig lists after
//    those), in the order PRIOR_IDENTITY_KEY_PROVIDER, PRIOR_IDENTITY_KEYRING_FILE,
//    PRIOR_IDENTITY_MASTER_KEY_FILE, at most one per variable, and they are checked whenever
//    APP_ENV itself is valid (also when another variable is invalid). Each text is one line:
//
//      PRIOR_IDENTITY_KEY_PROVIDER
//        unset, APP_ENV staging / prod, `PRIOR_IDENTITY_KEY_PROVIDER: must be set when
//        FIELD_KEY_PROVIDER set (any     APP_ENV=<appEnv>`
//        non-empty value, valid or not)
//        not exactly `local` or `kms`   `PRIOR_IDENTITY_KEY_PROVIDER: must be local or kms`
//        local, APP_ENV prod            `PRIOR_IDENTITY_KEY_PROVIDER: local must not be used when
//                                        APP_ENV=<appEnv> (cloud keys come from KMS)`
//        kms, APP_ENV local / test      `PRIOR_IDENTITY_KEY_PROVIDER: kms must not be used when
//                                        APP_ENV=<appEnv> (local and test never load real keys)`
//        (unset is no problem in local / test, nor while FIELD_KEY_PROVIDER is unset, §2)
//      PRIOR_IDENTITY_KEYRING_FILE
//        provider unset, variable set   `PRIOR_IDENTITY_KEYRING_FILE: must not be set without
//                                        PRIOR_IDENTITY_KEY_PROVIDER`
//        provider local / kms, unset    `PRIOR_IDENTITY_KEYRING_FILE: must be set when
//                                        PRIOR_IDENTITY_KEY_PROVIDER is set`
//        provider local / kms, not an   `PRIOR_IDENTITY_KEYRING_FILE: must be an absolute path`
//        absolute path
//        provider local / kms, exactly  `PRIOR_IDENTITY_KEYRING_FILE: must not be the same file
//        the text of FIELD_KEYRING_FILE  as FIELD_KEYRING_FILE`
//        (paths are compared as given; another spelling of the same file is caught when it is
//        opened, §4 g)
//      PRIOR_IDENTITY_MASTER_KEY_FILE
//        provider unset, variable set   `PRIOR_IDENTITY_MASTER_KEY_FILE: must not be set without
//                                        PRIOR_IDENTITY_KEY_PROVIDER`
//        provider local, unset          `PRIOR_IDENTITY_MASTER_KEY_FILE: must be set when
//                                        PRIOR_IDENTITY_KEY_PROVIDER=local`
//        provider local, not absolute   `PRIOR_IDENTITY_MASTER_KEY_FILE: must be an absolute path`
//        provider kms, variable set     `PRIOR_IDENTITY_MASTER_KEY_FILE: must not be set when
//                                        PRIOR_IDENTITY_KEY_PROVIDER=kms`
//      When the provider is set but not `local` / `kms`, the two file variables are not checked.
//      When it is `local` or `kms`, they are checked even if the provider is refused for this
//      APP_ENV. An absolute path is as in ./keyring.ts §3 (starts with `/`, no U+0000..U+001F,
//      no U+007F).
//
// 4. Result and opening. `AppConfig.priorIdentityKeyring?: PriorIdentityKeyringConfig | null` — an own
//    property of loadConfig's result exactly when PRIOR_IDENTITY_KEY_PROVIDER is set (and valid);
//    absent when the group is unset (local / test), so the documented shape of every existing
//    local / test configuration is unchanged. Same shape as `AppConfig.keyring`, paths kept
//    exactly as given. A hand-built AppConfig without it (or with null) counts as unset, in every
//    APP_ENV. `keyring` does not depend on this group.
//
//    `openPriorIdentityFieldCrypto(appEnv, priorIdentityKeyring, keyring)` (`keyring` is
//    `AppConfig.keyring`), in this order; the first failing step decides:
//      a. priorIdentityKeyring null:
//         APP_ENV local / test   → resolve with a keyring generated for this call only: a random
//                                  32-byte master key in a LocalKeyProvider with key id `local`,
//                                  `createWrappedKeyring`, `openFieldCrypto` (current version 1).
//                                  No file is read, the main keyring is not looked at; every call
//                                  generates new keys (so every process start does)
//         APP_ENV staging / prod → reject `not_configured` (no file is read)
//      b. APP_ENV prod and provider `local`   → reject `local_in_cloud` (no file is read)
//      c. provider `kms` without a KMS access → reject `kms_unavailable` (no file is read, no cloud
//                                               call; the KMS adapter is a later task)
//      d. PRIOR_IDENTITY_MASTER_KEY_FILE, exactly as ./keyring-startup.ts §1 / §3 c:
//         cannot be opened, not a regular file, cannot be read → `master_key_unreadable`;
//         content not 64 lowercase hex characters (+ one optional line feed) → `master_key_invalid`
//      e. PRIOR_IDENTITY_KEYRING_FILE, exactly as ./keyring-startup.ts §2 / §3 d (at most
//         KEYRING_FILE_MAX_BYTES, strict UTF-8 without BOM, JSON, key_id `local`):
//         cannot be opened, not a regular file, cannot be read → `keyring_unreadable`;
//         too large, not UTF-8 JSON, or `openFieldCrypto` rejects with `invalid_keyring` /
//         `invalid_key` → `keyring_invalid`
//      f. `openFieldCrypto` rejects with `key_provider_failed` → `unwrap_failed`
//      g. `keyring` is a local keyring (provider `local`): its two files are read again, the same
//         way and with the same limits as ./keyring-startup.ts §3 c–e, and its data keys
//         unwrapped; when that fails → `main_keyring_unavailable`. When any data key of the prior
//         identity keyring (any version) has the same bytes as any data key of the main keyring
//         (any version) → `shares_main_data_key` (a copied keyring file, the same file under
//         another path, a key imported into both). `keyring` null or `kms`: nothing is compared.
//         The blind-index keys are not compared (§6).
//      h. otherwise resolve with the `FieldCrypto` that `openFieldCrypto` returned for the prior
//         identity keyring — that very object, not a wrapper, not a Proxy.
//    Every rejection is a `PriorIdentityKeyringError`: `name` 'PriorIdentityKeyringError',
//    `code`, `message` exactly the text of its code below, nothing else attached (no `cause`, no
//    own property but stack, message, name and code; the plain stack of that message):
//      not_configured            'the prior identity keyring must be configured when APP_ENV is staging or prod'
//      local_in_cloud            'the local key provider must not be used for the prior identity keyring when APP_ENV is prod'
//      kms_unavailable           'the KMS key provider is not available for the prior identity keyring'
//      master_key_unreadable     'the prior identity master key file cannot be read'
//      master_key_invalid        'the prior identity master key file must hold exactly 64 lowercase hex characters'
//      keyring_unreadable        'the prior identity keyring file cannot be read'
//      keyring_invalid           'the prior identity keyring file is not a valid keyring for this master key'
//      unwrap_failed             'the prior identity keyring does not open with this master key'
//      main_keyring_unavailable  'the field keyring cannot be read to compare it with the prior identity keyring'
//      shares_main_data_key      'the prior identity keyring shares a data key with the field keyring'
//    It writes nothing (no console, no process.stdout / stderr, no logger, no warnings), keeps no
//    path, file content, key or underlying error in what it throws, and zeroes the key bytes and
//    file bytes it read once they are no longer needed (as ./keyring-startup.ts §6).
//
// 5. Wiring (platform.module.ts, ./index.ts; also in this task)
//    - Token: `PRIOR_IDENTITY_FIELD_CRYPTO = Symbol('PRIOR_IDENTITY_FIELD_CRYPTO')`, declared in
//      this file and exported from ./index.ts (so platform/index.ts exports it through
//      `export * from './config/index.ts'`). Other modules inject it as
//      `@Inject(PRIOR_IDENTITY_FIELD_CRYPTO) priorIdentityCrypto: FieldCrypto`.
//    - `PlatformModule.forRoot(options)` provides AND exports it exactly when
//      `options.config.priorIdentityKeyring` is set, or when `options.config.appEnv` is `local` /
//      `test` (then generated, §4 a); with an async factory that awaits
//      `openPriorIdentityFieldCrypto(appEnv, priorIdentityKeyring ?? null, keyring)`. In staging /
//      prod without the group (only a hand-built AppConfig gets there, §2) it is not provided at
//      all and nothing fails: asking for it fails, a provider that injects it cannot be created.
//      Whether `dbHandles` is given changes nothing.
//    - When FIELD_CRYPTO is provided too, the main keyring opens first: if it fails, the entry
//      fails with its `KeyringStartupError` (the factory injects FIELD_CRYPTO).
//    - Timing, sources and objects as ./keyring-startup.ts §4: a failure rejects `createHttpApp`
//      / `createWorkerContext` themselves with the `PriorIdentityKeyringError`; afterwards the
//      files are not read again; every injection gets the same object, never the FIELD_CRYPTO
//      object; the source is `options.config` only, never `process.env`; all five entries alike.
//    - platform/index.ts does NOT export `openPriorIdentityFieldCrypto`,
//      `readPriorIdentityKeyringConfig` or `PriorIdentityKeyringError`.
//
// 6. What the second cipher is for (B1-27a, not tested here). Only the prior identity's name and
//    id number ciphertexts are written with it, under contexts that start with `prior_identity.`
//    (never the contexts of the realname columns, so the two kinds of ciphertext can never be
//    swapped). The prior `id_no_hmac` is copied as it is: the blind index stays that of
//    FIELD_CRYPTO and is never recomputed with this cipher.
//
// Rules for the implementation: as ./keyring-startup.ts (erasable syntax only, `import type` for
// type-only imports, relative imports with `.ts`, no NestJS, no `process.env`, no logging; at run
// time only `node:` modules, ../crypto/index.ts and ./keyring-startup.ts). Key material in test
// files is generated by code (never a literal).
import { randomFillSync, timingSafeEqual } from 'node:crypto';
import {
  FieldCryptoError,
  LocalKeyProvider,
  createWrappedKeyring,
  openFieldCrypto,
  type FieldCrypto,
  type WrappedKeyring,
} from '../crypto/index.ts';
import type { KeyProvider } from '../crypto/index.ts';
import type { KmsAccess } from '../kms/index.ts';
import type { AppEnv } from './app-env.ts';
import type { KeyringConfig } from './keyring.ts';
import {
  KEYRING_FILE_MAX_BYTES,
  KeyringStartupError,
  LOCAL_MASTER_KEY_ID,
  readBoundedFile,
  readLocalKeyProvider,
} from './keyring-startup.ts';

/** Injection token of the opened prior identity cipher (§5). */
export const PRIOR_IDENTITY_FIELD_CRYPTO = Symbol('PRIOR_IDENTITY_FIELD_CRYPTO');

/** `AppConfig.priorIdentityKeyring` when the group is set (§4): the shape of `AppConfig.keyring`. */
export type PriorIdentityKeyringConfig = KeyringConfig;

export type PriorIdentityKeyringErrorCode =
  | 'not_configured'
  | 'local_in_cloud'
  | 'kms_unavailable'
  | 'master_key_unreadable'
  | 'master_key_invalid'
  | 'keyring_unreadable'
  | 'keyring_invalid'
  | 'unwrap_failed'
  | 'main_keyring_unavailable'
  | 'shares_main_data_key';

/** The one message of each code (§4). */
export const PRIOR_IDENTITY_KEYRING_MESSAGES: Readonly<
  Record<PriorIdentityKeyringErrorCode, string>
> = Object.freeze({
  not_configured: 'the prior identity keyring must be configured when APP_ENV is staging or prod',
  local_in_cloud:
    'the local key provider must not be used for the prior identity keyring when APP_ENV is prod',
  kms_unavailable: 'the KMS key provider is not available for the prior identity keyring',
  master_key_unreadable: 'the prior identity master key file cannot be read',
  master_key_invalid:
    'the prior identity master key file must hold exactly 64 lowercase hex characters',
  keyring_unreadable: 'the prior identity keyring file cannot be read',
  keyring_invalid: 'the prior identity keyring file is not a valid keyring for this master key',
  unwrap_failed: 'the prior identity keyring does not open with this master key',
  main_keyring_unavailable:
    'the field keyring cannot be read to compare it with the prior identity keyring',
  shares_main_data_key: 'the prior identity keyring shares a data key with the field keyring',
});

/** Every rejection of `openPriorIdentityFieldCrypto` (§4). */
export class PriorIdentityKeyringError extends Error {
  readonly code: PriorIdentityKeyringErrorCode;

  constructor(code: PriorIdentityKeyringErrorCode) {
    super(PRIOR_IDENTITY_KEYRING_MESSAGES[code]);
    this.name = 'PriorIdentityKeyringError';
    this.code = code;
  }
}

const PROVIDER = 'PRIOR_IDENTITY_KEY_PROVIDER';
const KEYRING_FILE = 'PRIOR_IDENTITY_KEYRING_FILE';
const MASTER_KEY_FILE = 'PRIOR_IDENTITY_MASTER_KEY_FILE';

/** §3: starts with `/`, no U+0000..U+001F, no U+007F (as ./keyring.ts, without zod at run time). */
function isAbsolutePath(path: string): boolean {
  if (!path.startsWith('/')) return false;
  for (let index = 0; index < path.length; index += 1) {
    const code = path.charCodeAt(index);
    if (code <= 31 || code === 127) return false;
  }
  return true;
}

/**
 * The prior identity part of `loadConfig`: the `priorIdentityKeyring` value (null when the group
 * is unset; meaningful only when `problems` is empty) and the problems of §3, in order. Reads only
 * the three PRIOR_IDENTITY_* names, FIELD_KEY_PROVIDER, FIELD_KEYRING_FILE and APP_ENV's already
 * validated value.
 */
export function readPriorIdentityKeyringConfig(
  appEnv: AppEnv,
  env: Readonly<Record<string, string | undefined>>,
): {
  readonly priorIdentityKeyring: PriorIdentityKeyringConfig | null;
  readonly problems: readonly string[];
} {
  const provider = env[PROVIDER] ?? '';
  const keyringFile = env[KEYRING_FILE] ?? '';
  const masterKeyFile = env[MASTER_KEY_FILE] ?? '';
  const fieldProvider = env['FIELD_KEY_PROVIDER'] ?? '';
  const fieldKeyringFile = env['FIELD_KEYRING_FILE'] ?? '';
  const cloud = appEnv === 'staging' || appEnv === 'prod';
  const problems: string[] = [];

  if (provider === '') {
    // While FIELD_KEY_PROVIDER itself is unset, its own problem is the one reported (§2).
    if (cloud && fieldProvider !== '') {
      problems.push(`${PROVIDER}: must be set when APP_ENV=${appEnv}`);
    }
    if (keyringFile !== '') problems.push(`${KEYRING_FILE}: must not be set without ${PROVIDER}`);
    if (masterKeyFile !== '') {
      problems.push(`${MASTER_KEY_FILE}: must not be set without ${PROVIDER}`);
    }
    return { priorIdentityKeyring: null, problems };
  }
  if (provider !== 'local' && provider !== 'kms') {
    return { priorIdentityKeyring: null, problems: [`${PROVIDER}: must be local or kms`] };
  }
  if (provider === 'local' && appEnv === 'prod') {
    problems.push(
      `${PROVIDER}: local must not be used when APP_ENV=${appEnv} (cloud keys come from KMS)`,
    );
  } else if (provider === 'kms' && !cloud) {
    problems.push(
      `${PROVIDER}: kms must not be used when APP_ENV=${appEnv} (local and test never load real keys)`,
    );
  }
  if (keyringFile === '') {
    problems.push(`${KEYRING_FILE}: must be set when ${PROVIDER} is set`);
  } else if (!isAbsolutePath(keyringFile)) {
    problems.push(`${KEYRING_FILE}: must be an absolute path`);
  } else if (keyringFile === fieldKeyringFile) {
    problems.push(`${KEYRING_FILE}: must not be the same file as FIELD_KEYRING_FILE`);
  }
  if (provider === 'local') {
    if (masterKeyFile === '') {
      problems.push(`${MASTER_KEY_FILE}: must be set when ${PROVIDER}=local`);
    } else if (!isAbsolutePath(masterKeyFile)) {
      problems.push(`${MASTER_KEY_FILE}: must be an absolute path`);
    }
  } else if (masterKeyFile !== '') {
    problems.push(`${MASTER_KEY_FILE}: must not be set when ${PROVIDER}=kms`);
  }
  return {
    priorIdentityKeyring:
      provider === 'local'
        ? { provider, keyringFile, masterKeyFile }
        : { provider: 'kms', keyringFile },
    problems,
  };
}

/** Opens the prior identity keyring (§4). Called by the factory of PlatformModule (§5). */
export async function openPriorIdentityFieldCrypto(
  appEnv: AppEnv,
  priorIdentityKeyring: PriorIdentityKeyringConfig | null,
  keyring: KeyringConfig | null,
  kms?: KmsAccess | null,
): Promise<FieldCrypto> {
  if (priorIdentityKeyring === null) {
    if (appEnv === 'staging' || appEnv === 'prod') {
      throw new PriorIdentityKeyringError('not_configured');
    }
    return await openGenerated();
  }
  if (appEnv === 'prod' && priorIdentityKeyring.provider === 'local') {
    throw new PriorIdentityKeyringError('local_in_cloud');
  }
  let provider: KeyProvider;
  if (priorIdentityKeyring.provider === 'kms') {
    if (kms === null || kms === undefined) throw new PriorIdentityKeyringError('kms_unavailable');
    provider = kms.keyProvider;
  } else {
    provider = await readMasterKey(priorIdentityKeyring.masterKeyFile);
  }
  const document = await readKeyringDocument(priorIdentityKeyring.keyringFile);
  let fieldCrypto: FieldCrypto;
  try {
    fieldCrypto = await openFieldCrypto(document, provider);
  } catch (error) {
    throw new PriorIdentityKeyringError(
      error instanceof FieldCryptoError && error.code === 'key_provider_failed'
        ? 'unwrap_failed'
        : 'keyring_invalid',
    );
  }
  // B1-30a: the check holds under KMS too, where prod needs it; without a KMS access a kms main keyring
  // has already refused to open.
  if (keyring !== null && (keyring.provider === 'local' || (kms !== null && kms !== undefined))) {
    await refuseSharedDataKeys(document, provider, keyring, kms ?? null);
  }
  return fieldCrypto;
}

/** §4 a: a keyring that lives only for this call (local / test without the group). */
async function openGenerated(): Promise<FieldCrypto> {
  const masterKey = Buffer.alloc(32);
  let provider: LocalKeyProvider;
  try {
    randomFillSync(masterKey);
    provider = new LocalKeyProvider(masterKey, LOCAL_MASTER_KEY_ID);
  } finally {
    masterKey.fill(0);
  }
  return await openFieldCrypto(await createWrappedKeyring(provider), provider);
}

/** §4 d. */
async function readMasterKey(masterKeyFile: string): Promise<LocalKeyProvider> {
  try {
    return await readLocalKeyProvider(masterKeyFile);
  } catch (error) {
    throw new PriorIdentityKeyringError(
      error instanceof KeyringStartupError && error.code === 'master_key_invalid'
        ? 'master_key_invalid'
        : 'master_key_unreadable',
    );
  }
}

/** §4 e (reading and parsing; the document itself is checked by `openFieldCrypto`). */
async function readKeyringDocument(keyringFile: string): Promise<WrappedKeyring> {
  let bytes: Buffer;
  try {
    bytes = await readBoundedFile(
      keyringFile,
      KEYRING_FILE_MAX_BYTES,
      'keyring_unreadable',
      'keyring_invalid',
    );
  } catch (error) {
    throw new PriorIdentityKeyringError(
      error instanceof KeyringStartupError && error.code === 'keyring_invalid'
        ? 'keyring_invalid'
        : 'keyring_unreadable',
    );
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return JSON.parse(text) as WrappedKeyring;
  } catch {
    throw new PriorIdentityKeyringError('keyring_invalid');
  } finally {
    bytes.fill(0);
  }
}

/**
 * §4 g: reads the main local keyring again and refuses when any data key of the prior identity
 * keyring equals any data key of it. Blind-index keys are not compared.
 */
async function refuseSharedDataKeys(
  priorDocument: WrappedKeyring,
  priorProvider: KeyProvider,
  keyring: KeyringConfig,
  kms: KmsAccess | null,
): Promise<void> {
  const priorKeys: Uint8Array[] = [];
  const mainKeys: Uint8Array[] = [];
  try {
    try {
      priorKeys.push(...(await unwrapDataKeys(priorDocument, priorProvider)));
    } catch {
      // openFieldCrypto has just unwrapped the same entries with the same provider.
      throw new PriorIdentityKeyringError('unwrap_failed');
    }
    try {
      const mainProvider: KeyProvider =
        keyring.provider === 'local'
          ? await readLocalKeyProvider(keyring.masterKeyFile)
          : (kms as KmsAccess).keyProvider;
      const bytes = await readBoundedFile(
        keyring.keyringFile,
        KEYRING_FILE_MAX_BYTES,
        'keyring_unreadable',
        'keyring_invalid',
      );
      let mainDocument: WrappedKeyring;
      try {
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        mainDocument = JSON.parse(text) as WrappedKeyring;
      } finally {
        bytes.fill(0);
      }
      // Validates the document exactly as at startup; the cipher itself is not kept.
      await openFieldCrypto(mainDocument, mainProvider);
      mainKeys.push(...(await unwrapDataKeys(mainDocument, mainProvider)));
    } catch {
      throw new PriorIdentityKeyringError('main_keyring_unavailable');
    }
    for (const prior of priorKeys) {
      for (const main of mainKeys) {
        if (prior.byteLength === main.byteLength && timingSafeEqual(prior, main)) {
          throw new PriorIdentityKeyringError('shares_main_data_key');
        }
      }
    }
  } finally {
    for (const key of [...priorKeys, ...mainKeys]) key.fill(0);
  }
}

/** The plain data keys of a document already validated by `openFieldCrypto`. */
async function unwrapDataKeys(
  document: WrappedKeyring,
  provider: KeyProvider,
): Promise<Uint8Array[]> {
  const keys: Uint8Array[] = [];
  try {
    for (const entry of document.data_keys) keys.push(await provider.unwrapKey(entry.wrapped));
    return keys;
  } catch (error) {
    for (const key of keys) key.fill(0);
    throw error;
  }
}
