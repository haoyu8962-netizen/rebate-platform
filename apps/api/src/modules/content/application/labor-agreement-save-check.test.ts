import { expect, it } from 'vitest';
import { bridgeOriginsSaveCheck } from './bridge-origins-save-check.ts';
import { combineConfigItemSaveChecks } from './config-item-admin.ts';
import { DEFAULT_AVATAR_URL_KEY, defaultAvatarSaveCheck } from './default-avatar-save-check.ts';
import {
  LABOR_AGREEMENT_SAVE_KEYS,
  LABOR_RESIGN_FROM_VERSION_KEY,
  LABOR_TEXT_SHA256_KEY,
  LABOR_TEXT_URL_KEY,
  LABOR_VERSION_KEY,
  OPERATOR_CREDIT_CODE_KEY,
  OPERATOR_NAME_KEY,
  laborAgreementSaveCheck,
} from './labor-agreement-save-check.ts';

const NONE = new Map<string, unknown>();
const one = (key: string, value: unknown) => new Map<string, unknown>([[key, value]]);
const SHA = 'a'.repeat(64);
/** Low-entropy samples (no secret-looking literals next to *_KEY names). */
const CREDIT = '9'.repeat(17) + 'X';

it('[AC-B2-03x#1] reads and checks exactly the six labor agreement keys, in registry order', () => {
  expect(laborAgreementSaveCheck().keys).toStrictEqual([
    'legal.labor_agreement.version',
    'legal.labor_agreement.text_url',
    'legal.labor_agreement.text_sha256',
    'legal.labor_agreement.resign_from_version',
    'legal.operator_entity.name',
    'legal.operator_entity.credit_code',
  ]);
  expect(LABOR_AGREEMENT_SAVE_KEYS).toStrictEqual(laborAgreementSaveCheck().keys);
});

const GOOD: ReadonlyArray<readonly [string, unknown]> = [
  [LABOR_VERSION_KEY, 1],
  [LABOR_VERSION_KEY, 2_147_483_647],
  [LABOR_TEXT_URL_KEY, 'https://cdn.example.com/labor/v3.html'],
  [LABOR_TEXT_URL_KEY, 'http://cdn.example.com/labor'],
  [LABOR_TEXT_SHA256_KEY, SHA],
  [LABOR_TEXT_SHA256_KEY, 'ab'.repeat(32)],
  [LABOR_RESIGN_FROM_VERSION_KEY, 1],
  [OPERATOR_NAME_KEY, '某某科技有限公司'],
  [OPERATOR_NAME_KEY, '名'.repeat(200)],
  [OPERATOR_CREDIT_CODE_KEY, CREDIT],
  [OPERATOR_CREDIT_CODE_KEY, '91'.repeat(9)],
];

it.each(GOOD)('[AC-B2-03x#2] %s = %j is let through', (key, value) => {
  expect(laborAgreementSaveCheck().refusals(NONE, one(key, value))).toStrictEqual([]);
});

const BAD: ReadonlyArray<readonly [string, string, unknown]> = [
  [LABOR_VERSION_KEY, 'zero', 0],
  [LABOR_VERSION_KEY, 'negative', -1],
  [LABOR_VERSION_KEY, 'fraction', 1.5],
  [LABOR_VERSION_KEY, 'above int32', 2_147_483_648],
  [LABOR_VERSION_KEY, 'numeric string', '1'],
  [LABOR_VERSION_KEY, 'null', null],
  [LABOR_TEXT_URL_KEY, 'relative path', '/labor.html'],
  [LABOR_TEXT_URL_KEY, 'ftp', 'ftp://cdn.example.com/labor'],
  [LABOR_TEXT_URL_KEY, 'surrounding space', ' https://cdn.example.com/labor'],
  [LABOR_TEXT_URL_KEY, 'empty', ''],
  [LABOR_TEXT_URL_KEY, 'number', 1],
  [LABOR_TEXT_SHA256_KEY, 'upper case', 'A'.repeat(64)],
  [LABOR_TEXT_SHA256_KEY, '63 characters', 'a'.repeat(63)],
  [LABOR_TEXT_SHA256_KEY, '65 characters', 'a'.repeat(65)],
  [LABOR_TEXT_SHA256_KEY, 'not hex', 'g'.repeat(64)],
  [LABOR_TEXT_SHA256_KEY, 'object', { sha256: SHA }],
  [LABOR_RESIGN_FROM_VERSION_KEY, 'zero', 0],
  [LABOR_RESIGN_FROM_VERSION_KEY, 'fraction', 2.5],
  [LABOR_RESIGN_FROM_VERSION_KEY, 'string', '2'],
  [OPERATOR_NAME_KEY, 'empty', ''],
  [OPERATOR_NAME_KEY, 'blank', '   '],
  [OPERATOR_NAME_KEY, 'surrounding space', ' 某某科技 '],
  [OPERATOR_NAME_KEY, '201 characters', '名'.repeat(201)],
  [OPERATOR_NAME_KEY, 'number', 1],
  [OPERATOR_CREDIT_CODE_KEY, '17 characters', '9'.repeat(17)],
  [OPERATOR_CREDIT_CODE_KEY, 'lower case', '9'.repeat(17) + 'x'],
  [OPERATOR_CREDIT_CODE_KEY, 'letter I', '9'.repeat(17) + 'I'],
  [OPERATOR_CREDIT_CODE_KEY, 'letter O', '9'.repeat(17) + 'O'],
  [OPERATOR_CREDIT_CODE_KEY, 'number', 911100001],
];

