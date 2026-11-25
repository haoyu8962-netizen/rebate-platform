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
// src/modules/admin/application/operator-totp-reset.ts。密码、权限点、启用状态与验证手机号不变。终端与日志都不出现
// 任何密钥。
//
// 已是未绑定：锁行后发现该账号的验证器已经未绑定（例如上一次重置已经成功、只是没看到成功提示就重跑），本命令
// 不改行、不写审计、不推进作废时刻，提示「已是未绑定，未做任何改动」，退出码 7（编排裁定 D10-2999 ②）；上一次
// 重置之后本人已拿到的绑定票据照常可用。本人在那之后已经绑定了新验证器、又需要重置的，是新的一次重置，照常执行。
//
// 确认期间状态变化：回显时读到的账号快照（row_version 与验证器绑定时刻）随重置请求带进事务，锁行后与之不同
// （例如负责人输入原因与 yes 期间，本人在浏览器绑定了新验证器）就不改行、不写审计、不推进作废时刻，提示「确认期间
// 账号状态已变化，未做任何改动，请重新运行」，退出码 8（B1-34t 实现 r3，money r2 S1）；重跑时按新的回显再确认。
//
// 重置之后的登录路径：账号密码（及 IP 白名单）→ 绑定新验证器（重新生成密钥），两步完成才签发 admin_token，
// 与契约的登录流程一致；已登记验证手机号的账号在登录第二步改走短信属于二次验证线的后续
// （FU-B134T-SMS-LOGIN-AFTER-RESET，D10-2999 ③），本命令不涉及。
//
// 失败与重跑：作废写在事务内、提交前（与后台 adminResetAdminTotp 同写法）。退出码 1 时，验证器可能仍是绑定状态
// 而已有会话已被作废、被要求重新登录——这是预期的偏严结果；重跑本命令即可完成重置（D10-2999 ①）。
//
// 退出码见 TOTP_RESET_EXIT：
//   0 已重置；
//   1 其他失败（配置、连接、作废写入、提交等；事务内的失败整笔回滚，重跑即可）；
//   2 参数或输入不合法（缺 --app / --login、不是交互终端、原因不合法）；
//   3 同应用另有可用超管；4 未输入 yes；5 找不到该账号；6 该账号不是超管；
//   7 该账号的验证器已是未绑定，未做任何改动；
//   8 回显之后、确认期间账号状态已变化，未做任何改动，请重新运行。
//
// 确认只认精确的 yes：终端字节按 UTF-8 流式解码且保留开头的 U+FEFF（ignoreBOM），带 BOM 的「yes」不算确认。
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
  createTerminalLineEditor,
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
  alreadyUnbound: 7,
  stateChanged: 8,
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

  // The snapshot of what was echoed goes with the request (money r2 S1); absent only from fakes.
  const result = await useCase.reset(
    state.snapshot === undefined
      ? { ...target, reason }
      : { ...target, reason, expected: state.snapshot },
  );
  if (result.kind === 'reset') {
    terminal.write(
      '已重置：验证器已清除，之前签发的登录凭证全部作废，已写审计。该账号下次登录：账号密码 → 绑定新验证器。',
    );
    return TOTP_RESET_EXIT.ok;
  }
  if (result.kind === 'already_unbound') {
    terminal.write(
      '该账号的身份验证器已是未绑定，未做任何改动（没有写审计，已有的登录凭证不受影响）。',
    );
    return TOTP_RESET_EXIT.alreadyUnbound;
  }
  if (result.kind === 'state_changed') {
    terminal.write('确认期间账号状态已变化，未做任何改动，请重新运行。');
    return TOTP_RESET_EXIT.stateChanged;
  }
  const [code, message] = REFUSALS[result.reason];
  terminal.write(message);
  return code;
}

/**
 * Reads one echoed line from the TTY. null on Ctrl-C, Ctrl-D or end of input. The bytes go through
 * the streaming line editor, so a character split over two chunks is decoded whole.
 */
function readLine(prompt: string): Promise<string | null> {
  const input = process.stdin;
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    const editor = createTerminalLineEditor();
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
      const step = editor.feed(chunk);
      if (step.echo !== '') process.stdout.write(step.echo);
      if (step.done !== undefined) finish(step.done);
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
        `重置失败：${error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error'}\n` +
          '若已有会话被要求重新登录，属预期（作废先于提交，偏严），重跑本命令即可完成重置。\n',
      );
      process.exitCode = TOTP_RESET_EXIT.failed;
    },
  );
}
