# 非资金开关切换演练

只由编排者在本地栈或 staging 上执行。需要 Node 24 和已安装的仓库依赖；本目录不安装依赖、
不启动栈、不读 `.env` 文件。

在仓库根目录、**交互终端**里运行（记录目录必须是仓库以外的绝对路径）：

```bash
APP_ENV=local DRILL_ADMIN_TOKEN=… DRILL_STEP_UP_TOKEN=… \
  DRILL_PROBE_BASE_URL=http://127.0.0.1:3100 DRILL_PROBE_APP_ID=… DRILL_PROBE_CLIENT_PLATFORM=ios \
  DRILL_PROBE_APP_VERSION=… DRILL_PROBE_DEVICE_ID=… DRILL_PROBE_INSTALL_SECRET=… \
  DRILL_PROBE_USER_TOKEN=… DRILL_PROBE_URL_JD=https://demo.invalid/jd/… \
  node infra/drills/switches/cli.ts --keys convert.enabled.jd \
  --base-url http://127.0.0.1:3102 --runs-dir /absolute/path/couli-runs
```

`--base-url` 填后台接口（`/admin/v1`）所在进程的根地址，`DRILL_PROBE_BASE_URL` 填用户端接口
（`/v1`）所在进程的根地址（只写协议、主机和端口）。`APP_ENV=staging` 时还要加 `--staging`，两个
地址都必须是 https，并且已登记在本目录的 `staging-origins.json`（经评审的改动才能增加，命令行和
环境变量都不能放行别的地址）。prod、其他 `APP_ENV`、非回环主机、带账号密码、路径、查询串或片段的
地址一律拒绝，不发任何请求。

凭据只从环境变量读（管理员令牌与预先取得的二次验证令牌也可用 `--bearer`、`--step-up-token`，但会
出现在进程列表里，不推荐），只放在请求头或签名密钥里，不进记录、不进输出：

- `DRILL_ADMIN_TOKEN`：管理员登录令牌，要有 `switch.all` 权限。
- `DRILL_STEP_UP_TOKEN`：预先取得的 totp 档二次验证令牌，只用于第一次写入。
- 二次验证令牌每次写入都会被服务端消耗，所以之后**每次写入（降级、恢复、恢复重试）各用一个新
  令牌**：脚本在终端提示输入身份验证器当前的 6 位动态码（不回显、不记录），用
  `adminStepUp`（POST `/admin/v1/auth/step-up`，`tier=totp`）换新令牌。写降级值之前就先换好恢复用
  的令牌，换不到就不写降级值。动态码输错（20002）最多再问两次；刚输过的码请等刷新后再输。
  标准输入不是终端时直接以 `step_up_unavailable` 退出。在提示处按 Ctrl-C 只放弃这一次令牌，
  需要它的那次写入不发（若是恢复写入，判 `restore_failed`，按记录手动恢复）。
- 探针用的演示账号：`DRILL_PROBE_APP_ID`、`DRILL_PROBE_CLIENT_PLATFORM`（ios / android / harmony /
  h5）、`DRILL_PROBE_APP_VERSION`、`DRILL_PROBE_DEVICE_ID` 与 `DRILL_PROBE_INSTALL_SECRET`（由
  `POST /v1/devices` 注册得到）、`DRILL_PROBE_USER_TOKEN`（该设备上演示用户登录后的访问令牌），以及
  每个演练平台一个可转链的演示商品链接 `DRILL_PROBE_URL_<平台大写>`（如 `DRILL_PROBE_URL_JD`）。

## 范围

只演练 规划/02 §14 降级表里、且在开关注册表（F1-10b）里登记为后台可改的非资金开关。每个开关用
什么探针、为什么有的不能演练，登记在 `drill.ts` 的清单里（`switchObservationOf`）：

| 开关 | 降级值 | 要看到的降级表现 | 实际运行用的探针 |
| --- | --- | --- | --- |
| `convert.enabled.<platform>` | 关 | 该平台转链返回 50301 | `convertLink`（POST `/v1/links/convert`，签名、登录、每次新幂等键）：开时 code 0 且有 `link_id`，关时 50301 且 `data.platform` 是该平台 |
| `agent.enabled` | 关 | 无模型降级：不调模型，照常出卡，给固定话术 | 本地不可观测：契约里没有任何接口返回「是否调用了模型」 |
| `jev.enabled` | 关 | 结果核对回到纯规则：不调 Jev，照常出卡并标「规格待确认」，文案语义预检跳过 | 本地不可观测：契约里没有任何接口返回「是否调用了 Jev」或语义预检是否跳过 |
| `parse.tpwd.enabled` | 关 | 返回 30132，引导用商品名搜索 | 本地不可观测：非生产环境只有演示联盟适配器，它不识别任何口令（真实口令解析等淘宝口令权限），开关开着 `parseInput` 也返回 30132，基线与降级分不开 |