it.each(BAD)('[AC-B2-03x#3] %s (%s) is refused with that key', (key, _label, value) => {
  expect(laborAgreementSaveCheck().refusals(NONE, one(key, value))).toStrictEqual([key]);
});

it('[AC-B2-03x#4] resign_from_version above version in the same write is refused on resign_from_version', () => {
  const check = laborAgreementSaveCheck();
  const write = (version: unknown, resign: unknown) =>
    new Map<string, unknown>([
      [LABOR_VERSION_KEY, version],
      [LABOR_RESIGN_FROM_VERSION_KEY, resign],
    ]);
  expect(check.refusals(NONE, write(2, 3))).toStrictEqual([LABOR_RESIGN_FROM_VERSION_KEY]);
  expect(check.refusals(NONE, write(3, 3))).toStrictEqual([]);
  expect(check.refusals(NONE, write(3, 1))).toStrictEqual([]);
  // The same write wins over the stored rows on both sides.
  const stored = new Map<string, unknown>([
    [LABOR_VERSION_KEY, 9],
    [LABOR_RESIGN_FROM_VERSION_KEY, 1],
  ]);
  expect(check.refusals(stored, write(2, 3))).toStrictEqual([LABOR_RESIGN_FROM_VERSION_KEY]);
  expect(check.refusals(stored, write(5, 5))).toStrictEqual([]);
});

it('[AC-B2-03x#5] against the stored row: a resign_from_version above stored version, or a version below stored resign_from_version, is refused on the written key', () => {
  const check = laborAgreementSaveCheck();
  const storedVersion = one(LABOR_VERSION_KEY, 3);
  expect(check.refusals(storedVersion, one(LABOR_RESIGN_FROM_VERSION_KEY, 4))).toStrictEqual([
    LABOR_RESIGN_FROM_VERSION_KEY,
  ]);
  expect(check.refusals(storedVersion, one(LABOR_RESIGN_FROM_VERSION_KEY, 3))).toStrictEqual([]);
  const storedResign = one(LABOR_RESIGN_FROM_VERSION_KEY, 3);
  expect(check.refusals(storedResign, one(LABOR_VERSION_KEY, 2))).toStrictEqual([
    LABOR_VERSION_KEY,
  ]);
  expect(check.refusals(storedResign, one(LABOR_VERSION_KEY, 3))).toStrictEqual([]);
  expect(check.refusals(storedResign, one(LABOR_VERSION_KEY, 4))).toStrictEqual([]);
});

it('[AC-B2-03x#6] the order check needs both values: none stored, or a stored value outside the shape, refuses nothing more', () => {
  const check = laborAgreementSaveCheck();
  expect(check.refusals(NONE, one(LABOR_RESIGN_FROM_VERSION_KEY, 7))).toStrictEqual([]);
  expect(check.refusals(NONE, one(LABOR_VERSION_KEY, 1))).toStrictEqual([]);
  expect(
    check.refusals(one(LABOR_VERSION_KEY, 'bad'), one(LABOR_RESIGN_FROM_VERSION_KEY, 7)),
  ).toStrictEqual([]);
  // A written value outside its shape is refused once, on its own key.
  expect(
    check.refusals(one(LABOR_VERSION_KEY, 3), one(LABOR_RESIGN_FROM_VERSION_KEY, 4.5)),
  ).toStrictEqual([LABOR_RESIGN_FROM_VERSION_KEY]);
});

