// 唯一超管验证器的运维重置命令（B1-34t；08 BR-ID-43「重置身份验证器」：只有一位超管时由负责人在服务器上用运维
// 命令重置，同样写 audit_logs；编排裁定 D10-2945、D10-2947）。由负责人本人在交互终端运行（规划/11 §7.1）。
// 同应用里另有可用超管（启用且已绑定验证器）时一律拒绝：那种情况由另一位超管在后台重置（HTTP adminResetAdminTotp）。
//
// 运行（在 rebate-platform 根目录，环境变量同 admin 入口：APP_ENV、DATABASE_URL（couli_app 角色）、REDIS_URL）：
//
//   node --conditions=couli-src apps/api/scripts/admin-totp-reset.ts --app <app_id> --login <登录名>
//
// 流程：回显应用、登录名与验证器绑定状态 → 输入原因（写明怎样确认是本人，1–200 字，不能全是空白）→ 输入 yes
// 确认（只认精确的 yes，其他任何输入都退出、不写库）→ 在同一事务里锁行重新判定、清掉验证器三列、写系统审计
// （system_actor system:ops_command，action admin_totp_reset）、作废该账号之前签发的 admin_token、登录票据与
// 二次验证令牌（Redis 命名空间 admin-auth）；作废写不进去时整笔回滚。用例见
// src/modules/admin/application/operator-totp-reset.ts。密码、权限点、启用状态与验证手机号不变；该账号下次登录
// 改为开启第二因子（已登记验证手机号的照常用短信登录）。终端与日志都不出现任何密钥。
//
// 退出码见 TOTP_RESET_EXIT：0 已重置；2 参数或输入不合法（缺 --app / --login、不是交互终端、原因不合法）；
// 3 同应用另有可用超管；4 未输入 yes；5 找不到该账号；6 该账号不是超管；1 其他失败（配置、连接、作废写入等；事务内的失败整笔回滚）。
//
// 只组装 @couli/db、platform 与 admin/ 的纯模块，不 import Nest、不跑 dist。日志（pino）写到 stderr。
// 导入本文件不启动入口（规则测试注入 terminal 与 useCase 调 runAdminTotpResetCommand）。
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { destination } from 'pino';
import {
  OPERATOR_TOTP_RESET_REASON_MAX,
  createOperatorTotpReset,
  operatorResetReasonOk,
  type OperatorTotpReset,
  type OperatorTotpResetResult,
} from '../src/modules/admin/application/operator-totp-reset.ts';
import { createAdminRevocations } from '../src/modules/admin/infra/admin-revocations.ts';
import { createSystemAuditWriter } from '../src/modules/admin/infra/system-audit.ts';
import { clockFromConfig } from '../src/modules/platform/clock/clock.ts';
import { loadConfig } from '../src/modules/platform/config/config.ts';
import { createManagedDbHandles, loadConnectionConfig } from '../src/modules/platform/db/index.ts';
import { SENSITIVE_KEYS, createRootLogger } from '../src/modules/platform/logging/logger.ts';
import { createRedisHandle } from '../src/modules/platform/redis/index.ts';

export const TOTP_RESET_EXIT = Object.freeze({
  ok: 0,
  failed: 1,
  invalid: 2,
  anotherUsableSuper: 3,
  notConfirmed: 4,
  unknown: 5,
  notSuper: 6,
});

export interface AdminTotpResetTerminal {
  readonly isTTY: boolean;
  readReason(prompt: string): Promise<string | null>;
  readConfirmation(prompt: string): Promise<string | null>;
  write(message: string): void;
}

export interface AdminTotpResetCommandDeps {
  readonly terminal: AdminTotpResetTerminal;
  readonly useCase: OperatorTotpReset;
}

const USAGE = '用法：admin-totp-reset.ts --app <app_id> --login <登录名>';
const CONFIRM_WORD = 'yes';

/** null: missing or empty --app / --login, an unknown option or a positional argument. */
function parse(argv: readonly string[]): { appId: string; loginName: string } | null {
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: { app: { type: 'string' }, login: { type: 'string' } },
      strict: true,
      allowPositionals: false,
    });
    if (values.app === undefined || values.app === '') return null;
    if (values.login === undefined || values.login === '') return null;
    return { appId: values.app, loginName: values.login };
  } catch {
    return null;
  }
}

const REFUSALS: Readonly<
  Record<Extract<OperatorTotpResetResult, { kind: 'refused' }>['reason'], [number, string]>
> = Object.freeze({
  unknown: [TOTP_RESET_EXIT.unknown, '找不到该账号，什么都没改。'],
  not_super: [TOTP_RESET_EXIT.notSuper, '该账号不是超管，请由超管在后台重置，什么都没改。'],
  another_usable_super: [
    TOTP_RESET_EXIT.anotherUsableSuper,
    '同应用另有启用且已绑定验证器的超管，请由那位超管在后台重置，什么都没改。',
  ],
  invalid_reason: [TOTP_RESET_EXIT.invalid, '原因不合法，什么都没改。'],
});

