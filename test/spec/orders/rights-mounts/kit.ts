// B1-10n rule-test kit (claude-independent, SPEC_REF 9ab94dc0): adminCreateRightsImport,
// adminListRightsImports and adminGetRightsImport on the admin entry, and the rights_import job on
// the worker entry's real assembly. The use cases and row processors have their own rule tests
// (rights-import-task, rights-import-rows, channel-import); here only the mount and the wiring.
// Real pieces: everything ../admin-mounts/kit.ts starts (admin token, session and permission checks,
// the step-up gate over Redis, contract validation, multipart, the started JOB_QUEUE, whose sends
// are recorded and passed on), the worker's AppModule with the handlers it registered on `order-sync`
// and `settle`, the ledger, PostgreSQL as couli_app.
// CREDITED orders are credited by the worker's own settle handler (job batch_execute), so the
// clawback starts from real CREDIT vouchers, balances and the booked pair.
// Synthetic: orders, snapshots, members, union accounts, the confirmed settle batch and its item
// seeded as the sync, the bill and the confirmation would have left them; in the files that inject
// them, the column templates (./templates.ts); one memory store shared by the two entries of this
// process (production's is one private bucket); a one-shot fault at the row checkpoint; for a sync
// window, the union adapter and the credential lookup only (demo credentials are never queryable).
// No real user or merchant data.
// A seed that cannot be built throws a plain Error, never an assertion: only the mount may be what
// is missing. Missing pieces fail as assertions: an unregistered admin route answers 404.
// Plain SQL always names the schema. Only the container runner executes the integration tests.
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createDb, destroyDb, pgUrl, type DB } from '@couli/db';
import { addFen } from '@couli/money';
import { sql, type Kysely, type KyselyPlugin } from 'kysely';
import { expect, inject, vi } from 'vitest';
import { createLedger } from '../../../../apps/api/src/modules/ledger/index.ts';
import type { OrderSyncRuntime } from '../../../../apps/api/src/modules/orders/worker-runtime.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import { MemoryImportStore } from '../../../../apps/api/src/modules/platform/import-store/index.ts';
import {
  JOB_QUEUE,
  type JobPayload,
  type JobQueue,
  type ReceivedJob,
} from '../../../../apps/api/src/modules/platform/index.ts';
import type { UnionAdapter, UnionOrder } from '../../../../apps/api/src/modules/union/index.ts';
import {
  NOW,
  apiRequire,
  type Harness,
  type HttpApp,
  type Request,
  type Response,
} from '../../admin/auth/kit.ts';
import { seedUser } from '../../identity/registration/kit.ts';
import { memoryLogger } from '../../identity/sms-codes/kit.ts';
import {
  PAID_AT,
  RECEIVED_AT,
  accepted,
  attributedOrder,
  orderNow,
  seedOrder,
  setup as adminSetup,
  type Order,
  type Send,
} from '../admin-mounts/kit.ts';
import { MULTIPART, form, multipart, sheet, xlsx, type Part } from '../rights-import-task/kit.ts';
import { TEMPLATES } from './templates.ts';

export {
  DENIED,
  STEP_UP_REQUIRED,
  accepted,
  attributedOrder,
  orderNow,
  refused,
} from '../admin-mounts/kit.ts';
export { NOW, TEMPLATES };

export const IMPORTS = '/admin/v1/rights-imports';
export const OCCURRED = '2026-10-07T10:00:00+08:00';
export const IP = '127.0.0.1';
/** The month of the seeded settle batch (the orders' received month). */
const BILL = '2026-10';
const CONFIRMED_AT = '2026-10-09T01:00:00.000Z';
/** The increment window a sync report arrives in. */
const WINDOW_START = '2026-10-09T01:00:00.000Z';
const WINDOW_END = '2026-10-09T01:30:00.000Z';

// ---------------------------------------------------------------------------------------------
// The admin entry.

/** One send of the entry's JOB_QUEUE (recorded, then passed on to the real queue). */
export interface Sent {
  readonly queue: string;
  readonly name: string;
  readonly payload: JobPayload;
}

interface RawApp {
  inject(request: Omit<Request, 'payload'> & { payload?: string | Buffer }): Promise<Response>;
}

