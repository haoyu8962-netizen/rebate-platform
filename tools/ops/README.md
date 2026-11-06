# tools/ops：编排脚本

编排会话（Claude 主会话）用来推进任务的脚本：台账、在途状态与失败熔断、用量账本（只记账）、看板、任务书、交接、沙箱外验证。规则出处是规划仓库 `规划/11_开发协作与自主推进.md`（下称 11），本文件只写用法和现状。

本目录是保护路径第三类（11 §4.4）：改动要负责人确认。脚本一律从可信副本运行（11 §2.4），可信副本建好前就是主检出；从 `couli-runs/worktrees/<编号>` 下运行一律拒绝。

## 1. 已有的脚本

全部是 `node tools/ops/<名>.ts`（Node 24 直接跑 TypeScript）或 bash / perl。退出码：0 正常，1 检查没过，2 用法或内部错误；另有约定的单独写明。`--json` 时标准输出只有一份 JSON，给人看的文字走标准错误。

| 脚本 | 做什么 | 出处 |
| --- | --- | --- |
| `task.ts check [编号…]` | 校验 `ops/tasks/*.yaml`：字段、文件名、≤40 行（不计 `red_exempt` 段，该段单独 ≤ 300 条，CT-06t，CT-06zzzb 由 50 放到 150，CT-06zzzc 由 150 放到 300（D10-624）；`red_exempt_outside` 段同样不计、≤ 300 条，只能列 `test_paths` 内、受信根已存在且有 `red_exempt` 或 `red_exempt_rows` 声明的 `*.test.ts`，CT-06zzzc；`red_exempt_rows` 段同样不计、单独 ≤ 300 条，只能写 `test_paths` 内、受信根已存在的 `*.test.ts`，CT-06zzze；`modify_existing` 段同样不计、与 `red_exempt` 合计 ≤ 300 条，字段 file / test / reason（`flake_fix` / `tighten_only`）/ ruling（`D10-<数字>`）/ note（≥ 10 字），`file` 须是受信根已存在的第一类 `*.test.ts`：有规则测试作者时在 `test_paths` 内，`tester: none` 时在 `paths` 内（编排定夺 D10-701 第 2 轮：`tester: none` 的台账按本表规则不得有 `test_paths`，而只改冻结测试、不改实现的单（B2-09v、FU-B209R-FLAKE）恰是 `tester: none`、测试文件写在 `paths` 里；放开「tester none 不写 test_paths」会牵动 red-check 范围与路径守卫，所以改为按 `paths` 判，两种都另须落在第一类规则测试资产内；与 `red_exempt` 不同，`tester: none` 也可写，因为本段要打开的正是 evidence-check 的第一类只增，这类单的 spec_commit 就是主干），同一 (file, test) 不得重复、不得同时写在 `red_exempt` / `red_exempt_rows` 里，CT-06zzzg，见 `tools/README.md`）、编号前缀在 05 里存在、`refs` 存在且 `refs_hash` 与规划原文一致、依赖存在、RV2 的实现与规则测试作者不是同一家、契约任务列全生成物（见下文「契约生成物」）。`pnpm ops:task:check` | 11 §2.1 |
| `task.ts show <编号> --json` | 任务字段（平铺）加算出的 `risk`、`ask`、`risk_paths` | 11 §1.2 |
| `task.ts hash <编号>` | 打印可直接粘贴的 `refs_hash` 段 | 11 §5.3 |
| `state.ts get\|set\|claim\|release\|bump-attempt\|settle\|opus-run\|migrate <编号>` | 在途状态 `couli-runs/state/<编号>.json`（先写临时文件再改名）；领任务 `couli-runs/claims/<编号>/`，租约 20 分钟，`claim --renew` 续期，过期才能被别的会话接手。轮次与失败熔断见下文「轮次怎么计」「失败熔断」；`bump-attempt` 在熔断打开时退出 3 | 11 §2.1、§2.2、§2.5 |
| `lock.ts`（只有函数） | 编排锁 `couli-runs/lock/orchestrator/`：取锁、心跳、释放；心跳停 20 分钟才允许接管。心跳与释放也在接管闸门 `<锁目录>.takeover` 里做，自己的租约已过期就不再续（返回 false，持有者必须停下） | 11 §2.2 |
| `usage.ts record\|summary` | 用量账本 `couli-runs/usage.jsonl`（只追加），只记每次调用的 token 与结果，不拦任何调用；读不出的行跳过并计数。`pnpm ops:usage summary` | 11 §1.3 |
| `status.ts [--json]` | 看板，每次现算，不落盘。`pnpm ops:status` | 11 §2.1、§5.2、§7.2 |
| `brief.ts <编号> [--phase test\|impl\|handover\|review] [--attempt n] [--out 文件]` | 任务书，写到 `couli-runs/<编号>/brief.md`；超过 24KB 或命中禁用词就不写文件、退出码 1。`pnpm ops:brief <编号>`。阶段（`ops/approvals.yaml` 第 19 条）：`test` 给 Codex 写规则测试（可新增规则测试资产与 `NotImplemented` 骨架，沙箱里只做静态检查）；`impl`（默认）给 Opus 实现子代理（测试冻结，只经 `verify-container.sh <编号> --fast` 跑测试）；`handover` 给 Codex 换家实现（测试冻结，只做静态检查）；`review` 给评审作数据（只读）。头部「本轮阶段」一行写明阶段，`dispatch.sh` 据此判断能否复用 | 11 §2.3 第 2 步、§5.3 |
| `handoff.ts [--out 文件] [--session 名]` | 交接，写 `couli-runs/handoff/CURRENT.md` 和带时间戳的副本，≤40 行。`pnpm ops:handoff` | 11 §5.1 |
| `verify-container.sh <编号> [--worktree 路径] [--fast \| --red [--base 提交] \| --browser] [--dry-run]` | 沙箱外验证：断网容器里跑 `pnpm verify`，退出码就是验证结果（124 = 超时）；2026-10-06 起 RV2 的完整验证以 PR 上的必过 CI 检查为准（`ops/approvals.yaml` 第 21 条），本机完整验证可选。结果在 `couli-runs/<编号>/verify/<n>/`。`--fast` 是 Opus 实现子代理自己跑测试的入口：只跑 `pnpm run verify:fast`，不起 PostgreSQL、容器 `--network none`，结果在 `verify-fast/<n>/`，不决定任务成败、不进证据。`--red` 是 Codex 写完规则测试后的隔离红测：只跑本任务 `test_paths` 内新写的测试文件（相对 `--base`，默认与 `origin/main` 的分叉点），每个文件由可信项目表 `verify-image/red-projects.json` 分到对应的 Vitest 配置（`red-plan.ts`；没有项目收的文件让红测直接失败），按项目的 `database` 拆成至多两个容器：需要库的组在内部网络上配一次性 PG 与 Redis，其余组（单元、浏览器）在另一个 `--network none`、不带任何库地址的容器里跑，同一任务两类都有时也一样，用可信 reporter `verify-image/red-reporter.mjs` 保留失败的 cause 链与每条测试的 annotation（构建冒烟的浏览器诊断附件：页面抛错、同源请求失败、懒加载失败、报脚本故障的 console.error——含 React Router errorElement 的「caught the following error during render」或 TypeError 等错误类型，骨架 NotImplemented 除外——让等元素超时的红判无效；打开页面的冒烟规则测试必须写诊断附件，等元素超时却没有附件也判无效；页面自己吞掉、不写 console.error 也不触发 pageerror 的错误由测试装的采集器补上（F1-01m）：`vite:preloadError` 记 `preload-error`、`unhandledrejection` 记 `unhandled-rejection`（骨架 NotImplemented 除外）、H5 路由错误页 `RetryPage` 记 `route-error`（同一附件里有骨架 NotImplemented 解释它时除外）、页面读不回记 `diagnostics-incomplete`，都让等元素超时的红判无效，细节见 `tools/agent/README.md`），报告导出到 `red/<n>/out/<项目>.json`，由 `red-check.ts` 逐个文件对账（另给它 `--base` 与快照树：base 上已存在的规则测试文件只要求新增或测试体改动的用例有效红，CT-06p；只因读到本任务改动的数据 / 夹具文件而入列的文件，其中测试体未变的用例可由主干台账 `red_exempt` 逐条声明豁免、经规则测试评审确认后可绿，CT-06r；用例外代码改过的文件只有列在台账 `red_exempt_outside` 里，其 `red_exempt` 才生效，`notes` 列出用例外改动的行段供评审确认，CT-06zzzc；登记文件若用例全部未变且全部声明豁免，则排出应跑清单（不跑不判，同 renames-only），CT-06zzzd / D10-630；口径见 `tools/README.md`），退出码是它的；`result.json` 带 `red_tests`、`expected`、报告 sha256。浏览器规则测试（`test/spec/**/*.browser.test.{ts,tsx}`）由项目 `spec-browser` 在真 Chromium 里跑；构建产物冒烟（`test/spec/**/*.smoke.test.ts`，F1-01k）由项目 `build-smoke` 跑：globalSetup（`build-smoke/global-setup.ts`）在临时目录里 `vite build` H5 三入口（`APP_ENV=test`）与后台，每个入口在 `127.0.0.1` 起只读静态服务，测试用 `playwright` 库驱动镜像里的 Chromium 打开；正常运行由严格报告器 `build-smoke/strict-reporter.mjs` 把关（诊断附件里有页面抛错、未被测试拦下的同源请求失败、懒加载失败、报脚本故障的 console.error，或采集器记下的 `preload-error`、`unhandled-rejection`、`route-error`、`diagnostics-incomplete`（NotImplemented 也不例外）就让运行失败，`--browser` 对 build-smoke 同样带上它）。两者都标 `browser: true`（要镜像里的 Chromium），同样断网；锁文件里没有 `playwright` 的分支遇到它们直接停（退出 2）。`--browser` 依项目表顺序跑全部 `browser` 项目（`spec-browser`，再 `build-smoke`），同一个容器、`--network none`（只有回环）、共用一个时限，前一个失败后一个照跑：截图导出到 `browser/<n>/out/screenshots/`（构建冒烟的是顶层的 `smoke-app.png`、`smoke-landing.png`、`smoke-conformance.png`、`smoke-admin.png`），每个项目的 Vitest JSON 报告到 `browser/<n>/out/<项目>.vitest-report.json`，供与设计稿对比（`out/` 权限 1733：容器用户能写、不能列目录）；退出码是第一个失败项目的，全部通过却一张截图都没导出时记失败（1），日志写明总共导出几张、其中浏览器测试与构建冒烟各几张；`result.json` 的 `script` 是 `browser`；与 `--fast` 一样是实现方自查，不进证据（`tools/ci/evidence-check.ts` 只认 `verify` 与 `red`）。`--dry-run` 只打印将跑什么（脚本、提交、树哈希、红测文件）。**没有宿主回退**（CR-01）：`--host` 一律拒绝，Docker 用不了就停下交 CI | 11 §2.3 第 3、5、7 步、§9.3 #6 |
| `verify-container.selftest.sh` | 上一个脚本的端到端自测，要 Docker 和网络，手动跑 | — |
| `spec.ts`、`overlap.ts`、`cli.ts` | 供上面脚本用的库：按 `SPEC_REF` 读规则原文与条目哈希、路径是否可能相交、公共小函数 | 11 §5.3 |

