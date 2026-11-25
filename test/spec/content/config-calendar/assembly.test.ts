import { randomBytes } from 'node:crypto';
import type { DB } from '@couli/db';
import { Kysely, PostgresDialect, type PostgresPool } from 'kysely';
import { expect, it, vi } from 'vitest';
import {
  createRootLogger,
  FixedClock,
  loadConfig,
  type Clock,
  type FieldCrypto,
  type PlatformOptions,
  type RootLogger,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createWrappedKeyring,
  LocalKeyProvider,
  openFieldCrypto,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import {
  createWithdrawApply,
  readReviewCalendars,
  type WithdrawApplyService,
} from '../../../../apps/api/src/modules/payout/application/withdraw-apply.ts';
import type { AutoPayoutConfigPort } from '../../../../apps/api/src/modules/payout/application/auto-payout.ts';
import { WITHDRAW_APPLY } from '../../../../apps/api/src/modules/payout/tokens.ts';
import {
  resolveAppealDeadline,
  resolveWorkingDayDeadline,
} from '../../../../apps/api/src/modules/risk/application/appeal-calendar.ts';
import type { RateLimitConfigReader } from '../../../../apps/api/src/modules/risk/application/rate-limit.ts';
import type { CalendarPort, ExpiryApi } from '../../identity/deletion-expiry/kit.ts';

// 观察提现服务实际收到的配置端口，保留原工厂与读取逻辑。
vi.mock('../../../../apps/api/src/modules/payout/application/withdraw-apply.ts', { spy: true });

const API = new URL('../../../../apps/api/src/', import.meta.url);
const APP_ID = 'calendar_assembly';
const HOLIDAYS = 'calendar.cn_holidays.2026';
const MAKEUP = 'calendar.cn_makeup_workdays.2026';
const START = '2026-10-01T12:00:00+08:00';
const EXPECTED_DEADLINE = '2026-10-05T16:00:00.000Z';
const CALENDAR = {
  holidays: ['2026-10-02', '2026-10-06'],
  makeupWorkdays: ['2026-10-03', '2026-10-04'],
};

type Entry = 'api' | 'worker' | 'admin';
interface ModuleMetadata {
  readonly imports?: readonly unknown[];
  readonly providers?: readonly unknown[];
}

function fixture(entry: Entry, now = START, overdueRequests: readonly unknown[] = []) {
  const clock = new FixedClock(now);
  const logger = createRootLogger({ level: 'silent', entry, appEnv: 'test' }, { write() {} });
  const calendarQueries: { sql: string; parameters: readonly unknown[] }[] = [];
  const calendarRows = [
    { key: HOLIDAYS, value: CALENDAR.holidays, version: 2 },
    { key: MAKEUP, value: CALENDAR.makeupWorkdays, version: 2 },
  ];
  // Kysely 生成真实 SQL，由内存驱动记录和返回夹具数据。
  const client = {
    processID: 1,
    release() {},
    async query(sql: string, parameters: readonly unknown[] = []) {
      let rows: readonly unknown[] = [];
      if (sql.includes('"config_items"')) {
        calendarQueries.push({ sql, parameters });
        if (parameters.includes(APP_ID)) {
          rows = calendarRows.filter(({ key }) => parameters.includes(key));
        }
      } else if (sql.includes('"deletion_requests"') && sql.includes('"apply_at" <=')) {
        rows = overdueRequests;
      }
      return { command: 'SELECT', rowCount: rows.length, rows };
    },
  };
  const pool = { connect: async () => client, end: async () => undefined, options: {} };
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: pool as unknown as PostgresPool }),
  });
  return { clock, logger, db, calendarQueries };
}

async function assemble(entry: Entry, clock: Clock, logger: RootLogger) {
  // URL 导入遵循规则测试项目的装配测试惯例，避免带装饰器的入口进入该项目的类型编译。
  const { AppModule } = (await import(new URL('app.module.ts', API).href)) as {
    AppModule: { forEntry(options: PlatformOptions): ModuleMetadata };
  };
  return AppModule.forEntry({ entry, config: loadConfig({ APP_ENV: 'test' }), clock, logger });
}

function factory<Args extends unknown[], Result>(root: ModuleMetadata, token: symbol | string) {
  const providers = (root.imports ?? []).flatMap((child) => {
    if (typeof child !== 'object' || child === null) return [];
    return (child as ModuleMetadata).providers ?? [];
  });
  const provider = providers.find((candidate) => {
    if (typeof candidate !== 'object' || candidate === null || !('provide' in candidate)) {
      return false;
    }
    const provided = candidate.provide;
    return typeof token === 'string'
      ? typeof provided === 'symbol' && provided.description === token
      : provided === token;
  }) as { useFactory?: (...args: Args) => Result } | undefined;
  expect(provider?.useFactory, `缺少 ${String(token)} 的生产工厂`).toBeTypeOf('function');
  return provider!.useFactory!;
}

function expectOneCalendarQuery({ calendarQueries }: ReturnType<typeof fixture>) {
  expect(calendarQueries).toHaveLength(1);
  const query = calendarQueries[0]!;
  const expected = [APP_ID, HOLIDAYS, MAKEUP].sort();
  expect(query.sql).toMatch(/^select\b/i);
  expect(query.parameters.map(String).sort()).toEqual(expected);
}