export async function runAdminTotpResetCommand(
  args: readonly string[],
  deps: AdminTotpResetCommandDeps,
): Promise<number> {
  const { terminal, useCase } = deps;
  const target = parse(args);
  if (target === null) {
    terminal.write(USAGE);
    return TOTP_RESET_EXIT.invalid;
  }
  if (!terminal.isTTY) {
    terminal.write('必须由负责人本人在交互终端运行，已退出，什么都没改。');
    return TOTP_RESET_EXIT.invalid;
  }

  const state = await useCase.inspect(target);
  if (state === null) {
    terminal.write(`应用 ${target.appId} 下找不到登录名 ${target.loginName}，什么都没改。`);
    return TOTP_RESET_EXIT.unknown;
  }
  terminal.write(
    [
      '将重置下面这个超管账号的身份验证器：',
      `  应用：${target.appId}`,
      `  登录名：${target.loginName}`,
      `  身份验证器：${state.totpBound ? '已绑定' : '未绑定'}`,
    ].join('\n'),
  );

  const reason = await terminal.readReason(
    `重置原因（写明怎样确认是本人，1–${String(OPERATOR_TOTP_RESET_REASON_MAX)} 字）：`,
  );
  if (reason === null || !operatorResetReasonOk(reason)) {
    terminal.write(
      `原因必填，1–${String(OPERATOR_TOTP_RESET_REASON_MAX)} 字且不能全是空白，已退出，什么都没改。`,
    );
    return TOTP_RESET_EXIT.invalid;
  }

  const answer = await terminal.readConfirmation(
    `确认重置应用 ${target.appId} 下 ${target.loginName} 的身份验证器？输入 ${CONFIRM_WORD} 继续，其他任何输入都退出：`,
  );
  if (answer !== CONFIRM_WORD) {
    terminal.write('未确认，已退出，什么都没改。');
    return TOTP_RESET_EXIT.notConfirmed;
  }

  const result = await useCase.reset({ ...target, reason });
  if (result.kind === 'reset') {
    terminal.write(
      '已重置：验证器已清除，之前签发的登录凭证全部作废，已写审计。该账号下次登录时重新开启第二因子。',
    );
    return TOTP_RESET_EXIT.ok;
  }
  const [code, message] = REFUSALS[result.reason];
  terminal.write(message);
  return code;
}

/** Reads one echoed line from the TTY. null on Ctrl-C, Ctrl-D or end of input. */
function readLine(prompt: string): Promise<string | null> {
  const input = process.stdin;
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    let value = '';
    const finish = (result: string | null) => {
      input.off('data', onData);
      input.off('end', onEnd);
      input.setRawMode(false);
      input.pause();
      process.stdout.write('\n');
      resolve(result);
    };
    const onEnd = () => finish(null);
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n') return finish(value);
        if (char === '\u0003' || char === '\u0004') return finish(null);
        if (char === '\u007f' || char === '\b') {
          if (value !== '') process.stdout.write('\b \b');
          value = [...value].slice(0, -1).join('');
        } else if (char >= ' ') {
          process.stdout.write(char);
          value += char;
        }
      }
    };
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
    input.once('end', onEnd);
  });
}

async function main(): Promise<number> {
  const config = loadConfig(process.env);
  const logger = createRootLogger(
    { level: config.logLevel, entry: 'admin-totp-reset', appEnv: config.appEnv },
    destination(2),
  );
  // The worker profile reads exactly DATABASE_URL and REDIS_URL (no read replica needed here).
  const connection = loadConnectionConfig('worker', process.env);
  const clock = clockFromConfig(config);
  const handles = createManagedDbHandles(
    {
      name: 'db',
      url: connection.db.url,
      max: 1,
      applicationName: 'couli-admin-totp-reset',
      readOnly: false,
    },
    null,
    { logger },
  );
  try {
    // Same Redis and namespace as the admin entry, so the admin checks read this voiding instant.
    const redis = await createRedisHandle(
      { entry: 'admin', redisUrl: connection.redisUrl },
      { logger },
    );
    if (redis === null) throw new Error('REDIS_URL missing');
    try {
      const useCase = createOperatorTotpReset({
        db: handles.db,
        clock,
        audit: createSystemAuditWriter({ clock, sensitiveKeys: SENSITIVE_KEYS }),
        revocations: createAdminRevocations({ redis: redis.namespace('admin-auth') }),
      });
      return await runAdminTotpResetCommand(process.argv.slice(2), {
        useCase,
        terminal: {
          isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
          readReason: readLine,
          readConfirmation: readLine,
          write: (message) => {
            process.stdout.write(`${message}\n`);
          },
        },
      });
    } finally {
      await redis.close();
    }
  } finally {
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
      // Configuration, database and Redis errors carry fixed texts without values.
      process.stderr.write(
        `重置失败：${error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error'}\n`,
      );
      process.exitCode = TOTP_RESET_EXIT.failed;
    },
  );
}