清单里含「本地不可观测」的开关时，整次运行在预留记录和任何读写之前拒绝，标准错误输出
`{"ok":false,"code":"unobservable_switch","keys":[…]}`，退出 1；只列可观测的开关就照常演练。

`payout.*`、`pay.*`、`withdraw.*`（含 `withdraw.auto_payout.enabled`）只要出现在清单里，整批在
任何读写之前拒绝。`agent.model_route` 后台不可改，`sms.provider`、`agent.result_check.provider`
不是紧急开关，都拒绝，也不改走配置中心接口。§14 以外的已登记开关同样拒绝。空清单、重复项、
重复或未知参数都拒绝。

## 步骤

只用契约里的 `adminListKillSwitches`（GET `/admin/v1/kill-switches`，分页读齐）和
`adminUpdateKillSwitch`（PUT `/admin/v1/kill-switches/{key}`，带 `expected_version` 与
`X-Step-Up-Token`，不带幂等键），以及换二次验证令牌的 `adminStepUp`；不跟随重定向。

1. 先预留记录文件（同名拒绝覆盖，权限 0600），再读一次全部开关做整批预检：每个开关都必须存在、
   后台可改、布尔型、当前值为开。原值为关或从未写过（null）都不动，整批不写。
2. 每个开关依次：核对基线（10 秒内要拿到正常表现：code 0 且不是降级表现，报错如 50001 不算；
   记下这次观测）→ 用读到的版本写降级值 → 10 秒内探测到完整的降级表现 → 用当前版本写回原值 →
   再给 10 秒，探测结果要和记下的基线观测完全一样才算恢复（只是「不再是降级」不算，报错不算）。
   每个阶段的观测都要在 10 秒窗口内返回才算数：超出窗口才返回的结果，哪怕匹配也判超时。一个
   开关做完（含恢复）才开始下一个；第二个起重新读原值。任何一步失败就不再开始后面的开关。
3. 写降级值后不论成败都恢复：探针出错、响应丢失（重新读取当前版本再写回）、收到 SIGINT/SIGTERM
   都一样。中断只停止等待降级与后续开关，不中断恢复和恢复后的探测。恢复写回失败最多换新版本
   再试一次，仍不成功判 `restore_failed`。

## 结果与记录

退出码 0 表示所有开关都切换、看到降级、写回原值并看到恢复，且记录已落盘；否则 1。记录在
`<runs-dir>/drills/switches/switches-<UTC 时刻>.json`，只含 `ok`、`problems`（开关名与问题码）、
`restored`（确认已回到原值的开关）及开始/结束时刻，不含令牌、地址或上游报文。运行开始时先写一份
`incomplete` 记录；若进程被 SIGKILL 或宿主崩溃，留下的仍是这份记录，编排者须到后台核对记录里
列出的开关并手动恢复。

问题码：`interrupted`、`read_failed`、`missing_switch`、`readonly_switch`、`unexpected_value`、
`baseline_degraded`（基线已是降级表现）、`baseline_unhealthy`（基线不是正常表现，如报错）、
`probe_failed`、`write_failed`（含换不到二次验证令牌而没发的降级写入）、`degradation_timeout`、
`restore_failed`、`recovery_timeout`。运行前就拒绝时只输出一行错误码：`invalid_option`、
`unsafe_target`、`forbidden_switch`、`unregistered_switch`、`readonly_switch`、`out_of_scope`、
`unobservable_switch`、`probe_unavailable`（探针配置缺项或不合法）、`step_up_unavailable`（不在
交互终端）、`record_in_repo`。

## 尚未接通

`agent.enabled`、`jev.enabled`、`parse.tpwd.enabled` 的业务探针：要等契约里有能看出「是否调用了
模型 / Jev」的观测入口，或非生产环境能识别口令，才能把它们在清单里改成可观测并接上探针。

冻结规则测试位于 `test/spec/drills/switches/`，只在验证容器或 CI 中运行。
