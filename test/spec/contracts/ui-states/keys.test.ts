import { expect, it } from 'vitest';
import {
  actions,
  announce,
  isPattern,
  keysOf,
  patternRows,
  retry,
  row,
  states,
  textKeysOf,
  texts,
  type Obj,
} from './kit.ts';

// 08「通用状态键」：状态行的文案键只取表 A～C（state.*、net.*、error.*、web_page.*，写请求结果未知的
// 场景键 pending_confirm.*、buy.timeout、login.network_retry，强更页的 app_update.*）。
const allowedPrefixes = [
  'state.',
  'net.',
  'error.',
  'web_page.',
  'pending_confirm.',
  'buy.',
  'login.',
  'app_update.',
];
// 三端草稿键（*.load_failed、*.network_error、*.loading、*.retry）随 FU-DS 删去，不得进状态目录；
// 08 表 C 定的 state.loading、state.retry 与强更页的 app_update.retry 不算草稿键。
const draftSuffix = /\.(load_failed|network_error|loading|retry)$/u;
const notDraft = ['state.loading', 'state.retry', 'app_update.retry'];
const draftExamples = [
  'home.loading',
  'wallet.load_failed',
  'me.load_failed',
  'withdraw.load_failed',
  'order_list.network_error',
  'order.network_error',
];
// 08 表 B 子键的模式串：error.<code>[.<reason>]，或钉了码的 error.50301[.<reason>]。
const patternShape = /^error\.(<code>|[0-9]{5})(\[\.<reason>\])?$/u;

const retryPrimary = [{ key: 'state.retry', emphasis: 'primary' }];

