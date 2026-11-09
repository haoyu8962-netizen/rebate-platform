// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { BLACKLIST_TYPE, ID, OTHER_TYPE_NAME, REF, createServer } from './fixtures.ts';
import {
  BLACKLIST_NAME,
  COLUMN,
  FLOW_TIMEOUT,
  LABEL,
  cellText,
  choose,
  main,
  mount,
  openDetail,
  openDiffs,
  query,
  rowsOf,
  scope,
  settled,
  squash,
} from './helpers.ts';

it(
  '[AC-F1-08ec-TYPE#1] 差错单列表与详情把 blacklist_after_credit 显示为中文名称（含「黑名单」，取自 texts/recon.ts），页面上不出现原始枚举值；其他类型照旧显示后台字典名',
  async () => {
    const server = createServer();
    await mount(server);
    await openDiffs(server, REF.open);
    await settled(server);
    for (const ref of [REF.open, REF.busy, REF.done, REF.closed]) {
      const name = cellText(ref, COLUMN.type);
      expect(name, `${ref} type is shown by its Chinese name`).toMatch(BLACKLIST_NAME);
      expect(name, `${ref} no raw enum value`).not.toContain(BLACKLIST_TYPE);
    }
    expect(squash(cellText(REF.ledger, COLUMN.type))).toContain(OTHER_TYPE_NAME.ledger_mismatch);
    expect(squash(cellText(REF.channel, COLUMN.type))).toContain(OTHER_TYPE_NAME.channel_mismatch);
    expect(main().textContent ?? '', 'no raw enum value in the list').not.toContain(BLACKLIST_TYPE);

    const listed = cellText(REF.open, COLUMN.type);
    const drawer = await openDetail(server, REF.open, ID.open);
    const text = squash(drawer.textContent);
    expect(text, 'the drawer shows the same name as the list').toContain(listed);
    expect(text).toMatch(BLACKLIST_NAME);
    expect(text, 'no raw enum value in the drawer').not.toContain(BLACKLIST_TYPE);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08ec-TYPE#2] 类型筛选里有黑名单类型：选中后【查询】的列表请求带 type=blacklist_after_credit，只列出该类型的差错单',
  async () => {
    const server = createServer();
    await mount(server);
    await openDiffs(server, REF.ledger);
    await settled(server);
    const before = server.reads().length;
    const offered = await choose(scope(), LABEL.type, BLACKLIST_NAME);
    expect(
      offered.filter((name) => BLACKLIST_NAME.test(name)),
      'one blacklist option',
    ).toHaveLength(1);
    expect(offered, 'the other types are still offered').toContain(OTHER_TYPE_NAME.ledger_mismatch);
    expect(offered.join(' '), 'options show names, not codes').not.toContain(BLACKLIST_TYPE);
    await query();
    const filtered = () =>
      server
        .reads()
        .slice(before)
        .filter((read) => read.query['type'] !== undefined);
    await waitFor(() => expect(filtered().length).toBeGreaterThan(0));
    await settled(server);
    expect(filtered().at(-1)!.query['type']).toBe(BLACKLIST_TYPE);
    await waitFor(() => expect(rowsOf(scope(), [REF.ledger])).toEqual([]));
    expect(rowsOf(scope(), [REF.channel])).toEqual([]);
    for (const ref of [REF.open, REF.busy, REF.done, REF.closed])
      expect(rowsOf(scope(), [ref]), ref).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);