### 轮次怎么计（`state.ts`）

规划/11 §2.5；负责人 2026-10-02 决定（`ops/approvals.yaml` 第 13 条）。

- 五个计数器各有上限：Codex 写规则测试 `test` 3 次；Opus 实现 `impl` 3 次；换家实现 `handover` 1 次（规划/11 §2.5，只限 RV0 / RV1）；规则测试评审 `spec-test` 2 轮；代码评审 `code` 3 轮（`money`、`general`、`contract` 共用；负责人 2026-10-02 由 2 轮提高到 3 轮，`ops/approvals.yaml` 第 17 条）。原来是一个评审计数器共 2 轮；`test`、`handover` 是 2026-10-05 分工切换时加的（`ops/approvals.yaml` 第 19 条，规划评审 RO-07）：Codex 写测试的 `impl` 模式调用不再计入实现次数。只有三个计数器的旧状态文件照常读，`test`、`handover` 当 0。
- Codex 调用记在哪个计数器上，看它 `meta.json` 的 `phase`（`codex-run.sh impl --phase test|handover`）；没有 `phase` 的旧调用（2026-10-05 前的 Codex 实现）记 `impl`。
- `bump-attempt <编号> test|handover`（`dispatch.sh` 按阶段调）、`bump-attempt <编号> impl`（编排者起 Opus 实现子代理前调）或 `bump-attempt <编号> review --review-type <类型>`（编排者在评审前调）在**派发前**计数并落盘，同时记一条待结算（`pending_bumps`：`kind`、`engine`、`bumped_at`）；用完了退出码 1、不写文件。
- `settle <编号> --meta <meta.json>`（`codex-run.sh` 每次调用结束后调）：先把这次调用与一条同 `kind` / `engine`、`bumped_at` 在调用开始前不久的未消耗待结算配对（CT-06zxk，FU-OPS-COUNTER）；**配不到即这次调用没被预计数**（上限被拒后误起、编排例外轮不计次），不改计数，无产出时只记 `uncounted_calls`（`refunded: false`）。配到且没有产出就结束的调用把那一轮还回去，记进状态文件的 `uncounted_calls`（`kind`、`started_at`、`exit_code`、`reason`）；按 `kind` + `started_at` 去重，重复执行不多还。「没有产出」指：硬超时或无活动击杀（124）、模型容量错误（11）、或退出 10 且校验没跑（缺 `-o`、`turn.failed`、退出码非 0、被中止、留下进程）。拿到回答但校验不过（`validation: failed`）、位置断言失败（12）、孤儿（包装脚本没写完 `meta.json`）照计。
- 不计轮次的调用照样计入每任务 10 次与连续无产出（见下一节）。
- `migrate <编号> [--unattributed-review spec-test|code] [--dry-run]`：把旧形状 `attempts: {impl, review}` 的状态文件换成新形状。评审轮次按 `<runs>/<编号>/` 下各次调用的 `meta.json`（`meta.<模式>.json` 与 `attempts/<n>/meta.json`）归到各自类型，没有产出的调用移进 `uncounted_calls`；实现次数减去没有产出的实现调用；其余字段（`state`、`last_error` …）不动。旧计数比留下的评审 `meta.json` 多时，必须用 `--unattributed-review` 说明多出的轮次归哪类，否则拒绝。旧形状的文件不经迁移读不进来（`get`、看板都会报错并提示这条命令）。

