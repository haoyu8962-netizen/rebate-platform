// @vitest-environment jsdom
// F1-15b: 【详情】 of a row opens a drawer (antd Drawer or Modal) that reads the record again by
// invitee (GET /admin/v1/invite-rewards/{invitee_id}, adminGetInviteReward) and shows what that
// read returned; 30701 shows the empty state of 「无记录」; nothing in it writes.
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { formatYuanAdmin } from '../../../../packages/money/src/index.ts';
import {
  DEFERRED,
  INVITER_PHONE,
  MIRRORED,
  PROCESSED,
  REWARDS,
  createRewardServer,
  failure,
  reward,
} from './fixtures.ts';
import {
  MINOR_REASON,
  RISK_REASON,
  SUBPAGE,
  byParty,
  click,
  detailControl,
  detailDialog,
  dialogUnits,
  expectParties,
  listed,
  mountAt,
  rawCodesIn,
  settled,
  squash,
  writeControls,
} from './helpers.ts';

it(
  '[AC-F1-15b-DETAIL#1] 详情按 invitee_id 读单条，抽屉显示两方手机号、金额、有效期天数、来源、触发订单、两方结果与不发原因',
  { timeout: 40_000 },
  async () => {
    const server = createRewardServer();
    await mountAt(server, SUBPAGE);
    const row = await listed(PROCESSED.invitee_phone_masked);
    await click(detailControl(row));
    const path = `${REWARDS}/${PROCESSED.invitee_id}`;
    await waitFor(() => expect(server.requests('GET', path)).toHaveLength(1));
    const drawer = await detailDialog();
    await waitFor(() => expect(squash(drawer.textContent)).toContain(PROCESSED.trigger_order_id));
    const text = squash(drawer.textContent);
    expect(text).toContain(squash(PROCESSED.invitee_phone_masked));
    expect(text).toContain(squash(INVITER_PHONE));
    expect(text).toContain(squash(formatYuanAdmin(1000n)));
    expect(text, 'eligibility days').toMatch(/30天/);
    expect(text).toContain(squash('2026-10-20 10:00'));
    expect(text).toContain(squash('2026-11-25 09:00'));
    expect(text, 'bind source landing').toMatch(/落地页/);
    expect(text, 'invitee granted').toMatch(/已发/);
    expect(text, 'inviter skipped').toMatch(/不发/);
    expect(text, 'skip reason risk_restricted').toMatch(/封禁|申诉|冻结|风控|受限|限制/);
    expect(rawCodesIn(drawer)).toEqual([]);
    expect(writeControls(drawer).map((node) => squash(node.textContent))).toEqual([]);
    await settled(server);
    expect(server.requests('GET', path)).toHaveLength(1);
    expect(server.log.filter((request) => request.method !== 'GET')).toEqual([]);
  },
);

it(
  '[AC-F1-15b-DETAIL#2] 详情显示单条接口的最新结果，而不是列表行里的旧状态',
  { timeout: 40_000 },
  async () => {
    const server = createRewardServer();
    await mountAt(server, SUBPAGE);
    const row = await listed(DEFERRED.invitee_phone_masked);
    expect(squash(row.textContent)).toMatch(/顺延/);
    // Paid in the meantime: the next read returns the processed record.
    const index = server.state.records.findIndex(
      (record) => record.invitee_id === DEFERRED.invitee_id,
    );
    expect(index).toBeGreaterThanOrEqual(0);
    server.state.records[index] = reward(DEFERRED.invitee_id, DEFERRED.invitee_phone_masked, {
      ...DEFERRED,
      status: 'processed',
      inviter_result: 'granted',
      invitee_result: 'granted',
      granted_at: '2026-11-26T00:00:10+08:00',
    });
    await click(detailControl(row));
    await waitFor(() =>
      expect(server.requests('GET', `${REWARDS}/${DEFERRED.invitee_id}`)).toHaveLength(1),
    );
    const drawer = await detailDialog();
    await waitFor(() => expect(squash(drawer.textContent)).toContain(squash('2026-11-26 00:00')));
    expect(squash(drawer.textContent)).toMatch(/已发/);
    expect(squash(drawer.textContent)).not.toMatch(/顺延/);
  },
);

it(
  '[AC-F1-15b-DETAIL#3] 单条读到 30701 显示无记录空态，不自动重发',
  { timeout: 40_000 },
  async () => {
    const server = createRewardServer();
    const path = `${REWARDS}/${PROCESSED.invitee_id}`;
    server.once('GET', path, () => failure(30701, null, '内容不存在'));
    await mountAt(server, SUBPAGE);
    const row = await listed(PROCESSED.invitee_phone_masked);
    await click(detailControl(row));
    const drawer = await detailDialog();
    await waitFor(() =>
      expect(squash(drawer.textContent)).toMatch(/无记录|暂无|没有.*记录|不存在/),
    );
    await settled(server);
    expect(server.requests('GET', path)).toHaveLength(1);
    expect(squash(drawer.textContent)).not.toContain(PROCESSED.trigger_order_id);
  },
);

it(
  '[AC-F1-15b-DETAIL#4] 详情里两方结果与不发原因各归各方：邀请人不发（风控受限）、被邀请人已发，互换显示即不过',
  { timeout: 40_000 },
  async () => {
    const server = createRewardServer({ records: [PROCESSED, MIRRORED] });
    await mountAt(server, SUBPAGE);
    await click(detailControl(await listed(PROCESSED.invitee_phone_masked)));
    const drawer = await detailDialog();
    await waitFor(() => expect(squash(drawer.textContent)).toContain(PROCESSED.trigger_order_id));
    expectParties(byParty(dialogUnits(drawer)), 'inviter', RISK_REASON);
  },
);

it(
  '[AC-F1-15b-DETAIL#5] 详情里两方结果与不发原因各归各方：邀请人已发、被邀请人不发（未满 18 周岁），互换显示即不过',
  { timeout: 40_000 },
  async () => {
    const server = createRewardServer({ records: [PROCESSED, MIRRORED] });
    await mountAt(server, SUBPAGE);
    await click(detailControl(await listed(MIRRORED.invitee_phone_masked)));
    const drawer = await detailDialog();
    await waitFor(() => expect(squash(drawer.textContent)).toContain(MIRRORED.trigger_order_id));
    expectParties(byParty(dialogUnits(drawer)), 'invitee', MINOR_REASON);
  },
);
