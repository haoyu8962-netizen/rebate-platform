import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { useHarness } from '../auth/kit.ts';
import { append, detail, setup, TO, type Query, type Setup } from '../audit-query/kit.ts';
import {
  APPEAL,
  APPEAL_TYPE,
  BLOCKLIST_REMOVE,
  BLOCKLIST_TYPE,
  CLAIM,
  expectRows,
  inWindow,
  LOOKUP,
  REGISTER,
  RESOLVE,
  view,
  type View,
} from './kit.ts';

// B1-34r (编排 D10-1759 / D10-1760, task §9): the audit console's derivation table registers the
// risk module's appeal console actions. Real HTTP (admin entry) and PG, run only by the container
// runner. Audit rows are appended straight into app.audit_logs with the shapes the risk writers
// store (bare ids); expected values are written out here, never computed by the production table.
const h = useHarness();

/** Rows as admin-appeals-write.ts stores them for one appeal: register → claim → resolve. */
async function appealTrail(f: Setup, appealId: string, userId: string, minute: number) {
  const register = {
    after: {
      appeal_id: appealId,
      // The appeal's own object lives in after; the audit row's object is the appeal.
      target_type: 'account',
      target_id: userId,
      user_id: userId,
      request_type: null,
      prev_risk_state: 'banned',
    },
  };
  const claim = {
    before: { appeal_id: appealId, handler_id: null, row_version: 1 },
    after: {
      appeal_id: appealId,
      handler_id: f.actor.id,
      claimed_at: inWindow(minute + 1),
      row_version: 2,
    },
  };
  const resolve = {
    before: {
      appeal_id: appealId,
      target_type: 'account',
      target_id: userId,
      user_id: userId,
      status: 'processing',
      row_version: 2,
    },
    after: {
      appeal_id: appealId,
      decision: 'revoked',
      note: '合成申诉处理备注',
      status: 'revoked',
      handler_id: f.actor.id,
      closed_at: inWindow(minute + 2),
    },
  };
  await append(h, f.actor, {
    action: REGISTER,
    target: appealId,
    ...register,
    at: inWindow(minute),
  });
  await append(h, f.actor, { action: CLAIM, target: appealId, ...claim, at: inWindow(minute + 1) });
  await append(h, f.actor, {
    action: RESOLVE,
    target: appealId,
    ...resolve,
    at: inWindow(minute + 2),
  });
  return { register, claim, resolve };
}

/** A blocklist_remove row as the revocation of a blocked_request appeal stores it. */
async function removal(f: Setup, entryId: string, appealId: string, minute: number) {
  const stored = {
    before: {
      blocklist_id: entryId,
      dimension: 'device',
      violation_type: 'fraud',
      status: 'active',
    },
    after: { blocklist_id: entryId, status: 'inactive', appeal_id: appealId },
  };
  await append(h, f.actor, {
    action: BLOCKLIST_REMOVE,
    target: entryId,
    ...stored,
    at: inWindow(minute),
  });
  return stored;
}

/** A blocked_request_lookup row: no object, the masked phone in after (admin-appeals-read.ts). */
async function lookup(f: Setup, phoneMasked: string, minute: number) {
  const after = { phone_masked: phoneMasked, found: 1 };
  await append(h, f.actor, { action: LOOKUP, target: null, after, at: inWindow(minute) });
  return after;
}

const appealRows = (appealId: string): View[] => [
  view(REGISTER, APPEAL_TYPE, appealId, APPEAL),
  view(CLAIM, APPEAL_TYPE, appealId, APPEAL),
  view(RESOLVE, APPEAL_TYPE, appealId, APPEAL),
];

it('[AC-B1-34r#1] 申诉登记、领取、处理与解除黑名单：列表与详情读出 appeal / blocklist、存的裸 id 与 risk.appeal', async () => {
  const f = await setup(h);
  const appealId = randomUUID();
  const userId = randomUUID();
  const entryId = randomUUID();
  const trail = await appealTrail(f, appealId, userId, 10);
  const removed = await removal(f, entryId, appealId, 20);
  const blocklistRow = view(BLOCKLIST_REMOVE, BLOCKLIST_TYPE, entryId, APPEAL);
  const rows = await expectRows(f, {}, [...appealRows(appealId), blocklistRow]);

  // The detail keeps the stored before / after next to the derived fields.
  const stored: [string, { before?: object; after: object }, View][] = [
    [REGISTER, trail.register, view(REGISTER, APPEAL_TYPE, appealId, APPEAL)],
    [CLAIM, trail.claim, view(CLAIM, APPEAL_TYPE, appealId, APPEAL)],
    [RESOLVE, trail.resolve, view(RESOLVE, APPEAL_TYPE, appealId, APPEAL)],
    [BLOCKLIST_REMOVE, removed, blocklistRow],
  ];
  for (const [action, values, expected] of stored) {
    const row = rows.find((item) => item.action === action);
    expect(row, action).toBeDefined();
    expect(await detail(f, row!.id)).toEqual({
      ...row,
      ...expected,
      before: values.before ?? null,
      after: values.after,
    });
  }
});