### Opus 实现的失败计数（`state.ts opus-run`）

规划评审 RO2-03、Codex 评审 CR-07（2026-10-05）。Opus 实现子代理不是 Codex 调用、不留 `meta.json`，所以由编排者在每一轮结束后结算：`state.ts opus-run <编号> --run-id <运行编号> --outcome ok|no-output|timeout|capacity --risk RV0|RV1|RV2`。没有结果（无产出、超时、容量或额度错误）的一轮把派工前计上的 `attempts.impl` 还回去（记进 `uncounted_calls`，`kind: impl`；与 `settle` 同口径，只有配到一条待结算的 `impl` 预计数才还，`bump-attempt` 被拒后误起或例外轮没计数的不还、记 `refunded: false`，CT-06zxk），并算一次失败，记进状态文件的 `opus_failures`（`total`、`consecutive`、`last_reason`）；每一轮记进 `opus_runs`，同一运行编号重复结算不改任何东西；有结果的一轮把 `consecutive` 清零。连续 3 次或累计 5 次时输出 `next: handover`（RV0 / RV1：`tools/agent/dispatch.sh <编号> --handover`，Codex 实现一次）或 `next: blocked`（RV2：不换家，标 blocked，规划/11 §2.5）；否则 `next: continue`。Opus 的轮次不计入每任务 10 次 Codex 调用上限。

### 失败熔断（`state.ts`），没有额度闸门

负责人 2026-10-02：「codex 额度是无限的，请你不要设置无意义的限制」（`ops/approvals.yaml` 第 15 条）。所以没有周额度估算、档位、校准，也没有每天的调用上限；`usage.ts` 只记账。只留下面这些针对失败的保护：

