// @vitest-environment jsdom
// F1-08fb 依据摘录 1: negative controls share a block with the new positive entry.
import { expect, it } from 'vitest';
import { FUND_VIEW, LOOKUP_ONLY, SUPER, UID, grants } from '../admin-ledger-readonly/fixtures.ts';
import {
  controlsNamed,
  main,
  mountLedger,
  queryUser,
  sidebarLinks,
  typeInto,
  uidInput,
} from '../admin-ledger-readonly/helpers.ts';
import { reset } from '../admin-planned/kit.ts';
import { EXPORTER, EXPORT_LABEL, createServer } from './fixtures.ts';
import { expectEntry, expectRequest, expectSuccess, submit } from './helpers.ts';

it(
  '[AC-F1-08fb-ENTRY#1] fund.view 无 export 始终隐藏；两点俱全时只在查询 UID 后显示标题行导出按钮',
  { timeout: 60_000 },
  async () => {
    const reader = createServer({ permissions: ['fund.view'] });
    await mountLedger(reader, FUND_VIEW);
    expect(controlsNamed(main(), EXPORT_LABEL)).toEqual([]);
    expect(controlsNamed(main(), '导出记录')).toHaveLength(1);
    await queryUser(reader, UID);
    expect(controlsNamed(main(), EXPORT_LABEL)).toEqual([]);
    expect(reader.exportPosts()).toEqual([]);
    reset();

    const server = createServer();
    await mountLedger(server, EXPORTER);
    expect(controlsNamed(main(), EXPORT_LABEL)).toEqual([]);
    await typeInto(uidInput(), UID);
    expect(controlsNamed(main(), EXPORT_LABEL)).toEqual([]);
    expect(server.requests).toEqual([]);
    await queryUser(server, UID);
    expectEntry();
  },
);

it(
  '[AC-F1-08fb-ENTRY#2] user.lookup 无 export 隐藏；user.lookup 加 export 直达可导出，不要求 fund.view',
  { timeout: 60_000 },
  async () => {
    const reader = createServer({ permissions: ['user.lookup'] });
    await mountLedger(reader, LOOKUP_ONLY);
    expect(controlsNamed(main(), EXPORT_LABEL)).toEqual([]);
    await queryUser(reader, UID);
    expect(controlsNamed(main(), EXPORT_LABEL)).toEqual([]);
    expect(controlsNamed(main(), '导出记录')).toHaveLength(1);
    reset();

    const server = createServer({ permissions: ['user.lookup', 'export'] });
    await mountLedger(server, grants('user.lookup', 'export'));
    expect(sidebarLinks('余额流水')).toEqual([]);
    expect(controlsNamed(main(), EXPORT_LABEL)).toEqual([]);
    await queryUser(server, UID);
    expectEntry();
    await submit(server);
    expectRequest(server.exportPosts()[0]!, { user_id: UID });
    await expectSuccess(server, 'EX20261117000001');
  },
);

it(
  '[AC-F1-08fb-ENTRY#3] 仅 export 没有任一读取点不能导出；超管查过 UID 后可导出且仍不请求明文',
  { timeout: 60_000 },
  async () => {
    const denied = createServer({ permissions: ['export'] });
    await mountLedger(denied, grants('export'));
    expect(controlsNamed(main(), EXPORT_LABEL)).toEqual([]);
    expect(denied.requests).toEqual([]);
    reset();

    const server = createServer({ isSuper: true });
    await mountLedger(server, SUPER);
    expect(controlsNamed(main(), EXPORT_LABEL)).toEqual([]);
    await queryUser(server, UID);
    expectEntry();
    await submit(server);
    expectRequest(server.exportPosts()[0]!, { user_id: UID });
    await expectSuccess(server, 'EX20261117000001');
  },
);