it('[AC-CT-09s#2] 每行的文案键都在 texts.default.json 里，模式串只出现在 desc_key 且只在两行', () => {
  const dictionary = texts();
  for (const item of states()) {
    const name = String(item['name']);
    for (const key of keysOf(item)) {
      expect(key, `${name} 的文案键`).toBeTypeOf('string');
      const text = key as string;
      if (isPattern(text)) {
        expect(item['desc_key'], `${name}：模式串只能写在 desc_key`).toBe(text);
        expect(patternRows, `${name}：只有 ${patternRows.join('、')} 可写模式串`).toContain(name);
        expect(text, `${name}.desc_key 的模式串写法`).toMatch(patternShape);
        const base = text.replace(/\[.*$/u, '');
        if (base !== 'error.<code>') {
          expect(Object.hasOwn(dictionary, base), `${name}：${base} 不在字典里`).toBe(true);
        }
      } else {
        expect(Object.hasOwn(dictionary, text), `${name}：${text} 不在 texts.default.json`).toBe(
          true,
        );
      }
    }
  }
});

it('[AC-CT-09s#2] 文案键只取 08 表 A～C 的通用与场景键，不出现三端草稿键', () => {
  for (const item of states()) {
    const name = String(item['name']);
    for (const key of keysOf(item)) {
      expect(key, `${name} 的文案键`).toBeTypeOf('string');
      const text = key as string;
      expect(
        allowedPrefixes.some((prefix) => text.startsWith(prefix)),
        `${name}：${text} 不是 08 表 A～C 的通用状态键`,
      ).toBe(true);
      expect(draftExamples, `${name}：${text} 是三端草稿键`).not.toContain(text);
      if (!notDraft.includes(text)) {
        expect(text, `${name}：${text} 是三端草稿键写法`).not.toMatch(draftSuffix);
      }
    }
  }
});

function expectErrorState(item: Obj, title: string, desc: string): void {
  expect(item['component']).toBe('ErrorState');
  expect(item['title_key']).toBe(title);
  expect(item['desc_key']).toBe(desc);
  expect(actions(item)).toEqual(retryPrimary);
  expect(retry(item)['mode']).not.toBe('none');
}

it('[AC-CT-09s#3] first_load：Skeleton 不显示文字，state.loading 作读屏名称，无按钮', () => {
  const item = row('first_load');
  expect(item['component']).toBe('Skeleton');
  expect(item['kind']).toBeNull();
  expect(item['title_key']).toBeNull();
  expect(item['desc_key']).toBeNull();
  expect(actions(item)).toEqual([]);
  expect(announce(item)['key']).toBe('state.loading');
  expect(announce(item)['mode']).not.toBe('none');
});

it('[AC-CT-09s#3] load_failed：ErrorState(load_failed)，state.load_failed.title / .desc + 主按钮 state.retry', () => {
  const item = row('load_failed');
  expectErrorState(item, 'state.load_failed.title', 'state.load_failed.desc');
  expect(item['kind']).toBe('load_failed');
});

it('[AC-CT-09s#3] load_failed_with_code：标题同加载失败，说明取 error.<code>[.<reason>]，主按钮 state.retry', () => {
  const item = row('load_failed_with_code');
  expectErrorState(item, 'state.load_failed.title', 'error.<code>[.<reason>]');
});

it('[AC-CT-09s#3] read_timeout：标题仍为 state.load_failed.title，说明句是 state.timeout，主按钮 state.retry', () => {
  const item = row('read_timeout');
  expectErrorState(item, 'state.load_failed.title', 'state.timeout');
  // 读请求超时且设备没有断网：不是断网态。
  expect(item['kind']).not.toBe('network');
});

it('[AC-CT-09s#3] offline_no_cache：ErrorState(network)，net.unavailable / net.unavailable.desc + 主按钮 state.retry', () => {
  const item = row('offline_no_cache');
  expectErrorState(item, 'net.unavailable', 'net.unavailable.desc');
  expect(item['kind']).toBe('network');
});

it('[AC-CT-09s#3] offline_with_cache：显示旧数据并以 NoticeBar 附 net.stale_data，提示条上有重试入口 state.retry', () => {
  const item = row('offline_with_cache');
  expect(item['component']).toBe('NoticeBar');
  expect(item['kind']).toBeNull();
  expect(textKeysOf(item)).toContain('net.stale_data');
  expect(textKeysOf(item)).not.toContain('net.unavailable');
  // 08 表 C state.retry 行：提示条上的重试入口用 state.retry。
  const entries = actions(item);
  expect(entries.length, 'offline_with_cache 至少有一个重试入口').toBeGreaterThan(0);
  for (const action of entries) {
    expect(action['key'], 'offline_with_cache 的按钮只用 state.retry').toBe('state.retry');
  }
});

it('[AC-CT-09s#3] write_unknown：Toast 轻提示 state.timeout，不自动重发、手动重试沿用同一幂等键，注明 90003 与三类场景键例外', () => {
  const item = row('write_unknown');
  expect(item['component']).toBe('Toast');
  expect(item['kind']).toBeNull();
  expect(textKeysOf(item)).toContain('state.timeout');
  // 结果未知的写请求不自动重发，重试交给用户，沿用同一幂等键（08 表 C state.timeout 行、规划/03 §4.2）。
  expect(retry(item)['mode'], 'write_unknown.retry.mode').toBe('manual');
  expect(retry(item)['idempotency'], 'write_unknown.retry.idempotency').toBe('same_key');
  const notes = `${String(item['trigger'])}\n${JSON.stringify(item['refs'])}`;
  // App 内 H5 的桥调用返回 90003 同此（08 表 C state.timeout 行）。
  expect(notes, 'write_unknown 的 trigger 或 refs 须注明桥调用 90003').toContain('90003');
  for (const scene of ['pending_confirm.', 'buy.timeout', 'login.network_retry']) {
    expect(notes, `write_unknown 的 trigger 或 refs 须注明 ${scene} 例外`).toContain(scene);
  }
});

// refs 里含 BR-TEXT-10（不把 BR-TEXT-100 之类误认为命中）。
const brText10 = /(^|[^0-9A-Za-z-])BR-TEXT-10(?![0-9])/u;
function citesBrText10(item: Obj): boolean {
  const refs = Array.isArray(item['refs']) ? (item['refs'] as unknown[]) : [];
  return refs.some((entry) => typeof entry === 'string' && brText10.test(entry));
}

it('[AC-CT-09s#3] value_missing：Inline 显示「—」（不进字典），读屏读 state.value_missing.a11y', () => {
  const item = row('value_missing');
  expect(item['component']).toBe('Inline');
  expect(item['kind']).toBeNull();
  expect(item['title_key']).toBeNull();
  expect(item['desc_key']).toBeNull();
  expect(actions(item)).toEqual([]);
  expect(announce(item)['key']).toBe('state.value_missing.a11y');
  expect(announce(item)['mode']).not.toBe('none');
  // 「—」（U+2014）是格式规则，不作为任何字典键的取值。
  expect(Object.values(texts())).not.toContain('—');
  expect(citesBrText10(item), 'value_missing.refs 须含 BR-TEXT-10').toBe(true);
});

it('[AC-CT-09s#3] value_missing_block：整块进 ErrorState(load_failed)，用加载失败一组与主按钮 state.retry', () => {
  const item = row('value_missing_block');
  expectErrorState(item, 'state.load_failed.title', 'state.load_failed.desc');
  expect(item['kind']).toBe('load_failed');
  expect(citesBrText10(item), 'value_missing_block.refs 须含 BR-TEXT-10').toBe(true);
});

it('[AC-CT-09s#3] empty：EmptyState 标题 state.empty.default，没有数据不是加载失败，不配重试', () => {
  const item = row('empty');
  expect(item['component']).toBe('EmptyState');
  expect(item['kind']).toBeNull();
  expect(item['title_key']).toBe('state.empty.default');
  expect(actions(item)).toEqual([]);
  expect(retry(item)['mode']).toBe('none');
  expect(keysOf(item)).not.toContain('state.retry');
});

it('[AC-CT-09s#3] page_maintenance：页面维护用 web_page.maintenance', () => {
  const item = row('page_maintenance');
  expect(['WebPage', 'ErrorState']).toContain(item['component']);
  if (item['component'] === 'ErrorState') expect(item['kind']).toBe('maintenance');
  expect(textKeysOf(item)).toContain('web_page.maintenance');
});

it('[AC-CT-09s#3] platform_maintenance：平台转链 / 联盟场景的 50301 用 error.50301[.<reason>]，核验场景按表 B 场景键另行处理', () => {
  const item = row('platform_maintenance');
  if (item['component'] === 'ErrorState') expect(item['kind']).toBe('maintenance');
  const desc = item['desc_key'];
  const trigger = String(item['trigger']);
  // 只接受模式串（带表 B 子键），不接受裸 error.50301。
  const pinned = desc === 'error.50301[.<reason>]';
  const generic = desc === 'error.<code>[.<reason>]' && trigger.includes('50301');
  expect(pinned || generic, 'platform_maintenance.desc_key 须为 error.50301[.<reason>]').toBe(true);
  // 08 表 B：50301「维护中」句说的是平台转链；实名、银行卡核验的 50301 用场景键 realname_vendor、
  // bank_vendor 及其回落，不用平台维护句。
  expect(trigger, 'platform_maintenance.trigger 限定平台转链 / 联盟场景').toMatch(/转链|联盟/u);
  expect(trigger, 'platform_maintenance.trigger 须写明 realname_vendor 例外').toContain(
    'realname_vendor',
  );
  expect(trigger, 'platform_maintenance.trigger 须写明 bank_vendor 例外').toContain('bank_vendor');
});

it('[AC-CT-09s#3] force_update：ForceUpdate 强更页用 error.10405', () => {
  const item = row('force_update');
  expect(item['component']).toBe('ForceUpdate');
  expect(item['kind']).toBeNull();
  expect(textKeysOf(item)).toContain('error.10405');
});