- 轮次上限照旧（上一节）。
- 每任务最多 10 次 Codex 调用（防失控循环）：该任务运行目录里每一次已结束的调用都算（`meta.<模式>.json` 与 `attempts/<n>/meta.json`），没有产出、还回了轮次的也算，模型容量错误也算。
- 同一任务连续 3 次调用没有产出（超时、无活动击杀、缺 `-o`、`turn.failed` 等，即 `settle` 会还回轮次的那些）就停这个任务；模型容量错误既不延长也不打断这个计数，拿到回答但校验不过的算有产出。
- 两道熔断按「再派一次会不会越线」判断，由 `bump-attempt` 在计数前检查：打开时退出 3、不写文件，`dispatch.sh` 输出 `{"action":"stopped","reason":"task-breaker",…}`。只停这个任务，其余任务照常；编排者把它标 `blocked` 并报告。看板列出所有打开的熔断。

### 沙箱外验证（`verify-container.sh`）

- 镜像定义在 `verify-image/`：`node:24-bookworm-slim` + 与根 `packageManager` 完全一致的 pnpm（不用 corepack）+ PGDG 的 `postgresql-client-18` + git 与 procps（`tools/` 的单元测试要建夹具仓库、要 `ps`）+ 浏览器测试用的 Chromium（F1-01j：与快照锁文件里 `playwright@` 版本一致的 `playwright install --with-deps --only-shell chromium`，装在只读的 `/ms-playwright`，`PLAYWRIGHT_BROWSERS_PATH` 指向它；headless 模式下 Playwright 启动的就是 headless shell）与中文字体 `fonts-noto-cjk`（构建时 `fc-cache -f`），非 root。Chromium 靠 Playwright 默认的 `--no-sandbox`、`--disable-dev-shm-usage` 在 `--cap-drop ALL`、no-new-privileges 下运行，其余加固不变。镜像标签由 `verify-image/` 的 Dockerfile、entrypoint 和 pnpm、playwright 两个版本算出，改了就自动重建；锁文件里没有 `playwright` 时（F1-01i 之前的分支）构建不带浏览器的镜像（`PLAYWRIGHT_VERSION=none`），`--browser` 与含浏览器测试的 `--red` 报错退出 2；锁文件里有多个 `playwright` 版本时一律停下。
- 依赖走离线 store：数据卷按 `pnpm-lock.yaml` 的 sha256 命名，没有时联网 `pnpm fetch` 一次（只挂锁文件和 `pnpm-workspace.yaml`）。
- 快照：先把 worktree 的 git 树（含未提交改动，不含被 `.gitignore` 忽略的任何东西：`node_modules`、`dist`、`.env*`、`*.key`、`coverage/`、`reports/` …）用 `git archive` 导出到 `couli-runs/<编号>/<verify|verify-fast|red|browser>/<n>/src/`，`result.json` 的 `tree` 就是这份快照的树哈希；之后容器只看这份快照，worktree 在镜像构建、填 store 期间被改动也影响不了结果。快照用完即删。不是 git 仓库顶层的目录按同一套排除规则用 tar 复制，`tree` 为 null。
- 每次运行：新建 `--internal` 网；一次性 PG（`pgvector/pgvector:0.8.6-pg18-trixie`，随机密码）只接这个网；验证容器根文件系统只读、快照只读挂 `/src`、store 只读、`/work` 与 `/tmp` 是 tmpfs；容器里先把 `/src` 拷到 `/work/repo`，`pnpm install --offline --frozen-lockfile`，再限时跑 `pnpm verify`。结束后容器和网络一律清掉。
- 规划原文：把规划仓库在 `SPEC_REF` 那一个提交做成只读快照（`couli-runs/spec-snapshots/<提交号>.git`）挂到 `/spec`，容器里 `COULI_SPEC_REPO=/spec`。容器看不到规划仓库的工作区和配置。快照没有历史，所以「`SPEC_REF` 在规划仓库 main 上」由本脚本在宿主对真实仓库核对，通过了才给快照写上 `origin/main`，容器里的 `spec-ref` 守卫据此通过。
- `result.json`：`mode`（`container`）、`script`（`verify` / `verify:fast` / `red` / `browser`）、`exit_code`、`commit`、`tree`（含未提交改动的工作区树哈希）、`prop_seed`、`prop_runs`（调用方传了 `PROP_RUNS` 记数字，没传记 `null`）、起止时间。基础设施出错（Docker 起不来、镜像构建失败）退出码 2，不写 `result.json`。
- 宿主回退已取消（Codex 评审 CR-01，2026-10-05）：原来的 `--host` 会在宿主上执行任务快照里的代码和测试（含 Codex 写的），清空环境变量挡不住。现在 `--host` 一律拒绝、退出 2；Docker 用不了就停下，把这次运行交给 CI。原 `timeout-group.pl` 随之删除。
- worktree 在 `/tmp`、`/private/tmp`、`$TMPDIR` 下一律拒绝（那里是 Codex 沙箱的可写根，11 §0）。
- 可调环境变量：`COULI_VERIFY_TIMEOUT_SECS`（默认 3600、上限 3600，可调小、不能超过上限；CT-06v，集成测试已 464 文件、1200 不够；CT-06zxf / D10-372 起默认由 2400 提到 3600，遇 exit 124 先变基再跑）、`COULI_VERIFY_PREFIX`（容器、网络、数据卷的名字前缀，默认 `couli-verify`）、`PROP_SEED`、`PROP_RUNS`（本脚本不设默认，传了才透传给容器。没传时纯函数段默认 1 万次（规划/11 §4.2），集成段由 `test:int` 脚本默认 2000（D10-210、D10-499）；调用方传的值优先）。
- 宿主一次性服务模式（负责人 2026-10-08 / 09：本机不跑 Docker，容器验证放到 AWS 测试机；测试库不进 Docker；10-09 定方案 A）。设 `COULI_VERIFY_HOST_SERVICES=1` 开启（其他取值退出 2），只改要连库的那次运行（`pnpm verify`、`--red` 里需要库的组），其余（`--fast`、`--browser`、只有单元组的 `--red`）与原来一样：

  | 变量 | 默认 | 含义 |
  | --- | --- | --- |
  | `COULI_VERIFY_SVC_USER` | `couli-svc` | 一次性服务的运行用户；只能属于下一行的组 |
  | `COULI_VERIFY_SVC_GROUP` | `couli-sock` | socket 的属组；只有本次的测试容器经 `--group-add` 拿到它 |
  | `COULI_VERIFY_SVC_ROOT` | `/var/lib/couli-ephemeral` | 放一次性实例的 tmpfs（0700，属运行用户） |
  | `COULI_VERIFY_PG_BIN` | `/usr/lib/postgresql/18/bin` | PostgreSQL 18 程序（测试机为 Pigsty 装的包，pgvector 0.8.6 已 hold） |
  | `COULI_VERIFY_REDIS_BIN` | `/usr/bin` | `redis-server`、`redis-cli` 所在目录（Pigsty 装的 Redis 7.2） |

  测试机先用运行目录的 `RUNNER/setup-isolation.sh` 准备一次（建用户与组、代码目录 0700、按 uid 封出网的 nftables 表 `inet couli_isolation` 及开机加载单元、tmpfs）。脚本需要 `sudo`（`systemd-run`、`systemctl`、`nft`、`install`、`rm`）和 `flock`。每次连库运行：
  1. 先核对隔离：运行用户只属于 socket 组，`inet couli_isolation` 的 output 链对其 uid 拒绝，再以该用户实测连 `1.1.1.1:443` 必须失败；任一不满足退出 2。
  2. 取整台宿主共用的一把锁 `/run/lock/couli-host-services.lock`（`flock`，所有接入线、所有 `COULI_RUNS` 共用；进程没了锁就没了，不存在失效锁接管；`COULI_VERIFY_SVC_LOCK` 只给工具测试用）。核对实例根是专用 tmpfs 挂载点、属运行用户、0700，否则退出 2、什么都不删。再清掉被杀运行留下的东西：带 `couli.services=host` 标签的容器（docker 调用有硬超时）、`couli-svc-*` 临时单元、运行登记 `/run/lock/couli-host-services.runs` 里登记过的目录；实例根里有未登记的条目就退出 2，不删。最后核对运行用户没有残留进程、`/dev/shm`、`/dev/mqueue` 与 SysV IPC 对象（有就清掉再核对）。
  3. 在 tmpfs 的本次目录里 `initdb`（超级用户 `postgres`，口令随机、只属本次，经 `systemd-run --pipe` 的标准输入交给 initdb，不上命令行），起 `postgres`（`listen_addresses=''`，只开本次 socket 目录里的 unix socket，权限 0770 给 socket 组）和 `redis-server`（`port 0`、只开 unix socket、`save ""`、`appendonly no`、`maxmemory 256mb`、`noeviction`，与 `infra/local/compose.yaml` 一致；另把 `MIGRATE`、`REPLICAOF`、`SLAVEOF`、`MODULE`、`DEBUG`、`SAVE`、`BGSAVE`、`BGREWRITEAOF`、`SHUTDOWN`、`FAILOVER`、`SYNC`、`PSYNC` 改名为空即禁用，受保护配置（`dir`、`dbfilename` 等）运行中不可改；`CONFIG` 保留，因为 Redis 规则测试用 `CONFIG GET maxmemory-policy` 核对策略（与 CI、容器里的 Redis 一样）；开跑前核对 `MIGRATE` 已是未知命令、策略是 `noeviction`）。三者都是以运行用户身份起的 systemd 临时单元，带沙箱：独立的空网络命名空间、只许 `AF_UNIX`、`IPAddressDeny=any`；独立 IPC 命名空间（`PrivateIPC`、`RemoveIPC`）；`/tmp`、`/var/tmp`、`/dev/shm` 映射到本次目录下（在 6G tmpfs 上，不落宿主磁盘）；系统只读，看不到 `/home`、`/root`、`/run`、`/Users`、`/var/log`、`/data` 和 Pigsty 等服务的配置（含口令的 `/etc/grafana`、`/etc/pg_exporter.yml`、`/etc/alertmanager.yml`、`/etc/nginx` 等，按测试机实际核对）；只有本次目录可写；无特权能力、`NoNewPrivileges`、只许 `@system-service` 系统调用；`MemoryMax=4G`、`TasksMax=512`；独立的 `/proc` 视图；`RuntimeMaxSec` 兜底。超级用户执行 `COPY ... PROGRAM` 起的进程同样在这个沙箱里。
  4. 连库容器 `--network none`，只把本次 socket 目录（只有这两个 socket）只读挂到 `/run/couli-services`，加 socket 组和小代理（node，本脚本写出、只读挂载）：代理在容器内 `127.0.0.1:5432`、`127.0.0.1:6379` 上转发到两个 socket。所以 `TEST_PG_ADMIN_URL` 是 `postgres://postgres:<口令>@127.0.0.1:5432/postgres`、`TEST_REDIS_URL` 是 `redis://127.0.0.1:6379/0`：`packages/db/src/pg-url.ts` 与测试 Redis 探活只认 host:port 形式的地址，`db:check` 的 `pg_dump` 也照此连接。
  5. 运行结束（含失败、超时、信号）停掉单元并逐个确认：只有 systemd 明确答出未加载、或已加载且 `inactive` / `failed` 才算停；没有回答、回答为空、超时、权限或通信错误都算没停。再确认运行用户没有残留进程，删掉本次目录并确认不存在（核对命令本身失败不算不存在），确认没有 IPC / 共享内存残留，才从登记里移除。这些都成功了才写 `result.json`；任何一步失败或服务起不来，按基础设施错误退出 2、不写结果。写结果前（以及脚本结束时）把日志、`red-check.json` 和 `out/` 下的每个普通文件里的本次口令替换掉，报告的 sha256 与 `red_tests` 在替换之后才算；口令经标准输入交给 node，不上任何命令行；替换失败按基础设施错误退出 2。连库容器的整个 `docker run` 另有宿主侧硬时限（容器自身时限加 15 分钟），超时就有界删除容器、清理服务、退出 2 不写结果。宿主检查脚本的每条命令（`findmnt`、`stat`、`pgrep`、`ipcs`、`find`）都单独核对退出码，全部成功才在末尾输出成功标记，没有标记就算没查成。`result.json` 仍是 `mode: container`，多两个字段：`"gate"`（开跑时记录的门禁来源：可信根的提交、其跟踪文件是否与该提交一致、本脚本的 sha256；覆盖进来的门禁 `clean` 为 false）和 `"services": "host-ephemeral"`。证据只认 `gate` 为可信根当前提交且 `clean: true` 的结果（`couli-runs/scripts/rebase-verify.sh`）；`tools/ci/evidence-check.ts` 不看这两个字段。

  残留风险：`TEST_PG_ADMIN_URL` 仍经环境变量进容器（`global-setup.ts` 只从环境读，改读文件要动测试代码），容器里的代码能从 `/proc/1/environ` 读到这个口令；它只是本次一次性实例的超级用户，该实例以无网、读不到代码的运行用户在沙箱里跑、运行后即删。版本与 CI 不同：宿主的 Redis 是 Pigsty 装的 7.2.16，CI、`infra/local/compose.yaml` 与默认模式是 7.4.11，用到 7.4 新命令（如 `HEXPIRE`）的规则测试在测试机上会假红；PostgreSQL 是 PGDG 打包的 18.6（pgvector 0.8.6），不是 pgvector 镜像。两边并不等价，必需检查仍以 CI 为准。未设 `COULI_VERIFY_HOST_SERVICES` 时脚本行为与原来逐字一致。编排者经运行目录的 `scripts/remote-run.sh`（`container-run.sh` 默认调用它）在测试机上以这个模式运行，结果同步回本机 `couli-runs/<编号>/`。

