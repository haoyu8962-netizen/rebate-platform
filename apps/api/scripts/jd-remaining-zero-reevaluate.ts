// B2-04zzh（FU-JD-REMAINING-ZERO-SWITCH-ON，D10-923 / D10-930；BR-CALC-15、BR-FUND-07、BR-FUND-01 R6）：
// 京东剩余数量为 0 的未入账单一次性重评 CLI。脚本只做命令行外壳：参数解析、调用 settlement 的重评服务、打印安全字段。
//
// 运行方式（仓库根目录；服务从 apps/api/dist 编译产物组装，先构建）：
//   pnpm build
//   APP_ENV=<环境> DATABASE_URL=<couli_app 连接> \
//     node apps/api/scripts/jd-remaining-zero-reevaluate.ts --app <app_id> --actor <运维执行人 admin id> [--apply]
// 默认只列清单（dry-run，什么都不写）；--apply 才逐单作废（独立事务、订单键锁内重读、同一判定、同事务
// order.invalidated 与一条 audit_logs）。开关 orders.jd.refunded_quantity_r9_enabled 关时 --apply 也只列清单。
// 可重跑：已 VOID 的单不再出现。输出处理数 / 作废数 / 跳过数；清单只打内部 order_id，不打子订单号、用户与买家参数。
// 导入本文件不启动入口（规则测试注入 deps 调 run）。
// 退出码：0 成功，1 其他失败，2 参数不合法（与 union-pids.ts 同一分层）。
// The service file itself (no Nest decorators), so the spec project's compile stays off the barrel.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { JdRemainingZeroReevaluation } from '../src/modules/settlement/rebate/application/rebate.ts';

export const JD_REMAINING_ZERO_REEVALUATE_EXIT = Object.freeze({ ok: 0, failed: 1, invalid: 2 });

export interface JdRemainingZeroReevaluateDeps {
  /** settlement createJdRemainingZeroReevaluation（入口从 dist 组装）。 */
  readonly reevaluation: JdRemainingZeroReevaluation;
  readonly terminal: {
    readonly write: (message: string) => void;
    readonly error: (message: string) => void;
  };
}

/**
 * exitCode：0 / 1 / 2；candidates：清单张数（处理数）；voided：作废数；skipped：跳过数。
 * 参数不合法时三个计数都是 0，什么都不读、不写。
 */
export interface JdRemainingZeroReevaluateResult {
  readonly exitCode: number;
  readonly candidates: number;
  readonly voided: number;
  readonly skipped: number;
}

const USAGE =
  '用法：jd-remaining-zero-reevaluate.ts --app <app_id> [--actor <运维执行人 admin id>] [--apply]（--apply 必须带 --actor）';

interface Parsed {
  readonly appId: string;
  readonly actor: string | null;
  readonly apply: boolean;
}

/** null：参数不合法（缺 --app、--apply 缺 --actor、未知参数、位置参数、空值）。 */
function parse(argv: readonly string[]): Parsed | null {
  let values: { app?: string | undefined; actor?: string | undefined; apply?: boolean | undefined };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        app: { type: 'string' },
        actor: { type: 'string' },
        apply: { type: 'boolean' },
      },
      allowPositionals: false,
      strict: true,
    }));
  } catch {
    return null;
  }
  const appId = values.app?.trim() ?? '';
  const actor = values.actor?.trim() ?? '';
  const apply = values.apply === true;
  if (appId === '') return null;
  if (values.actor !== undefined && actor === '') return null;
  if (apply && actor === '') return null;
  return { appId, actor: actor === '' ? null : actor, apply };
}

const NOTHING = { candidates: 0, voided: 0, skipped: 0 } as const;

/** settlement JdRemainingZeroReevaluationError（按名字与形状认，脚本不在运行时依赖源码模块）。 */
function isPartialFailure(error: unknown): error is {
  readonly summary: {
    readonly candidates: number;
    readonly voided: number;
    readonly skipped: number;
  };
  readonly failed: number;
} {
  if (!(error instanceof Error) || error.name !== 'JdRemainingZeroReevaluationError') return false;
  const candidate = error as Error & { summary?: unknown; failed?: unknown };
  return (
    typeof candidate.failed === 'number' &&
    typeof candidate.summary === 'object' &&
    candidate.summary !== null
  );
}