it('[AC-B1-34r#2] 按 target_type=appeal 只出三个申诉动作、按 blocklist 只出解除黑名单，彼此不串、近似类型不命中', async () => {
  const f = await setup(h);
  const [a1, a2, user1] = [randomUUID(), randomUUID(), randomUUID()];
  const [e1, e2] = [randomUUID(), randomUUID()];
  await appealTrail(f, a1, user1, 10);
  await append(h, f.actor, {
    action: REGISTER,
    target: a2,
    after: { appeal_id: a2, target_type: 'blocked_request', target_id: randomUUID() },
    at: inWindow(20),
  });
  // One revocation removing two entries.
  await removal(f, e1, a2, 30);
  await removal(f, e2, a2, 31);
  await lookup(f, '138****0001', 40);
  // Another registered action whose bare target equals an appeal id.
  await append(h, f.actor, {
    action: 'user_risk_state_change',
    target: a1,
    after: { user_id: a1, action: 'freeze', reason: 'fixture' },
    at: inWindow(50),
  });

  const appeals = [...appealRows(a1), view(REGISTER, APPEAL_TYPE, a2, APPEAL)];
  const blocklist = [
    view(BLOCKLIST_REMOVE, BLOCKLIST_TYPE, e1, APPEAL),
    view(BLOCKLIST_REMOVE, BLOCKLIST_TYPE, e2, APPEAL),
  ];
  const risk = view('user_risk_state_change', 'user', a1, 'risk.freeze');
  await expectRows(f, { target_type: APPEAL_TYPE }, appeals);
  await expectRows(f, { target_type: BLOCKLIST_TYPE }, blocklist);
  await expectRows(f, { target_type: 'user' }, [risk]);
  await expectRows(f, { target_type: APPEAL_TYPE, permission: APPEAL }, appeals);
  await expectRows(f, { target_type: BLOCKLIST_TYPE, permission: APPEAL }, blocklist);
  // blocklist_remove is done under risk.appeal, not under risk.blocklist.
  await expectRows(f, { target_type: BLOCKLIST_TYPE, permission: 'risk.blocklist' }, []);
  await expectRows(f, { permission: 'risk.blocklist' }, []);
  // Crossed object and type, and near-miss type names, match nothing.
  const crossed: Query[] = [
    { target_type: APPEAL_TYPE, target_id: e1 },
    { target_type: BLOCKLIST_TYPE, target_id: a1 },
    { target_type: 'user', target_id: e1 },
    { target_type: 'appeals' },
    { target_type: 'Appeal' },
    { target_type: 'blocklists' },
    { target_type: 'blocklist_entry' },
    { target_type: 'blocked_request' },
    { target_type: 'account' },
  ];
  for (const query of crossed) await expectRows(f, query, []);
});

it('[AC-B1-34r#3] 按 target_id 精确查到申诉与黑名单条目的行；带前缀、截断或改大小写的 id 不命中', async () => {
  const f = await setup(h);
  const [a1, a2, user1] = [randomUUID(), randomUUID(), randomUUID()];
  const [e1, e2] = [randomUUID(), randomUUID()];
  await appealTrail(f, a1, user1, 10);
  await appealTrail(f, a2, randomUUID(), 20);
  await removal(f, e1, a1, 30);
  await removal(f, e2, a2, 31);
  // Same bare id as appeal a1 under another registered action.
  await append(h, f.actor, {
    action: 'user_risk_state_change',
    target: a1,
    after: { user_id: a1, action: 'freeze', reason: 'fixture' },
    at: inWindow(40),
  });

  const risk = view('user_risk_state_change', 'user', a1, 'risk.freeze');
  await expectRows(f, { target_id: a1 }, [...appealRows(a1), risk]);
  await expectRows(f, { target_id: a2 }, appealRows(a2));
  await expectRows(f, { target_id: e1 }, [view(BLOCKLIST_REMOVE, BLOCKLIST_TYPE, e1, APPEAL)]);
  await expectRows(f, { target_id: e2 }, [view(BLOCKLIST_REMOVE, BLOCKLIST_TYPE, e2, APPEAL)]);
  await expectRows(f, { target_type: APPEAL_TYPE, target_id: a1 }, appealRows(a1));
  await expectRows(f, { target_id: a1, permission: APPEAL }, appealRows(a1));
  await expectRows(f, { target_type: BLOCKLIST_TYPE, target_id: e2, permission: APPEAL }, [
    view(BLOCKLIST_REMOVE, BLOCKLIST_TYPE, e2, APPEAL),
  ]);
  for (const target_id of [
    `appeals:${a1}`,
    `appeal:${a1}`,
    `blocklist:${e1}`,
    a1.slice(0, -1),
    e1.slice(1),
    a1.toUpperCase(),
  ]) {
    await expectRows(f, { target_id }, []);
  }
});