实测（2026-10-02，M2 Max，Docker Desktop 28.0.1；当时机器同时在跑别的任务，数字偏慢）：

| 项 | 耗时 |
| --- | --- |
| 镜像无缓存构建（之后有缓存，不再构建） | 34–62 秒 |
| 自测用的小 workspace（1 个依赖）每次运行，其中起 PG 2–5 秒 | 4–21 秒 |
| 骨架期整仓库（482 个包）首次联网填 store | 6–75 秒 |
| 整仓库 `verify:fast` 段（类型检查、lint、格式、依赖方向、全部单元测试、契约、守卫） | 42–116 秒 |
| 整仓库 `typecheck + test:int + db:check` 段（24 条连库集成测试、快照与类型漂移比对，全部通过） | 30 秒（整次 65 秒） |

容器里的 Node 是镜像 `node:24-bookworm-slim` 当时的版本（实测 24.21.0），宿主是 24.15.0；都在 `engines` 范围内。完整的 `pnpm verify` 一次跑通留给集成步骤，届时把耗时回填到这里。

### 契约生成物（`task.ts check`，CT-06n）

- `status: todo` 的台账，`paths` 只要碰到 `contracts/openapi.yaml`（字面写出或被 `contracts/**` 之类的 glob 匹配），`paths` ∪ `mechanical_paths` 就必须同时覆盖五份生成物：`packages/contracts-ts/src/openapi.gen.ts`、`apps/api/src/modules/platform/http/auth-routes.gen.ts`、`apps/api/src/modules/platform/validation/signing-routes.gen.ts`、`apps/api/src/modules/risk/application/min-version-routes.gen.ts`，以及 CT-06zxd 加入的 `packages/contracts-ts/src/planned-operations.gen.ts`（字面相同或被 glob 匹配，如 `packages/contracts-ts/**`）。缺任一就报错，错误信息列出要补的路径。起因：CT-15n、CT-02i、CT-22a、CT-22b 增删 planned 操作要重生成三份路由表，台账没列，中途补台账（#563、#605）。
- 前四份只看 `paths`：三份路由表连 planned 操作也列，只删 `x-implementation: planned` 不改变它们（`openapi.gen.ts` 也不变；B1-29b 实测，与生成脚本一致）。所以 Codex 实现台账只在 `mechanical_paths` 里写 `contracts/openapi.yaml`（第 31 条）时，这四份不强制；但只删 planned 也会改 `planned-operations.gen.ts`，它照样要求覆盖（见下文 CT-06zxd 一条）。`route-schemas.gen.ts` 只列已实现的操作，归实现它的任务，不在强制之列。
- `status: done` 的台账不追溯。CT-06n 之前已入账、还没做完而缺这几份的 11 个台账（B1-08l、B1-08m、B1-11e、B1-11j、B1-13d、B1-13h、CT-04b、CT-07a、F1-09d、F1-09e、F1-09f）写在 `task.ts` 的 `CONTRACT_GENERATED_EXEMPT` 里豁免；清单冻结，新台账不进清单，直接列全生成物。
- `packages/contracts-ts/src/planned-operations.gen.ts`（CT-06zxd；F1-06zu 起由 `pnpm codegen` 从 `x-implementation: planned` 导出）也在 `CONTRACT_GENERATED` 里，但触发条件不同：只删 planned 标记也会改它，所以 `paths` 或 `mechanical_paths` 任一碰到 `contracts/openapi.yaml` 都要求覆盖它（只在 `mechanical_paths` 时报错前缀是 `mechanical_paths:`，其余四份仍只看 `paths`）。`CONTRACT_GENERATED_EXEMPT` 不豁免它；它单有冻结名单 `PLANNED_OPERATIONS_GEN_EXEMPT`，改动时主干（c5f973f3）上没有缺它的未完成台账，名单为空，新台账不得加入。
  - 已知冲突：可信根 `tools/guard/codex-impl-tasks.json` 的 `mechanical_paths` 白名单（冻结，第三类保护路径）只有 `contracts/openapi.yaml`、`openapi.gen.ts`、`route-schemas.gen.ts` 三份，不含 `planned-operations.gen.ts`。所以只在 `mechanical_paths` 写契约的 Codex 台账两头都过不了：不列它被本规则拦，列了又被白名单拒（`task.test.ts` 用例钉住，不会静默通过）。遇到这种台账就停，不改台账绕过，另开第三类任务改白名单（需负责人 `owner-approved-<头提交前 12 位>` 标签）。改动时（c5f973f3）没有这种未完成台账。
