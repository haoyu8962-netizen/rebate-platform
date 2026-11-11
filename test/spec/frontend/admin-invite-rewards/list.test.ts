// @vitest-environment jsdom
// F1-15b: the read-only record subpage /invite-rewards (01 F-ADM-27, 04 §6.6 invite-rewards):
// GET /admin/v1/invite-rewards page by page; each row shows both masked phones as given, the
// amount per party in yuan, source, qualification, trigger order and time, status, both parties'
// results, the reasons by Chinese name (never the raw enum code) and the posting time. A subpage
// of 配置中心: no new sidebar item.
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { formatYuanAdmin } from '../../../../packages/money/src/index.ts';
import {
  BOTH_SKIPPED,
  DEFERRED,
  EXPIRED,
  INVITER_PHONE,
  MIRRORED,
  OTHER_INVITER_PHONE,
  PROCESSED,
  QUALIFIED,
  REWARDS,
  VOIDED,
  createRewardServer,
} from './fixtures.ts';
import {
  MINOR_REASON,
  RISK_REASON,
  SUBPAGE,
  breadcrumb,
  byParty,
  cellUnder,
  expectParties,
  firstPageSize,
  headers,
  listQueries,
  listed,
  mainElement,
  menuLink,
  menuNames,
  mountAt,
  rawCodesIn,
  rowOf,
  rowUnits,
  settled,
  sidebarLinksTo,
  squash,
  superMenuNames,
  writeControls,
} from './helpers.ts';

it(
  '[AC-F1-15b-LIST#1] 直达 /invite-rewards：首次只带 page 与 page_size 请求发放记录，面包屑与侧栏高亮归配置中心，侧栏菜单清单不变',
  { timeout: 40_000 },
  async () => {
    const server = createRewardServer();
    await mountAt(server, SUBPAGE);
    await listed(PROCESSED.invitee_phone_masked);
    await settled(server);
    expect(window.location.pathname).toBe(SUBPAGE);
    const queries = listQueries(server);
    expect(queries.length).toBeGreaterThan(0);
    expect(Object.keys(queries[0] ?? {}).sort()).toEqual(['page', 'page_size']);
    expect(queries[0]?.['page']).toBe('1');
    firstPageSize(server);
    expect(breadcrumb().slice(0, 2)).toEqual(['规则与配置', '配置中心']);
    expect(breadcrumb()).toHaveLength(3);
    expect(breadcrumb()[2]).toMatch(/发放记录/);
    expect(menuLink('配置中心').getAttribute('aria-current')).toBe('page');
    expect(menuNames()).toEqual(superMenuNames());
    expect(sidebarLinksTo(SUBPAGE)).toEqual([]);
  },
);

it(
  '[AC-F1-15b-LIST#2] 表头含被邀请人、邀请人、金额、来源、资格、触发、状态、结果、原因与到账时间',
  { timeout: 40_000 },
  async () => {
    const server = createRewardServer();
    await mountAt(server, SUBPAGE);
    await listed(PROCESSED.invitee_phone_masked);
    const titles = headers();
    const has = (pattern: RegExp) => titles.some((title) => pattern.test(title));
    expect(has(/被邀请人/), '被邀请人 column').toBe(true);
    expect(
      titles.some((title) => /邀请人/.test(title.replace(/被邀请人/g, ''))),
      '邀请人 column',
    ).toBe(true);
    for (const pattern of [/金额/, /来源|渠道/, /资格/, /触发/, /状态/, /结果/, /原因/, /到账/])
      expect(has(pattern), `column ${String(pattern)}`).toBe(true);
  },
);

it(
  '[AC-F1-15b-LIST#3] 已处理一行：脱敏手机号原样、每方金额按后台金额格式、北京时间、触发订单、来源与两方结果、不发原因中文名',
  { timeout: 40_000 },
  async () => {
    const server = createRewardServer();
    await mountAt(server, SUBPAGE);
    const row = await listed(PROCESSED.invitee_phone_masked);
    const text = squash(row.textContent);
    expect(text).toContain(squash(PROCESSED.invitee_phone_masked));
    expect(text).toContain(squash(INVITER_PHONE));
    expect(text).toContain(squash(formatYuanAdmin(1000n)));
    expect(text).toContain(squash('2026-10-20 10:00'));
    expect(text).toContain(squash('2026-11-25 09:00'));
    expect(text).toContain(PROCESSED.trigger_order_id);
    expect(text, 'bind source landing').toMatch(/落地页/);
    expect(text, 'status processed').toMatch(/处理/);
    expect(text, 'invitee granted').toMatch(/已发/);
    expect(text, 'inviter skipped').toMatch(/不发/);
    expect(text, 'skip reason risk_restricted').toMatch(/封禁|申诉|冻结|风控|受限|限制/);
    expect(rawCodesIn(row)).toEqual([]);
  },
);

