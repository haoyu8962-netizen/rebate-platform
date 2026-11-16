import { expect, it } from 'vitest';
import { filtersSummary } from './admin-exports.ts';
import { csvCell, csvRecord, LEDGER_EXPORT_HEADER, ledgerExportCells } from './export-worker.ts';

const USER = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c04';

it('[AC-CT-24zzm-UNIT#3] csvCell：裸整数（可带负号）原样，其余以公式字符开头的仍加前缀', () => {
  expect(csvCell('-500')).toBe('-500');
  expect(csvCell('1000')).toBe('1000');
  expect(csvCell('-1+2')).toBe("'-1+2");
  expect(csvCell('-')).toBe("'-");
  expect(csvCell('-1.5')).toBe("'-1.5");
  expect(csvCell('=1+1')).toBe("'=1+1");
  expect(csvCell('+100')).toBe("'+100");
  expect(csvCell(null)).toBe('');
});

it('[AC-CT-24zzm-UNIT#4] 流水一行 = 列表 item 的字段逐个：金额整数分带符号，可空列为空', () => {
  expect(LEDGER_EXPORT_HEADER).toHaveLength(14);
  const cells = ledgerExportCells({
    entry_id: '42',
    booked_at: '2026-10-08T05:00:00.000Z',
    accounting_date: '2026-10-08',
    ledger_type: 'WITHDRAW_FREEZE',
    sub_type: null,
    sub_account: 'available',
    amount_fen: -500,
    balance_after_fen: null,
    voucher: {
      voucher_id: 'v',
      uniq_key: 'WITHDRAW_FREEZE:w',
      biz_type: 'withdrawal',
      biz_id: 'w',
    },
    link: { type: 'withdrawal', id: 'w' },
  });
  expect(cells).toHaveLength(LEDGER_EXPORT_HEADER.length);
  expect(csvRecord(cells)).toBe(
    '42,2026-10-08T05:00:00.000Z,2026-10-08,WITHDRAW_FREEZE,,available,-500,,v,WITHDRAW_FREEZE:w,withdrawal,w,withdrawal,w\r\n',
  );
  const bare = ledgerExportCells({
    entry_id: '43',
    booked_at: '2026-10-08T05:00:00.000Z',
    accounting_date: '2026-10-08',
    ledger_type: 'REBATE_CREDIT',
    sub_type: 'DIRECT',
    sub_account: 'frozen',
    amount_fen: 1000,
    balance_after_fen: 0,
    voucher: { voucher_id: 'v', uniq_key: 'k', biz_type: 'FIXTURE', biz_id: 'b' },
    link: null,
  });
  expect(bare.slice(4, 8)).toEqual(['DIRECT', 'frozen', '1000', '0']);
  expect(bare.slice(12)).toEqual([null, null]);
});

it('[AC-CT-24zzm-UNIT#5] ledger 的筛选摘要含用户与各筛选', () => {
  expect(filtersSummary('ledger', { user_id: USER })).toBe(`用户：${USER}`);
  expect(
    filtersSummary('ledger', {
      user_id: USER,
      ledger_type: 'REBATE_CREDIT',
      sub_account: 'frozen',
      accounting_date_from: '2026-10-01',
      ref: 'r1',
    }),
  ).toBe(
    `用户：${USER}；流水类型：REBATE_CREDIT；子户：冻结；会计日：2026-10-01 至 不限；关联单号：r1`,
  );
});