- `brief.ts`：`paths` 碰到 `contracts/openapi.yaml` 的任务，第 3 节路径清单后加一句提示：增删操作（含 planned）后要重跑 `pnpm codegen` 与 apps/api 下 generate-auth-routes / generate-signing-routes / generate-min-version-routes / generate-route-schemas 脚本。

### 任务书（`brief.ts`）

- 八节与固定句照规划仓库 `docs/templates/task-brief.md`。规则原文只经 `git show $SPEC_REF:<路径>` 读，表格行去掉「影响面」一列；一跳引用只带表格行。不带第 7 节失败输出时整份超过 24KB 的（CT-06o），`refs` 的表格行与细则照旧全文，「一跳引用」改为 `| 编号 | 标题 | 状态 |` 精简表（标题取规则格的粗体开头，没有粗体时取首句、超过 40 字截断加「…」），表前注明原文见 SPEC_REF 版本的规划/08；格式定了再按剩余空间截第 7 节，仍超限照常拒写，提示里写明已用精简表。契约任务不受影响。
- 契约任务（`type: contract`，负责人 2026-10-02，`ops/approvals.yaml` 第 17 条）：第 2 节不放 BR 原文与一跳引用，只列 `refs` 的编号与标题（规则格的粗体开头），再逐字内嵌台账 `contract_sections` 点名的 `规划/04` 各节（如 `['2', '7']`、`['6.1', '8.4']`，从该节标题到下一个同级或更高级标题）。没写 `contract_sections` 时第 2 节注明没有点名章节。实测（SPEC_REF `cbd8f06`，根 `AGENTS.md` 不再内嵌之后）：CT-01（04 §2、§7）28268 字节，单第 2 节就有 25543 字节，仍超限、照常拒写并打印各节字节数；CT-02a（§5、§6.1–§6.3、§8.4，另内嵌 `apps/api/AGENTS.md`）23493 字节；CT-03（§9、§10.1）13986 字节。内嵌根 `AGENTS.md` 时三份分别是 38960、34236、24678 字节。
- 第 4 节只列与本任务相关的保护路径：伸进允许路径里的，以及验收用的规则测试所在的；其余只给清单文件的位置（它们本来就在允许路径之外，路径守卫会拦）。
- 第 5 节先写一句「根 AGENTS.md 由 Codex 自动读取」，不内嵌根 `AGENTS.md`：`codex-run.sh` 总是以 `-C <工作树根>` 运行 Codex，Codex 会自己注入根 `AGENTS.md`（验证日实测）。根以下、从仓库根到 `paths` 这条链上以及 `paths` 之下的各级子目录 `AGENTS.md` 不会被注入，照旧内嵌全文，浅的在前。
- 第 2 次尝试起，第 7 节附上一轮失败输出的末 200 行（最多 8KB，单行截到 400 字符）；任务书快到 24KB 时自动只留放得下的最后几行，剩余空间不足 1KB 就按超限处理。失败输出的路径取在途状态的 `last_error`。
- 超过 24KB 不写文件、退出码 1，并打印各节字节数，方便判断该怎么拆。根 `AGENTS.md`（约 10.6KB）不再计入，第 5 节只剩子目录 `AGENTS.md`（如 `apps/api/AGENTS.md`）。

