// B1-12zd SETTLE_ADJUSTED invite wording (编排 D10-803、D10-816 ①; 08 BR-TEXT-01 收益术语唯一含义:
// an upline's commission is「推广收益」,「邀请奖励」only means the BR-INV invite campaign). Unit tests: no
// database. Expected texts are written out from the task brief §9.2, never read from the code.
// Top-level it() only.
import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  renderSettleAdjustedMessage,
  type SettleAdjustedFacts,
} from '../../../../apps/api/src/modules/notification/application/clawback-message.ts';
import { isLedger, orderDetail } from '../clawback-message/routes.ts';

const TEXTS_FILE = 'contracts/texts.default.json';
const ROOT = new URL('../../../../', import.meta.url);
const ORDER_ID = '0190a6a0-0000-7000-8000-0000000000d3';

/** The term the invite row must no longer use (BR-TEXT-01: it names the invite campaign only). */
const CAMPAIGN_TERM = '邀请奖励';

/** §9.2-1: the new invite title and body, verbatim; self and share unchanged. */
const INVITE_TITLE = '推广收益已调整';
const inviteBody = (amount: string) => `一笔推广收益已按结算金额调整，减少 ${amount}`;

/** The texts dictionary of contracts/texts.default.json; a missing file fails as an assertion. */
function texts(): Record<string, unknown> {
  const file = new URL(TEXTS_FILE, ROOT);
  expect(existsSync(file), `缺少契约文件 ${TEXTS_FILE}`).toBe(true);
  const doc = JSON.parse(readFileSync(file, 'utf8')) as { texts?: Record<string, unknown> };
  expect(typeof doc.texts, `${TEXTS_FILE} 的 texts 必须是对象`).toBe('object');
  return doc.texts ?? {};
}

/** A decrease of 320 fen booked to the available balance: {amount} = ¥3.2. */
function facts(patch: Partial<SettleAdjustedFacts>): SettleAdjustedFacts {
  return {
    order_id: ORDER_ID,
    role: 'direct',
    adjust_fen: -320n,
    bucket: 'user_available',
    sub_type: 'SETTLE_DIFF',
    ...patch,
  };
}

it('[AC-B1-12zd#1] 契约文案 inbox.title.SETTLE_ADJUSTED.invite 改为「推广收益已调整」，self / share 两键不变，三键都不含「邀请奖励」', () => {
  const dictionary = texts();
  const keys = ['self', 'share', 'invite'].map(
    (variant) => `inbox.title.SETTLE_ADJUSTED.${variant}`,
  );
  const values = Object.fromEntries(keys.map((key) => [key, dictionary[key]]));
  expect(values).toStrictEqual({
    'inbox.title.SETTLE_ADJUSTED.self': '返利已调整',
    'inbox.title.SETTLE_ADJUSTED.share': '推广收益已调整',
    'inbox.title.SETTLE_ADJUSTED.invite': INVITE_TITLE,
  });
  for (const key of keys) expect(String(dictionary[key]), key).not.toContain(CAMPAIGN_TERM);
});

it('[AC-B1-12zd#2] 直接上级（direct）负差 → 标题「推广收益已调整」、正文「一笔推广收益已按结算金额调整，减少 ¥3.2」逐字，不带原因（J7），跳余额流水', () => {
  const message = renderSettleAdjustedMessage(facts({ role: 'direct' }), null);
  expect(message).toMatchObject({
    code: 'SETTLE_ADJUSTED',
    variant: 'invite',
    category: 'service',
    title: INVITE_TITLE,
    body: inviteBody('¥3.2'),
  });
  expect(message?.body).toBe('一笔推广收益已按结算金额调整，减少 ¥3.2');
  expect(isLedger(message?.route)).toBe(true);
  expect(JSON.stringify(message)).not.toContain(ORDER_ID);
});

it('[AC-B1-12zd#3] 间接上级（indirect，PRICE_PROTECT）负差 → 与直接上级同一邀请行：标题「推广收益已调整」，正文逐字且不带「：商家价保退差」', () => {
  const message = renderSettleAdjustedMessage(
    facts({ role: 'indirect', sub_type: 'PRICE_PROTECT', adjust_fen: -123456n }),
    null,
  );
  expect(message).toMatchObject({
    code: 'SETTLE_ADJUSTED',
    variant: 'invite',
    category: 'service',
    title: '推广收益已调整',
    body: '一笔推广收益已按结算金额调整，减少 ¥1234.56',
  });
  expect(message?.body).not.toContain('商家价保退差');
  expect(isLedger(message?.route)).toBe(true);
});

it('[AC-B1-12zd#4] 邀请行的标题与正文都不含「邀请奖励」：两种上级 × 三种 sub_type × 多个金额，无覆盖与覆盖全为空时都一样', () => {
  const seen: string[] = [];
  for (const role of ['direct', 'indirect']) {
    for (const sub_type of ['SETTLE_DIFF', 'PRICE_PROTECT', 'PRICE_COMPARE']) {
      for (const [adjust_fen, yuan] of [
        [-1n, '¥0.01'],
        [-990n, '¥9.9'],
        [-1000n, '¥10'],
      ] as const) {
        for (const override of [null, { title_override: null, body_override: null }]) {
          const message = renderSettleAdjustedMessage(
            facts({ role, sub_type, adjust_fen }),
            override,
          );
          expect(message?.title).toBe(INVITE_TITLE);
          expect(message?.body).toBe(inviteBody(yuan));
          seen.push(`${message?.title ?? ''}\n${message?.body ?? ''}`);
        }
      }
    }
  }
  expect(seen).toHaveLength(36);
  for (const text of seen) expect(text).not.toContain(CAMPAIGN_TERM);
});

it('[AC-B1-12zd#5] 只改邀请行：同一负差下自购 / 分享两行的标题与正文原样不变，邀请行换成「推广收益」措辞', () => {
  const rendered = (['self', 'share', 'direct', 'indirect'] as const).map((role) => {
    const message = renderSettleAdjustedMessage(facts({ role, sub_type: 'PRICE_COMPARE' }), null);
    return [message?.variant, message?.title, message?.body];
  });
  expect(rendered).toStrictEqual([
    ['self', '返利已调整', '订单返利已按结算金额调整，减少 ¥3.2：比价订单'],
    ['share', '推广收益已调整', '一笔分享订单的推广收益已按结算金额调整，减少 ¥3.2：比价订单'],
    ['invite', '推广收益已调整', '一笔推广收益已按结算金额调整，减少 ¥3.2'],
    ['invite', '推广收益已调整', '一笔推广收益已按结算金额调整，减少 ¥3.2'],
  ]);
  const self = renderSettleAdjustedMessage(facts({ role: 'self' }), null);
  expect(self?.route).toStrictEqual(orderDetail(ORDER_ID));
});

it('[AC-B1-12zd#6] 邀请行只覆盖正文时标题回退新默认「推广收益已调整」；只覆盖标题时正文回退新默认句', () => {
  const bodyOnly = renderSettleAdjustedMessage(facts({ role: 'direct' }), {
    title_override: null,
    body_override: '减少 {amount}',
  });
  const titleOnly = renderSettleAdjustedMessage(facts({ role: 'indirect' }), {
    title_override: '收益变动',
    body_override: null,
  });
  expect([bodyOnly?.title, bodyOnly?.body, titleOnly?.title, titleOnly?.body]).toStrictEqual([
    '推广收益已调整',
    '减少 ¥3.2',
    '收益变动',
    '一笔推广收益已按结算金额调整，减少 ¥3.2',
  ]);
});