/** The B1-10m scenario plus uploads, reads, the recorded sends and the import tasks in its state. */
export async function setup(
  h: Harness,
  options: { grants?: readonly string[]; isSuper?: boolean } = {},
) {
  const base = await adminSetup(h, options);
  const { admin, appId, f } = base;

  const queue = f.app.get<JobQueue>(JOB_QUEUE);
  const sent: Sent[] = [];
  const send = queue.send.bind(queue);
  vi.spyOn(queue, 'send').mockImplementation(async (name, job, payload, sendOptions) => {
    const id = await send(name, job, payload, sendOptions);
    sent.push({ queue: name, name: job, payload: structuredClone(payload) });
    return id;
  });

  const raw = f.app as unknown as RawApp;
  const call = (
    method: 'GET' | 'POST',
    url: string,
    payload: Buffer | undefined,
    headers: Record<string, string>,
    options: Send,
  ): Promise<Response> => {
    const who = options.caller === undefined ? admin : options.caller;
    return raw.inject({
      method,
      url,
      remoteAddress: IP,
      headers: {
        ...(who === null ? {} : { authorization: `Bearer ${who.token}` }),
        ...(options.stepUp === undefined ? {} : { 'x-step-up-token': options.stepUp }),
        ...headers,
      },
      ...(payload === undefined ? {} : { payload }),
    });
  };
  const get = (url: string, options: Send = {}) => call('GET', url, undefined, {}, options);
  const upload = (parts: readonly Part[], options: Send = {}) =>
    call('POST', IMPORTS, multipart(parts), { 'content-type': MULTIPART }, options);

  const state = async () => ({
    ...(await base.state()),
    imports: await h.db
      .selectFrom('rights_imports')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    sends: sent.length,
  });

  /** The one rights_import job of a task. */
  const importJob = (importId: string): Sent => {
    const jobs = sent.filter(
      (job) =>
        job.queue === 'order-sync' &&
        job.name === 'rights_import' &&
        job.payload['import_id'] === importId,
    );
    expect(jobs, `one rights_import job of ${importId}`).toHaveLength(1);
    return jobs[0]!;
  };

  return { ...base, sent, get, upload, state, importJob };
}
export type Scenario = Awaited<ReturnType<typeof setup>>;

/** A union account of the scenario's app. */
export async function seedUnionAccount(s: Scenario, platform = 'taobao'): Promise<string> {
  const id = randomUUID();
  await s.h.db
    .insertInto('union_accounts')
    .values({
      id,
      app_id: s.appId,
      platform,
      account_name: `synthetic-${id}`,
      status: 'active',
      auth_status: 'active',
    })
    .execute();
  return id;
}

/** A finished import task written directly (for the detail route). */
async function seedImport(s: Scenario): Promise<string> {
  const id = randomUUID();
  const now = s.f.clock.now();
  await s.h.db
    .insertInto('rights_imports')
    .values({
      id,
      app_id: s.appId,
      kind: 'rights',
      platform: 'jd',
      union_account_id: null,
      time_basis: null,
      from: null,
      to: null,
      file_path: `${s.appId}/${id}.xlsx`,
      status: 'done',
      total_rows: 0,
      succeeded_rows: 0,
      failed_rows: 0,
      skipped_rows: 0,
      duplicate_rows: 0,
      created_by: s.admin.id,
      created_at: now,
      finished_at: now,
    })
    .execute();
  return id;
}

// ---------------------------------------------------------------------------------------------
// One valid request of each operation (the three kinds are cases of the same route).

export type Action = 'rights' | 'punish' | 'channel' | 'list' | 'detail';

export const ACTIONS: readonly Action[] = ['rights', 'punish', 'channel', 'list', 'detail'];

/** contracts/openapi.yaml, specs/permissions.yaml: what each action needs, and no more. */
export const GRANTS: Readonly<Record<Action, readonly string[]>> = {
  rights: ['order.claim'],
  punish: ['order.claim'],
  channel: ['order.claim', 'risk.blocklist'],
  list: ['order.claim'],
  detail: ['order.claim'],
};

const NEEDS_STEP_UP: ReadonlySet<Action> = new Set<Action>(['channel']);

/** The success envelope of each action. */
export const ANSWER: Readonly<Record<Action, string>> = {
  rights: 'AdminRightsImportCreateResponse',
  punish: 'AdminRightsImportCreateResponse',
  channel: 'AdminRightsImportCreateResponse',
  list: 'AdminRightsImportPageResponse',
  detail: 'AdminRightsImportDetailResponse',
};

