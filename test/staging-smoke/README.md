# staging 冒烟（QA-04）

直连 staging 的接口层冒烟脚本，只在测试机手动或定时运行；不进 `pnpm verify`、不在 CI 跑，也不连生产。

## 节点文件（只在测试机，`~/.couli-staging-smoke/`，目录 0700、文件 0600）

| 文件 | 谁写 | 内容 |
| --- | --- | --- |
| `target.json` | 人工写一次 | `{ "env": "staging", "admin_base_url": "https://…", "api_base_url": "https://…" }`，不含凭据 |
| `admin.json` | 只由 `enroll-admin.ts` 写 | 冒烟后台账号的登录名、密码、身份验证器种子 |
| `member.json` | 人工写一次 | 专用测试会员的测试号副本与可选夹具，见下文 |
| `device.json` | 只由 `smoke.ts` 写 | 测试会员的设备（`device_id`、`install_secret`），跨天复用；回 10402 时自动重新注册一次并覆盖 |

两个地址都必须是 https 的裸 origin（不带路径、查询），主机名里要有 `staging` 这一段（如 `admin.staging.example.com`、`api-staging.example.com`）；`env` 不是 `staging` 时拒跑。仓库里不写任何地址或凭据。

## 一次性登记后台账号：`enroll-admin.ts`

前提：负责人已在 staging 后台建好 `smoke-staging` 账号（只给提现审批与打款执行所需的最小权限），测试机出口 IP 已在 staging 的后台 IP 白名单里。

```sh
node test/staging-smoke/enroll-admin.ts
```

按提示粘贴初始密码（不回显）。脚本自己完成：首次登录 → 改成随机新密码 → 取身份验证器种子 → 算码绑定 → 写 `admin.json` → 用新的时间步重登一次并登出，确认存下的值能用。最终密码和种子谁都不知道。

- 输出只有步骤名、HTTP 状态和业务码，不打印密码、票据、令牌、种子或动态码。
- 动态码错一次即停，不自动重试（连错 5 次会锁 30 分钟）。
- 中途断开：再运行一次会接着做（绑定其实已成功、只是回包丢了的，也会用存下的值核一遍后补记为已绑定）。只有续跑登录回 10008（密码不对），才说明上次改密没成功，这时删掉 `admin.json` 用初始密码重跑；回 10009（已锁定）等锁定结束后原样再跑；超时、断网等其他失败也不要删 `admin.json`，稍后原样再跑，一直不行再找负责人重置账号。
- 登录返回 10403：测试机出口 IP 不在白名单（或前面的反代没配进 TRUSTED_PROXIES）。
- `admin.json` 丢了：负责人在后台重置该账号的初始密码与身份验证器后重跑。

## 每日冒烟：`smoke.ts`

```sh
node test/staging-smoke/smoke.ts --out ../couli-runs/STAGING-SMOKE/runs/$(date +%F)
```

- 结果：`<out>/summary.md`（汇总表 + 每步耗时、HTTP 状态、业务码、trace_id）与 `<out>/summary.json`。只有 FAIL / YELLOW 的步骤留响应原文，且先按字段名脱敏（令牌、票据、密码、手机号、收款账号等一律 `***`），再把本次用到的每个秘密值（手机号、验证码、密码、动态码、令牌、install_secret、签名）出现处替换成 `***`。
- 每条用例给 PASS / FAIL / YELLOW / SKIP。退出码：有 FAIL 为 1；拒跑（节点文件缺失、`env` 不是 staging、主机名不带 staging、文件权限不是 0600、参数不对）为 2，拒跑时一个请求都不发；其余为 0。
- 整次约 6–12 分钟：短信发送之间至少隔 61 秒，后台每次用动态码都等新的 30 秒时间步，打款结果最多轮询 6 分钟。
- `--node-dir <目录>` 只用于自测拒跑路径（把节点文件指到临时目录）；测试机上不要带。
- 红了（任一 FAIL）由跑的人在 notices 写一行「**staging 冒烟红**：哪一步、原文」；YELLOW 是环境问题（余额、IP、种子数据），不算红。

### `member.json`（0600，人工写一次）

```json
{
  "phone": "<STAGING_TEST_PHONES 里的一个号>",
  "sms_code": "<节点固定验证码>",
  "payout_account": { "payout_method": "alipay", "alipay_logon_id": "<当前已绑的支付宝>", "payee_name": "<实名>" },
  "parse_text": "<一条能换出返利卡的商品链接或分享文本>",
  "search_platform": "taobao",
  "search_q": "抽纸",
  "app_id": "couli",
  "app_version": "x.y.z"
}
```

只有 `phone`、`sms_code` 必填。`payout_account` 必须是**测试会员当前已绑定的那个支付宝**（用例 6 只「原样再存一次」，见下文）；不填则用例 6 只读不改。不填 `parse_text` 则用例 3 记 SKIP。`app_version` 不填时取 `GET /v1/app-versions/check` 的 `latest_version`。

### 测试会员的一次性准备（编排 / 负责人做，冒烟不代做）

专用测试会员：已实名、已签当前劳务协议（BR-WDR-31）、已绑一个支付宝收款账号、有 staging 种子订单；余额按 D10-2119 ② 由负责人后台调账补足。冒烟不建、不改这些前置，缺了就报 YELLOW 或 FAIL 并写明原因。

### 用例

