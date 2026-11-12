# test/replay：回放测试

放什么：把录制好的外部响应（联盟订单同步、通道回调等）按场景回放进系统的测试，以及回放框架。每个场景声明最低业务量（如入账订单数下限），跑完核对，低于即失败（规划/11 §4.2）。

录制文件的规矩（规划/11 §4.5）：

- 本仓库是公开的，这里只放**合成数据**；真实录制只在私有库，回放只在负责人的本机运行。
- 每个录制目录带 `provenance.json`（来源 `probe` / `doc-derived` / `synthetic`、CAP 编号、抓取时间、脱敏前原文 sha256、脱敏器版本）。
- 遇到非 `probe` 来源的录制，验收记录不写通过。没有真实录制时只用领域层的演示适配器造数据，不伪造平台报文格式。

怎么跑：回放要完整的应用与真实 PostgreSQL，只在沙箱外运行，不进 `verify:fast`。本目录目前不在任何 vitest 配置的 `include` 里。（CT-06zzzzza 起已过时：本目录的 `*.test.ts` 由 `test/vitest.replay.config.ts` 收录，见下。）

运行入口（CT-06zzzzza，D10-1372）：`test/vitest.replay.config.ts` 收录 `replay/**/*.test.ts`，真实 PostgreSQL（测试库底座同 integration 配置），`passWithNoTests` 保持 false；没有场景时由 CI 作业 `verify-replay` 先查本目录有无 `*.test.ts`，没有就跳过 `test:replay` 步骤并打 notice（D10-1389）。

- 本机：`pnpm --filter @couli/spec-tests run test:replay`（沙箱外，要 Docker 或 `TEST_PG_ADMIN_URL`）。
- 先红：`tools/ops/verify-container.sh <编号> --red`，`replay` 组和 `spec-int` 一样起一次性 PostgreSQL 与 Redis。
- CI：作业 `verify-replay`，与 `verify-int-*` 并行；目前不挡合并（不在 `ci-gate` 必需项里），QA-03c 做完且连续稳定后转为必需项。

TODO(规划/11 §4.5): 回放框架与运行配置（测试库底座就绪、联盟账号到位后录首批场景） — blocked on B1-01

保护规则（规划/11 §4.4 第一类）：本目录**只能新增，不能改删**。要改须单独开 `test-change` 任务，由另一家评审。

现在还没有回放场景。