/** The rows one action needs, and its request. */
export async function arrange(
  s: Scenario,
  action: Action,
): Promise<(options?: Send) => Promise<Response>> {
  switch (action) {
    case 'rights':
    case 'punish': {
      const parts = form({ kind: action, platform: 'jd' }, sheet(['succeeded']));
      return (options) => s.upload(parts, options);
    }
    case 'channel': {
      const accountId = await seedUnionAccount(s);
      const fields = { kind: 'channel', platform: 'taobao', union_account_id: accountId };
      const parts = form(fields, sheet(['succeeded']));
      return (options) => s.upload(parts, options);
    }
    case 'list':
      return (options) => s.get(`${IMPORTS}?page=1&page_size=20`, options);
    case 'detail': {
      const importId = await seedImport(s);
      return (options) => s.get(`${IMPORTS}/${importId}`, options);
    }
  }
}

/** The options of a request the action accepts from the scenario's own account. */
export async function allowed(s: Scenario, action: Action): Promise<Send> {
  return NEEDS_STEP_UP.has(action) ? { stepUp: await s.stepUp(s.admin) } : {};
}

// ---------------------------------------------------------------------------------------------
// The worker's real assembly.

type Handle = (job: ReceivedJob) => Promise<void>;

interface Context {
  get(token: unknown, options: { strict: boolean }): unknown;
  close(): Promise<void>;
}

/**
 * A couli_app handle on the harness's database, bound to the app schema once as the production
 * entries' are: h.db is bound twice (admin/auth/kit.ts), and Kysely cannot compile the ledger's
 * FOR UPDATE OF on such a handle. The harness keeps its URL to itself, so this one is built the way
 * @couli/db/testing's urlFor builds it.
 */
async function singleBoundDb(h: Harness): Promise<Kysely<DB>> {
  const { factoryUrl, rolePasswords } = inject('couliTestDb');
  const { rows } = await sql<{ name: string }>`SELECT current_database() AS name`.execute(h.db);
  const url = pgUrl(factoryUrl, {
    user: 'couli_app',
    password: rolePasswords.couli_app,
    database: rows[0]!.name,
  });
  return createDb({ connectionString: url, max: 6 });
}

/**
 * The worker entry's AppModule on the harness's database and keyring, with an in-memory queue
 * runtime (never polled): `run` hands a recorded send to the handler the worker registered on
 * order-sync, `settle` hands a batch_execute job to the one it registered on settle, `sync` hands
 * that order-sync handler a window job whose one page is `report`. The worker has its own
 * single-bound handle, closed after the context when the test ends; `plugin` goes on that handle (a
 * fault, a recorder); `now` is the worker's own clock (a job that runs after the upload), NOW by
 * default.
 */
