# tools/agent：Codex 调用包装与派工

这里是本仓库调用 Codex 的唯一入口，也写明 Claude 实现子代理怎么派；Codex 不可用时顶替它的独立 Claude 子代理也只经这里的 `claude-run.sh`（§14）。规则出处：规划仓库 `规划/11_开发协作与自主推进.md` §1.1、§2.2–§2.5、§3.1、§3.3、§4.3、§9.3。本目录属于保护路径第三类（门禁与规则），改动要负责人确认。

一句话：`codex-run.sh` 把 Codex 关在固定的沙箱参数里跑一次，跑完告诉编排者「有没有可用产出」；任务做没做对，不看它，只看沙箱外的 `pnpm verify`。

**默认分工（负责人 2026-10-05，`ops/approvals.yaml` 第 19 条；规划/11 §1.1）：Opus 实现、Codex 写测试与评审。**

**评审只用 Codex（负责人 2026-10-09，`ops/approvals.yaml` 第 27 条）**：Claude 写的实现不再派 Claude 新子代理做第二家评审（RV2 也不派），所有风险级的代码评审只跑 Codex 新只读会话（`gpt-6-astra`，推理档位默认 `medium`，第 52 条；环境变量 `CODEX_REVIEW_EFFORT` 是保留的开关，只在负责人另有决定时改）；Codex 写的规则测试仍由 Claude 新子代理过审（§11），Codex 实现的代码（换家、第 23 / 30 条首发）仍由 Claude 评审。

| 谁 | 做什么 | 经什么 |
| --- | --- | --- |
| Claude Opus 5.5 子代理（`claude-opus-5-5`） | 主实现，所有区域 | 编排会话用 Claude Code 的 Agent 能力起，见 §10 |
| Codex | 实现前写规则 / 验收测试和只抛 `NotImplemented` 的骨架，先红 | `codex-run.sh impl <id> --phase test`（`dispatch.sh <id>`） |
| Codex 新只读会话 | 对抗评审（所有区域、所有风险级；Claude 写的实现只由它评审，推理档位默认 `medium`，`ops/approvals.yaml` 第 52 条） | `codex-run.sh review <id>` |
| Claude 新子代理（不是实现那个） | 规则测试过审（spec-test）；Codex 实现的代码（换家、第 23 / 30 条首发）的评审 | §11 |
| Codex（换家，一次） | Opus 超限后的 RV0 / RV1 实现 | `dispatch.sh <id> --handover`（`codex-run.sh impl --phase handover`） |
| 独立 Claude 新上下文（`claude-opus-5-5`，每次 `claude -p` 新会话） | Codex 不可用或额度不足时顶替 Codex：写规则测试（先红）、对抗评审（money / general / contract / spec-test）；Codex 能用时仍优先 Codex（负责人 2026-10-21，`ops/approvals.yaml` 第 36 条） | `claude-run.sh impl <id> --phase test`、`claude-run.sh review <id>`，见 §14 |

**执行边界**（规划第 2 轮评审 RO2-01/04）：Codex 沙箱里只做不执行测试的静态检查（类型检查、lint）；任何运行测试的命令都由编排者在隔离容器（`tools/ops/verify-container.sh`）或 CI 里跑；Codex 生成的任何可执行内容（规则测试、骨架、换家实现）都不在宿主上运行。Opus 实现子代理跑测试也只经 `verify-container.sh <id> --fast`，因为里面有 Codex 写的测试。`verify-container.sh` 没有宿主回退（CR-01）：Docker 用不了就停下，交给 CI。

**旧任务按旧流程走完**（编排会话 2026-10-05 补充要求）：`tools/guard/legacy-tasks.json` 列出的 82 个台账（分工切换合入前最后一个主干提交 `85f4f53` 上的全部任务）不受新分工约束：不要求 `test_paths`、证据不要求红测记录（仍要完整的容器 `verify`）。其中台账 `impl: codex`、`tester: claude` 的（如 B1-01r～w）照旧：Claude 写规则测试 → Codex spec-test 评审（`codex-run.sh review --review-type spec-test`）→ Codex 实现（`dispatch.sh <id>` 自动选旧的实现阶段：`codex-run.sh impl --phase impl`，计 `attempts.impl`，不算换家、不记 `implementer`，任务书是旧格式：沙箱里可跑 `pnpm verify:fast`）→ Codex / Claude 代码评审。`--phase impl` 只接受这类台账；新任务一律走新分工。清单内的任务还有两条旧口径（CR3-01、CR3-02）：没有 `test_paths` 时，路径守卫、red-check 与 `--red` 的应跑清单都用同一套旧范围（全部第一类规则测试资产，`tools/lib/legacy-tasks.ts` 的 `ruleTestScope`）；骨架按切换前的规则判（文件里有 `NotImplemented`），逐语句检查只管清单外的任务。清单外的新台账只能写 `impl: claude`、`tester: codex` 或 `none`（`task.ts check`，CR3-03），换家只记在运行时的 `implementer`。

**部分任务改由 Codex 实现**（负责人 2026-10-06，`ops/approvals.yaml` 第 23 条，规划/11 §1.1 例外、§2.5「Codex 首发实现」、§7.3 第 14 项；负责人 2026-10-16 起未开工的任务默认改由 Codex 实现，第 30 条，规划/11 §1.1、§7.3 第 15 项：已开工的保持原分工，未开工的按台账编号逐个加进清单、不整行放行，流程与边界同下；**负责人 2026-10-17 实现回到 Claude、Codex 只做对抗评审，第 34 条，规划/11 §1.1、§7.3 第 16 项：第 30 条停用，清单冻结不再新增（`tools/lib/codex-impl-tasks.test.ts` 持冻结集），清单里已开工的 Codex 任务做完为止，尚未开工的下次台账 PR 改回 `impl: claude`、`tester: codex` 并移出清单；困难任务由编排指定 Opus 5.5 高推理或 Fable 5.1，台账 `impl` 仍写 `claude`、模型写注释**）：`tools/guard/codex-impl-tasks.json` 按子任务编号放行（带小写后缀的条目只放行该子任务；不带后缀的条目是整行放行，含其全部子任务）。这些台账可写 `impl: codex`、`tester: claude`（`task.ts check`），且照新任务要求写 `test_paths`、证据要红测记录：Claude 子代理先写规则测试（`brief.ts <id> --phase test` 生成任务书）并先红 → Codex 新只读会话过审测试（`codex-run.sh review --review-type spec-test`，台账 `tester: claude` 才放行）→ 记下 `spec_commit` 后 `dispatch.sh <id>` 自动选实现阶段（`codex-run.sh impl --phase impl`，计 `attempts.impl`，上限 3；没有 `spec_commit` 拒绝派发），任务书与换家同口径：沙箱只做静态检查，测试由编排者在隔离容器或 CI 跑 → 评审按风险级：RV0 / RV1 由 Claude 新子代理；RV2 两家（Claude 新子代理 + Codex 新只读会话，`codex-run.sh review` 每次都是新会话）。这类 PR 都带规则测试（`test/**`，RV2），evidence-check 按整个 PR 算风险，所以实际上都要两家评审。第 27 条起证据只要求实现方之外的那一家：evidence-check 读到台账 `impl: codex` 时要求 `claude` 条目，`codex` 条目可选（有则照旧校验）。Codex 首发实现超限后换 Opus 实现一次（RV0 / RV1）由编排者手工记录，本脚本不自动处理；RV2 `blocked` 问负责人。这类台账只能是 `type: impl`，`paths` 不得碰清单文件 `forbidden_paths` 列的资金、归属、打款、订单、迁移、契约、客户端与门禁路径（`MONEY_PATHS` 的超集；`task.ts check` 拒收，清单缺这一栏则一律拒收）；Codex 首发台账不能再走 `dispatch.sh --handover`。清单外的任务不受影响。

**契约去 planned 的机械提交**（`ops/approvals.yaml` 第 31 条，编排会话按规划/11 §7.3 第 11 项决定，落实第 30 条；起因 #522）：Codex 实现的接口任务，台账可另写 `mechanical_paths`（只能取 `codex-impl-tasks.json` 的 `mechanical_paths`：`contracts/openapi.yaml`、`packages/contracts-ts/src/openapi.gen.ts`、`apps/api/src/modules/platform/validation/route-schemas.gen.ts`；`task.ts check` 校验，`forbidden_paths` 只管 `paths`，不管这一栏；非 Codex 实现台账写这一栏拒收）。这几份文件不进任务书、不交给 Codex。Codex 的运行都结束、实现已提交后，编排者自己删去对应接口的 `x-implementation: planned`、跑 `pnpm contracts:codegen` 与 `node apps/api/src/modules/platform/validation/scripts/generate-route-schemas.ts`，单独提交，提交信息结尾块写 `Couli-Mechanical: contract-codegen`（与 `Co-Authored-By` 同一块）；这个提交只许改这几份文件、契约只许删 planned 行，CI guard-git 按提交分开查（`tools/README.md`「契约机械提交」）。`post-run.sh` 的路径守卫不认这个 trailer，只认 `paths`，所以机械提交之后不要再派 Codex 运行（要再派先撤掉机械提交）。

**谁实现的就不评审谁**：台账 `tester` 不是 `claude` 时（Codex 写的或读不到作者）`codex-run.sh review --review-type spec-test` 一律拒绝（CR-08）；换家后（在途状态 `implementer: codex`，或运行目录里有 `phase: handover` 的调用）Codex 的代码评审一律拒绝，改由 Claude 新子代理按 §11 的做法评审（CR-09）。`codex-run.sh impl` 核对任务书「本轮阶段」与 `--phase` 一致，不一致拒绝（CR-14）。

## 1. 文件

