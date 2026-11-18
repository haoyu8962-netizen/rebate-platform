// @vitest-environment jsdom
// F1-08fd 要的行为 2: 发起时间 (Beijing days) is sent on 【查询】 as created_at bounds the
// contract takes (ISO 8601 with offset): `from` = the first day 00:00:00+08:00 (inclusive), `to`
// = the day after the last day 00:00:00+08:00 (exclusive); one end given, only that end is sent
// (the contract does not ask for both). Typing alone sends nothing and keeps the rows.
import { expect, it } from 'vitest';
import {
  FROM_DAY,
  FROM_SENT,
  TO_DAY,
  TO_SENT,
  createServer,
  exportRow,
  ids,
  listQuery,
} from './exports-fixtures.ts';
import {
  leaveTime,
  mount,
  query,
  reads,
  readsDone,
  rowIds,
  rowsAre,
  timeInputs,
  typeDay,
  unmount,
} from './exports-helpers.ts';

/** 2026-10-20 00:00:00 Beijing: outside (to is exclusive). */
const AT_END = exportRow('exp_TimeAtEnd00001', 'done', { created_at: '2026-10-19T16:00:00Z' });
/** 2026-10-19 23:59:59 Beijing: inside. */
const LAST_SECOND = exportRow('exp_TimeLastSec001', 'failed', {
  created_at: '2026-10-19T15:59:59Z',
});
/** 2026-10-18 00:00:00 Beijing: inside (from is inclusive). */
const AT_START = exportRow('exp_TimeAtStart001', 'done', { created_at: '2026-10-17T16:00:00Z' });
/** 2026-10-17 23:59:59 Beijing: outside. */
const BEFORE = exportRow('exp_TimeBefore001', 'cancelled', { created_at: '2026-10-17T15:59:59Z' });
const TASKS = [AT_END, LAST_SECOND, AT_START, BEFORE];

it(
  '[AC-F1-08fd-TIME#1] 发起时间选起止日按【查询】带 from=起日 00:00:00+08:00、to=止日次日 00:00:00+08:00（from 含 to 不含），未按查询不发请求不改列表',
  { timeout: 120_000 },
  async () => {
    const server = createServer(undefined, TASKS);
    await mount(server);
    await readsDone(server, 1);
    await rowsAre(ids(TASKS));

    const [start, end] = timeInputs();
    await typeDay(start!, FROM_DAY);
    await typeDay(end!, TO_DAY);
    await leaveTime();
    expect(reads(server)).toHaveLength(1);
    expect(rowIds()).toEqual(ids(TASKS));

    await query(server);
    expect(reads(server)).toEqual([listQuery(), listQuery({ from: FROM_SENT, to: TO_SENT })]);
    await rowsAre([LAST_SECOND.id, AT_START.id]);
  },
);

it(
  '[AC-F1-08fd-TIME#2] 发起时间只填起日只带 from、只填止日只带 to',
  { timeout: 120_000 },
  async () => {
    const first = createServer(undefined, TASKS);
    await mount(first);
    await readsDone(first, 1);
    await rowsAre(ids(TASKS));
    const [start] = timeInputs();
    await typeDay(start!, FROM_DAY);
    await leaveTime();
    expect(reads(first)).toHaveLength(1);
    await query(first);
    expect(reads(first)).toEqual([listQuery(), listQuery({ from: FROM_SENT })]);
    await rowsAre([AT_END.id, LAST_SECOND.id, AT_START.id]);

    unmount();
    const second = createServer(undefined, TASKS);
    await mount(second);
    await readsDone(second, 1);
    await rowsAre(ids(TASKS));
    const [, end] = timeInputs();
    await typeDay(end!, TO_DAY);
    await leaveTime();
    expect(reads(second)).toHaveLength(1);
    await query(second);
    expect(reads(second)).toEqual([listQuery(), listQuery({ to: TO_SENT })]);
    await rowsAre([LAST_SECOND.id, AT_START.id, BEFORE.id]);
  },
);
