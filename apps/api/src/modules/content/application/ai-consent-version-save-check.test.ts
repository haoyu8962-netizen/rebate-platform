import { expect, it } from 'vitest';
import {
  AI_CONSENT_VERSION_KEY,
  aiConsentVersionSaveCheck,
  currentAiConsentVersion,
} from './ai-consent-version-save-check.ts';
import { combineConfigItemSaveChecks } from './config-item-admin.ts';
import { laborAgreementSaveCheck } from './labor-agreement-save-check.ts';

const KEY = 'legal.ai_third_party.version';
const MAX = 2_147_483_647;
const NONE = new Map<string, unknown>();
const one = (value: unknown) => new Map<string, unknown>([[KEY, value]]);

it('[AC-B1-22zb#1] reads and checks exactly legal.ai_third_party.version', () => {
  expect(AI_CONSENT_VERSION_KEY).toBe(KEY);
  expect(aiConsentVersionSaveCheck().keys).toStrictEqual([KEY]);
});

it('[AC-B1-22zb#4] the current version is the stored value, 1 when the row is missing', () => {
  expect(currentAiConsentVersion(NONE)).toBe(1);
  expect(currentAiConsentVersion(one(1))).toBe(1);
  expect(currentAiConsentVersion(one(7))).toBe(7);
  expect(currentAiConsentVersion(one(MAX))).toBe(MAX);
});

it.each<[string, unknown]>([
  ['zero', 0],
  ['negative', -1],
  ['fraction', 2.5],
  ['above int32', MAX + 1],
  ['numeric string', '5'],
  ['null', null],
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
])('[AC-B1-22zb#5] an invalid stored value (%s) counts as 1', (_label, value) => {
  expect(currentAiConsentVersion(one(value))).toBe(1);
  expect(aiConsentVersionSaveCheck().refusals(one(value), one(1))).toStrictEqual([]);
});

it('[AC-B1-22zb#2] a lower write is refused, an equal or higher one passes', () => {
  const check = aiConsentVersionSaveCheck();
  expect(check.refusals(one(3), one(2))).toStrictEqual([KEY]);
  expect(check.refusals(one(MAX), one(MAX - 1))).toStrictEqual([KEY]);
  expect(check.refusals(one(3), one(3))).toStrictEqual([]);
  expect(check.refusals(one(3), one(4))).toStrictEqual([]);
  expect(check.refusals(NONE, one(1))).toStrictEqual([]);
});

it.each<[string, unknown]>([
  ['zero', 0],
  ['negative', -1],
  ['above int32', MAX + 1],
  ['fraction', 1.5],
  ['numeric string', '3'],
  ['null', null],
  ['NaN', Number.NaN],
])('[AC-B1-22zb#17] an invalid written value (%s) is refused by the check itself', (_l, v) => {
  const check = aiConsentVersionSaveCheck();
  expect(check.refusals(NONE, one(v))).toStrictEqual([KEY]);
  expect(check.refusals(one(1), one(v))).toStrictEqual([KEY]);
  expect(check.refusals(one(MAX), one(v))).toStrictEqual([KEY]);
  expect(check.refusals(one('v2'), one(v))).toStrictEqual([KEY]);
});

it('[AC-B1-22zb#6] writes without the key are never refused', () => {
  const check = aiConsentVersionSaveCheck();
  const other = new Map<string, unknown>([['legal.labor_agreement.version', 1]]);
  expect(check.refusals(one(9), other)).toStrictEqual([]);
});

it('[AC-B1-22zb#7] combined with the labor agreement check, each refuses only its own key', () => {
  const check = combineConfigItemSaveChecks(laborAgreementSaveCheck(), aiConsentVersionSaveCheck());
  const stored = new Map<string, unknown>([[KEY, 4]]);
  expect(
    check.refusals(
      stored,
      new Map<string, unknown>([
        [KEY, 3],
        ['legal.labor_agreement.version', 1],
      ]),
    ),
  ).toStrictEqual([KEY]);
  expect(
    check.refusals(
      stored,
      new Map<string, unknown>([
        [KEY, 4],
        ['legal.labor_agreement.version', 0],
      ]),
    ),
  ).toStrictEqual(['legal.labor_agreement.version']);
});