| 文件 | 作用 |
| --- | --- |
| `codex-run.sh` | 包装脚本：`impl`（`--phase test` 写测试 / `--phase handover` 换家实现 / `--phase impl` 旧台账的 Codex 实现）、`review`、`selfcheck` |
| `claude-run.sh` | 同一包装脚本的独立 Claude 引擎（第 36 条）：以 `AGENT_ENGINE=claude-independent` 载入 `codex-run.sh`，命令行、超时、退出码、可信根、运行目录与 `meta.json` 相同；只有 `impl --phase test`、`review`、`selfcheck`（§14） |
| `supervise.pl` | 进程组监管：硬超时、无活动看门狗、整组击杀、确认组内无存活进程 |
| `dispatch.sh` | 派工前检查 + 后台启动一次 Codex 写测试（或 `--handover` 换家实现） |
| `post-run.sh` | Codex 运行结束后：先跑守卫，再给出下一步动作 |
| `next-action.ts` | `post-run.sh` 的判定表（纯函数，有单测） |
| `validate-output.ts` | 产出校验：schema（Ajv2020 strict）+ 评审规则 + 资金清单；规则测试评审的范围外条目移进 `out_of_scope`、重算结论、追加到 `out-of-scope.md` |
| `meta.ts` | 给 bash 用的 JSON 读写小工具、事件流解析 |
| `format-tests.ts` | 独立 Claude 写测试那次交回的测试文件，由包装脚本用可信根的 eslint（只做 layout 修正）与 prettier 格式化，并核对只改了格式（§14，D10-292） |
| `common.sh` | 三个脚本共用的路径解析与进程组函数 |
| `schemas/impl.schema.json`、`schemas/review.schema.json` | 结构化产出的 schema（每个 object 都是 `additionalProperties:false` + 全字段必填）；评审产出另有 `out_of_scope`（任务 refs 以外的问题，不计入结论） |
| `prompts/review-{money,general,contract,spec-test}.md` | 四种评审提示词；`spec-test` 现由 Claude 新子代理使用（§11），其余三种是 Codex 代码评审用的，换家或 Codex 首发实现时 Claude 评审子代理也用 |
| `testing/` | 测试用假 `codex`（`couli-fake-codex.sh`）、假 `claude`（`couli-fake-claude.sh`）和夹具；不连模型、不耗额度 |

## 2. 命令

```bash
# Codex 写规则测试（默认 --phase test）或换家实现（--phase handover，只限 RV0 / RV1）
# 任务书必须已在 <runs>/<id>/brief.md（brief.ts --phase test|handover）
tools/agent/codex-run.sh impl <id> [--phase test|handover] [--worktree <dir>] [--timeout-min <n>] [--dry-run]

# 评审（只读沙箱）
tools/agent/codex-run.sh review <id> [--worktree <dir>] \
  [--review-type money|general|contract|spec-test] [--base <ref>] [--timeout-min <n>] [--dry-run]

# 自检：不发起任何 Codex 回合，不耗额度
tools/agent/codex-run.sh selfcheck

# 派工（后台）与收尾：默认是 Codex 写测试；--handover 是换家实现
tools/agent/dispatch.sh <id> [--handover]
tools/agent/post-run.sh <id>

# 单独校验一份产出
node tools/agent/validate-output.ts --schema <schema> --file <json> [--money] [--refs <BR-…,BR-…>] [--allowed-paths <glob,glob>] [--rewrite] [--out-of-scope-log <md>] [--diff-base <ref> --cwd <worktree>] [--json]
```

- `<id>` 是台账编号（如 `B2-03a`）。`<runs>` 默认是仓库旁边的 `couli-runs/`，worktree 默认 `<runs>/worktrees/<id>`。
- `--review-type` 不传时按任务的风险级定：RV2 → `money`（资金清单强制），其余 `general`。RV2 任务不接受 `general`。台账 `tester: codex` 的任务不接受 `--review-type spec-test`（退出 2）：Codex 不评审自己写的规则测试，规则测试过审交 Claude 新子代理（§11）。
- `--phase` 只用于 `impl`，不传是 `test`；写进 `meta.json` 的 `phase`，`tools/ops/state.ts` 据此把这次调用记在 `test` 或 `handover` 计数器上，不记进实现次数（RO-07）。`handover` 只接受可信副本 `task.ts show` 算出 RV0 / RV1 的任务。
- `--base` 不传时取 `HEAD` 与 `origin/main`（没有则 `main`）的分叉点。
- `--timeout-min` 只能调小：实现上限 30 分钟、评审 15 分钟（规划/11 §2.2）。超时的任务要拆小，不是加时间。
- `--dry-run` 把将要执行的 argv 一行一个打印出来（参数里的换行显示为 `\n`），不启动 Codex、不写任何文件。

## 3. 包装脚本保证什么

