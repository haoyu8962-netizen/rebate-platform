// STAGING-SMOKE (QA-04b): the daily interface-level smoke against staging (brief「第一阶段」,
// rulings D10-2111, D10-2112, D10-2119). Runs only on the test node:
//
//   node test/staging-smoke/smoke.ts --out <result directory>
//
// Hard off outside staging: target.json must say env "staging" and both base URLs must be bare
// https origins with a staging host label (lib/node-files.ts readTarget); anything else refuses
// before a single request. Cases 1–8 run in order (see README.md); each reports PASS / FAIL /
// YELLOW / SKIP with per-step times, HTTP status and business code. Results: <out>/summary.json and
// <out>/summary.md, with response bodies kept only for failed or yellow steps and redacted.
// Nothing printed or written carries a phone number, SMS code, password, TOTP secret or code,
// token, install_secret or signature. Exit code: 1 when any case FAILs, 2 when the run is refused.
import { resolve } from 'node:path';
import { LOW_BALANCE_FEN, type SmokeContext } from './cases/context.ts';
import {
  case1,
  case2,
  case3,
  case4,
  case5,
  case6,
  case8,
  caseLogout,
} from './cases/member-cases.ts';
import { case7 } from './cases/withdraw-loop.ts';
import { recordCallsOn } from './lib/http.ts';
import { MemberClient } from './lib/member-client.ts';
import {
  NodeFileError,
  readAdminCredential,
  readDeviceCredential,
  readMemberConfig,
  readTarget,
  useNodeDir,
} from './lib/node-files.ts';
import { Report, registerSecret, scrub, yuan, type CaseContext } from './lib/report.ts';

interface Args {
  readonly out: string;
  readonly nodeDir: string | null;
}

class UsageError extends Error {}

function parseArgs(argv: readonly string[]): Args {
  let out: string | null = null;
  let nodeDir: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (
      (arg === '--out' || arg === '--node-dir') &&
      value !== undefined &&
      !value.startsWith('--')
    ) {
      if (arg === '--out') out = value;
      else nodeDir = value;
      i += 1;
    } else {
      throw new UsageError(`unknown or incomplete argument: ${arg ?? ''}`);
    }
  }
  if (out === null) throw new UsageError('missing --out <result directory>');
  return { out: resolve(out), nodeDir: nodeDir === null ? null : resolve(nodeDir) };
}

type CaseFn = (c: CaseContext, ctx: SmokeContext) => Promise<void>;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  // Test-only: points the node files at a scratch directory (default ~/.couli-staging-smoke).
  if (args.nodeDir !== null) useNodeDir(args.nodeDir);
  const target = await readTarget();
  const config = await readMemberConfig();
  registerSecret(config.phone);
  registerSecret(config.smsCode);
  registerSecret(config.payoutAccount?.alipayLogonId);
  registerSecret(config.payoutAccount?.payeeName);
  const adminCredential = await readAdminCredential();
  // Read device.json up front too: a refused file (loose mode, not a regular file …) is a
  // refusal with exit 2, not a case-1 FAIL (review r1 S2).
  await readDeviceCredential();

  const report = new Report();
  recordCallsOn(report);
  const ctx: SmokeContext = {
    target,
    member: new MemberClient(target.apiBaseUrl, config.appId),
    config,
    adminCredential,
    loggedIn: false,
    legal: null,
    minSupportedVersion: null,
  };
  process.stdout.write(
    `staging smoke: money cases need a withdrawable balance ≥ ${yuan(LOW_BALANCE_FEN)}\n`,
  );

  const needsLogin: readonly (readonly [string, string, CaseFn])[] = [
    ['3', '粘贴商品链接查返利', case3],
    ['4', '订单列表与详情', case4],
    ['5', '钱包汇总与流水', case5],
    ['6', '改收款账号（二次验证带业务摘要）', case6],
    ['7', '提现闭环：驳回退回 + 审批打款到账', case7],
    ['8', '事件上报与强更检查', case8],
  ];
  const first = await report.runCase('1', '设备注册 + 测试号登录 + 刷新令牌', (c) => case1(c, ctx));
  if (ctx.member.hasDevice) {
    await report.runCase('2', '首页配置与商品池', (c) => case2(c, ctx));
  } else {
    report.skipCase('2', '首页配置与商品池', '用例 1 没有拿到设备');
  }
  for (const [id, title, run] of needsLogin) {
    if (ctx.loggedIn) await report.runCase(id, title, (c) => run(c, ctx));
    else report.skipCase(id, title, `用例 1 没有登录成功（${first}）`);
  }
  if (ctx.loggedIn) await report.runCase('9', '收尾：会员退出登录', (c) => caseLogout(c, ctx));

  await report.write(args.out);
  process.stdout.write(`\nresults: ${args.out}/summary.md\n`);
  return report.failed ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const known = error instanceof NodeFileError || error instanceof UsageError;
    const text = known
      ? (error as Error).message
      : `unexpected error (${error instanceof Error ? error.name : 'error'})`;
    process.stderr.write(`staging-smoke: refused: ${scrub(text)}\n`);
    process.exitCode = 2;
  },
);