export async function run(
  argv: readonly string[],
  deps: JdRemainingZeroReevaluateDeps,
): Promise<JdRemainingZeroReevaluateResult> {
  const parsed = parse(argv);
  if (parsed === null) {
    deps.terminal.error(USAGE);
    return { exitCode: JD_REMAINING_ZERO_REEVALUATE_EXIT.invalid, ...NOTHING };
  }
  try {
    const listed = await deps.reevaluation.list(parsed.appId);
    deps.terminal.write(`剩余数量 ≤ 0 的未入账京东单：${String(listed.length)} 张`);
    for (const candidate of listed) {
      deps.terminal.write(`${candidate.orderId} ${candidate.rebateStatus}`);
    }
    if (!parsed.apply) {
      deps.terminal.write('只列清单（dry-run），未改任何单；加 --apply 才执行。');
      return {
        exitCode: JD_REMAINING_ZERO_REEVALUATE_EXIT.ok,
        candidates: listed.length,
        voided: 0,
        skipped: 0,
      };
    }
    // parse() guarantees an actor with --apply.
    const summary = await deps.reevaluation.apply({
      appId: parsed.appId,
      actor: parsed.actor ?? '',
    });
    if (summary.candidates > 0 && summary.voided === 0 && summary.skipped === 0) {
      deps.terminal.write(
        '开关 orders.jd.refunded_quantity_r9_enabled 未开：只列清单，未改任何单。',
      );
    }
    deps.terminal.write(
      `处理 ${String(summary.candidates)} 张，作废 ${String(summary.voided)} 张，跳过 ${String(summary.skipped)} 张。`,
    );
    return { exitCode: JD_REMAINING_ZERO_REEVALUATE_EXIT.ok, ...summary };
  } catch (error) {
    // 只打错误类型、计数与固定文案，不带单号、用户与参数值。
    if (isPartialFailure(error)) {
      const { summary, failed } = error;
      deps.terminal.error(
        `部分失败：处理 ${String(summary.candidates)} 张，作废 ${String(summary.voided)} 张，跳过 ${String(summary.skipped)} 张，失败 ${String(failed)} 张（已回滚，重跑会再处理）。`,
      );
      return { exitCode: JD_REMAINING_ZERO_REEVALUATE_EXIT.failed, ...summary };
    }
    deps.terminal.error(`执行失败：${error instanceof Error ? error.name : 'unknown error'}`);
    return { exitCode: JD_REMAINING_ZERO_REEVALUATE_EXIT.failed, ...NOTHING };
  }
}

// ---- Entry: only when executed directly; assembles the built services from apps/api/dist. ----

function distUrl(path: string): string {
  return new URL(`../dist/${path}`, import.meta.url).href;
}

async function main(): Promise<number> {
  // Nest decorators in built barrels need the metadata polyfill before loading.
  await import('reflect-metadata');
  const [
    configMod,
    clockMod,
    dbMod,
    loggerMod,
    queueMod,
    eventsMod,
    contentMod,
    auditMod,
    rebateMod,
  ] = (await Promise.all([
    import(distUrl('modules/platform/config/config.js')),
    import(distUrl('modules/platform/clock/clock.js')),
    import(distUrl('modules/platform/db/index.js')),
    import(distUrl('modules/platform/logging/logger.js')),
    import(distUrl('modules/platform/queue/runtime.js')),
    import(distUrl('modules/platform/events/events.js')),
    import(distUrl('modules/content/index.js')),
    import(distUrl('modules/admin/infra/audit-writer.js')),
    import(distUrl('modules/settlement/rebate/application/rebate.js')),
  ])) as [
    typeof import('../src/modules/platform/config/config.ts'),
    typeof import('../src/modules/platform/clock/clock.ts'),
    typeof import('../src/modules/platform/db/index.ts'),
    typeof import('../src/modules/platform/logging/logger.ts'),
    typeof import('../src/modules/platform/queue/runtime.ts'),
    typeof import('../src/modules/platform/events/events.ts'),
    typeof import('../src/modules/content/index.ts'),
    typeof import('../src/modules/admin/infra/audit-writer.ts'),
    typeof import('../src/modules/settlement/rebate/application/rebate.ts'),
  ];
  const config = configMod.loadConfig(process.env);
  const logger = loggerMod.createRootLogger(
    { level: config.logLevel, entry: 'jd-remaining-zero-reevaluate', appEnv: config.appEnv },
    (await import('pino')).destination(2),
  );
  const clock = clockMod.clockFromConfig(config);
  const url = dbMod.loadDatabaseUrl(process.env['DATABASE_URL'] ?? '', 'DATABASE_URL');
  const handles = dbMod.createManagedDbHandles(
    { name: 'db', url, max: 2, applicationName: 'couli-jd-remaining-zero', readOnly: false },
    null,
    { logger },
  );
  const db = handles.db;
  // A send-only queue (the admin entry's plan registers no consumer): order.invalidated reaches its
  // subscribers through the same bus and job table as the entries' own publishes.
  const queue = queueMod.createQueueRuntime({ entry: 'admin', db, logger });
  try {
    await queue.start();
    const reevaluation = rebateMod.createJdRemainingZeroReevaluation({
      db,
      clock,
      logger,
      events: eventsMod.createEventBus({ queue, clock }),
      // Same adapter as the worker's SettlementWorkerPorts.config (app.module): the item's value.
      config: {
        get: async (appId, key) =>
          (await contentMod.createContentReader({ db, clock }).configValue(appId, key))?.value,
      },
      audit: (trx) =>
        auditMod.createAuditWriter({ db: trx, clock, sensitiveKeys: loggerMod.SENSITIVE_KEYS }),
    });
    const { exitCode } = await run(process.argv.slice(2), {
      reevaluation,
      terminal: {
        write: (message) => process.stdout.write(`${message}\n`),
        error: (message) => process.stderr.write(`${message}\n`),
      },
    });
    return exitCode;
  } finally {
    await queue.stop();
    await handles.close();
  }
}

function executedDirectly(): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (executedDirectly()) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(
        `启动失败：${error instanceof Error ? error.name : 'unknown error'}（未构建时先运行 pnpm build）\n`,
      );
      process.exitCode = JD_REMAINING_ZERO_REEVALUATE_EXIT.failed;
    },
  );
}