it('[AC-B2-03x#7] a write that sets none of the six keys is not refused, whatever is stored', () => {
  const check = laborAgreementSaveCheck();
  const stored = new Map<string, unknown>([
    [LABOR_VERSION_KEY, 1],
    [LABOR_RESIGN_FROM_VERSION_KEY, 5],
    [LABOR_TEXT_SHA256_KEY, 'bad'],
  ]);
  expect(check.refusals(stored, one('share_domains', ['a.example.com']))).toStrictEqual([]);
  expect(check.refusals(NONE, new Map())).toStrictEqual([]);
  // A write of one key is not refused for another key's bad stored value.
  expect(check.refusals(stored, one(LABOR_TEXT_URL_KEY, 'https://x.example.com/'))).toStrictEqual(
    [],
  );
});

it('[AC-B2-03x#8] several bad keys in one write are each refused', () => {
  const write = new Map<string, unknown>([
    [LABOR_VERSION_KEY, 2],
    [LABOR_TEXT_URL_KEY, 'nope'],
    [LABOR_TEXT_SHA256_KEY, SHA],
    [LABOR_RESIGN_FROM_VERSION_KEY, 3],
    [OPERATOR_NAME_KEY, ''],
    [OPERATOR_CREDIT_CODE_KEY, CREDIT],
  ]);
  expect(laborAgreementSaveCheck().refusals(NONE, write)).toStrictEqual([
    LABOR_TEXT_URL_KEY,
    OPERATOR_NAME_KEY,
    LABOR_RESIGN_FROM_VERSION_KEY,
  ]);
});

it('[AC-B2-03x#9] combined with the bridge_origins and default avatar checks, each keeps refusing its own keys', () => {
  const combined = combineConfigItemSaveChecks(
    bridgeOriginsSaveCheck(),
    defaultAvatarSaveCheck(),
    laborAgreementSaveCheck(),
  );
  expect(combined.keys).toStrictEqual([
    'bridge_origins',
    'h5_base_url',
    'me.default_avatar_url',
    ...LABOR_AGREEMENT_SAVE_KEYS,
  ]);
  const stored = new Map<string, unknown>([
    ['h5_base_url', 'https://h5.example.com/'],
    [LABOR_VERSION_KEY, 3],
  ]);
  const goodBridge = { origins: ['https://h5.example.com'] };
  const badBridge = { origins: [] };

  expect(combined.refusals(stored, one(LABOR_RESIGN_FROM_VERSION_KEY, 4))).toStrictEqual([
    LABOR_RESIGN_FROM_VERSION_KEY,
  ]);
  expect(combined.refusals(stored, one(LABOR_RESIGN_FROM_VERSION_KEY, 2))).toStrictEqual([]);
  expect(combined.refusals(stored, one(DEFAULT_AVATAR_URL_KEY, 'http://x/a.png'))).toStrictEqual([
    DEFAULT_AVATAR_URL_KEY,
  ]);
  expect(combined.refusals(stored, one('bridge_origins', badBridge))).toStrictEqual([
    'bridge_origins',
  ]);
  expect(
    combined.refusals(
      stored,
      new Map<string, unknown>([
        ['bridge_origins', badBridge],
        [DEFAULT_AVATAR_URL_KEY, ''],
        [OPERATOR_CREDIT_CODE_KEY, 'x'],
      ]),
    ),
  ).toStrictEqual(['bridge_origins', DEFAULT_AVATAR_URL_KEY, OPERATOR_CREDIT_CODE_KEY]);
  expect(
    combined.refusals(
      stored,
      new Map<string, unknown>([
        ['bridge_origins', goodBridge],
        [DEFAULT_AVATAR_URL_KEY, 'https://cdn.example.com/a.png'],
        [OPERATOR_CREDIT_CODE_KEY, CREDIT],
      ]),
    ),
  ).toStrictEqual([]);
});
