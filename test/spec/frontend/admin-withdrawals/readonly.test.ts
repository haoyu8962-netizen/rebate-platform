// @vitest-environment jsdom
import { cleanup } from '@testing-library/react';
import { expect, it } from 'vitest';
import { ALL_GRANTS, ID, NO, PAYEE, createServer, detailRoute } from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  WRITE,
  assertOnlyReads,
  assertReadOnly,
  detailShown,
  main,
  mount,
  openDetail,
  openList,
  revealEntries,
  settled,
  squash,
  textOf,
  usable,
} from './helpers.ts';

// Every test of this folder records all requests and renderings (helpers.ts afterEach): nothing
// but GET /admin/v1/withdrawals, GET /admin/v1/withdrawals/{id} and the common reads, and no
// unmasked phone number, payee account or payee name at any time. These tests press every entry.

it(
  '[AC-F1-08a-READONLY#1] 审核列表（账号持 withdraw.review、payout.execute、payout.manual_entry、export、pii.reveal_identity、pii.reveal_phone 等全部写与查看全量权限点）：没有可点的【批量通过】【批量手动打款】【批量自动打款】【导出】等写入口，点任何写入口或【查看】类入口都只发允许的 GET',
  async () => {
    const server = createServer(undefined, { permissions: ALL_GRANTS });
    await mount(server);
    await openList(server, NO.pending);
    await settled(server);
    await assertReadOnly(server);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08a-READONLY#2] 提现单详情（待审核、已通过待执行、微信等用户确认三种状态，全部写与查看全量权限点）：没有可点的【审核通过】【驳回】【执行打款】【手动成功】【撤销微信转账】【重新计算】，收款账号与手机号旁没有可点的【查看】，点任何这类入口都不发揭示或写请求、不出现完整账号 / 姓名 / 手机号',
  async () => {
    const { actions, click, REVEAL } = await import('./helpers.ts');
    const otherEntry = (node: HTMLElement) =>
      !/^(审核通过|驳回)$/.test(
        squash(node.getAttribute('aria-label')) || squash(node.textContent),
      );
    const cases = [
      { id: ID.pending, number: NO.pending, payee: PAYEE.pending },
      { id: ID.approved, number: NO.approved, payee: PAYEE.approved },
      { id: ID.paying, number: NO.paying, payee: PAYEE.paying },
    ];
    for (const { id, number, payee } of cases) {
      const server = createServer(undefined, { permissions: ALL_GRANTS });
      await mount(server, { route: detailRoute(id) });
      const area = await detailShown(server, id, number);
      expect(squash(textOf(area)), `${number}: the masked account`).toContain(
        squash(payee.masked_account),
      );
      expect(usable(main(), WRITE).filter(otherEntry), `${number}: no usable write entry`).toEqual(
        [],
      );
      expect(revealEntries(area), `${number}: no usable reveal entry`).toEqual([]);
      expect(usable(area, WRITE).filter(otherEntry), 'no usable write entry').toEqual([]);
      const pressable = [
        ...actions(area, WRITE).filter(otherEntry),
        ...actions(area, REVEAL),
        ...actions(area, /^查看/),
      ];
      for (const node of new Set(pressable)) if (node.isConnected) await click(node);
      await settled(server);
      expect(server.writes(), 'no request other than GET').toEqual([]);
      assertOnlyReads();
      cleanup();
    }
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08a-READONLY#3] 列表进详情一路（列表 → 【详情】 → 详情，全部权限点）只请求 GET /admin/v1/withdrawals 与 GET /admin/v1/withdrawals/{id}，不请求打款、导出、自动到账设置、风险标签重算或查看全量',
  async () => {
    const { actions, click, REVEAL } = await import('./helpers.ts');
    const otherEntry = (node: HTMLElement) =>
      !/^(审核通过|驳回)$/.test(
        squash(node.getAttribute('aria-label')) || squash(node.textContent),
      );
    const server = createServer(undefined, { permissions: ALL_GRANTS });
    await mount(server);
    const area = await openDetail(server, NO.failed, ID.failed);
    await settled(server);
    assertOnlyReads();
    expect(server.writes()).toEqual([]);
    expect(server.detailReads().every((read) => read.path.endsWith(ID.failed))).toBe(true);
    expect(usable(main(), WRITE).filter(otherEntry), 'no usable write entry').toEqual([]);
    expect(usable(area, WRITE).filter(otherEntry), 'no usable write entry').toEqual([]);
    expect(revealEntries(area), 'no usable reveal entry beside the masked values').toEqual([]);
    const pressable = [
      ...actions(area, WRITE).filter(otherEntry),
      ...actions(area, REVEAL),
      ...actions(area, /^查看/),
    ];
    for (const node of new Set(pressable)) if (node.isConnected) await click(node);
    await settled(server);
    expect(server.writes(), 'no request other than GET').toEqual([]);
    assertOnlyReads();
  },
  FLOW_TIMEOUT,
);
