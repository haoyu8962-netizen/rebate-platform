// @vitest-environment jsdom
import { formatFen, parseFen } from '@couli/money';
import { expect, it } from 'vitest';
import {
  GRANTS,
  INVALID,
  MANUAL,
  NOW,
  WHEN,
  approvedRows,
  assertRequest,
  button,
  click,
  confirm,
  dateInputValue,
  disabled,
  field,
  fill,
  fillRows,
  mount,
  notice,
  ok,
  open,
  paid,
  rowOf,
  select,
  serverFor,
  settled,
  verify,
} from './helpers.ts';

it(
  '[AC-F1-08al-VALIDATE#1] 任一行的三项必填缺失均提示并阻止整批提交，修正后才可确认',
  { timeout: 60_000 },
  async () => {
    const rows = approvedRows(2);
    const server = serverFor(rows);
    await mount(server);
    await select(rows);
    const modal = await open();
    expect(disabled(button(modal, '确认录入'))).toBe(true);
    await fillRows(modal, rows);
    for (const item of rows)
      for (const scenario of [
        { label: '通道流水号', error: INVALID.serialRequired },
        { label: '实付时间', error: INVALID.timeRequired },
        { label: '实付金额（元）', error: INVALID.amountRequired },
      ]) {
        const row = rowOf(modal, item.out_biz_no);
        const input = field(row, scenario.label);
        const previous = input.value;
        await fill(input, '');
        await notice(scenario.error, row);
        expect(disabled(button(modal, '确认录入'))).toBe(true);
        await click(button(modal, '确认录入'));
        expect(server.writes()).toEqual([]);
        await fill(input, previous);
        expect(disabled(button(modal, '确认录入'))).toBe(false);
      }
  },
);

it(
  '[AC-F1-08al-VALIDATE#2] 流水号去首尾空白、拒绝内部空白与 NUL 和超长；1 与 64 字符原样保留大小写',
  { timeout: 60_000 },
  async () => {
    const rows = approvedRows(2);
    const server = serverFor(rows);
    await mount(server);
    await select(rows);
    const modal = await open();
    const body = await fillRows(modal, rows);
    const row = rowOf(modal, rows[0]!.out_biz_no);
    const input = field(row, '通道流水号');
    for (const value of ['   ', 'A B', 'A\tB', 'A\u00a0B', 'A\u0000B', 'A'.repeat(65)]) {
      await fill(input, value);
      await notice(value.trim() === '' ? INVALID.serialRequired : INVALID.serial, row);
      expect(disabled(button(modal, '确认录入'))).toBe(true);
      await click(button(modal, '确认录入'));
      expect(server.writes()).toEqual([]);
    }
    await fill(input, ' x ');
    await fill(field(rowOf(modal, rows[1]!.out_biz_no), '通道流水号'), ` ${'Aa'.repeat(32)} `);
    body.items[0]!.channel_order_id = 'x';
    body.items[1]!.channel_order_id = 'Aa'.repeat(32);
    server.once('POST', MANUAL, () => ok({ items: paid(rows) }));
    await confirm(server, modal);
    await verify();
    await settled(server);
    assertRequest(server, body);
  },
);

it(
  '[AC-F1-08al-VALIDATE#3] 实付金额按整数分比较应付；少一分、多一分和申请总额均拒绝且不擅改输入',
  { timeout: 60_000 },
  async () => {
    const rows = approvedRows(2);
    const server = serverFor(rows);
    await mount(server);
    await select(rows);
    const modal = await open();
    await fillRows(modal, rows);
    const row = rowOf(modal, rows[1]!.out_biz_no);
    const input = field(row, '实付金额（元）');
    for (const value of [
      '98.00',
      '98.02',
      '0.00',
      '-98.01',
      formatFen(parseFen(rows[1]!.amount_fen)),
    ]) {
      await fill(input, value);
      await notice(INVALID.amount, row);
      expect(input.value).toBe(value);
      expect(disabled(button(modal, '确认录入'))).toBe(true);
      await click(button(modal, '确认录入'));
      expect(server.writes()).toEqual([]);
    }
    await fill(input, formatFen(parseFen(rows[1]!.net_fen)));
    expect(disabled(button(modal, '确认录入'))).toBe(false);
    expect(server.writes()).toEqual([]);
  },
);

it(
  '[AC-F1-08al-VALIDATE#4] 实付时间以注入时钟判断：晚一秒也拒绝，等于现在可提交且请求带时区',
  { timeout: 60_000 },
  async () => {
    const rows = approvedRows(1);
    const server = serverFor(rows);
    let current = Date.parse(NOW);
    const clock = { now: () => current };
    await mount(server, GRANTS, clock);
    await select(rows);
    const modal = await open();
    const body = await fillRows(modal, rows);
    const row = rowOf(modal, rows[0]!.out_biz_no);
    const input = field(row, '实付时间');
    await fill(input, dateInputValue(input, '2026-11-18T04:00:01.000Z'));
    await notice(INVALID.future, row);
    expect(disabled(button(modal, '确认录入'))).toBe(true);
    await click(button(modal, '确认录入'));
    expect(server.writes()).toEqual([]);
    // Moving only the injected clock also makes an otherwise historical value invalid.
    current = Date.parse('2026-11-18T03:29:59.000Z');
    await fill(input, dateInputValue(input, WHEN));
    await notice(INVALID.future, row);
    expect(disabled(button(modal, '确认录入'))).toBe(true);
    current = Date.parse(NOW);
    await fill(input, dateInputValue(input, NOW));
    body.items[0]!.paid_at = NOW;
    server.once('POST', MANUAL, () => ok({ items: paid(rows) }));
    await confirm(server, modal);
    await verify();
    await settled(server);
    assertRequest(server, body);
  },
);