it(
  '[AC-F1-15b-LIST#4] 作废、双方不发、待触发、顺延、已过期各行显示状态与原因的中文名，页面不出现任何原始枚举码',
  { timeout: 40_000 },
  async () => {
    const server = createRewardServer();
    await mountAt(server, SUBPAGE);
    await listed(PROCESSED.invitee_phone_masked);
    const voided = squash(rowOf(VOIDED.invitee_phone_masked).textContent);
    expect(voided, 'status voided').toMatch(/作废/);
    expect(voided, 'void reason order_clawed_back').toMatch(/扣回/);
    expect(voided, 'bind source backfill').toMatch(/补填/);
    const skipped = squash(rowOf(BOTH_SKIPPED.invitee_phone_masked).textContent);
    expect(skipped).toContain(squash(OTHER_INVITER_PHONE));
    expect(skipped).toContain(squash(formatYuanAdmin(1234n)));
    expect(skipped, 'both not paid').toMatch(/不发/);
    expect(skipped, 'skip reason same_device').toMatch(/同设备/);
    expect(skipped, 'nobody paid').not.toMatch(/已发/);
    const qualified = squash(rowOf(QUALIFIED.invitee_phone_masked).textContent);
    expect(qualified, 'status qualified').toMatch(/资格|待触发|等触发/);
    expect(qualified, 'bind source register').toMatch(/注册/);
    expect(qualified).toContain(squash('2026-10-19 20:30'));
    expect(squash(rowOf(DEFERRED.invitee_phone_masked).textContent), 'deferred').toMatch(/顺延/);
    expect(squash(rowOf(EXPIRED.invitee_phone_masked).textContent), 'expired').toMatch(/过期/);
    expect(rawCodesIn(mainElement())).toEqual([]);
  },
);

it(
  '[AC-F1-15b-LIST#5] 只读：页面没有补发、修改、作废等写操作按钮，浏览只发 GET',
  { timeout: 40_000 },
  async () => {
    const server = createRewardServer();
    await mountAt(server, SUBPAGE);
    await listed(PROCESSED.invitee_phone_masked);
    await settled(server);
    expect(writeControls(mainElement()).map((node) => squash(node.textContent))).toEqual([]);
    expect(server.log.filter((request) => request.method !== 'GET')).toEqual([]);
    expect(
      server.rewardRequests().every((request) => request.path === REWARDS),
      'the list alone, no detail read before one is asked for',
    ).toBe(true);
  },
);

it(
  '[AC-F1-15b-LIST#6] 列表按服务端顺序（取得资格时间新的在前）逐行显示，六条都在',
  { timeout: 40_000 },
  async () => {
    const server = createRewardServer();
    await mountAt(server, SUBPAGE);
    await listed(PROCESSED.invitee_phone_masked);
    const order = [VOIDED, PROCESSED, QUALIFIED, BOTH_SKIPPED, DEFERRED, EXPIRED].map(
      (record) => record.invitee_phone_masked,
    );
    await waitFor(() => {
      const shown = Array.from(mainElement().querySelectorAll('tbody tr'))
        .map((node) => order.find((phone) => (node.textContent ?? '').includes(phone)))
        .filter((phone) => phone !== undefined);
      expect(shown).toEqual(order);
    });
  },
);

it(
  '[AC-F1-15b-LIST#7] 两方结果与不发原因各归各方：按表头或单元格内的邀请人、被邀请人标注取每方内容，两方互换显示即不过',
  { timeout: 40_000 },
  async () => {
    const server = createRewardServer({ records: [PROCESSED, MIRRORED] });
    await mountAt(server, SUBPAGE);
    await listed(PROCESSED.invitee_phone_masked);
    await listed(MIRRORED.invitee_phone_masked);
    // PROCESSED: inviter skipped (risk_restricted), invitee granted.
    const first = byParty(rowUnits(rowOf(PROCESSED.invitee_phone_masked)));
    expectParties(first, 'inviter', RISK_REASON);
    // MIRRORED: inviter granted, invitee skipped (minor).
    const second = byParty(rowUnits(rowOf(MIRRORED.invitee_phone_masked)));
    expectParties(second, 'invitee', MINOR_REASON);
  },
);

it(
  '[AC-F1-15b-LIST#8] 到账时间列显示 granted_at 而不是触发时间；granted_at 为空时显示不含时间的占位',
  { timeout: 40_000 },
  async () => {
    const server = createRewardServer({ records: [MIRRORED, DEFERRED, BOTH_SKIPPED] });
    await mountAt(server, SUBPAGE);
    // MIRRORED: triggered 2026-11-22 14:00, posted 2026-11-23 00:05:30 (+08:00).
    const posted = cellUnder(await listed(MIRRORED.invitee_phone_masked), /到账/);
    expect(posted).toContain(squash('2026-11-23 00:05'));
    expect(posted, 'not the trigger time').not.toContain(squash('2026-11-22 14:00'));
    // Triggered but nobody paid yet (deferred) or nobody paid at all (both skipped).
    for (const record of [DEFERRED, BOTH_SKIPPED]) {
      const pending = cellUnder(await listed(record.invitee_phone_masked), /到账/);
      expect(pending, `${record.status} placeholder`).not.toBe('');
      expect(pending, `${record.status} shows no time`).not.toMatch(/\d/);
    }
  },
);