## 2. 还没有的（不要当成已经有）

下面每一项都没有文件，也没有占位脚本。格式统一为 `TODO(规划/11 §<节>): <内容> — blocked on <原因>`，方便全仓检索。

- TODO(规划/11 §2.2): `tick.sh`（取编排锁、回收已结束的运行、算就绪任务、输出下一步动作的 JSON）与每 30 分钟的定时心跳 — blocked on owner（拦截钩子与 `codex` 垫片装好后才启用心跳，§7.3 第 5 项）。锁、认领、就绪计算的函数已在 `lock.ts`、`state.ts`、`status.ts`
- TODO(规划/11 §2.3 第 9 步、§3.2、§8): `push.sh`、`merge.sh`（gitleaks、私有指纹比对、只暂存 `paths`、排队合并、写 `longrun-props` 状态、核对 `couli-runs/approvals/<PR>`） — blocked on GitHub remote（另需私有库 `rebate-private`）
- TODO(规划/11 §3.2): 证据文件生成器（写 `ops/evidence/<编号>.json`） — blocked on B2-01a（10-04 试跑跑通一轮循环后定字段）
- CI 的 `evidence-check` 已有最小实现（`tools/ci/evidence-check.ts`，工作流 `.github/workflows/evidence.yml`，必过项已写进 `ops/branch-protection.json`）；未在 GitHub 上跑过。它检查的字段见 `ops/evidence/README.md`。TODO(规划/11 §3.2): 资金路径 `run_attempt` 不大于 1 — blocked on GitHub remote
- TODO(规划/11 §4.5): `records-from-junit.ts`（由 CI 的 JUnit 生成验收记录，并归档到私有库） — blocked on GitHub remote
- TODO(规划/11 §4.2): `examples-blind.ts`（分账算例两家盲算比对） — blocked on B2-03（排在 10-04~05，代表例要负责人确认）
- TODO(规划/11 §5.3): 规格索引生成器（`ops/spec-index.json`）与每晚推进 `SPEC_REF`、把受影响任务标 `stale` — blocked on B2-01a（排在 10-04~05；条目哈希的算法已在 `spec.ts`，`task.ts check` 已用它核对 `refs_hash`）
- TODO(规划/11 §0): 可信副本同步（`couli-runs/trusted/rebate-platform` 只跟随 `origin/main`） — blocked on GitHub remote。建好前 `trustedRoot()` 就是主检出（任务 worktree 永远不算）
- TODO(规划/11 §2.1): 看板里的未合并 PR 与 CI 状态 — blocked on GitHub remote。现在固定输出「PR/CI: 未接入」，不调用 `gh`
- TODO(规划/11 §5.1): 交接、日志、备忘写进私有库 `rebate-private/ops-state/` — blocked on GitHub remote（私有库未建）。交接现在写在 `couli-runs/handoff/`
- TODO(规划/11 §2.5): 重派退避（15、30、60 分钟）与超限后换家 / `blocked` 的处理 — blocked on `tick.sh`。`state.ts bump-attempt` / `settle` 只负责计数、结算与上限