1. **命令固定**。实现与评审的 argv 就是规划/11 §2.4 那两条，写死在脚本里；调用方传不进任何 Codex 参数。评审提示词后面追加的「Review context」一段（任务编号、基线、任务 refs、改动文件列表、任务书）是包装脚本自己加的，§2.4 原命令里没有。
2. **stdin 关闭**（`/dev/null`），带 `COULI_CODEX_WRAPPER=1`。
3. **位置断言**。启动前：worktree、它的 git 目录、`<runs>`、可信副本都不在 `/tmp`、`/private/tmp`、`$TMPDIR` 下，否则退出 12；脚本自身或 `COULI_TRUSTED_ROOT` 位于 `couli-runs/worktrees/<编号>` 下（任务 worktree）一律拒绝，退出 2。结束后：HEAD、当前分支、分支列表、`refs/stash`、暂存区、本地 git 配置（不含 `branch.*`）、`.git/hooks` 与启动前一致，否则退出 12，产出作废。分支列表里只放过一种变化：**别的任务的分支**（`refs/heads/task/<别的编号>`）新增、移动或删除，因为编排者会在本次运行期间给别的任务建 worktree、提交规则测试；这种变化只记进 `meta.json` 的 `other_task_branches_changed`。
4. **超时杀整组**。Codex 在独立进程组里跑；硬超时或无活动时对整组先 TERM、等 `COULI_KILL_GRACE_SECS`（默认 5 秒，上限 5，只能调小）、再 KILL，确认组内没有存活进程后才去看 `-o` 文件。「无活动」= 事件文件没有新内容 **且** 这次运行的进程没有消耗 CPU（实现 5 分钟 / 评审 12 分钟；每秒扫一次进程表，CPU 时间在窗口内增长不到窗口的 5% 算静止）：沙箱里一条跑很久、不打事件的 `pnpm test` 不会被误杀。监管脚本还记住组长的全部后代（含用 `setsid` 脱离进程组的；靠继承的一个文件描述符在收尾时再找一遍，Linux 用 `/proc`，macOS 用 `lsof`），收尾时一并结束。包装脚本自己被 TERM / INT / HUP 时同样杀整组。Codex 正常退出但留下后台进程（`stragglers_killed`）或有后代脱离了进程组（`escaped_killed`）的，进程被清掉，这一次按**无产出**处理（退出 10，`-o` 改名 `.rejected`）：被强制清理过的运行里写出来的东西不当作模型的回答。
5. **旧产出不会被当成新产出**。每次调用前把上一次同模式的产出挪进 `attempts/<n>/`，并确认 `-o` 文件不存在；本次没被接受的 `-o`（包括击杀之后才写出来的）改名为 `*.rejected`。
6. **成败判定**（规划/11 §2.4）。四条同时成立才算有产出：Codex 退出码 0、事件流最后一条是 `turn.completed`、`-o` 存在、通过可信副本里的 `validate-output.ts`。
7. **门禁从可信副本读**。schema、提示词、校验器、`usage.ts`、守卫都取自 `COULI_TRUSTED_ROOT`（默认：`<runs>/trusted/rebate-platform` 存在就用它，否则脚本所在的主检出），不读任务 worktree：脚本从 `couli-runs/worktrees/<编号>` 下运行、或 `COULI_TRUSTED_ROOT` 指到那里，直接拒绝（退出 2），没有静默回退。
9. **真正的 codex**。只用 `command -v codex`（垫片算数，它会转给真正的二进制），且它的物理路径不能在仓库、worktree、`couli-runs` 或临时目录下。`COULI_CODEX_BIN` 只给测试夹具用：必须同时设 `COULI_AGENT_TEST=1`，且运行目录位于某个 `.tmp` 目录下，否则拒绝（退出 2）。
10. **评审范围只到任务的 refs**（负责人 2026-10-02 决定，`ops/approvals.yaml` 第 13 条）。包装脚本从可信副本的 `task.ts show` 取任务的 `refs`，写进评审上下文一行「In-scope rules (the task's refs)」。规则测试评审（spec-test）只对照这些 BR 的条款；一跳引用的规则只作理解用；关于 refs 以外规则的问题写进 `out_of_scope`，不计入 `verdict`。资金评审提示词带同样的范围说明（仓库硬规则与七项清单始终在范围内）。spec-test 评审校验时带 `--refs`：`findings` 里只引用 refs 以外 BR 编号的条目记一条警告（进 `meta.json` 的 `validation_messages`），不算 S0 / S1——「pass 带 S0 / S1」的矛盾检查不数它，只因它而 `fail` 的另记一条「范围内是 pass」的警告。
12. **规则测试评审还以任务 `paths` 为界**（负责人 2026-10-02 决定，`ops/approvals.yaml` 第 14 条）。spec-test 评审的上下文多一行「Allowed paths」（任务 `paths`，取自可信副本的 `task.ts show`），校验时带 `--allowed-paths`；规则测试目录（可信副本 `tools/guard/protected-paths.json` 第一类）自动算在范围内。下面几种 `findings` 条目算范围外：只引用 refs 以外的 BR；`file` 在任务 `paths` 与规则测试目录之外；正文引用的仓库路径全在其外；`rule` 以评审方的范围标记 `[out-of-scope]` 开头。校验带 `--rewrite`：通过校验后把这些条目移进 `-o` 文件的 `out_of_scope`，`verdict` 只按范围内的 S0 / S1 重算（有就 `fail`，没有就 `pass`），每条移动与结论改变都记一条警告进 `validation_messages`；再带 `--out-of-scope-log <runs>/<id>/out-of-scope.md`：把全部 `out_of_scope` 条目（评审方自己写的和移进来的）按 `key` 去重追加进这个文件（不存在就建），留给后续任务写规则测试。校验不过的产出不改写、不追加。资金评审不变。
11. **评审类型跟着风险级**。`--review-type` 不传时，可信副本的 `tools/ops/task.ts show <id>` 算出 RV2 就用 `money`（强制资金清单），否则 `general`；RV2 任务显式传 `general` 被拒绝（`contract`、`spec-test` 仍可用）。评审产出里 `verdict: pass` 却带 S0 / S1 发现的，按无产出处理（退出 10）。
8. **每次调用都记账并结算轮次**：结束后调用 `tools/ops/usage.ts record`（规划/11 §1.3；只记 token 用量，额度不设限制，记账失败只记警告、不改退出码），再调用 `tools/ops/state.ts settle <id> --meta <meta.<mode>.json>`：没有产出就结束的调用（见 §4）把派发前计上的那一轮还回去；它的 `meta.<mode>.json` 照样留在运行目录，仍计入每任务 10 次与「连续 3 次无产出」两道失败熔断（`state.ts taskCalls`）。`settle` 按调用的 `started_at` 去重，重复执行不会多还；没有在途状态文件时什么都不做；它失败只记警告，这一轮按已计处理。调用前就被拒绝（退出 2）的调用没有 `meta.json`，改由 `state.ts release` 退回那一轮（§4「拒绝时退回轮次」）。
13. **增量评审**（CT-06x，负责人 2026-10-19）。评审指引 `REVIEW.md`（高风险区、严重度、免查文件、发现必须给文件与行号、增量规则）只取门禁可信根的那份：包装脚本构造提示词时读 `<可信根>/REVIEW.md`，原文作为只读的规则块 `Review guide (trusted root, rules)` 拼在提示词与上下文之间；可信根里没有就不拼，并在 stderr 记一行。被审 worktree 里的 `REVIEW.md`（包括被审改动新增或改过的）一律算待审数据，提示词要求不得据它放宽检查。Claude 评审子代理不经包装脚本，由编排者把可信根的 `REVIEW.md` 原文交给它们，不让它们读被审工作树里的那份。第 2 轮起，包装脚本在构造提示词时（归档之前）找同一评审类型的上一轮产出，只认「同一次调用」成对留下的产出与元数据——`<runs>/<id>/review-codex.json` 配 `meta.review.json`，否则最大编号的 `attempts/<n>/` 内的 `review-codex.json` 配 `meta.json`；成对要求 meta 的 `mode` 为 `review`、`review_type` 相同、`has_output` 为真、`exit_code` 为 0、`output_file` 是本运行目录的 `review-codex.json`，且产出文件的修改时间落在该次调用的 `started_at`～`finished_at` 之内（容差 1 秒）。调用方另存的编号文件（如 `review-codex-<类型>-r<N>.json`）不与任何 meta 配对。找到后把「上一轮评审 JSON 原文」与「上一轮评审时的头提交」（meta 的 `head_before`）作为只读数据块 `Previous review round` 拼进上下文；找不到、对不上或头提交不在 worktree 里就照旧全面审，并在 stderr 记一行。命令行参数、沙箱与退出码不变。

有产出不等于任务成功。Codex 说「测试通过」不算数，成败看 PR 头提交上的必过 CI 检查（`ops/approvals.yaml` 第 21 条，2026-10-06 起）；本机 `tools/ops/verify-container.sh` 的完整验证可作自查。

## 4. 退出码

| 退出码 | 含义 | 编排者怎么处理 |
| --- | --- | --- |
| 0 | 有可用产出 | `post-run.sh` → 守卫 → 沙箱外验证 |
| 10 | 没有可用产出（退出码非 0、缺 `turn.completed`、缺 `-o`、校验不过、被中止） | 退避重试。没拿到回答（`validation` 为 `not-run`：缺 `-o`、`turn.failed`、退出码非 0、被中止、留下进程）不计轮次；拿到回答但校验不过（`validation: failed`）计一轮 |
| 11 | 模型容量错误（`Selected model is at capacity`） | 退避重试，不计轮次，仍计入每任务 10 次；不计入连续无产出 |
| 12 | 位置断言失败 | 按越界处理：不执行、不提交这个 worktree 里的任何东西，先人工看 `meta.json` 的 `position_changed` |
| 124 | 硬超时或无活动被击杀 | 不计轮次，仍计入每任务 10 次与连续无产出；反复超时说明任务要拆小 |

「计不计轮次」由 `tools/ops/state.ts settle` 判定（规划/11 §2.5，负责人 2026-10-02 决定）；位置断言失败（12）照计。
| 2 | 用法错误，或参数被拒绝 | 修正调用；Codex 没有被启动；调用前已计的那一轮退回（见下） |

**拒绝时退回轮次**（CT-06zzzp，FU-CODEX-RUN-REJECT-COUNT，D10-898）：调用方在调用前已 `state.ts bump-attempt` 计了一轮，而拒绝（`fail_usage`、`refuse`、本引擎失败熔断已开）都发生在写 `meta.json` 之前，`settle` 不会跑。所以任务编号、模式与参数都已解析、可信根已确定、不是 `--dry-run`、可信根有 `tools/ops/state.ts` 时，脚本在退出 2 之前先调 `state.ts release <id> <kind> --engine <本引擎> --reason <拒绝原因的前一段>`：`kind` 与 `settle` 同口径（`impl` 按 `--phase` 记 `test` / `handover` / `impl`；`review` 按评审类型，没传类型按代码评审）。只退同 kind、同引擎、在 `settle` 配对窗口内最新一条未消耗的预计数（标 `refused`），找不到就不改。退出码仍是 2；`release` 失败只记一行 warning，这一轮按已计处理。任务编号缺失或不合法、参数解析阶段的错误（此时还不知道 `--dry-run`）、可信根确定之前的拒绝都不调 `release`。`claude-run.sh` 共用这段代码，以 `--engine claude-independent` 退回。

`selfcheck`：0 通过，1 有检查项失败。

## 5. 运行目录 `<runs>/<id>/`

| 文件 | 内容 |
| --- | --- |
| `brief.md` | 任务书（`pnpm ops:brief <id>` 生成），实现与评审共用 |
| `impl.json`、`events.jsonl`、`err.txt` | 实现的结构化产出、事件流、stderr |
| `review-codex.json`、`review-events.jsonl`、`review-err.txt` | 评审的同三样 |
| `meta.json` | 最近一次调用的结果；`meta.impl.json` / `meta.review.json` 是按模式各留的一份 |
| `*.rejected` | 没被接受的 `-o` 文件，留作排查 |
| `wrapper-impl/`、`wrapper-review/` | 包装脚本的工作文件：实际发给 Codex 的提示词（`prompt.md`）、进程组号、监管结果、前后位置快照、校验信息 |
| `attempts/<n>/` | 之前各次调用的产出，`n` 按调用先后递增（不是 attempts 计数），每个目录带当次的 `meta.json` |
| `dispatch.log` | `dispatch.sh` 后台启动的那次包装脚本的输出 |
| `post-run/` | `post-run.sh` 取到的状态与守卫输出 |
| `verify/<n>/` | 沙箱外验证的日志与结果（`tools/ops/verify-container.sh` 写） |
| `out-of-scope.md` | 规则测试评审范围以外的条目，按 `key` 去重累积追加（`validate-output.ts --out-of-scope-log` 写，不随 `attempts/` 归档）；编排者据此给后续任务写规则测试 |

`meta.json` 字段：`mode`、`engine`（`codex` / `claude-independent`，§14；没有这个字段的旧文件是 Codex）、`phase`（只 `impl` 有：`test` / `handover`）、`task`、`worktree`、`run`、`started_at`、`finished_at`、`exit_code`、`codex_exit`、`timed_out`、`idle_killed`、`aborted`、`has_output`、`capacity_error`、`head_before`、`head_after`、`thread_id`、`codex_version`、`model`、`last_event`、`pgid`、`group_gone`、`stragglers_killed`、`validation`、`validation_messages`、`position_changed`、`other_task_branches_changed`、`timeout_secs`、`idle_secs`、`wrapper_pid`、`output_file`、`events_file`，评审另有 `review_type`、`base`。`has_output` 只表示产出通过了校验；位置断言失败时 `exit_code` 仍是 12。

## 6. 禁止的用法（规划/11 §2.4 禁用）

- 不经本脚本直接跑 `codex exec`；不带 `-s` 或不带 `--ignore-rules` 的 `codex exec`。
- `--dangerously-bypass-approvals-and-sandbox`、`danger-full-access`。
- `sandbox_workspace_write.network_access=true`（一开就同时放开 Docker、本机数据库和外网）。
- 独立的 `CODEX_HOME`（会丢登录）。环境里设了非默认的 `CODEX_HOME`，脚本直接拒绝。
- Codex 自带的 `--worktree`、`--add-dir`、`resume`、任何 `sandbox_mode` 覆盖。
- `exclude_tmpdir_env_var`、服务档位、`--ephemeral`：脚本不会加，也传不进去。

调用方的参数里只要出现 `network_access`、`sandbox_mode`、`--add-dir`、`--dangerously-bypass-approvals-and-sandbox`、`--worktree`（本脚本自己的 `--worktree <目录>` 除外）、`danger-full-access`、`resume`、`CODEX_HOME`，或任何脚本不认识的参数，一律退出 2。

## 7. 派工与收尾

`dispatch.sh` 只派 Codex 的 `impl` 模式运行，分两种（`ops/approvals.yaml` 第 19 条）：

| 调用 | 阶段 | 计数器 | 任务书 | 前提 |
| --- | --- | --- | --- | --- |
| `dispatch.sh <id>` | `test`：Codex 写规则测试与骨架 | `attempts.test`（3 次） | `brief.ts --phase test` | 在途状态没有 `spec_commit`（有了就停，`spec-commit-exists`：测试已冻结，实现交 Opus，§10） |
| `dispatch.sh <id> --handover` | `handover`：Opus 超限后 Codex 实现一次 | `attempts.handover`（1 次） | `brief.ts --phase handover` | 可信副本算出 RV0 / RV1；RV2 停（`handover-refused`，规划/11 §2.5） |

已有的 `brief.md` 只在它的「本轮阶段」行与这次阶段相同时复用；否则重新生成，免得把写测试的任务书交给实现、或反过来。

`dispatch.sh <id>` 先用 `mkdir <runs>/<id>/dispatch.lock` 取一把只在本次派工期间存在的锁（10 分钟没清掉的视为残留），再按顺序检查，任何一步不过就停（没有额度闸门）：认领任务（owner 是 `COULI_SESSION`，不设则本进程唯一；只有认领已被同一 owner 持有时才 `--renew`）→ 上一次派工记录的 pid 还活着就停（`run-in-progress`）→ 阶段前提（上表）→ **先把这一阶段的尝试次数加一**（每次都加；上一次调用若没有产出就结束，包装脚本结束时已经把那一轮还回去了；该任务的失败熔断打开时 `bump-attempt` 退出 3，派工输出 `{"action":"stopped","reason":"task-breaker",…}` 并以 3 退出，只停这个任务）→ 任务书在不在（不在就生成）→ worktree 与 `node_modules` 在不在（依赖由编排者在沙箱外装，这里绝不安装）。然后在独立会话里后台启动 `codex-run.sh impl <id>`（有 `caffeinate` 就套上防睡眠），登记 pid 与开始时间，输出一行 `{"action":"dispatched","pid":…,"run":"…"}`。

三处细节：

- **没有额度闸门**。负责人 2026-10-02 说 Codex 额度不设限制（`ops/approvals.yaml` 第 15 条）：`dispatch.sh` 不调 `usage.ts`、不按风险级改派；只有失败类熔断（每任务 10 次调用、同一任务连续 3 次无产出，`state.ts bump-attempt` 里检查）停任务。
- **重派一定重新生成任务书**。第 2 次尝试起（在途状态的 `attempts.impl` ≥ 2），不管 `brief.md` 在不在都重新跑 `brief.ts`：任务书里的「第 n 次尝试」和「上一轮失败输出」取自在途状态，沿用旧任务书就丢了上一轮的失败输出（规划/11 §2.3「重试不用 resume」）。所以重派前编排者要先 `node tools/ops/state.ts set <id> --last-error <失败输出文件>`。
- **停掉一次在跑的派工**：对输出里的 `pid` 发整组信号，`kill -TERM -- -<pid>`（负号表示整组）。包装脚本收到后把 Codex 进程组整组结束、写完 `meta.json` 再退出。只杀单个 pid 可能留下还在跑的包装脚本。

评审不经 `dispatch.sh`：编排者先 `node tools/ops/state.ts bump-attempt <id> review --review-type <类型>`，再前台或后台跑 `codex-run.sh review <id> --review-type <同一类型> …`。轮次按评审类型分开计（规划/11 §2.5）：规则测试评审（`spec-test`）最多 2 轮，代码评审（`money`、`general`、`contract` 共用一个计数）最多 3 轮（负责人 2026-10-02，`ops/approvals.yaml` 第 17 条）；没有产出就结束的调用由包装脚本还回那一轮。评审前的 `bump-attempt` 同样先查失败熔断，打开就退出 3，这个任务停下并报告。

`post-run.sh <id>` 只读文件，不执行任务代码、不动 git、不动 worktree，输出一行 JSON：

| `action` | 什么时候 |
| --- | --- |
| `verify` | 换家实现（或 2026-10-05 前的 Codex 实现）有产出、路径守卫与保护路径守卫都过。附 `revert_first`（`ops/`、`docs/` 下要先还原的越界改动）和 `outside_needed`（要在沙箱外跑的命令） |
| `red-check` | Codex 写测试（`phase: test`）有产出、守卫都过。不验证（测试本来就该红）：编排者跑 `tools/ops/verify-container.sh <id> --red`（隔离容器里只跑本任务 `test_paths` 内新写的测试文件，导出 Vitest JSON 报告，`red-check.ts` 逐个文件对账，退出码就是它的；base 上已存在的规则测试文件只要求新增或测试体改动的用例有效红，未改用例可绿、列在 `exempt` / `notes`，CT-06p；只因读到本任务改动的数据 / 夹具文件而整文件入列的，其中测试体未变的用例可由主干台账 `red_exempt`（file / test / reason ≥ 10 字）逐条声明豁免，`notes` 标「需规则测试评审确认」，规则测试评审（§11）逐条确认「非削弱」后在证据 `spec_test_review` 记 `red_exempt_confirmed: true`（`evidence-check` 校验），未声明或新增 / 改动的用例照旧须红，CT-06r；主干台账 `renames`（带引号的名字字面量改名对，CT-06zxc）命中的冻结文件按替换后的基线比较，替换后与新内容逐字相同的剔出应跑清单，规则测试评审（§11）须逐对核对命中的改名确是纯改名（只是名字跟改、不改任何期望值或断言含义）、逐个核对被剔出的文件替换后与新内容逐字相同，确认后才在证据 `spec_test_review` 记 `renames_confirmed: { pairs, left_out }`；主干台账 `expected_values`（回调外顶层 helper 里逐条登记的期望值改动：file / helper / from → to，CT-06zxe，D10-371）生效的文件只要求调用被改 helper 的用例（含经别的顶层 helper 间接调用）有效红、其余未改用例照 CT-06p，`notes` 列出每条登记的生效情况与受影响用例，规则测试评审（§11）须逐条核对登记确是只改期望值（不删断言、不改断言以外的逻辑、新值与规则一致）、受影响用例正确且都红，确认后才在证据 `spec_test_review` 记 `expected_values_confirmed: { entries }`；口径见 `tools/README.md`），过了才提交 `test(spec): …`、`state.ts set --spec-commit`，把 `red/<n>/result.json` 记进证据；RV2 再交 Claude 新子代理过审（§11），然后派 Opus 实现（§10） |
| `retry` | 失败的一次尝试（无产出、超时、越界、自称没做完、孤儿）。附 `backoff_min`：第 1 次后 15 分钟，第 2 次后 30 分钟；超时与无产出另附 `counts_as_attempt`（`false` = 包装脚本已还回这一轮）。孤儿（包装脚本没写完 `meta.json`）没有结算，照计一次 |
| `blocked` | 三次用完、位置断言失败、要装依赖（`deps-needed`）、实现者自报受阻、守卫出错 |
| `ask` | 改动碰了保护路径第二、三类，交负责人确认 |
| `capacity-retry` | 模型容量错误，不计次数 |
| `none`（退出码 1） | 这次运行还没结束 |

守卫（`tools/guard/path-guard.ts`、`protected-paths.ts`）一律从可信副本运行，基线取规则测试提交（`spec_commit`），没有就取分叉点。写测试的运行（`phase: test`）从分叉点算，路径守卫带 `--author`：只许规则测试资产（第一类保护路径，只新增）与任务 `paths` 内含 `NotImplemented` 的骨架，`ops/`、`docs/` 越界照旧只报告；计数器取 `attempts.test`（换家取 `attempts.handover`，没有 `phase` 的旧运行取 `attempts.impl`）。包装脚本已死但 Codex 进程组还活着时，`post-run.sh` 会把整组结束掉，再按孤儿计一次失败。

## 8. 首次真实自检（由编排者做）

规划/11 §2.4 的三组参数各自实测过，写进同一条命令后还没有真实跑过；进程组击杀也只用 `sleep` 验证过。骨架期所有测试都用假 `codex`。第一次真实调用按下面做，结果回写规划/11 §9.3：

```bash
# 1. 不耗额度：核对参数名、进程组击杀、schema、提示词
tools/agent/codex-run.sh selfcheck

# 2. 真实实现一次（耗一次额度）。先准备一个不在 /tmp 下的任务 worktree 和一份很小的任务书
tools/agent/codex-run.sh impl <id> --dry-run      # 先看 argv
tools/agent/codex-run.sh impl <id> --timeout-min 10
#    期望：退出 0；meta.json 里 has_output=true、position_changed=[]、last_event=turn.completed
#    再核对会话文件 ~/.codex/sessions/…/rollout-*-<thread_id>.jsonl：
#    turn_context.model 是 gpt-6-astra、effort 是 high；没有 skill 段；/tmp 下写不进去

# 3. 真实评审一次（耗一次额度）
tools/agent/codex-run.sh review <id> --review-type general --base <基线提交>

# 4. 回合中途击杀：给一份需要跑很久的任务书，把超时压到 60 秒
COULI_CODEX_TIMEOUT_SECS=60 tools/agent/codex-run.sh impl <id>
#    期望：退出 124；meta.json 里 group_gone=true；ps 里没有残留的 codex 进程；
#    之后几分钟内 impl.json 不会再出现（若出现的是 impl.json.rejected 之外的文件，就是缺陷）
```

TODO(规划/11 §2.4, §9.3)：上面第 2–4 步尚未执行 — blocked on 编排者首跑（骨架期禁止调用真实 codex；每一步耗一次额度，并会往 `~/.codex/config.toml` 写一条信任记录）。

## 9. 环境变量

| 变量 | 作用 |
| --- | --- |
| `COULI_RUNS`、`COULI_TRUSTED_ROOT`、`COULI_SPEC_REPO` | 运行目录、可信副本、规划仓库的位置 |
| `COULI_CODEX_BIN` | 换一个 `codex` 可执行文件；只在 `COULI_AGENT_TEST=1` 且运行目录在 `.tmp` 下时接受（测试夹具用），否则拒绝 |
| `COULI_SESSION` | 编排会话名；`dispatch.sh` 用它作认领的 owner，同名会话才能续期自己的认领。不设时每次派工用一个唯一名字，仍被占着的认领不会被续期 |
| `COULI_KILL_GRACE_SECS` | TERM 到 KILL 的等待秒数，默认 5，上限 5 |
| `CODEX_REVIEW_EFFORT` | `review` 模式的推理档位（`model_reasoning_effort`）：`minimal` / `low` / `medium` / `high` / `xhigh`，默认 `medium`（`ops/approvals.yaml` 第 52 条，负责人 2026-11-07 由第 27 条的 `low` 改为 `medium`），只在负责人另有决定时改，其他值退出 2；`impl` 模式（Codex 写测试、换家实现）固定 `high`，不受它影响 |
| `COULI_CODEX_TIMEOUT_SECS`、`COULI_CODEX_IDLE_SECS` | 把硬超时、无活动阈值调小（测试与首次自检用）；调不大。这两个变量是本目录自己加的，根 `.env.example` 末尾有注释说明 |
| `COULI_CODEX_WRAPPER=1` | 只由本脚本设置，`codex` 垫片据此放行 |

## 10. Claude Opus 实现子代理怎么派

实现子代理不经脚本起：编排会话用 Claude Code 的 Agent 能力起一个新子代理（规划/11 §2.3 第 5 步）。每次都按下面做：

1. **前提**：在途状态已有 `spec_commit`（Codex 写的规则测试已提交、`verify-container.sh <id> --red` 已通过；RV2 还要 §11 的过审通过），worktree `<runs>/worktrees/<id>` 的依赖已由编排者在沙箱外装好。每一轮起之前给它取一个运行编号（例如 Agent 任务编号或 `opus-<时间>`），第 7 步结算要用。
2. **计数**：起之前 `node <可信副本>/tools/ops/state.ts bump-attempt <id> impl`（Opus 实现 3 次；退出 3 = 失败熔断打开，停）。
3. **任务书**：`node <可信副本>/tools/ops/brief.ts <id> --phase impl --out <runs>/<id>/brief.md`。实现阶段的任务书写明规则测试已冻结、测试只经可信容器入口跑；不要把写测试阶段的任务书交给实现子代理。
4. **起子代理**：模型指定 `claude-opus-5-5`（Agent 调用的模型参数选 opus，并在提示词里写明模型锁定）；工作目录就是 `<runs>/worktrees/<id>`（独立 worktree，不用主检出，不在 `/tmp` 下）；提示词 = 任务书全文 + 下面几条硬约束：不提交、不建分支、不 `git add` / `stash` / `reset`、不装依赖、不改 `ops/` 与 `docs/`、不改规则测试与保护路径；跑测试只用 `<runs>/trusted/rebate-platform/tools/ops/verify-container.sh <id> --fast`（断网容器里的 `pnpm verify:fast`，结果在 `<runs>/<id>/verify-fast/<n>/`；浏览器测试另用同一脚本的 `--browser`，结果与截图在 `<runs>/<id>/browser/<n>/`；Docker 不可用时停下报告，不在宿主直跑测试）；结束时按任务书第 8 节的 JSON 结构回报。子代理在后台跑（规划/11 §2.2），编排会话在等待期间不碰这个 worktree。
5. **硬超时与取消**（RO-08）：硬超时沿用 30 分钟（规划/11 §2.2，和 Codex 写入型相同；超时的任务要拆小，不加时间）。到点或要放弃时，用 Agent 能力停掉这个子代理（TaskStop），然后**确认它已经停了**再做任何事：子代理的任务状态显示已结束；`verify-container.sh` 起的容器没有残留（`docker ps --filter label=couli.task=<id>` 为空，有就 `docker rm -f`）；worktree 在之后 1 分钟内不再有文件变化。确认之前不重派、不跑守卫、不在这个 worktree 上起新的实现。
6. **结束后核对**（位置断言，规划/11 §2.4）：起之前记下 `git -C <wt> rev-parse HEAD`、`git -C <wt> for-each-ref refs/heads`、`git -C <wt> diff --cached --name-only`；结束后三者都要不变（暂存区为空），变了按越界处理：这个 worktree 里的东西一律不运行、不提交，先人工看。
7. **守卫与记录**：从可信副本跑 `path-guard.ts --task <id> --base <spec_commit> --cwd <wt> --json` 与 `protected-paths.ts --base <spec_commit> --cwd <wt> --json`（先守卫、后执行）；再把这一轮结算：`state.ts opus-run <id> --run-id <运行编号> --outcome ok|no-output|timeout|capacity --risk <RV>`。没有结果（无产出、超时、容量或额度错误）的一轮把第 2 步计上的 `attempts.impl` 还回去（和 Codex 无产出一样，按运行编号去重，重复结算不多还，CR-07），同时计入 Opus 失败；连续 3 次或累计 5 次时输出 `next: handover`（RV0 / RV1：`dispatch.sh <id> --handover`）或 `next: blocked`（RV2：标 blocked，不换家）（RO2-03）。有结果的进完整验证：PR 头提交上的必过 CI 检查（`ops/approvals.yaml` 第 21 条）；本机 `verify-container.sh <id>`（完整 `pnpm verify`）可选，作自查或写进证据（写了须在头提交树上通过）。

`verify-container.sh` 的 `--fast` 是为这一步加的（`tools/ops/README.md`）：只跑 `pnpm run verify:fast`，不起 PostgreSQL、容器 `--network none`，结果放 `verify-fast/<n>/`，与决定任务成败的 `verify/<n>/` 分开。

## 11. 规则测试过审（spec-test）交 Claude 新子代理

Codex 写的规则测试由另一家过审（规划/11 §2.3 第 4 步，RV2 必做）：

1. `codex-run.sh review --review-type spec-test` 只接受可信台账写明 `tester: claude` 的旧任务；`tester: codex`、`none`、台账读不到都拒绝（退出 2，CR-08）。
2. 换家实现（`dispatch.sh --handover`）之后的代码评审也按本节的做法交 Claude 新子代理，提示词换成对应的 `review-general.md` / `review-money.md` / `review-contract.md`，产出写 `review-claude-<类型>.json`，计数用 `bump-attempt <id> review --review-type <类型>`（CR-09）。证据文件（`ops/evidence/<id>.json`）写 `handover: {implementer: "codex", commit: <换家实现提交>, note: <原因>}`，Claude 评审条目写 `commit`（它评审的提交：换家实现提交或其后）与 `checklist_complete`。编排者提交 Codex 换家产出时，提交标题带 `(handover, Codex)`；这个提交只改台账 `paths` 内的文件（至少一个）和本任务台账文件。evidence-check 只对台账 `paths` 低于 RV2、没改资金与归属实现路径、规则测试与本任务文件之外的改动也低于 RV2 的任务接受换家（RV2 不换家）；此时只要求绑定到换家提交之后的 Claude 评审都通过，评审之后只许改本任务证据与台账文件，换家前的 Codex 评审条目不再检查；细则见 `ops/evidence/README.md`。
3. 计数：`state.ts bump-attempt <id> review --review-type spec-test`（最多 2 轮，计数器不变）。
4. 起一个新的 Claude 子代理（不是本任务的实现子代理，也不是别的评审子代理），只读：提示词 = 可信副本的 `prompts/review-spec-test.md` + 一段上下文（任务编号、基线 = 分叉点、`spec_commit`、任务 refs、任务 paths、`git diff --name-only <基线> <spec_commit>`）+ `brief.ts <id> --phase review` 生成的任务书。它不运行测试（变异清单靠推演；要跑就由编排者在容器里跑）。
5. 产出按 `schemas/review.schema.json` 写到 `<runs>/<id>/review-claude-spec-test.json`，编排者校验：`node <可信副本>/tools/agent/validate-output.ts --schema <可信副本>/tools/agent/schemas/review.schema.json --file <产出> --refs <refs> --allowed-paths <paths> --rewrite --out-of-scope-log <runs>/<id>/out-of-scope.md --diff-base <基线> --cwd <wt>`。校验不过算一轮、没有结论；`verdict: fail`（范围内有 S0 / S1）就退回 Codex 改测试（`dispatch.sh <id>` 前先 `state.ts set --spec-commit none`，在途状态的 `last_error` 指向这份评审）。

## 12. 私有库（`rebate-private`）里的 Codex 写入

Agent 评测集与注入集放私有库（规划/11 §1.1）。读脚本的结论（没有真的调用 Codex）：

- `codex-run.sh impl <id> --worktree <目录>` 对 `<目录>` 只要求是一个 git 工作树的根、有 HEAD、它和它的 git 目录都不在 `/tmp`、`$TMPDIR` 下；不要求是 `rebate-platform`。所以 `--worktree /Users/zhixing/我的项目/rebate-private` 能跑，位置断言照常核对那个仓库的 HEAD、分支、暂存区。
- **不建议直接用私有库主检出**：Codex 的写范围是整个 `-C` 目录，会直接改私有库的工作区。做法是先给私有库建一个 worktree，再把它交给包装脚本，例如 `git -C /Users/zhixing/我的项目/rebate-private worktree add ../couli-runs/worktrees/<id>-private -b task/<id>`，然后 `tools/agent/codex-run.sh impl <id> --phase test --worktree <runs>/worktrees/<id>-private`（linked worktree 的 gitdir 在私有库 `.git` 里，不在沙箱可写根内）。
- 限制：任务书仍来自本仓库的台账（`<runs>/<id>/brief.md`），台账的 `repo` 只能是本仓库与三个原生仓库，`paths` 按本仓库的风险表算级；`dispatch.sh` 固定用 `<runs>/worktrees/<id>` 且要求有 `node_modules`，所以私有库的写入只能由编排者直接调 `codex-run.sh impl --worktree`；`post-run.sh` 的守卫按本仓库的保护路径清单看私有库的改动，结论只作参考，私有库的改动由编排者人工过目后提交。这些行为本次没有改。

## 13. 已知未验证与限制

- 规划/11 §9.3「仍未测的要点」里 Codex 那一条全部仍未测：两条命令全部参数写在一起的首跑、真实回合中途的进程组击杀、其他模型 id、如何避免往 `~/.codex/config.toml` 写信任记录（每个 worktree 路径会被写一条，负责人已选 A：不动全局配置）、Linux 上的沙箱。
- 事件名（`thread.started`、`turn.completed`、`turn.failed`、`error`）与容量错误出现在哪个事件里，是按验证日的记录写的，假 `codex` 也照这个造；真实事件流首跑时要核对一次。
- 活性看事件文件的修改时间和进程 CPU（见 §3 第 4 条），没有看 rollout 文件；CPU 的判定是启发式的（窗口内增长不到窗口的 5% 算静止），一条既不打事件又几乎不耗 CPU 的长命令（纯等待网络）仍会被当成无活动。
- 脱离进程组的后代靠两条线索找回：进程表里的父子关系（每秒扫一次，被 init 收养前）和继承的文件描述符（收尾时）。主动关掉所有描述符再 `setsid` 的进程两条都躲得过，只能靠守卫和容器验证兜底。
- 位置断言对分支列表的放宽只限「别的任务的分支」（见 §3 第 3 条），这是相对规划/11 §2.4 原文「分支列表未变」的一处偏离：照原文做，几个任务并行时编排者一建分支，在跑的任务就会被判 12。本地 `main` 移动、出现非 `task/` 开头的新分支、本任务分支被动过，仍然判 12。所以 Codex 运行期间编排者不要移动本地 `main`（新任务分支从 `origin/main` 建），也不要在这个仓库里 `git stash`。
- 资金清单的「引用行在 diff 里」按 `git diff -U3 <基线>` 的块范围判断（含上下文行）；新文件整份算在内。
- 评审产出里发现的 `key` 被校验成固定格式 `<文件>#<函数或符号>#<规则编号>`（不含空白，开头与 `file` 字段相同）：文件部分到第一个 `#` 为止，函数或符号部分不含 `#`，规则编号部分可以含 `#`（AC 编号如 `AC-F1-02r#18`，D10-234），但首尾不能是 `#`。格式不对整份评审按无产出处理（退出 10），会多耗一轮评审；首次真实评审后看模型是否稳定按这个格式写，不稳就放宽 `validate-output.ts` 里的 `KEY_PATTERN`。
- 本目录的测试要用 `bash`、`perl`、`git`，并在 `REPO/.tmp/` 下建一次性 git 仓库（verify 镜像已装 git）。全部用例本机约 30–90 秒（看机器负载）；孤儿进程要靠 1 号进程回收，容器须带 `--init`（`verify-container.sh` 已带）。2026-10-02 已在 verify 镜像里按同样的加固参数（只读根、断网、`/work` tmpfs、离线装依赖、仓库根没有 `.git`）跑过本目录全部用例：66 条通过，约 25 秒（Linux bash 5.2、perl 5.36、git 2.39）。
- Codex 沙箱内（`pnpm verify:fast`）能否正常运行这些测试（进程组信号、`.tmp` 下的 `.git`）未测。
- 2026-10-05 的分工切换（`ops/approvals.yaml` 第 19 条）只改了派工、计数与守卫，还没有真实跑过一轮「Codex 写测试 → 先红 → Claude 过审 → Opus 实现」。§10、§11 的子代理步骤靠编排会话照做，没有脚本强制；位置断言与守卫是事后关口。
- 隔离红测（`verify-container.sh --red`）只跑项目表里的 Vitest 文件；`db/invariants/**` 的 SQL 不是测试文件，不在对账清单里。浏览器测试（`test/spec/**/*.browser.test.{ts,tsx}`，F1-01j）有入口：项目 `spec-browser`（Vitest 浏览器模式，验证镜像里的真 Chromium，断网；同一任务另有集成测试时，浏览器组仍在单独的断网容器里跑）；red-check 对红测报告里标了在浏览器里跑的浏览器测试文件，把 `expect.element` / `expect.poll` 等待超时的包装（vitest 5.0.1 给最后一个错误加的 cause「Matcher did not succeed in time.」）看穿到它包着的错误：断言失败、`expect.element` 的匹配器失败、等不到目标元素（`Cannot find element with locator`）算有效红，浏览器起不来、页面脚本出错、模块找不到、TypeError 仍然无效。`expect.element` 等元素超时也可能以「expect.poll() function didn't resolve in time.」结束，这和任何挂住的 `expect.poll` 长得一样，只有等待从测试文件本身发起、且该文件的代码里不用 `poll` 时才算有效红（红测报告器记录调用位置——栈里依赖与 Vite 预构建模块之外的第一帧，去掉 `http://localhost:<端口>` 前缀与查询串——与 `poll_in_source`——只看代码，注释、字符串与模板文字里的 poll 不算）。所以**浏览器规则测试等元素一律用 `expect.element`，写在测试文件里，不用 `expect.poll`，也不把等待放进辅助模块**。候选副本上的真实红测（2026-10-06，F1-01j red/1、red/2）已演示：等不到元素 + 普通断言失败判有效，TypeError 判无效。`pnpm verify` 与 CI 的 `verify-int` 都跑 `test:browser`，所以浏览器测试走正常的 `verify` 证据；`mode: ci` 记录仍一律拒绝（CR2-06）。`verify-container.sh --browser` 只跑浏览器测试并导出截图，与 `--fast` 一样不进证据。
- 构建产物冒烟（`test/spec/**/*.smoke.test.ts`，F1-01k）：项目 `build-smoke`（`test/vitest.build-smoke.config.ts`，Node 环境，`test:smoke`）。globalSetup（`tools/ops/build-smoke/global-setup.ts`）在临时目录里构建 H5 三入口（`APP_ENV=test`）与后台，每个入口在 `127.0.0.1` 的 0 号端口起只读静态服务，`GET /` 不回 200 就抛错；测试只经 `inject('buildSmoke')` 拿地址与产物目录，用 `playwright` 库启动镜像里的 Chromium。判红：只有断言失败（AssertionError）与 `locator.waitFor` 的 TimeoutError（「locator.waitFor: Timeout <n>ms exceeded.」，且只在红测报告器带 cause、文件在 `test/spec/` 下且在 Node 里跑时）算有效红；globalSetup 失败（构建、服务、健康检查：一条测试都没跑）、浏览器起不来、`page.goto` 失败或超时、`net::ERR_*`、其他 Playwright 超时（截图、点击…）一律无效。页面渲染时抛错不会让测试本身失败（Playwright 只发 `pageerror`，页面白屏后等元素超时），所以测试把页面事件写进诊断附件（annotation「<入口> 浏览器诊断（不作为断言）」，JSON `{entry, url, diagnostics}`，不写成断言），红测报告器把每条测试的 annotation 连同解析后的 JSON 导出（`assertionResults[].annotations[].json`）；red-check 在认可断言或等元素超时之前先看诊断：有 `pageerror`（骨架的 NotImplemented 除外：只认错误首行以 `NotImplemented` 或 `Error: NotImplemented` 开头，TypeError、ReferenceError 等类型先判，与 Node 侧一致）、与入口同源且不是测试自己拦下的 `requestfailed`、动态 import 失败的 console.error，或报脚本故障的 console.error，就判无效。后者是 Codex money r3 的 S1 ②：React Router 的 errorElement 接住渲染错误后只写 console.error「React Router caught the following error during render <错误栈>」（`<Await>` 同样），不发 `pageerror`，页面显示错误界面、等元素超时；所以 console.error 含「caught the following error during render」，或含 TypeError、ReferenceError、SyntaxError、RangeError、EvalError、URIError 等错误类型，都判无效，只有错误本身首行（去掉 React Router 前缀后）以 `NotImplemented` 或 `Error: NotImplemented` 开头的骨架错误除外（编排者裁定：骨架 NotImplemented 导致的等元素超时仍算有效红）。**打开页面的冒烟规则测试必须写诊断附件**：`locator.waitFor` 超时而该用例没有诊断附件时从严判无效（页面是否抛错无从得知），在 `notes` 里写明；不打开页面、没有诊断附件的用例（如体积预算）按失败本身判断，也在 `notes` 里写明。正常（应当全绿）的运行由 build-smoke 项目自己的严格报告器（`tools/ops/build-smoke/strict-reporter.mjs`，配置里与 default 一起启用，只此一个项目用）把关：任何诊断附件里出现 `pageerror`（这里骨架的 NotImplemented 也不例外）、同源且不是测试自己拦下的 `requestfailed`、懒加载失败、报脚本故障的 console.error（同上，这里 NotImplemented 也不例外），或诊断附件读不出 `diagnostics` 列表，就把退出码置 1，并在 stderr 列出用例、入口与消息——测试本身全过也一样失败。命令行给了 `--reporter` 会替换配置里的报告器：隔离红测用红测报告器（由 red-check 判），`verify-container.sh --browser` 对 build-smoke 额外带上严格报告器。`pnpm verify` 在 `test:browser` 之后跑 `test:smoke`，CI 的 `verify-int` 同样跑；`verify:fast` 不跑。`verify-container.sh --browser` 在浏览器测试之后接着跑构建冒烟，四张截图导出到同一 `out/screenshots/`。
- **页面吞掉的错误（F1-01m，补 F1-01k 的已知盲区；负责人 2026-10-07 blocked B-11 选 A）**：页面自己吞掉、既不写 console.error 也不触发 `pageerror` 的错误——例如懒加载分块返回 200 但模块初始化抛 TypeError，React Router 接住 `import()` 的拒绝直接显示重试页——原先诊断为空，等元素超时会被当成有效红。现在冒烟规则测试在 `page.goto` 前用 `page.addInitScript` 装采集器，监听 `vite:preloadError`（Vite 预加载辅助在懒加载分块或其依赖加载失败、初始化抛错时派发，`payload` 是被拒绝的错误；不调用 `preventDefault`，不改变页面行为）与 `unhandledrejection`，存在页面的 `window.__couliSmokeDiag`；结束时（截图之前）读回并检查路由错误页（H5 `RetryPage`：`role="alert"` 内 h1 为 `h5.load_failed`「页面加载失败，请重试」，`apps/h5/src/components/retry/retry-page.tsx`，由 `apps/h5/src/entries/app/routes.ts` 的 errorElement 显示），追加到诊断附件：`preload-error`、`unhandled-rejection`（消息为 `String(错误)` 加其余栈行）、`route-error`（标题与路径）；页面读不回（关闭、5 秒内无响应、采集器没装上）记 `diagnostics-incomplete`。red-check：`preload-error`、`unhandled-rejection` 判无效（首行是骨架 NotImplemented 的除外，口径同 `pageerror`）；`route-error` 判无效，除非同一附件里有骨架 NotImplemented（`pageerror`、`preload-error`、`unhandled-rejection` 首行，或 React Router「caught the following error during render」后的错误首行）解释它；`diagnostics-incomplete` 一律判无效（页面事件不完整）。严格报告器对这四种一律判绿跑失败，NotImplemented 也不例外。仍看不到的：不经 Vite 预加载辅助、也不显示 `RetryPage` 的吞错（例如组件内部 try/catch 后只渲染空白），以及后台入口（目前没有路由 errorElement）。
- 骨架检查（`tools/guard/lib/skeleton.ts`，CR-05、CR2-01）用 Node 自带的 `stripTypeScriptTypes`（实验特性）把 TypeScript 转成 JavaScript 后逐条看新增或改动的顶层语句：只许 import、export 列表与转出、类型、函数声明（函数体只有 `void <参数>;` 与最后的 NotImplemented 抛出）和只含这类方法、无初始值字段的类；其余可执行语句（含 `export const x = f()`、`= Math.floor`、字面量常量）一律拒绝。旧代码豁免绑定符号名与完整声明文本，同样的函数体换个名字不算旧代码。TSX 与装饰器转换不了，按「不是骨架」处理。
- 台账 `test_paths`：只有 `tools/guard/legacy-tasks.json` 列出的、合并分工切换时 origin/main（`85f4f53`，#97 合入前最后一个主干提交）上已有的 82 个台账可以没有（提交守卫对它们沿用全部第一类路径）；之后的新任务只要有测试作者就必须写，`task.ts check` 与提交守卫都拒绝缺字段（CR2-02）。
- 隔离红测用可信的 Vitest reporter（`tools/ops/verify-image/red-reporter.mjs`，只读挂进容器）保留失败的 cause 链：fast-check 把属性里抛出的错误只放在 `cause` 里，Vitest 自带的 JSON reporter 会丢掉它；另导出每条测试的 annotation（JSON 附件解析后放 `json`，构建冒烟的诊断靠它）。red-check 以最内层 cause 判定：`AssertionError` 或骨架的 `NotImplemented` 才算有效红；属性只「返回 false」不算（属性的先红必须在属性里用 `expect` 断言，失败报告才显示底层断言）；看不出原因一律不算（CR2-03）。
- 每个应跑的文件由可信项目表 `tools/ops/verify-image/red-projects.json`（与 `test/`、`packages/testing/` 的 Vitest 配置逐条核对，见 `tools/ops/red-plan.test.ts`）分到 `spec-unit`、`spec-int`（含 `acceptance/**`，起一次性 PG）、`spec-browser`（`spec/**/*.browser.test.{ts,tsx}`，真 Chromium；只有 `test/` 的单元配置排除这些文件，其他包里的浏览器测试会被单元层拾起并失败，不会静默不跑）、`build-smoke`（`spec/**/*.smoke.test.ts`，构建产物 + 真 Chromium，同样只有 `test/` 的单元配置排除）或 `testing-unit`；没有项目收的文件（如 `test/replay/**`）让红测直接失败（CR2-04）。

## 14. Codex 不可用时：独立 Claude 子代理写测试与对抗评审（`claude-run.sh`）

负责人 2026-10-21（`ops/approvals.yaml` 第 36 条，编排裁定 D10-104）：「对抗review 可以使用Claude 的子代理 没有上下文的去对抗review」，写规则测试也允许——**Codex 不可用或额度不足时**，写测试与对抗评审（money / general / contract / spec-test）交给无上下文的独立 Claude；**Codex 能用时仍优先 Codex**；证据如实记为独立 Claude，不得记成 `codex`。

**什么时候用**：codex-run.sh 退出 11（用量上限、容量）或 Codex 账号 / 模型不可用（如 400 `model is not supported`），且编排没有说「等 Codex 恢复」。脚本不判断 Codex 是否可用，这一条靠编排与各线遵守；`claude-run.sh` 的运行在 `meta.json` 里一律是 `engine: "claude-independent"`，事后可查。

**命令**（与 §2 相同，只是脚本名不同）：

```bash
tools/agent/claude-run.sh impl <id> [--phase test] [--worktree <dir>] [--timeout-min <n>] [--dry-run]
tools/agent/claude-run.sh review <id> [--worktree <dir>] [--review-type money|general|contract|spec-test] [--base <ref>] [--timeout-min <n>] [--dry-run]
tools/agent/claude-run.sh selfcheck      # 只读 claude --help，不发起任何 Claude 回合
```

**和 codex-run.sh 一样的**：参数不透传；硬超时与无活动阈值（实现 30 / 5 分钟、评审 15 / 12 分钟，只能调小）；退出码 0 / 10 / 11 / 12 / 124 / 2（用量上限、`rate_limit_event` 被拒、HTTP 429 / 529 都是 11，不计轮次）；提示词、schema、`validate-output.ts` 从可信根读；运行目录 `<runs>/<id>/`、`attempts/<n>/` 归档、位置断言、`state.ts settle`；评审类型跟风险级（RV2 默认 money）。

**不一样的**：

- 每次都是全新上下文：`claude -p --model claude-opus-5-5 --effort high --output-format stream-json --verbose --include-partial-messages --no-session-persistence --safe-mode --restricted --disable-slash-commands --strict-mcp-config --permission-mode dontAsk`，从不带 `--resume` / `--continue`；不读用户、项目、插件配置与 CLAUDE.md，没有 MCP 与技能，不能起子代理。结构化产出用 `--json-schema`（可信根 schema 原文），取 `result` 事件的 `structured_output`；成功的判定是最后一个 `result` 事件为 `success` 且非错误（`last_event: result.success`）。
- **没有 shell**（#1046 r1 S0 / S1）：两种模式都不放 Bash——前缀规则拦不住 `git log --output=<任意文件>` 这类写入，`pnpm exec eslint -c x.mjs` 会在宿主执行生成的代码。模型要的 git 信息由包装脚本在调用前写进 `<runs>/<id>/wrapper-<mode>/context/`（`git-status.txt`、`git-log.txt`、`git-diff.patch`、`untracked.txt`，以及 `spec/`：规划仓库在 worktree 的 `SPEC_REF` 上的 `规划/` 与 `docs/`），以 `--add-dir` 只读给它，提示词末尾写明位置；`--restricted` 把文件工具限在 worktree 与这个目录里。静态检查与测试由编排者在隔离容器里跑。
- **评审只读**：工具只有 Read、Grep、Glob，没有任何写入工具；Claude 没有操作系统级只读沙箱，所以结束后另核对工作区内容不变（`git diff HEAD` 全文 + 每个未跟踪文件的内容哈希；已修改文件被再次改写也算），变了退出 12、产出作废；被忽略的路径不在核对范围内（模型也没有能写它们的工具）。产出文件是 `review-claude-independent.json`（不是 `review-codex.json`）。spec-test 评审只要可信台账写明了作者（`codex` / `claude` / `claude-independent`）都接受，读不到作者拒绝；反过来 `codex-run.sh` 的 spec-test 评审会扫描运行目录里每次写测试调用的 `meta.json`，只要有一次是 Codex 写的（`engine: codex` 或没有 `engine`），就拒绝 Codex 评审（第 19 条：Codex 不评审自己写的测试；台账写的作者可能已改成 claude-independent，轮次又是跨引擎共用的）；换家后的代码评审也可以由它做（不是 Codex 评审自己）。
- **写测试只限本任务**：只有 `--phase test`（`handover` / `impl` 拒绝：实现仍归 Opus 子代理，换家仍归 Codex）；先开台账 PR 把 `tester` 改为 `claude-independent`（可信台账不是这个值就拒绝，退出 2），台账要有 `test_paths`。可编辑范围 = 台账 `test_paths` + `paths`（骨架），大括号展开成 `Edit(/<glob>)` 规则，其余写入自动拒绝；不能执行任何命令（类型检查、lint 与先红都由编排者在容器里跑）。结果照常过 `path-guard.ts` / `protected-paths.ts`、隔离红测。写测试的上下文与写实现的 Opus 子代理不是同一个，规则测试过审（spec-test）再起另一个独立 Claude 或由编排侧 Claude 子代理做（§11）。
- **账号**：`CLAUDE_INDEPENDENT_CONFIG_DIR=<某账号的 Claude 配置目录>`（绝对路径、已存在、不在仓库 / 可信副本 / 运行目录下）作为子进程的 `CLAUDE_CONFIG_DIR`；不设就沿用当前环境。脚本只用目录名，不读其中任何文件；调用方环境里的 `ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_BASE_URL`、`CLAUDE_CODE_OAUTH_TOKEN` 不传给子进程（不会误走按量计费的 API key）。
- **交回的测试文件由包装脚本格式化**（编排裁定 D10-292）：独立 Claude 没有 shell，跑不了 prettier，交回的测试常让 `verify:fast` 的 `format:check` 红，以前每次要编排按 D10-206 人工核「纯格式修正」。现在 `--phase test` 的调用在产出通过可信校验、位置断言没有发现变化之后、判定结果之前，取本次调用新增或改动（调用前后各记一份「与 HEAD 不同或未跟踪的文件及其内容哈希」，比出新出现或内容变了的）、落在台账 `test_paths` 内、后缀为 `.ts` / `.tsx` / `.js` / `.mjs` / `.cjs` 的文件，交给可信根的 `tools/agent/format-tests.ts`：先存原文，再用可信根 `node_modules/.bin/eslint` 与 `eslint.config.js` 跑 `--fix --fix-type layout`（只做排版修正，剩下的规则问题不算失败），再用可信根 `prettier` 与 `.prettierrc.json` 跑 `--write`，最后把前后两版各做规范化后逐字比较（字符串、模板文本、正则、注释之外去掉全部空白与分号、逗号、圆括号，引号统一，带引号的对象键按裸键比，类型联合开头的 `|` 去掉，数字按 prettier 的写法归一）。摘要写进本次 `meta.json` 的 `test_format`（每个文件的 `path`、`changed`、前后行数与增删行数、`format_only`，另有总体 `ok`、跳过的文件与原因）；没有要格式化的文件时 `ok: true`、`files: []`，产出没通过校验或位置断言失败时是 `null`。任何文件的改动不只是格式（或 eslint / prettier 本身出错）：全部文件恢复成模型交回的原文，这次调用按「无可用产出」处理（退出 10、`validation: "failed"`，原因写进 `validation_messages`，`impl.json` 改名为 `impl.json.rejected`）。格式化发生在位置断言的第二次快照之后，impl 模式的快照本来不含工作区内容，也不暂存任何文件，所以不算模型的改动；`path-guard`（`post-run.sh`）随后看的是格式化后的工作区，格式化只碰本次已改的 `test_paths` 内文件，不会造成越界。规范化比较只是安全网（只差括号、逗号或分号、或只差记号间空白的两段代码会被看成相同，判定的局限写在 `format-tests.ts` 文件头）；真正依靠的是只跑 layout 修正与 prettier。骨架（台账 `paths`）不在格式化范围内。Codex 引擎与评审模式不受影响。
- `meta.json` 与 codex 相同的字段，另有 `engine: "claude-independent"`、`agent_exit`、`agent_version`、`config_dir`，没有 `codex_exit` / `codex_version`。Codex 的 token 账本（`usage.ts`）不记 Claude 调用。
- **Codex 路径登记的变化**（#1046 r1 S2）：Codex 的命令行与工作目录不变（只有 claude 分支在 worktree 里启动，有测试断言 Codex 的 cwd 与 argv）；`meta.json` 多一个 `engine: "codex"`；评审调用前归档时连 `review-claude-independent.json` 一起归档；退出 11 的日志文案多了「or a usage limit」；spec-test 评审多一道「Codex 写过本任务测试就拒绝」；每次调用前多查一次本引擎的失败熔断（`state.ts breakers <id> --engine codex`，退出 3 就拒绝，退出 2）。

**计数**（`tools/ops/state.ts`）：轮次是任务的，不分引擎——写测试 3 次、规则测试评审 2 轮、代码评审 3 轮，Codex 与独立 Claude 合计；派发前照旧 `state.ts bump-attempt <id> test|review … --engine claude-independent`。失败熔断（每任务 10 次调用、连续 3 次无产出）按引擎分开算：Codex 撞用量上限或连败不挡独立 Claude，反过来也一样。`--engine` 是调用方自报的，所以两个包装脚本启动前还会用自己的引擎再查一次（`state.ts breakers <id> --engine <AGENT_ENGINE>`），用 `--engine claude-independent` 计轮次再去跑 codex-run.sh 绕不过 Codex 的熔断。`post-run.sh <id>` 可照常用于写测试那次运行（它读 `meta.impl.json` 与 `impl.json`）。

**证据怎么记**（`ops/evidence/<id>.json`，`tools/ci/evidence-check.ts`）：

- 每条评审条目（`reviews[]`，以及有 red_exempt 或改名命中时的 `spec_test_review`）都必须写 `engine`，且等于 `reviewer`；`codex` 条目另写 `"model": "gpt-6-astra"`，`claude-independent` 条目写 `"model": "claude-opus-5-5"`（#1046 r1 S2：引擎与模型绑定，取自 `meta.json` 的 `model`）。**在途 PR 的旧证据要补这两个字段**，否则 evidence-check 红。
- 独立 Claude 的评审条目写 `"reviewer": "claude-independent", "engine": "claude-independent", "model": "claude-opus-5-5"`，其余字段与 Codex 条目相同：`verdict: "pass"`、`open_s0_s1: 0`、`checklist_complete: true`（资金清单必填）。它顶替缺的那一家：Opus 实现时顶替 `codex` 条目，Codex 实现时顶替 `claude` 条目；台账读不到时两家都要，其中只能有一家是顶替。换家时，绑定换家提交的独立 Claude 条目（写 `commit`）算作 Claude 评审。
- 把独立 Claude 的产出写成 `reviewer: "codex"` 会被拒收：`engine` 不符，或 `model` 不是 `gpt-6-astra`；不写 `engine` 也拒收。
- `spec_test_review.renames_confirmed`（改名确认，CT-06zxc）：台账 `renames` 有一对命中本任务应判候选文件的基线、或有文件因此被剔出应跑清单时必填，形状 `{ "pairs": [{ "from": …, "to": … }, …], "left_out": [文件, …] }`，`pairs` 恰为命中的改名对（按台账顺序）、`left_out` 恰为被剔出的文件，写 `true` 或多一项少一项都拒收；评审方、`engine`、`last_verdict: pass` 的要求同下一条。规则测试评审须自己逐对核对（在 base 与 spec_commit 之间看每处命中确是纯改名、被剔出的文件替换后逐字相同）后才写这一字段；**不得照 evidence-check 报错信息里打印的值照抄**——那只说明门禁算出了什么，不是核对过的结论。
- `spec_test_review.expected_values_confirmed`（期望值登记确认，CT-06zxe，D10-371）：台账 `expected_values` 有一条在本任务应判文件的基线（先按 `renames` 替换后）上生效（顶层 helper 存在且唯一、`from` 在 helper 内恰好出现一次、替换后 helper 的值骨架不变）时必填，形状 `{ "entries": [{ "file": …, "helper": …, "from": …, "to": … }, …] }`，`entries` 恰为生效的登记（按台账顺序），写 `true` 或多一项少一项、多出别的键都拒收；评审方、`engine`、`last_verdict: pass` 的要求同下一条。规则测试评审须在 base 与 spec_commit 之间逐条核对：改动只是期望值本身（没删断言、没改断言以外的逻辑、没借字面量让断言变空）、新值有 refs 里的 BR 依据；逐条核**改后值不让断言恒真**——比较 / 长度 / 匹配类匹配器的期望实参改成 `toBeGreaterThanOrEqual(0)`、`toHaveLength(0)`、`toMatch('')`、`toBeLessThan(<极大值>)`、`toBeGreaterThan(<极小值>)` 这类写法一律不得确认（机制只能保证改动落在断言里：expect 链末端匹配器（`expect(…)` / `expect.soft(…)` / `expect.poll(…)` 经 `.not` / `.resolves` / `.rejects` 到 `.toXxx(`）的期望实参上，或这类匹配器 / `expect.objectContaining(` 等实参里对象字面量（键前是 `{` 或 `,`）的属性值上；不在 `.where(` / `sql(` 等查询调用里、不在夹具输入或查询对象（非 expect 调用的实参、变量里的对象、返回的对象）里、不是三元分支或类型注解、不是 `toString(` / `toFixed(` 这类非匹配器、不改带标签模板（CT-06zxh，评审 r2 S2-2）；判断不了新值是否让断言变空，评审 r1 S2-1）——且改的不是查询参数、运算符或 SQL，并对照 red-check `notes` 核对受影响用例（直接或经顶层 helper 间接调用被改 helper 的 it 块；基线里被改 helper 之外有字符串、模板或正则字面量整词提到被改 helper 或其调用闭包里的名字时，red-check 改整文件判，CT-06zxh）确实都在旧实现上有效红；同样**不得照 evidence-check 报错信息照抄**。同一份「不得确认」清单写在规则测试评审的提示词 `tools/agent/prompts/review-spec-test.md`（Part 4）里，两处口径一致。
- `spec_test_review`（红测豁免与改名的确认）：台账 `tester: codex` → `claude` 或 `claude-independent`；`tester: claude` → `codex` 或 `claude-independent`；`tester: claude-independent` → `claude` 或另一次 `claude-independent`；写了 `engine` 同样要与 `reviewer` 一致。

示例（Opus 实现、Codex 用不了时的资金评审）：

```json
"reviews": [
  { "reviewer": "claude-independent", "engine": "claude-independent", "model": "claude-opus-5-5", "review_type": "money", "verdict": "pass", "open_s0_s1": 0, "checklist_complete": true, "run": "couli-runs/<id>/attempts/<n>/meta.json" }
]
```

