// @vitest-environment jsdom
import { cleanup } from '@testing-library/react';
import { expect, it } from 'vitest';
import { ALL_GRANTS, ID, NO, PAYEE, createServer, detailRoute } from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  WRITE,
  assertOnlyReads,
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
import { assertReadOnlyLanded } from '../admin-withdrawal-batch-payout/frozen-moved/readonly-landed.ts';

// Every test of this folder records all requests and renderings (helpers.ts afterEach): nothing
// but GET /admin/v1/withdrawals, GET /admin/v1/withdrawals/{id} and the common reads, and no
// unmasked phone number, payee account or payee name at any time. These tests press every entry.

it(
  '[AC-F1-08a-READONLY#1] 审核列表（账号持 withdraw.review、payout.execute、payout.manual_entry、export、pii.reveal_identity、pii.reveal_phone 等全部写与查看全量权限点）：可用写入口恰为【一键组批】（F1-08an，不点），没有可点的【批量通过】【批量手动打款】【批量自动打款】【导出】等其他写入口，点其余写入口或【查看】类入口都只发允许的 GET',
  async () => {
    const server = createServer(undefined, { permissions: ALL_GRANTS });
    await mount(server);
    await openList(server, NO.pending);
    await settled(server);
    await assertReadOnlyLanded(server, {}, ['一键组批']);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08a-READONLY#2] 提现单详情（待审核、已通过待执行、微信等用户确认三种状态，全部写与查看全量权限点）：没有可点的【审核通过】【驳回】【撤销微信转账】【重新计算】，【执行打款】【手动成功】只在已通过待执行单上恰各 1 个（F1-08am），收款账号与手机号旁没有可点的【查看】，点其余这类入口都不发揭示或写请求、不出现完整账号 / 姓名 / 手机号',
  async () => {
    const { actions, click, REVEAL } = await import('./helpers.ts');
    const nameOf = (node: HTMLElement) =>
      squash(node.getAttribute('aria-label')) || squash(node.textContent);
    const otherEntry = (node: HTMLElement) => !/^(审核通过|驳回)$/.test(nameOf(node));
    // 【执行打款】【手动成功】 are not pressed here either (their flows: admin-withdrawal-detail-payout).
    const notPressed = (node: HTMLElement) =>
      !/^(审核通过|驳回|执行打款|手动成功)$/.test(nameOf(node));
    const PAYOUT_ENTRIES = ['执行打款', '手动成功'].sort();
    const cases = [
      { id: ID.pending, number: NO.pending, payee: PAYEE.pending, entries: [] as string[] },
      { id: ID.approved, number: NO.approved, payee: PAYEE.approved, entries: PAYOUT_ENTRIES },
      { id: ID.paying, number: NO.paying, payee: PAYEE.paying, entries: [] as string[] },
    ];
    for (const { id, number, payee, entries } of cases) {
      const server = createServer(undefined, { permissions: ALL_GRANTS });
      await mount(server, { route: detailRoute(id) });
      const area = await detailShown(server, id, number);
      expect(squash(textOf(area)), `${number}: the masked account`).toContain(
        squash(payee.masked_account),
      );
      expect(
        usable(main(), WRITE).filter(otherEntry).map(nameOf).sort(),
        `${number}: no usable write entry`,
      ).toEqual(entries);
      expect(revealEntries(area), `${number}: no usable reveal entry`).toEqual([]);
      expect(
        usable(area, WRITE).filter(otherEntry).map(nameOf).sort(),
        'no usable write entry',
      ).toEqual(entries);
      const pressable = [
        ...actions(area, WRITE).filter(notPressed),
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

it(
  '[AC-F1-08am-READONLY#1] 已通过待执行单（银行卡、没有转账尝试）的详情按权限点出入口：不持 payout.execute 与 payout.manual_entry 时（其余写与查看权限点照持，或只持查看）【执行打款】【手动成功】都不出现（隐藏，不是置灰）；持 payout.execute 不持 payout.manual_entry 时只出可用的【执行打款】；持 payout.manual_entry 不持 payout.execute 时只出可用的【手动成功】；都不点，只发允许的 GET、不出现完整账号 / 姓名 / 手机号',
  async () => {
    const { actions } = await import('./helpers.ts');
    const PAYOUT = /^(执行打款|手动成功)$/;
    const nameOf = (node: HTMLElement) =>
      squash(node.getAttribute('aria-label')) || squash(node.textContent);
    const others = ALL_GRANTS.filter(
      (point) => point !== 'payout.execute' && point !== 'payout.manual_entry',
    );
    const viewOnly = ALL_GRANTS.filter(
      (point) => point === 'withdraw.review' || point === 'fund.view',
    );
    const cases = [
      { label: 'all but payout.*', permissions: others, want: [] as string[] },
      { label: 'view only', permissions: viewOnly, want: [] as string[] },
      {
        label: 'payout.execute',
        permissions: [...others, 'payout.execute' as const],
        want: ['执行打款'],
      },
      {
        label: 'payout.manual_entry',
        permissions: [...others, 'payout.manual_entry' as const],
        want: ['手动成功'],
      },
    ];
    for (const { label, permissions, want } of cases) {
      const server = createServer(undefined, { permissions });
      await mount(server, { route: detailRoute(ID.approved) });
      const area = await detailShown(server, ID.approved, NO.approved);
      await settled(server);
      expect(actions(area, PAYOUT).map(nameOf).sort(), `${label}: shown entries`).toEqual(want);
      expect(usable(area, PAYOUT).map(nameOf).sort(), `${label}: usable entries`).toEqual(want);
      expect(server.writes(), `${label}: no request other than GET`).toEqual([]);
      assertOnlyReads();
      cleanup();
    }
  },
  FLOW_TIMEOUT * 2,
);

it(
  '[AC-F1-08an-READONLY#1] 审核列表按权限点出【一键组批】：全部权限点（含 payout.execute）时恰 1 个且可用；不持 payout.execute（其余写与查看权限点照持）时不出现（隐藏，不是置灰）；未勾选时都没有【批量自动打款】；都不点，只发允许的 GET',
  async () => {
    const { actions } = await import('./helpers.ts');
    const GROUP = /^一键组批$/;
    const AUTO = /^批量自动打款$/;
    const cases = [
      { label: 'all grants', permissions: ALL_GRANTS, want: 1 },
      {
        label: 'all but payout.execute',
        permissions: ALL_GRANTS.filter((point) => point !== 'payout.execute'),
        want: 0,
      },
    ];
    for (const { label, permissions, want } of cases) {
      const server = createServer(undefined, { permissions });
      await mount(server);
      await openList(server, NO.pending);
      await settled(server);
      expect(actions(main(), GROUP), `${label}: shown 一键组批`).toHaveLength(want);
      expect(usable(main(), GROUP), `${label}: usable 一键组批`).toHaveLength(want);
      expect(actions(main(), AUTO), `${label}: no 批量自动打款 without a selection`).toEqual([]);
      expect(server.writes(), `${label}: no request other than GET`).toEqual([]);
      assertOnlyReads();
      cleanup();
    }
  },
  FLOW_TIMEOUT * 2,
);