export async function worker(
  h: Harness,
  options: { readonly plugin?: KyselyPlugin; readonly now?: string } = {},
) {
  // URL imports keep decorated HTTP controllers out of the spec project's TS compilation.
  const { AppModule } = (await import(
    new URL('../../../../apps/api/src/app.module.ts', import.meta.url).href
  )) as { AppModule: { forEntry(options: object): unknown } };
  const { PlatformModule } = (await import(
    new URL('../../../../apps/api/src/modules/platform/index.ts', import.meta.url).href
  )) as { PlatformModule: { forRoot(options: object): { providers?: unknown[] } } };
  const { orderSyncToken } = (await import(
    new URL('../../../../apps/api/src/modules/orders/index.ts', import.meta.url).href
  )) as { orderSyncToken(): symbol };
  const { NestFactory } = (await import(
    pathToFileURL(apiRequire.resolve('@nestjs/core')).href
  )) as {
    NestFactory: { createApplicationContext(module: unknown, options: object): Promise<Context> };
  };
  const db = await singleBoundDb(h);
  const queue = {
    send: vi.fn(async () => 'fixture'),
    register: vi.fn<(name: string, handler: Handle) => void>(),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
  const original = PlatformModule.forRoot.bind(PlatformModule);
  const spy = vi.spyOn(PlatformModule, 'forRoot').mockImplementation((forRootOptions) => {
    const module = original(forRootOptions);
    return {
      ...module,
      providers: (module.providers ?? []).map((provider) =>
        typeof provider === 'object' &&
        provider !== null &&
        'provide' in provider &&
        provider.provide === JOB_QUEUE
          ? { provide: JOB_QUEUE, useValue: queue }
          : provider,
      ),
    };
  });
  let context: Context | undefined;
  try {
    context = await NestFactory.createApplicationContext(
      AppModule.forEntry({
        entry: 'worker',
        config: loadConfig(h.env),
        clock: new FixedClock(options.now ?? NOW),
        logger: memoryLogger().logger,
        dbHandles: {
          db: options.plugin === undefined ? db : db.withPlugin(options.plugin),
          dbRead: null,
          close: async () => undefined,
        },
      }),
      { logger: false, abortOnError: false },
    );
    h.apps.push(context as unknown as HttpApp);
  } finally {
    spy.mockRestore();
    const handle: Pick<Context, 'close'> = { close: () => destroyDb(db) };
    h.apps.push(handle as unknown as HttpApp);
  }
  const handler = (name: string): Handle => {
    const handlers = queue.register.mock.calls.filter(([registered]) => registered === name);
    expect(handlers, `${name} handlers registered by the worker`).toHaveLength(1);
    return handlers[0]![1];
  };
  return {
    run: (send: Sent) =>
      handler('order-sync')(
        Object.freeze({
          id: randomUUID(),
          queue: send.queue,
          name: send.name,
          payload: structuredClone(send.payload),
          attempt: 1,
        }),
      ),
    settle: (batchId: string, appId: string) =>
      handler('settle')(
        Object.freeze({
          id: randomUUID(),
          queue: 'settle',
          name: 'batch_execute',
          payload: { app_id: appId, batch_id: batchId },
          attempt: 1,
        }),
      ),
    sync: async (appId: string, unionAccountId: string, report: UnionOrder) => {
      const runtime = context?.get(orderSyncToken(), { strict: false }) as OrderSyncRuntime;
      vi.spyOn(runtime.access, 'queryableAccount').mockResolvedValue(unionAccountId);
      vi.spyOn(runtime.registry, 'get').mockReturnValue({
        listOrders: vi
          .fn<UnionAdapter['listOrders']>()
          .mockResolvedValue({ items: [report], nextCursor: null }),
      });
      await handler('order-sync')(
        Object.freeze({
          id: randomUUID(),
          queue: 'order-sync',
          name: 'window',
          payload: {
            app_id: appId,
            platform: report.platform,
            union_account_id: unionAccountId,
            query_kind: 'increment',
            scene: '-',
            window_start: WINDOW_START,
            window_end: WINDOW_END,
          },
          attempt: 1,
        }),
      );
    },
  };
}
export type Worker = Awaited<ReturnType<typeof worker>>;

/**
 * Both entries' memory stores read and write one set of files: each entry of this process builds
 * its own stand-in (production's two processes share one private bucket).
 */
export function shareImportStore(): void {
  const files = new Map<string, Uint8Array>();
  vi.spyOn(MemoryImportStore.prototype, 'put').mockImplementation(async (input) => {
    files.set(input.key, new Uint8Array(input.bytes));
  });
  vi.spyOn(MemoryImportStore.prototype, 'get').mockImplementation(async (key) => {
    const stored = files.get(key);
    return stored === undefined ? null : new Uint8Array(stored);
  });
}

/** Uploads through the admin entry; the worker's handler takes the job the entry sent. */
export async function imported(
  s: Scenario,
  w: Worker,
  fields: Readonly<Record<string, string>>,
  rows: readonly (readonly (string | null)[])[],
  options: Send = {},
): Promise<string> {
  const importId = await queued(s, fields, rows, options);
  await w.run(s.importJob(importId));
  return importId;
}

/** Uploads through the admin entry; the job stays recorded, nothing has run it. */
export async function queued(
  s: Scenario,
  fields: Readonly<Record<string, string>>,
  rows: readonly (readonly (string | null)[])[],
  options: Send = {},
): Promise<string> {
  const created = await accepted<{ import_id: string; status: string }>(
    await s.upload(form(fields, xlsx(rows)), options),
    ANSWER.rights,
  );
  expect(created.status).toBe('queued');
  return created.import_id;
}

/** The task's detail through the admin entry. */
export async function detailOf(s: Scenario, importId: string) {
  return accepted(await s.get(`${IMPORTS}/${importId}`), ANSWER.detail);
}

export function rightsOf(s: Scenario) {
  return s.h.db
    .selectFrom('order_rights')
    .selectAll()
    .where('app_id', '=', s.appId)
    .orderBy('id')
    .execute();
}

// ---------------------------------------------------------------------------------------------
// One-shot fault: the row checkpoint of the rights_import job fails after the row's writes.

export const CHECKPOINT_FAILURE = 'synthetic failure at the row checkpoint';

export interface CheckpointFault {
  armed: boolean;
  readonly plugin: KyselyPlugin;
}

export function checkpointFault(): CheckpointFault {
  const fault: CheckpointFault = {
    armed: false,
    plugin: {
      transformQuery({ node }) {
        if (fault.armed && node.kind === 'UpdateQueryNode') {
          const text = JSON.stringify(node, (_key, item: unknown) =>
            typeof item === 'bigint' ? item.toString() : item,
          );
          if (text.includes('"rights_imports"') && text.includes('"succeeded_rows"')) {
            fault.armed = false;
            throw new Error(CHECKPOINT_FAILURE);
          }
        }
        return node;
      },
      async transformResult({ result }) {
        return result;
      },
    },
  };
  return fault;
}

// ---------------------------------------------------------------------------------------------
// The order of a job's writes: what its transactions insert into the named tables, as they run.

export interface InsertRecorder {
  armed: boolean;
  readonly inserts: string[];
  readonly plugin: KyselyPlugin;
}

export function insertRecorder(tables: readonly string[]): InsertRecorder {
  const recorder: InsertRecorder = {
    armed: false,
    inserts: [],
    plugin: {
      transformQuery({ node }) {
        if (recorder.armed && node.kind === 'InsertQueryNode') {
          const into = JSON.stringify(node.into);
          const table = tables.find((name) => into.includes(`"${name}"`));
          if (table !== undefined) recorder.inserts.push(table);
        }
        return node;
      },
      async transformResult({ result }) {
        return result;
      },
    },
  };
  return recorder;
}

// ---------------------------------------------------------------------------------------------
// A creditable order. N 1000 (settle_commission_fen), reserve 1500 → B 850; self 5000 bp → 425,
// direct 1000 bp → 85, indirect 500 bp → 42; platform 298 + reserve 150 = 448. Every other
// commission column holds a decoy (BR-CALC-02: with a settlement record N is only that value): the
// estimate 3222, and the snapshot taken on the estimate 4333 → B 3683, shares 1841 / 368 / 184.

export interface CreditableOrder {
  readonly order: Order;
  readonly self: string;
  readonly direct: string;
  readonly indirect: string;
}

/** What commission froze for an order, at reserve 1500; amounts are self, direct, indirect. */
interface SnapshotTerms {
  readonly raw_n_fen: bigint;
  readonly subsidy_commission_fen: bigint;
  readonly reserve_fen: bigint;
  readonly n_total_fen: bigint;
  readonly pre_base_deduct_fen: bigint;
  readonly base_fen: bigint;
  readonly platform_retain_fen: bigint;
  readonly user_share_total_fen: bigint;
  readonly platform_est_profit_fen: bigint;
  readonly amounts: readonly [bigint, bigint, bigint];
}

/** The order's commission snapshot, version 1, over the scenario's user and two new uplines. */
async function seedSnapshot(
  s: Scenario,
  order: Order,
  terms: SnapshotTerms,
): Promise<CreditableOrder> {
  const { db } = s.h;
  const attrAt = new Date(PAID_AT);
  const self = s.userId;
  const direct = await seedUser(db, s.appId);
  const indirect = await seedUser(db, s.appId);
  const [selfFen, directFen, indirectFen] = terms.amounts;
  const people = [
    { user: self, role: 'self', ratio: 5000, amount: selfFen },
    { user: direct, role: 'direct', ratio: 1000, amount: directFen },
    { user: indirect, role: 'indirect', ratio: 500, amount: indirectFen },
  ] as const;
  const ruleVersionId = randomUUID();
  await db
    .insertInto('commission_rule_versions')
    .values({
      app_id: s.appId,
      rule_version_id: ruleVersionId,
      status: 'published',
      effective_from: attrAt,
      indirect_enabled: true,
      created_at: attrAt,
    })
    .execute();
  await db
    .insertInto('commission_splits')
    .values({
      app_id: s.appId,
      order_id: order.order_id,
      rule_version_id: ruleVersionId,
      order_type: 'self',
      activity_type: null,
      rebate_mode: null,
      paid_at: attrAt,
      paid_at_source: 'platform',
      raw_n_fen: terms.raw_n_fen,
      subsidy_commission_fen: terms.subsidy_commission_fen,
      reserve_bp: 1500,
      reserve_fen: terms.reserve_fen,
      tlj_deduct_fen: 0n,
      base_fen: terms.base_fen,
      platform_retain_fen: terms.platform_retain_fen,
      beneficiaries: JSON.stringify(
        people.map((p) => ({
          user_id: p.user,
          role: p.role,
          ratio_bp: p.ratio,
          level: 'L1',
          initial_status: 'active',
          forfeit_reason: null,
        })),
      ),
      created_at: attrAt,
    })
    .execute();
  await db
    .insertInto('commission_split_totals')
    .values({
      app_id: s.appId,
      order_id: order.order_id,
      commission_version: 1,
      n_total_fen: terms.n_total_fen,
      pre_base_deduct_fen: terms.pre_base_deduct_fen,
      base_fen: terms.base_fen,
      user_share_total_fen: terms.user_share_total_fen,
      tlj_redpacket_fen: 0n,
      platform_est_profit_fen: terms.platform_est_profit_fen,
      created_at: attrAt,
    })
    .execute();
  await db
    .insertInto('commission_split_amounts')
    .values(
      people.map((p) => ({
        app_id: s.appId,
        order_id: order.order_id,
        commission_version: 1,
        user_id: p.user,
        role: p.role,
        base_fen: terms.base_fen,
        amount_fen: p.amount,
        created_at: attrAt,
      })),
    )
    .execute();
  for (const p of people) {
    await db
      .insertInto('commission_split_beneficiary_events')
      .values({
        app_id: s.appId,
        order_id: order.order_id,
        user_id: p.user,
        role: p.role,
        status: 'active',
        reason: null,
        created_at: attrAt,
      })
      .execute();
  }
  return { order, self, direct, indirect };
}

/**
 * A WAITING order on its settlement record, with its commission snapshot; taobao unless told. A jd
 * order stays RECEIVED: jd.csv has no settled code, its record comes from the statement alone
 * (docs/changes/20261101-京东结算佣金只由账单导入.md).
 */
export async function waitingOrder(
  s: Scenario,
  platform: 'taobao' | 'jd' = 'taobao',
): Promise<CreditableOrder> {
  const order = await seedOrder(s, {
    platform,
    product_key: `${platform}:fixture`,
    user_id: s.userId,
    user_basis: 'param',
    scene_basis: 'param',
    platform_status: platform === 'jd' ? 'RECEIVED' : 'SETTLED',
    rebate_status: 'WAITING',
    commission_version: 1,
    est_commission_fen: 3222n,
    settle_commission_fen: 1000n,
    subsidy_commission_fen: 111n,
    initial_est_fen: 4333n,
    n_total_fen: 4444n,
    pre_base_deduct_fen: 761n,
    base_fen: 3683n,
    platform_est_profit_fen: 2051n,
    received_at: RECEIVED_AT,
    settle_period: BILL,
    quantity: 1,
    refunded_quantity: 0,
  });
  const seeded = await seedSnapshot(s, order, {
    raw_n_fen: 4333n,
    subsidy_commission_fen: 111n,
    reserve_fen: 650n,
    n_total_fen: 4444n,
    pre_base_deduct_fen: 761n,
    base_fen: 3683n,
    platform_retain_fen: 1290n,
    user_share_total_fen: 2393n,
    platform_est_profit_fen: 2051n,
    amounts: [1841n, 368n, 184n],
  });
  await seedSettlement(s, order, 1000n);
  return seeded;
}

/** The order's first settlement record, from before anything the test imports. */
async function seedSettlement(s: Scenario, order: Order, commissionFen: bigint): Promise<void> {
  await s.h.db
    .insertInto('order_settlements')
    .values({
      app_id: s.appId,
      order_id: order.order_id,
      seq: 1,
      source: 'STATEMENT',
      settle_commission_fen: commissionFen,
      settled_at: new Date(PAID_AT),
      content_hash: randomUUID(),
      created_at: new Date(PAID_AT),
    })
    .execute();
}

/** The order columns of a taobao order valued at 1200. */
const ORDER_ON_1200 = {
  platform: 'taobao',
  product_key: 'taobao:fixture',
  commission_version: 1,
  est_commission_fen: 1200n,
  subsidy_commission_fen: 0n,
  initial_est_fen: 1200n,
  n_total_fen: 1200n,
  pre_base_deduct_fen: 180n,
  base_fen: 1020n,
  platform_est_profit_fen: 537n,
  quantity: 1,
  refunded_quantity: 0,
} as const;

/** N 1200, reserve 1500 → reserve 180, B 1020; 510 / 102 / 51, platform 357 + 180 = 537. */
const SNAPSHOT_ON_1200: SnapshotTerms = {
  raw_n_fen: 1200n,
  subsidy_commission_fen: 0n,
  reserve_fen: 180n,
  n_total_fen: 1200n,
  pre_base_deduct_fen: 180n,
  base_fen: 1020n,
  platform_retain_fen: 357n,
  user_share_total_fen: 663n,
  platform_est_profit_fen: 537n,
  amounts: [510n, 102n, 51n],
};

/** An ESTIMATED taobao order without a settlement record, valued on its estimate. */
export async function estimatedOrder(s: Scenario): Promise<CreditableOrder> {
  const order = await attributedOrder(s, { ...ORDER_ON_1200, platform_status: 'PAID' });
  return seedSnapshot(s, order, SNAPSHOT_ON_1200);
}

/** A WAITING taobao order whose settlement record says what its estimate said: 1200. */
export async function settledAtEstimate(s: Scenario): Promise<CreditableOrder> {
  const order = await attributedOrder(s, {
    ...ORDER_ON_1200,
    platform_status: 'SETTLED',
    rebate_status: 'WAITING',
    settle_commission_fen: 1200n,
    received_at: RECEIVED_AT,
    settle_period: BILL,
  });
  const seeded = await seedSnapshot(s, order, SNAPSHOT_ON_1200);
  await seedSettlement(s, order, 1200n);
  return seeded;
}

/** What the deletion expiry leaves (BR-ID-27, BR-ID-28): users deleting, the request processing. */
export async function seedProcessingDeletion(s: Scenario, userId: string): Promise<void> {
  await s.h.db
    .updateTable('users')
    .set({ status: 'deleting' })
    .where('app_id', '=', s.appId)
    .where('id', '=', userId)
    .execute();
  await s.h.db
    .insertInto('deletion_requests')
    .values({
      id: randomUUID(),
      app_id: s.appId,
      user_id: userId,
      status: 'processing',
      apply_at: '2026-09-24T02:00:00.000Z',
      cooling_until: NOW,
      balance_snapshot_fen: 0n,
    })
    .execute();
}

/**
 * The confirmed settle batch of the order, as the bill and the confirmation leave it, run by the
 * worker's own settle handler. The D-1 asset snapshot of NOW has timed out (BR-FUND-18), so the
 * batch runs; credit.enabled.<platform> is on. Returns the batch item.
 */
export async function runBatch(s: Scenario, w: Worker, order: Order) {
  const { db } = s.h;
  const confirmedAt = new Date(CONFIRMED_AT);
  await db
    .insertInto('config_items')
    .values({
      app_id: s.appId,
      key: `credit.enabled.${order.platform}`,
      value: JSON.stringify(true),
      updated_by: 'synthetic',
    })
    .execute();
  await db
    .insertInto('settle_bills')
    .values({
      app_id: s.appId,
      bill_id: BILL,
      generation_started_at: confirmedAt,
      generated_at: confirmedAt,
      created_at: confirmedAt,
    })
    .execute();
  const batchId = randomUUID();
  await db
    .insertInto('settle_batches')
    .values({
      batch_id: batchId,
      app_id: s.appId,
      bill_id: BILL,
      platform: order.platform,
      kind: 'main',
      status: 'CONFIRMED',
      settle_mode: 'IMMEDIATE',
      scheduled_at: null,
      confirmed_by: s.admin.id,
      confirmed_at: confirmedAt,
      cancelled_reason: null,
      settle_run_id: null,
      order_count: 1,
      started_at: null,
      finished_at: null,
      paused_by_switch_at: null,
      row_version: 3,
      created_at: confirmedAt,
    })
    .execute();
  const itemId = randomUUID();
  await db
    .insertInto('settle_batch_items')
    .values({
      id: itemId,
      app_id: s.appId,
      batch_id: batchId,
      item_type: 'order',
      order_id: order.order_id,
      user_id: null,
      role: null,
      beneficiary_credit_id: null,
      settle_seq: 1,
      b_settle_fen: 1000n,
      amount_fen: null,
      result: null,
      skip_reason: null,
      created_at: confirmedAt,
    })
    .execute();
  await w.settle(batchId, s.appId);
  return db
    .selectFrom('settle_batch_items')
    .selectAll()
    .where('app_id', '=', s.appId)
    .where('id', '=', itemId)
    .executeTakeFirstOrThrow();
}

/** A waitingOrder credited by the worker's settle handler; a seed failure is a plain Error. */
export async function creditedOrder(
  s: Scenario,
  w: Worker,
  platform: 'taobao' | 'jd' = 'taobao',
): Promise<CreditableOrder> {
  const seeded = await waitingOrder(s, platform);
  const item = await runBatch(s, w, seeded.order);
  const now = await orderNow(s, seeded.order.order_id);
  if (item.result !== 'credited' || now.rebate_status !== 'CREDITED') {
    throw new Error(
      `kit: the seeded credit left ${now.rebate_status}, item ${String(item.result)} ${String(item.skip_reason)}`,
    );
  }
  return seeded;
}

/** The union's report of an order on the normalized DTO: a raw status code and a new estimate. */
export function reported(order: Order, rawStatus: string, estFen: bigint): UnionOrder {
  return {
    platform: order.platform as UnionOrder['platform'],
    order_id: order.sub_order_id,
    sub_order_id: order.sub_order_id,
    parent_order_id: order.parent_order_id,
    raw_status: rawStatus,
    paid_fen: 2990n,
    commission_fen: estFen,
    est_commission_fen: estFen,
    paid_at: new Date(PAID_AT),
    raw_payload_id: '301',
  };
}

/** One commission version of an order: its amount rows and totals, without the write time. */
export async function versionRows(s: Scenario, orderId: string, version: number) {
  const { db } = s.h;
  const amounts = await db
    .selectFrom('commission_split_amounts')
    .select(['user_id', 'role', 'base_fen', 'amount_fen'])
    .where('app_id', '=', s.appId)
    .where('order_id', '=', orderId)
    .where('commission_version', '=', version)
    .orderBy('role')
    .execute();
  const totals = await db
    .selectFrom('commission_split_totals')
    .select([
      'n_total_fen',
      'pre_base_deduct_fen',
      'base_fen',
      'user_share_total_fen',
      'tlj_redpacket_fen',
      'platform_est_profit_fen',
    ])
    .where('app_id', '=', s.appId)
    .where('order_id', '=', orderId)
    .where('commission_version', '=', version)
    .execute();
  return { amounts, totals };
}

// ---------------------------------------------------------------------------------------------
// Money reads.

interface Line {
  readonly uniq_key: string;
  readonly subject: string;
  readonly owner_id: string;
  readonly amount_fen: bigint;
  readonly ledger_type: string;
  readonly sub_type: string | null;
}

export function lines(s: Scenario): Promise<readonly Line[]> {
  return s.h.db
    .selectFrom('ledger_entries as e')
    .innerJoin('ledger_vouchers as v', (join) =>
      join.onRef('v.id', '=', 'e.voucher_id').onRef('v.app_id', '=', 'e.app_id'),
    )
    .innerJoin('ledger_accounts as a', (join) =>
      join.onRef('a.id', '=', 'e.account_id').onRef('a.app_id', '=', 'e.app_id'),
    )
    .select([
      'v.uniq_key',
      'a.subject',
      'a.owner_id',
      'e.amount_fen',
      'e.ledger_type',
      'e.sub_type',
    ])
    .where('e.app_id', '=', s.appId)
    .execute();
}

/** The entries of one voucher as sorted `subject|owner|amount` strings (debit positive). */
export async function voucherLines(s: Scenario, uniqKey: string): Promise<string[]> {
  return (await lines(s))
    .filter((line) => line.uniq_key === uniqKey)
    .map((line) => `${line.subject}|${line.owner_id}|${String(line.amount_fen)}`)
    .sort();
}

/** The voucher keys of the app that contain `part`, sorted. */
export async function voucherKeys(s: Scenario, part: string): Promise<string[]> {
  const keys = (await lines(s)).map((line) => line.uniq_key);
  return [...new Set(keys)].filter((key) => key.includes(part)).sort();
}

/** Σ of the signed entries on one subject (debit positive). */
export async function subjectNet(s: Scenario, subject: string): Promise<bigint> {
  return (await lines(s))
    .filter((line) => line.subject === subject)
    .reduce((sum, line) => addFen(sum, line.amount_fen), 0n);
}

export async function available(s: Scenario, userId: string): Promise<bigint> {
  const [row] = await createLedger({ clock: s.f.clock }).getBalances(s.h.db, {
    appId: s.appId,
    userIds: [userId],
  });
  if (row === undefined) throw new Error('kit: the user has no ledger account');
  return row.available_fen;
}

/** Everything a clawback may change, for comparing before and after a redelivery. */
export async function moneyState(s: Scenario, seeded: CreditableOrder) {
  const all = await lines(s);
  return {
    order: await orderNow(s, seeded.order.order_id),
    rights: await rightsOf(s),
    lines: all
      .map(
        (line) =>
          `${line.uniq_key}|${line.subject}|${line.owner_id}|${String(line.amount_fen)}|${line.ledger_type}|${String(line.sub_type)}`,
      )
      .sort(),
    balances: [
      await available(s, seeded.self),
      await available(s, seeded.direct),
      await available(s, seeded.indirect),
    ],
    pending: (await s.state()).pending,
    events: await s.events(),
  };
}
