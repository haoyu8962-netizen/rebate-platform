// @vitest-environment jsdom
// F1-08fa 后台字典（BR-TEXT-25 `admin_dict.<enum>.<code>`，任务依据摘录 第 3 条）：流水类型与子户
// 的中文名只取字典，缺行显示编码。这里把随包字典换成一份只有部分行的字典：有行的显示字典名，
// 没行的显示编码；筛选下拉同样用字典名，选中后请求里仍是编码。子类型的字典键尚未定（契约线补），
// 样例只用字典里没有任何对应行的子类型，所以显示编码。
import { expect, it, vi } from 'vitest';
import {
  ENTRIES,
  FILTER_LABEL,
  FREED,
  FROZE,
  PAGE_SIZE,
  UID,
  createServer,
  holdName,
  rowShown,
  subAccountName,
  summaryShown,
  typeName,
} from './fixtures.ts';
import {
  applyFilters,
  choose,
  filterForm,
  mountLedger,
  queryUser,
  summaryPairs,
  tableRows,
} from './helpers.ts';

vi.mock('../../../../contracts/texts.admin.default.json', () => ({
  default: {
    version: 1,
    texts: {
      'admin_dict.ledger_type.CLAWBACK': '订单扣回',
      'admin_dict.ledger_type.WITHDRAW_FREEZE': '提现冻结',
      'admin_dict.ledger_type.REFERRAL_CREDIT': '邀请分佣入账',
      'admin_dict.ledger_sub_account.available': '可用',
      'admin_dict.ledger_sub_account.frozen': '冻结',
      'admin_dict.withdraw_hold_kind.manual': '人工冻结',
    },
    fallbacks: {},
  },
}));

it(
  '[AC-F1-08fa-DICT#1] 字典有行：流水类型、子户、冻结种类显示字典名；没行的类型（WITHDRAW_FEE、REWARD）与冻结种类（recon_diff）显示编码',
  { timeout: 60_000 },
  async () => {
    // The oracle reads the same (mocked) dictionary.
    expect(typeName('CLAWBACK')).toBe('订单扣回');
    expect(typeName('REWARD')).toBe('REWARD');
    expect(subAccountName('frozen')).toBe('冻结');
    expect(holdName('manual')).toBe('人工冻结');
    expect(holdName('recon_diff')).toBe('recon_diff');
    const server = createServer();
    await mountLedger(server);
    await queryUser(server, UID);
    expect(summaryPairs()).toEqual(summaryShown(UID));
    expect(summaryPairs().at(-1)).toEqual(['提现限制', '人工冻结、recon_diff']);
    expect(tableRows()).toEqual(ENTRIES.map(rowShown));
    expect(tableRows().map((cells) => [cells[2], cells[3], cells[4]])).toEqual([
      ['订单扣回', 'PART_REFUND', '可用'],
      ['提现冻结', '—', '冻结'],
      ['提现冻结', '—', '可用'],
      ['WITHDRAW_FEE', '—', '冻结'],
      ['REWARD', 'invite', '可用'],
      ['邀请分佣入账', 'INDIRECT', '可用'],
    ]);
  },
);

it(
  '[AC-F1-08fa-DICT#2] 筛选下拉用字典名：选「提现冻结」「冻结」后请求里是 ledger_type=WITHDRAW_FREEZE、sub_account=frozen',
  { timeout: 60_000 },
  async () => {
    const server = createServer();
    await mountLedger(server);
    await queryUser(server, UID);
    await choose(filterForm(), FILTER_LABEL.ledgerType, '提现冻结');
    await choose(filterForm(), FILTER_LABEL.subAccount, '冻结');
    await applyFilters(server);
    expect(server.ledgerQueries().at(-1)).toEqual({
      user_id: UID,
      ledger_type: 'WITHDRAW_FREEZE',
      sub_account: 'frozen',
      page: '1',
      page_size: PAGE_SIZE,
    });
    expect(tableRows()).toEqual([rowShown(FROZE)]);
    expect(FREED.sub_account).toBe('available');
  },
);
