// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import {
  ADJ,
  ADJUSTMENT_ORDER,
  COLUMN,
  FIELD,
  TEXT,
  VIEW_GRANTS,
  WRITEOFF_COLUMN,
  WRITEOFF_ORDER,
  createServer,
} from './fixtures.ts';
import {
  column,
  fields,
  mount,
  openDetail,
  openTab,
  panel,
  settled,
  waitColumn,
} from './helpers.ts';

// The console dictionary without any row (as in [AC-F1-08d-DICT#1]): every status and reason
// name falls back to its code, the whole cell being the code.
vi.mock('../../../../contracts/texts.admin.default.json', () => ({ default: { texts: {} } }));

it(
  '[AC-F1-08ca-DICT#1] 后台字典缺行时：调账单的原因、状态列与详情、候选单的状态列整格显示原编码（如 PAYOUT_RECOVERY / APPROVED / PENDING），不显示键路径或空白',
  { timeout: 60_000 },
  async () => {
    const server = createServer({ permissions: VIEW_GRANTS });
    await mount(server);
    await waitColumn(COLUMN.id, ADJUSTMENT_ORDER);
    await settled(server);
    expect(column(panel(), COLUMN.reason)).toEqual([
      'ACCOUNT_CLOSED',
      'PAYOUT_RECOVERY',
      'PAYOUT_RECOVERY',
      'RECON_FIX',
      'ACCOUNT_CLOSED',
      'OTHER',
      'RESTORE',
      'ACCOUNT_CLOSED',
    ]);
    expect(column(panel(), COLUMN.status)).toEqual([
      'PENDING',
      'APPROVED',
      'APPROVED',
      'APPROVED',
      'REJECTED',
      'APPROVED',
      'APPROVED',
      'CANCELLED',
    ]);

    const sheet = await openDetail(server, ADJ.recovery);
    expect(fields(sheet, [FIELD.reason, FIELD.status])).toEqual({
      [FIELD.reason]: 'PAYOUT_RECOVERY',
      [FIELD.status]: 'APPROVED',
    });

    await openTab(TEXT.writeoffsTab);
    await waitColumn(WRITEOFF_COLUMN.id, WRITEOFF_ORDER);
    expect(column(panel(), WRITEOFF_COLUMN.status)).toEqual([
      'PENDING',
      'PENDING',
      'APPROVED',
      'CANCELLED',
    ]);
  },
);
