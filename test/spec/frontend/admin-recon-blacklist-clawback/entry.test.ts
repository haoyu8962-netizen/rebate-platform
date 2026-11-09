// @vitest-environment jsdom
import { cleanup } from '@testing-library/react';
import { expect, it } from 'vitest';
import { CLAW_GRANTS, ID, RECON_GRANTS, REF, VIEW_CLAW_GRANTS, createServer } from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  allClawbackEntries,
  awaitEntry,
  clawbackDialogs,
  click,
  clawbackEntries,
  mount,
  openDetail,
  settle,
  settled,
  stepUpDialogs,
} from './helpers.ts';

/** Clicks every (disabled) 【确认扣回】 of `ref`: none of them may open anything or send anything. */
async function pressDisabled(ref: string): Promise<void> {
  for (const node of allClawbackEntries(ref)) await click(node);
  await settle();
}

it(
  '[AC-F1-08ec-ENTRY#1] 持 fund.recon + order.blacklist_clawback：待处理 / 处理中的黑名单差错单详情有可用的【确认扣回】；已调账 / 已关闭的黑名单差错单与其他类型（账实不符、通道对账不一致）的待处理差错单都没有，点置灰的也不弹框、不发 POST',
  async () => {
    const server = createServer(undefined, { permissions: CLAW_GRANTS });
    await mount(server);
    for (const [ref, id] of [
      [REF.open, ID.open],
      [REF.busy, ID.busy],
    ] as const) {
      await openDetail(server, ref, id);
      await awaitEntry(ref);
    }
    for (const [ref, id] of [
      [REF.done, ID.done],
      [REF.closed, ID.closed],
      [REF.ledger, ID.ledger],
      [REF.channel, ID.channel],
    ] as const) {
      await openDetail(server, ref, id);
      expect(clawbackEntries(ref), `${ref} no usable 【确认扣回】`).toEqual([]);
      await pressDisabled(ref);
      expect(clawbackDialogs(), `${ref} no confirmation dialog`).toEqual([]);
    }
    await settled(server);
    expect(server.requests('POST')).toEqual([]);
    expect(stepUpDialogs()).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08ec-ENTRY#2] 不持 order.blacklist_clawback（只持 fund.recon）：待处理 / 处理中的黑名单差错单都没有可用的【确认扣回】，不发 POST；同样的差错单换成持该权限点的账号就有',
  async () => {
    const holder = createServer(undefined, { permissions: CLAW_GRANTS });
    await mount(holder);
    await openDetail(holder, REF.open, ID.open);
    await awaitEntry(REF.open);
    cleanup();

    const server = createServer(undefined, { permissions: RECON_GRANTS });
    await mount(server);
    for (const [ref, id] of [
      [REF.open, ID.open],
      [REF.busy, ID.busy],
    ] as const) {
      await openDetail(server, ref, id);
      expect(clawbackEntries(ref), `${ref} no usable 【确认扣回】 without the point`).toEqual([]);
      await pressDisabled(ref);
      expect(clawbackDialogs()).toEqual([]);
    }
    await settled(server);
    expect(server.requests('POST')).toEqual([]);
    expect(stepUpDialogs()).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08ec-ENTRY#3] 持 fund.view + order.blacklist_clawback（不持 fund.recon）：待处理的黑名单差错单详情照样有可用的【确认扣回】，只打开详情时不发 POST',
  async () => {
    const server = createServer(undefined, { permissions: VIEW_CLAW_GRANTS });
    await mount(server);
    await openDetail(server, REF.open, ID.open);
    await awaitEntry(REF.open);
    await settled(server);
    expect(server.requests('POST')).toEqual([]);
  },
  FLOW_TIMEOUT,
);