it('[AC-B1-34s#9] API 入口给提现申请装配批量读取，同年日历双键只查一次', async () => {
  const f = fixture('api');
  try {
    const root = await assemble('api', f.clock, f.logger);
    const applyFactory = factory<
      [Clock, RootLogger, Kysely<DB>, FieldCrypto],
      WithdrawApplyService | null
    >(root, WITHDRAW_APPLY);
    const keyProvider = new LocalKeyProvider(randomBytes(32));
    const crypto = await openFieldCrypto(await createWrappedKeyring(keyProvider), keyProvider);
    const create = vi.mocked(createWithdrawApply);
    create.mockClear();
    applyFactory(f.clock, f.logger, f.db, crypto);
    expect(create).toHaveBeenCalledTimes(1);
    const { rules } = create.mock.calls[0]![0];
    expect(rules.config).toMatchObject({ configValues: expect.any(Function) });
    expect(await readReviewCalendars(rules, f.db, APP_ID, f.clock.now())).toStrictEqual({
      2026: CALENDAR,
    });
    expectOneCalendarQuery(f);
  } finally {
    await f.db.destroy();
  }
});

it('[AC-B1-34s#10] API 入口给申诉装配批量读取，同年日历双键只查一次', async () => {
  const f = fixture('api');
  try {
    const root = await assemble('api', f.clock, f.logger);
    const configFactory = factory<[Clock], (db: Kysely<DB>) => RateLimitConfigReader>(
      root,
      'APPEALS_CONFIG',
    );
    const config = configFactory(f.clock)(f.db);
    expect(config).toMatchObject({ configValues: expect.any(Function) });
    const deadline = await resolveAppealDeadline({
      appId: APP_ID,
      clock: f.clock,
      config,
      logger: f.logger,
    });
    expect(deadline.toISOString()).toBe(EXPECTED_DEADLINE);
    expectOneCalendarQuery(f);
  } finally {
    await f.db.destroy();
  }
});

it('[AC-B1-34s#11] Worker 注销扫描使用生产批量端口，同一应用同年两笔申请共用一次双键查询', async () => {
  const f = fixture(
    'worker',
    '2026-11-01T12:00:00+08:00',
    ['request-1', 'request-2'].map((id) => ({
      id,
      app_id: APP_ID,
      apply_at: new FixedClock(START).now(),
      status: 'processing',
    })),
  );
  try {
    const root = await assemble('worker', f.clock, f.logger);
    const calendar = factory<[Clock, Kysely<DB>], CalendarPort>(
      root,
      'IDENTITY_DELETION_EXPIRY_CALENDAR_CONFIG',
    )(f.clock, f.db);
    expect(calendar).toMatchObject({ configValues: expect.any(Function) });
    const identityUrl = new URL('modules/identity/index.ts', API).href;
    const identity = (await import(identityUrl)) as Pick<ExpiryApi, 'createDeletionExpiry'>;
    const warn = vi.spyOn(f.logger, 'warn');
    const expiry = identity.createDeletionExpiry({
      db: f.db,
      clock: f.clock,
      logger: f.logger,
      calendar,
      withdrawals: { hasNonTerminal: async () => false },
      balance: { availableFen: async () => 0n },
    });
    await expiry.runOnce();
    expectOneCalendarQuery(f);
    expect(
      warn.mock.calls.filter(([, message]) => message === 'identity_deletion_overdue'),
    ).toHaveLength(2);
  } finally {
    await f.db.destroy();
  }
});

it('[AC-B1-34s#12] 后台个人信息副本的生产日历端口通过一次查询读同年双键', async () => {
  const { IdentityAdminModule } = (await import(
    new URL('modules/identity/identity-admin.module.ts', API).href
  )) as {
    IdentityAdminModule: {
      forAdmin(options: { dataCopyCalendar(db: Kysely<DB>, clock: Clock): CalendarPort }): unknown;
    };
  };
  const forAdmin = vi.spyOn(IdentityAdminModule, 'forAdmin');
  const f = fixture('admin');
  try {
    await assemble('admin', f.clock, f.logger);
    expect(forAdmin).toHaveBeenCalledTimes(1);
    const options = forAdmin.mock.calls[0]![0];
    expect(options.dataCopyCalendar).toBeTypeOf('function');
    const calendar = options.dataCopyCalendar(f.db, f.clock);
    expect(calendar).toMatchObject({ configValues: expect.any(Function) });
    const deadline = await resolveWorkingDayDeadline({
      appId: APP_ID,
      from: f.clock.now(),
      workingDays: 3,
      config: calendar,
      logger: f.logger,
    });
    expect(deadline.toISOString()).toBe(EXPECTED_DEADLINE);
    expectOneCalendarQuery(f);
  } finally {
    forAdmin.mockRestore();
    await f.db.destroy();
  }
});

it('[AC-B1-34s#13] Worker 自动到账改转人工时可用生产批量端口一次查询同年日历双键', async () => {
  const { PayoutModule } = (await import(new URL('modules/payout/payout.module.ts', API).href)) as {
    PayoutModule: {
      forWorker(options: {
        autoPayout?: (deps: { db: Kysely<DB>; clock: Clock }) => { config: AutoPayoutConfigPort };
      }): unknown;
    };
  };
  const forWorker = vi.spyOn(PayoutModule, 'forWorker');
  const f = fixture('worker');
  try {
    await assemble('worker', f.clock, f.logger);
    expect(forWorker).toHaveBeenCalledTimes(1);
    const { autoPayout } = forWorker.mock.calls[0]![0];
    expect(autoPayout).toBeTypeOf('function');
    const { config } = autoPayout!({ db: f.db, clock: f.clock });
    expect(config).toMatchObject({ configValues: expect.any(Function) });
    expect(
      await readReviewCalendars({ config, logger: f.logger }, f.db, APP_ID, f.clock.now()),
    ).toStrictEqual({ 2026: CALENDAR });
    expectOneCalendarQuery(f);
  } finally {
    forWorker.mockRestore();
    await f.db.destroy();
  }
});
