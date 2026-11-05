import { expect, it } from 'vitest';
import { bridgeOriginsSaveCheck } from './bridge-origins-save-check.ts';
import { combineConfigItemSaveChecks } from './config-item-admin.ts';
import {
  DEFAULT_AVATAR_URL_KEY,
  defaultAvatarSaveCheck,
  defaultAvatarUrlValid,
} from './default-avatar-save-check.ts';

const NONE = new Map<string, unknown>();
const write = (value: unknown) => new Map<string, unknown>([[DEFAULT_AVATAR_URL_KEY, value]]);

it('[AC-B2-03w#1] reads and checks only me.default_avatar_url', () => {
  expect(DEFAULT_AVATAR_URL_KEY).toBe('me.default_avatar_url');
  expect(defaultAvatarSaveCheck().keys).toStrictEqual(['me.default_avatar_url']);
});

it.each([
  'https://cdn.example.com/avatar/default.png',
  'HTTPS://cdn.example.com/a.png',
  'https://cdn.example.com',
])('[AC-B2-03w#2] a usable https URL is let through: %s', (value) => {
  expect(defaultAvatarUrlValid(value)).toBe(true);
  expect(defaultAvatarSaveCheck().refusals(NONE, write(value))).toStrictEqual([]);
});

it.each([
  ['http', 'http://cdn.example.com/a.png'],
  ['relative path', '/static/avatar.png'],
  ['protocol-relative', '//cdn.example.com/a.png'],
  ['empty string', ''],
  ['no host', 'https://'],
  ['unparseable', 'https://exa mple.com/a.png'],
  ['number', 42],
  ['null', null],
  ['object', { url: 'https://cdn.example.com/a.png' }],
  ['array', ['https://cdn.example.com/a.png']],
])('[AC-B2-03w#3] %s is refused with the key', (_label, value) => {
  expect(defaultAvatarUrlValid(value)).toBe(false);
  expect(defaultAvatarSaveCheck().refusals(NONE, write(value))).toStrictEqual([
    'me.default_avatar_url',
  ]);
});

it('[AC-B2-03w#4] a write that does not set the key is not refused, whatever is stored', () => {
  const stored = new Map<string, unknown>([[DEFAULT_AVATAR_URL_KEY, 'http://bad']]);
  const other = new Map<string, unknown>([['share_domains', ['a.example.com']]]);
  expect(defaultAvatarSaveCheck().refusals(stored, other)).toStrictEqual([]);
  expect(defaultAvatarSaveCheck().refusals(NONE, new Map())).toStrictEqual([]);
});

it('[AC-B2-03w#5] combined with the bridge_origins check, both keep refusing their own key', () => {
  const combined = combineConfigItemSaveChecks(bridgeOriginsSaveCheck(), defaultAvatarSaveCheck());
  expect(combined.keys).toStrictEqual(['bridge_origins', 'h5_base_url', 'me.default_avatar_url']);
  const stored = new Map<string, unknown>([['h5_base_url', 'https://h5.example.com/']]);
  const goodBridge = { origins: ['https://h5.example.com'] };
  const badBridge = { origins: [] };

  expect(combined.refusals(stored, write('http://cdn.example.com/a.png'))).toStrictEqual([
    'me.default_avatar_url',
  ]);
  expect(combined.refusals(stored, write('https://cdn.example.com/a.png'))).toStrictEqual([]);
  expect(combined.refusals(stored, new Map([['bridge_origins', badBridge]]))).toStrictEqual([
    'bridge_origins',
  ]);
  expect(combined.refusals(stored, new Map([['bridge_origins', goodBridge]]))).toStrictEqual([]);
  expect(
    combined.refusals(
      stored,
      new Map<string, unknown>([
        ['bridge_origins', badBridge],
        [DEFAULT_AVATAR_URL_KEY, ''],
      ]),
    ),
  ).toStrictEqual(['bridge_origins', 'me.default_avatar_url']);
  expect(
    combined.refusals(
      stored,
      new Map<string, unknown>([
        ['bridge_origins', goodBridge],
        [DEFAULT_AVATAR_URL_KEY, 'https://cdn.example.com/a.png'],
      ]),
    ),
  ).toStrictEqual([]);
});
