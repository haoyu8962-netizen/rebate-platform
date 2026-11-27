import { expect, it } from 'vitest';
import { loadEnums } from '../../../../packages/contracts-ts/scripts/catalog.ts';
import { checkEvents } from '../../../../packages/contracts-ts/scripts/events.ts';
import {
  doc,
  expectedCardErrorFields,
  expectFieldShape,
  field,
  fields,
  homeCardError,
  validateEvent,
  without,
} from '../sdui-card-error-page-version/kit.ts';
import { at } from './kit.ts';

// 规划/03 §4.7；复用已冻结的 CT-13b 字段形状和样例，reason 仍用字符串。
const shareEnums = {
  copyKinds: ['full_text', 'tpwd_only', 'link_only'],
  handoffChannels: ['system', 'wechat_session', 'wechat_timeline'],
  handoffResults: ['handed_off', 'failed', 'cancelled'],
};

it('[AC-CT-26zs#10] 分别登记分享生成与复制事件', () => {
  // 少登记一步、复制种类多/漏一项、或没有生成结果时，分别由字段清单和字段形状报错。
  // platform 已存在于公共字段，独立保留公共端别。
  const platform = at(doc(), 'common_fields', 'platform');
  expect(platform).toMatchObject({ type: 'enum', required: true });
  expect(Object.keys(fields('share_generate'))).toEqual(['result']);
  const result = field('share_generate', 'result');
  expect(['string', 'enum']).toContain(result['type']);
  expect(result['required']).toBe(true);
  expect(Object.keys(fields('share_copy'))).toEqual(['kind']);
  expectFieldShape('share_copy', 'kind', {
    type: 'enum',
    required: true,
    values: shareEnums.copyKinds,
  });
  expect(Number(doc()['version'])).toBeGreaterThan(6);
});

it('[AC-CT-26zs#11] 保存只记四个计数，取消只记阶段', () => {
  // 旧单一 saved 布尔值、把 cancelled 设为布尔、加图片链接或原文，都会失败。
  const counts = ['cancelled', 'failed', 'succeeded', 'total'];
  expect(Object.keys(fields('share_save_images')).sort()).toEqual(counts);
  for (const count of counts) {
    expectFieldShape('share_save_images', count, { type: 'integer', required: true });
  }
  expect(Object.keys(fields('share_cancel'))).toEqual(['stage']);
  const stage = field('share_cancel', 'stage');
  expect(['string', 'enum']).toContain(stage['type']);
  expect(stage['required']).toBe(true);
});

it('[AC-CT-26zs#12] 分享交接记录渠道与结果，保留安装渠道', () => {
  // 缺渠道、成功记成 sent/received、把安装渠道重写成分享渠道，都会失败。
  // 03 §4.7 的交接 channel 与公共安装 channel 同名。本用例锁定事件自己的渠道取值，
  // 等待裁定线上的字段名。
  expect(at(doc(), 'common_fields', 'channel')).toMatchObject({
    type: 'string',
    required: false,
    note: expect.stringContaining('install_channel'),
  });
  const handoff = fields('share_handoff');
  expectFieldShape('share_handoff', 'result', {
    type: 'enum',
    required: true,
    values: shareEnums.handoffResults,
  });
  const channels = Object.keys(handoff).filter((name) => name !== 'result');
  expect(channels).toHaveLength(1);
  for (const channel of channels) {
    expectFieldShape('share_handoff', channel, {
      type: 'enum',
      required: true,
      values: shareEnums.handoffChannels,
    });
  }
  expect(checkEvents(loadEnums())).toEqual([]);
});

it('[AC-CT-26zs#13] 登记首屏 block_missing 并沿用四项诊断', () => {
  // 只在客户端发值而未登记、给 reason 封枚举、重命名或漏掉诊断字段，都会失败。
  const name = 'sdui_card_error';
  const detail = at(doc(), 'events', name);
  const message = [detail['description'], field(name, 'reason')['note']].map(String).join(' ');
  expect(message).toContain('block_missing');
  expect(message).toMatch(/首屏|first.screen|above.the.fold/iu);
  expect(message).toMatch(/核心|core/iu);
  expect(message).toMatch(/解码失败|decod.{0,12}fail/iu);
  expect(message).toMatch(/过滤|filter/iu);
  expect(Object.keys(fields(name)).sort()).toEqual(Object.keys(expectedCardErrorFields).sort());
  for (const [key, shape] of Object.entries(expectedCardErrorFields)) {
    expectFieldShape(name, key, shape);
  }
  const sample = without(
    homeCardError({ reason: 'block_missing', schema_version: 'unknown' }),
    'version',
  );
  expect(validateEvent(name, sample)).toEqual([]);
  for (const key of ['schema_version', 'bridge_version', 'config_version', 'h5_release']) {
    expect(validateEvent(name, without(sample, key))).toContain(`${key}: missing`);
  }
  expect(validateEvent(name, homeCardError())).toEqual([]);
});
