// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { EXPECTED, ID, ORDER_KEY, REF, createServer } from './fixtures.ts';
import {
  CANCEL,
  DIMENSIONS_LABEL,
  DIMENSION_SHOWN,
  FLOW_TIMEOUT,
  NOTE,
  SERVER_DECIDES,
  action,
  clawbackDialogs,
  clawbackEntries,
  click,
  mount,
  openClawback,
  settle,
  settled,
  showsAmount,
  squash,
  stepUpDialogs,
  textFields,
  textOf,
} from './helpers.ts';

/** The order key as a whole token (not a prefix of a longer number). */
function showsOrder(text: string, orderKey: string): boolean {
  return new RegExp(`${orderKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9])`).test(text);
}

it(
  '[AC-F1-08ec-CONFIRM#1] 点【确认扣回】先弹二次确认：显示订单（order_key）、命中维度（channel、order_no_suffix）、差错单金额 expected_fen（后台金额格式）并注明实扣以服务端计算为准，有选填的备注；还没弹动态码、没发请求',
  async () => {
    const server = createServer();
    await mount(server);
    const modal = await openClawback(server, REF.open, ID.open);
    const spaced = textOf(modal);
    const text = squash(spaced);
    expect(showsOrder(text, ORDER_KEY.open), `the order ${ORDER_KEY.open} in 「${text}」`).toBe(
      true,
    );
    expect(text, 'the hit dimensions are named').toMatch(DIMENSIONS_LABEL);
    expect(text, 'dimension channel').toMatch(DIMENSION_SHOWN.channel);
    expect(text, 'dimension order_no_suffix').toMatch(DIMENSION_SHOWN.order_no_suffix);
    expect(showsAmount(spaced, EXPECTED.open), `expected_fen ${EXPECTED.open} as yuan`).toBe(true);
    expect(text, 'the amount taken back is calculated by the server').toMatch(SERVER_DECIDES);
    expect(textFields(modal, NOTE), 'one note field').toHaveLength(1);
    expect(stepUpDialogs(), 'no step-up before confirming').toEqual([]);
    await settled(server);
    expect(server.requests('POST'), 'nothing sent before confirming').toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08ec-CONFIRM#2] 处理中、单一命中维度的差错单：确认框显示该订单与维度 channel、金额 expected_fen；点【取消】关闭确认框，不弹动态码、不发任何 POST，入口仍可用',
  async () => {
    const server = createServer();
    await mount(server);
    const modal = await openClawback(server, REF.busy, ID.busy);
    const spaced = textOf(modal);
    const text = squash(spaced);
    expect(showsOrder(text, ORDER_KEY.busy), `the order ${ORDER_KEY.busy}`).toBe(true);
    expect(text).toMatch(DIMENSION_SHOWN.channel);
    expect(showsAmount(spaced, EXPECTED.busy), `expected_fen ${EXPECTED.busy} as yuan`).toBe(true);
    expect(text).toMatch(SERVER_DECIDES);
    await click(action(modal, CANCEL));
    await settle();
    await waitFor(() => expect(clawbackDialogs()).toEqual([]));
    await settled(server);
    expect(server.requests('POST')).toEqual([]);
    expect(stepUpDialogs()).toEqual([]);
    expect(clawbackEntries(REF.busy).length, 'the entry is still usable').toBeGreaterThan(0);
  },
  FLOW_TIMEOUT,
);
