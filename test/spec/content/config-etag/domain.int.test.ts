// Pure companion cases kept in this task's integration suite for the isolated --red run.
// Synthetic channels are domain inputs only; never platform recordings or runtime overrides.
import { createHash } from 'node:crypto';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import { expect, it } from 'vitest';
import {
  configEtag,
  ifNoneMatchHits,
  rankPlatforms,
} from '../../../../apps/api/src/modules/content/domain/config-etag.ts';
import type { MaterialChannelsSpec } from '../../../../apps/api/src/modules/platform/index.ts';
import { canonical, PLATFORMS } from './kit.ts';
import { signedFixture } from '../bridge-origins/jws-kit.ts';

function data(): Omit<Schema<'Config'>, 'config_version'> {
  return {
    dict_version: '0',
    h5_base_url: 'https://h5.example.test/',
    h5_release: { version: 'stable-v1' },
    share_domains: [],
    features: { flags: {}, platform_status: {}, rank_platforms: [] },
    texts: { '2': '二', '10': '十', Z: '大写', a: '小写' },
    legal: { privacy: { version: 7, min_version: 3 }, agreement: { version: 5 } },
    invite: { required: false, backfill_hours: 168, bind_phone_guide: true, before_buy_tip: true },
    agent: {
      enabled: false,
      whitelist_only: true,
      filing_text: '',
      examples: [],
      guest_daily_quota: 3,
      require_phone: false,
    },
    kf: { url: 'https://kf.example.test/' },
    jump_tip: {},
    clipboard: {},
    bridge_origins: signedFixture(),
    auth_tips: {},
    compliance: {},
    display: { z: [{ b: 2, a: 1 }, null, false], a: { z: '引号"\n', a: '中文' } },
    lkg_max_age_sec: 604800,
    bridge_disabled_methods: ['ext.openApp', 'clipboard.read'],
    platform_icons: {},
  };
}

function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, item]) => [key, reverseKeys(item)]),
  );
}

it('[AC-F1-02h#30] configEtag 对最终 data 做递归规范化，嵌套对象键序与数字形键均遵守 JS sort', () => {
  const payload = data();
  const expected = `"${createHash('sha256').update(canonical(payload)).digest('hex').slice(0, 32)}"`;
  const before = structuredClone(payload);
  expect(configEtag(payload)).toBe(expected);
  expect(configEtag(reverseKeys(payload) as typeof payload)).toBe(expected);
  expect(payload).toEqual(before);
});

it('[AC-F1-02h#31] configEtag 保留数组顺序，不能把数组也排序', () => {
  const payload = data();
  const first = configEtag(payload);
  const second = configEtag({
    ...payload,
    bridge_disabled_methods: ['clipboard.read', 'ext.openApp'],
  });
  expect(second).not.toBe(first);
});

const ETAG = '"0123456789abcdef0123456789abcdef"';
it.each([
  { label: '精确', header: ETAG, hit: true },
  { label: '弱', header: `W/${ETAG}`, hit: true },
  { label: '列表和空白', header: `  "old" , W/${ETAG} , "next" `, hit: true },
  { label: '星号', header: '*', hit: true },
  { label: '缺失', header: undefined, hit: false },
  { label: '空串', header: '', hit: false },
  { label: '不同 tag', header: '"abc"', hit: false },
  { label: '裸 tag', header: ETAG.slice(1, -1), hit: false },
  { label: '弱裸 tag', header: `W/${ETAG.slice(1, -1)}`, hit: false },
  { label: '小写弱前缀', header: `w/${ETAG}`, hit: false },
  { label: '重复弱前缀', header: `W/W/${ETAG}`, hit: false },
  { label: '尾部垃圾', header: `${ETAG}junk`, hit: false },
  { label: '未闭引号', header: ETAG.slice(0, -1), hit: false },
  { label: '大小写不同', header: ETAG.toUpperCase(), hit: false },
  { label: '引号内星号', header: '"*"', hit: false },
])('[AC-F1-02h#32] If-None-Match $label：弱比较结果 $hit', ({ header, hit }) => {
  expect(ifNoneMatchHits(header, ETAG)).toBe(hit);
});

function channel(
  platform: string,
  selectable: boolean,
  sort_basis: 'sales' | 'popularity' | 'personalized',
): MaterialChannelsSpec['channels'][number] {
  return {
    platform,
    channel_id: `${platform}_${sort_basis}`,
    name: '合成频道',
    sort_basis,
    selectable,
    source: 'synthetic rule fixture',
  };
}

it('[AC-F1-02h#33] 非空频道按 PlatformCode 顺序去重，只认 sales / popularity，忽略未知和不可选平台', () => {
  const spec: MaterialChannelsSpec = {
    version: 'synthetic',
    channels: [
      channel('suning', true, 'personalized'),
      channel('douyin', false, 'sales'),
      channel('pdd', false, 'sales'),
      channel('unknown', true, 'sales'),
      channel('jd', true, 'popularity'),
      channel('taobao', true, 'personalized'),
      channel('jd', true, 'sales'),
      channel('pdd', true, 'popularity'),
      channel('Taobao', true, 'sales'),
    ],
  };
  expect(rankPlatforms(spec)).toEqual(['jd', 'pdd']);
});

it('[AC-F1-02h#34] 全部 PlatformCode 都支持，输入顺序不影响枚举序', () => {
  const spec: MaterialChannelsSpec = {
    version: 'synthetic',
    channels: PLATFORMS.toReversed().map((platform) => channel(platform, true, 'sales')),
  };
  expect(rankPlatforms(spec)).toEqual([...PLATFORMS]);
});

it.each([
  { label: '空白名单', channels: [] },
  { label: '全部不可选', channels: PLATFORMS.map((platform) => channel(platform, false, 'sales')) },
  { label: '未知平台', channels: [channel('unknown', true, 'sales')] },
])('[AC-F1-02h#35] $label 下 rank_platforms 为 []', ({ channels }) => {
  expect(rankPlatforms({ version: 'synthetic', channels })).toEqual([]);
});
