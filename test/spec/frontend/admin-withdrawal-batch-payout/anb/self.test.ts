// @vitest-environment jsdom
// F1-08anb SELF（BR-WDR-11：不要求执行人 ≠ 审核人，一人即可完成整个流程；例：财务甲审核单 X 后把 X 放进自己执行的
// 批次 → 照常执行）：登录会话的管理员（refine getIdentity 的 admin_id）就是某张待执行单的 reviewer_id。这张单的勾选框
// 可用；只勾它 → 一次动态码 → 恰 1 笔 POST，withdrawal_ids 恰为这张单；没有「执行人不能是审核人」类提示。
// 约定见 ../helpers.ts 与 ./helpers.ts 开头。
import { cleanup, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  EXECUTOR,
  SUPER,
  TEXT,
  VERIFY,
  assertBatch,
  checkbox,
  confirm,
  disabled,
  executedReply,
  openBatch,
  resultShown,
  row,
  select,
  serverFor,
  settled,
  shows,
  verify,
  writes,
} from '../helpers.ts';
import { ONE_BATCH, OTHER_ADMIN, SELF_ADMIN, mountAs, writeLines } from './helpers.ts';

/** Hints that the reviewer may not execute (cancelled by BR-WDR-11 / ADD-05). */
const SAME_PERSON_HINTS: readonly string[] = [
  '执行人不能是审核人',
  '不能执行自己审核',
  '审核人与执行人',
  '同一人',
  '需他人',
];

it(
  '[AC-F1-08anb-SELF#1] 登录会话的管理员 id 等于某张待执行单的 reviewer_id（持 payout.execute 的账号与超管各一次）：这张单的勾选框可用；只勾它 → 确认 → 一次动态码 → 恰 1 笔 POST /admin/v1/payout-batches，withdrawal_ids 恰为 [这张单]；没有「执行人不能是审核人」类提示；结果为「已发起打款」',
  { timeout: 180_000 },
  async () => {
    for (const who of [EXECUTOR, SUPER]) {
      const label = who.isSuper ? 'super' : 'payout.execute';
      const other = row(1, 'APPROVED', 1234567, 'alipay', {
        ['reviewer_id']: OTHER_ADMIN,
        ['reviewed_at']: '2026-11-19T09:00:00+08:00',
      });
      const mine = row(2, 'APPROVED', 9801, 'bank_card', {
        ['reviewer_id']: SELF_ADMIN,
        ['reviewed_at']: '2026-11-19T09:30:00+08:00',
      });
      const server = serverFor([other, mine]);
      server.once('POST', '/admin/v1/payout-batches', () =>
        executedReply(server, [mine.withdrawal_id]),
      );
      const direct = await mountAs(server, who, SELF_ADMIN);
      expect(server.state[1]!.reviewer_id, `${label}: reviewed by the signed-in admin`).toBe(
        SELF_ADMIN,
      );

      const box = checkbox(mine);
      expect(disabled(box), `${label}: the self-reviewed row can be ticked`).toBe(false);
      await select([mine]);
      const modal = await openBatch(server);
      for (const hint of SAME_PERSON_HINTS)
        expect(shows(document.body, hint), `${label}: no hint ${hint}`).toBe(false);
      await confirm(server, modal);
      await verify();
      await waitFor(() => expect(writes(server)).toHaveLength(1));
      await settled(server);

      expect(server.requests('POST', VERIFY), `${label}: one dynamic code`).toHaveLength(1);
      expect(writes(server), `${label}: one batch write`).toHaveLength(1);
      assertBatch(server, 0, [mine.withdrawal_id]);
      expect(writes(server)[0]!.body).toEqual({ withdrawal_ids: [mine.withdrawal_id] });
      expect(writeLines(server), `${label}: nothing else written`).toEqual(ONE_BATCH);
      await resultShown(mine.out_biz_no, TEXT.paying);
      for (const hint of SAME_PERSON_HINTS)
        expect(shows(document.body, hint), `${label}: no hint ${hint}`).toBe(false);
      expect(direct, `${label}: no direct fetch`).not.toHaveBeenCalled();
      cleanup();
    }
  },
);
