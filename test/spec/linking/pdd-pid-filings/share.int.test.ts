// B1-06zi (BR-ATTR-05 细则「别人的分享 link」, unchanged): another user's share link is judged on
// the sharer's stored binding only — never queried, nothing filed, even though the sharer has no
// filing row on the share slot. That holds on main already, so it runs as the second half of a case
// whose first half (the sharer's own open filing the self_buy slot) is red on main.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { databaseFixture } from '../open-pdd-auth/database.ts';
import { outcome, service } from '../open-pdd-auth/kit.ts';
import { identity, success } from '../open-pdd-auth/assertions.ts';
import { TIMEOUT, activeUnfiled, currentPid, filed, filings } from './kit.ts';

const database = databaseFixture(createTestDatabase);

it.each(['b', 'guest'] as const)(
  '[AC-B1-06zi#9] 分享者本人开自己的分享 link 补写自买位备案后，%s 开其分享 link：只看分享者绑定，不查、不写备案',
  async (opener) => {
    const f = await activeUnfiled(database(), { query: true, scene: 'share' });
    const open = service(f);
    // A's own share link is served as a new self_buy link and judged on A's self_buy slot.
    const own = await success(await outcome(() => open.open(f.request())));
    expect(own.new_link_id).not.toBeNull();
    expect(f.query).toHaveBeenCalledTimes(1);
    identity(f, f.query.mock.calls[0]![0], f.a.attr, 'self_buy');
    const rows = await filings(f);
    expect(rows).toEqual([filed(f, f.a.userId, currentPid('self_buy'), f.clock.now())]);

    f.opener(opener);
    const before = await f.bindings();
    f.convert.mockClear();
    const data = await success(await outcome(() => open.open(f.request())));
    expect(data.new_link_id).toBeNull();
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(f.convert).toHaveBeenCalledTimes(1);
    identity(f, f.convert.mock.calls[0]![1], f.a.attr, 'share');
    expect(await filings(f)).toEqual(rows);
    expect(await f.bindings()).toEqual(before);
    expect(await f.sessions()).toEqual([]);
  },
  TIMEOUT,
);