### 现在怎么手动走一轮（`tick.sh` 之前）

1. `pnpm ops:status` 看就绪任务与失败熔断。
2. 建 worktree `../couli-runs/worktrees/<编号>`（分支 `task/<编号>`）并在沙箱外 `pnpm install --frozen-lockfile`。
3. Codex 写规则测试（台账要先有 `test_paths`）：`tools/agent/dispatch.sh <编号>`（内部依次：`state.ts claim` → 核对台账 `test_paths` → `state.ts bump-attempt <编号> test`（含失败熔断） → `brief.ts --phase test` → 后台 `codex-run.sh impl --phase test`），结束后 `tools/agent/post-run.sh <编号>` 过守卫（`path-guard.ts --author`），输出 `red-check`：跑 `tools/ops/verify-container.sh <编号> --red`（隔离容器里只跑本任务新写的规则测试，`red-check.ts` 逐个文件对账），通过后提交 `test(spec): …`、`state.ts set <编号> --spec-commit <提交>`；RV2 再交 Claude 新子代理过审（`tools/agent/README.md` §11）。
4. Opus 实现：按 `tools/agent/README.md` §10 起 Claude 子代理（`bump-attempt <编号> impl` → `brief.ts --phase impl` → 子代理 → 位置断言 → 守卫 → `state.ts opus-run --run-id …`）。
5. 完整验证看 PR 头提交上的必过检查（GitHub CI：ci-gate、contracts-gate、longrun-props；`ops/approvals.yaml` 第 21 条，2026-10-06 起）；`tools/ops/verify-container.sh <编号>` 仍可在本机跑，结果可选地写进证据文件（写了就必须在头提交树上通过）。
6. 失败要重派时：先 `node tools/ops/state.ts set <编号> --last-error <verify/<n>/log.txt 的路径>`，然后回到第 4 步（Opus 超限后 RV0 / RV1 换家：`dispatch.sh <编号> --handover`）。`dispatch.sh` 先计数再生成任务书，从第 2 次尝试起每次都重新生成，所以新任务书会写「第 n 次尝试」并带上一轮失败输出的末尾。`last_error` 目前没有脚本自动写，漏了这一步新任务书就没有失败输出。

## 3. 测试

- 单元测试：`pnpm --filter @couli/tools exec vitest run ops`。夹具放 `<仓库>/.tmp/ops-tests/`，`COULI_RUNS` 指到那里，不碰真实的 `couli-runs`。
- 一部分用例读真实的规划仓库（按 `SPEC_REF`）和真实的台账 `ops/tasks/`（取当时的第一个未完成任务，不写死编号，任务完成或归档后用例不用改），所以需要 git 和规划仓库；验证容器里由 `/spec` 快照提供。其中「真实台账通过 `task.ts check`」这条用例让台账校验进了 `pnpm verify`：`refs_hash` 过期会让验证失败。
- GitHub CI 上没有规划仓库：`.github/workflows/ci.yml` 的 `verify-fast` 把公开的规划仓库带完整历史检出到 `.tmp/spec-repo` 并设 `COULI_SPEC_REPO`，否则这些用例和 `spec-ref`、`banned-terms` 守卫都会失败。这一步还没在 GitHub 上跑过。TODO(规划/11 §5.3): 在真实 runner 上验证规划仓库检出 — blocked on GitHub remote
- `verify-container.sh` 的容器路径不在单元测试里（要 Docker 和网络），改了验证配方后手动跑 `bash tools/ops/verify-container.selftest.sh`。