| # | 做什么 | 核什么 |
| --- | --- | --- |
| 1 | 复用或注册设备 → 版本检查定 X-App-Version → 取配置里的协议版本 → 发登录验证码（测试号不发真短信）→ 短信登录 → 刷新令牌 | 各响应契约形状；session_scope=full；刷新后两个令牌都轮换，新令牌能用 |
| 2 | 配置、首页 `/v1/pages/home`、商品搜索（真实联盟，1 次） | 契约形状；ETag 等于 `config_version`，带 If-None-Match 回 304；搜索结果平台一致 |
| 3 | 粘贴 `parse_text` 查返利（真实联盟，每次只调 1 次） | 结果 1–3 条、每条是商品卡或错误码；全是错误码报 YELLOW |
| 4 | 订单列表（scope=self）与第一条的详情 | 契约形状；详情与列表的 order_id、展示状态一致；没有订单报 YELLOW |
| 5 | 钱包汇总、流水、提现规则、提现记录 | 契约形状；规则的 `withdrawable_fen` 与汇总一致 |
| 6 | 读收款账号 → 短信二次验证（action=payout_account_change，摘要是该支付宝）→ 原样再存 → 复读 | 存后脱敏账号不变、`change_remaining_this_month` 不变（没计成一次变更） |
| 7 | 前置（余额、次数、收款账号）→ 后台登录 → **驳回路径**：申请 ¥1 → 后台驳回 → **通过路径**：申请 ¥1 → 后台审批 → 执行打款批次（staging 假通道）→ 轮询结果 | 申请后可用 −¥1、冻结 +¥1、有 WITHDRAW_FREEZE；驳回后状态 REJECTED、余额回到申请前、有 WITHDRAW_RETURN、站内信多一条 WD_REJECTED；打款后 PAID_*、冻结释放、`withdrawn_fen` +¥1、有 WITHDRAW_PAID（−到账额）、记录里状态一致、站内信多一条 WD_SUCCESS |
| 8 | 上报 1 条 `app_launch` 事件 → 强更检查 → 以 0.0.0 版本调写接口 | `dropped_count`=0；强更检查契约形状；低于最低支持版本回 403 / 10405 且 `min_supported_version` 一致（staging 没设最低版本则记 SKIP） |
| 9 | 会员退出登录 | 旧 access_token 随后回 401 |

用例 1 登录失败时 3–9 记 SKIP。

### 规矩（编排裁定 D10-2112、D10-2119）

- 可提现余额低于 ¥10 → 用例 7 报 YELLOW，不动钱。
- 后台回 10403 且 `reason=admin_ip_not_allowed` → 用例 7 报 YELLOW「出口 IP 可能变了」，后台部分停止。后台登录排在创建提现单之前，所以后台不通时不会留下新的待审单。
- 动态码被拒（20002）或账号被锁（10009）→ 整个后台部分立刻停，不重试、不刷码。每次用码都等新的时间步。
- 金额只用整数分，¥ 显示用整数运算拼。

### 每日重复跑会撞到的业务规则与处理

| 规则 | 原文要点 | 处理 |
| --- | --- | --- |
| BR-WDR-04 每人每日提现次数（默认 1） | 「驳回和打款失败不占次数」 | 先走驳回、再走通过：驳回后当日次数回来，两笔都能在同一天跑。前置里今日或本月剩余次数为 0 就报 YELLOW |
| BR-WDR-04 每人每月提现次数（默认 10） | 计数为 created_at 在本月且不是 REJECTED / FAILED 的单 | 每天到账 1 笔，**按默认值每月第 11 天起用例 7 报 YELLOW（本月剩 0）**。要每天都跑满，需编排在 staging 把 `withdraw.monthly_count_per_user` 调成 0（不限）或 ≥31——这是配置决定，冒烟不改 |
| BR-WDR-04 最低额与步长（默认 ¥1、整元） | `amount_fen ≥ min_amount_fen`，`% amount_step_fen = 0` | 每笔固定 ¥1（100 分）；staging 若调高最低额，申请会回 30303 并在结果里写出 reason |
| BR-WDR-02 ④ 每月改收款账号次数（默认 2） | 「首次绑定、失败的请求、提交同一个账号都不计次」 | 用例 6 只原样再存当前账号，并核 `change_remaining_this_month` 不变；member.json 的账号若与已绑的不同会被计次，所以存后发现次数变了就判 FAIL |
| BR-WDR-02 ⑦ 收费核验每日 3 次 | 只针对银行卡三要素核验 | 只支持支付宝，不触发收费核验 |
| BR-ID-05 短信频率（每号 60 秒 1 条、每小时 5 条、每天 10 条，登录与二次验证合计） | 测试号照样计数（B1-02zza 只是不真发） | 每次跑 2–4 条（登录、改收款账号，提现若仍要二次验证再各 1 条），两条之间至少隔 61 秒；遇 42901 等 Retry-After 再试一次。**同一测试号若被第二阶段客户端冒烟同日共用，注意每小时 5 条的上限**，最好各用各的测试号 |
| BR-ID-08 提现二次验证 | 2026-11-14 起提现不要 step_up_token；契约仍标 `x-step-up: withdraw` | 提现先不带令牌；回 10003 才做短信二次验证（摘要 = 收款账号 id + 金额）并沿用原幂等键重放 |
| BR-WDR-30 自动到账（默认关；开了每人每月 1 笔） | 判 auto 的单由系统审批并打款 | 申请后若已不是 PENDING_REVIEW：驳回路径报 YELLOW；通过路径跳过人工审批与执行，直接轮询结果 |
| BR-FUND-16 分录只插入 | 提现单与流水不能删 | 「清理」只能是用专用测试会员：每次跑留下 1 笔驳回、1 笔到账；前置里发现以前中断留下的待审单会标 YELLOW 提醒人工驳回 |