it('[AC-B1-34r#4] blocked_request_lookup 读出权限 risk.appeal、对象为 null，按任何 target_type / target_id 都筛不到它', async () => {
  const f = await setup(h);
  const appealId = randomUUID();
  const [masked1, masked2] = ['138****0001', '139****0002'];
  const first = await lookup(f, masked1, 10);
  const second = await lookup(f, masked2, 20);
  await append(h, f.actor, {
    action: REGISTER,
    target: appealId,
    after: { appeal_id: appealId, target_type: 'blocked_request', target_id: randomUUID() },
    at: inWindow(30),
  });
  const looked = view(LOOKUP, null, null, APPEAL);
  const registered = view(REGISTER, APPEAL_TYPE, appealId, APPEAL);
  const rows = await expectRows(f, {}, [looked, looked, registered]);
  const lookups = rows.filter((item) => item.action === LOOKUP);
  expect(lookups).toHaveLength(2);
  const afters: unknown[] = [];
  for (const item of lookups) {
    const one = await detail(f, item.id);
    expect(one).toMatchObject({ ...looked, before: null });
    afters.push(one.after);
  }
  expect(afters).toHaveLength(2);
  expect(afters).toEqual(expect.arrayContaining([first, second]));

  await expectRows(f, { permission: APPEAL }, [looked, looked, registered]);
  await expectRows(f, { target_type: APPEAL_TYPE }, [registered]);
  const objectFilters: Query[] = [
    { target_type: BLOCKLIST_TYPE },
    { target_type: 'blocked_request' },
    { target_type: LOOKUP },
    { target_type: 'phone' },
    { target_id: masked1 },
    { target_id: masked2 },
    { target_type: BLOCKLIST_TYPE, permission: APPEAL },
  ];
  for (const query of objectFilters) await expectRows(f, query, []);
});

it('[AC-B1-34r#5] 历史可查：登记前写下的申诉审计行（直接在表里）读时就推出对象与权限，读取不改表', async () => {
  const f = await setup(h);
  // These rows are appended straight into app.audit_logs, weeks before the window of the other
  // cases: they stand for records written before this registration. audit_logs stores only action
  // and target, so the console derives target_type / target_id / permission at read time; no
  // backfill or migration makes them findable.
  const history = { from: '2026-08-01T00:00:00.000Z', to: TO };
  const appealId = randomUUID();
  const entryId = randomUUID();
  await append(h, f.actor, {
    action: REGISTER,
    target: appealId,
    after: { appeal_id: appealId, target_type: 'account', target_id: randomUUID() },
    at: '2026-08-03T01:00:00.000Z',
  });
  await append(h, f.actor, {
    action: CLAIM,
    target: appealId,
    after: { appeal_id: appealId, handler_id: f.actor.id },
    at: '2026-08-03T02:00:00.000Z',
  });
  await append(h, f.actor, {
    action: RESOLVE,
    target: appealId,
    after: { appeal_id: appealId, decision: 'revoked', status: 'revoked' },
    at: '2026-08-04T03:00:00.000Z',
  });
  await append(h, f.actor, {
    action: BLOCKLIST_REMOVE,
    target: entryId,
    after: { blocklist_id: entryId, status: 'inactive', appeal_id: appealId },
    at: '2026-08-04T03:00:00.000Z',
  });
  await append(h, f.actor, {
    action: LOOKUP,
    target: null,
    after: { phone_masked: '137****0003', found: 0 },
    at: '2026-08-05T04:00:00.000Z',
  });
  const stored = () =>
    h.db.selectFrom('audit_logs').selectAll().where('app_id', '=', f.appId).orderBy('id').execute();
  const before = await stored();

  const blocklistRow = view(BLOCKLIST_REMOVE, BLOCKLIST_TYPE, entryId, APPEAL);
  const lookedUp = view(LOOKUP, null, null, APPEAL);
  await expectRows(f, history, [...appealRows(appealId), blocklistRow, lookedUp]);
  await expectRows(f, { ...history, target_type: APPEAL_TYPE }, appealRows(appealId));
  await expectRows(f, { ...history, target_id: appealId }, appealRows(appealId));
  await expectRows(f, { ...history, target_type: BLOCKLIST_TYPE, target_id: entryId }, [
    blocklistRow,
  ]);
  await expectRows(f, { ...history, permission: APPEAL }, [
    ...appealRows(appealId),
    blocklistRow,
    lookedUp,
  ]);
  // The derivation happens on read: the stored rows are untouched and nothing is written back.
  expect(await stored()).toEqual(before);
});
