# 收款通道上线检查清单（B2-15k）

> 依据：规划/08 BR-PAY-03、04、05、06、08、09；规划/09 CAP-X-16（V-43）、CAP-X-17（V-44）。
> 适配器按官方文档快照写成（`docs-mirror/wechat-pay/`、`docs-mirror/alipay/`），**下面每一项都未实测**。
> 打开 `pay.enabled` 与渠道开关的前提见 BR-PAY-09 细则；`success_states` 等清单的增改须附实测样例。
> 实测通过后在对应项写日期与留样位置，并把 `specs/*-pay-error-map.csv` 对应行的 `verified` 改为 `yes`。

## 1. 渠道能力（CAP-X-16 微信、CAP-X-17 支付宝，两个渠道各跑一遍）

- [ ] 下单：微信 `POST /v3/pay/transactions/app`（金额、`time_expire`、`notify_url`）；支付宝本地签 orderStr，提交前渠道侧没有这张单。
- [ ] 调起：调起参数字段与签名（微信 `Sign=WXPay`；支付宝 orderStr 的编码）能被官方 SDK 接受。
- [ ] 三端调起：iOS、安卓、鸿蒙的最低 SDK 与渠道 App 版本，未安装渠道 App 时的表现，取消与失败的返回值（BR-PAY-09 ④）。
- [ ] 通知验签与解密：微信四个头、公钥 ID、时间窗、AES-256-GCM；支付宝待验签串（含空值参数的拼法）、`seller_id` 是否总带上（缺了判 rejected，由查询定结果）。
- [ ] 通知应答与重试：应答格式、重试间隔、重试次数。
- [ ] 查单：状态含义（`specs/*-pay-error-map.csv`），微信 404 + `ORDER_NOT_EXIST`、支付宝 40004 + `ACQ.TRADE_NOT_EXIST` 的实际返回。
- [ ] 查单应答里的身份字段：支付宝查单、退款查询文档没有 `seller_id` / `app_id`，适配器用本配置值填；核实这样做时身份核对只来自验签。
- [ ] 关单：微信 204、支付宝 10000 之后再查的结果；关单后还能否被支付；已过期单的关单错误码（关单错误一律再查，不靠错误码）。
- [ ] 支付宝 `TRADE_CLOSED` 也可能是「支付完成后全额退款」：核实它对 PENDING 单会不会出现。
- [ ] 支付宝 `TRADE_FINISHED`：实测前按不成功处理，查单记 warn `pay_trade_finished`，通知照常带回原状态。
- [ ] 退款：受理应答字段（微信 `amount`、支付宝 `refund_fee` 是累计还是单次）、退款时限、同一退款单号重提的语义（验证前不重提）。
- [ ] 退款查询与退款通知：微信 `CLOSED`、`ABNORMAL`（`refund_fail_states` 实测前为空，继续占额）；支付宝无退款信息的 10000、没有 `refund_status` 的应答。
- [ ] 账单格式：两家文档都没给可靠的文件格式（微信无列定义，支付宝无编码与压缩细节），文件大小上限是自定的 64 MiB、未实测。
- [ ] 费率与结算周期。

## 2. 环境与密钥

- [ ] KMS 放置密钥（prod 开通前必须完成）：prod 的收款密钥只存 KMS（BR-PAY-08 ②；裁定 D10-554）。读取适配器已有（B1-30a），但**只打桩验证过，没有真连 KMS**，要负责人开通后实测。
  - 配 `KMS_REGION_ID`、`KMS_ENDPOINT`、`KMS_KEY_ID`、`KMS_RAM_ROLE`；通用凭据一律建成 **text** 类型（binary 会被拒）。
  - secret 名（`<env>` 是 `prod`）：`couli/<env>/pay/wechat/merchant-private-key`、`pay/wechat/apiv3-key`、`pay/wechat/platform-public-key`、`pay/alipay/app-private-key`，以及 `pay/alipay/public-key`，或证书三件 `pay/alipay/app-cert`、`pay/alipay/public-cert`、`pay/alipay/root-cert`（配 `PAY_ALIPAY_KEY_MODE=cert`）。联盟：`union/pdd/client-secret`、`union/taobao/app-secret`、`union/jd/app-secret`、`union/dataoke/app-secret`。
  - 字段加密 keyring：用 `apps/api/scripts/keyring-init-kms.ts` 建，主 keyring 和 prior identity keyring 各建一个（不得共用数据密钥，启动时校验），再配 `FIELD_KEY_PROVIDER=kms`、`PRIOR_IDENTITY_KEY_PROVIDER=kms`。
  - RAM 权限按入口的角色分开：`kms:Decrypt`（`KMS_KEY_ID`）；`kms:GetSecretValue` 收款 secret 只给 api、worker、admin，联盟 secret 只给 api、stream、worker，payout 一个都不给；`kms:Encrypt` 只在建 keyring 时用，不给运行角色。
  - 启动时读一次，换密钥要重启。读不到时：keyring 和联盟拒启动，收款该渠道不可用（下单 50306）。
- [ ] 可读进程：只有 api、worker、admin 拿得到密钥，stream、payout 没有挂载也不读（BR-PAY-08 ①）。
- [ ] 沙箱网关地址：`PAY_ALIPAY_GATEWAY` 的实际地址未实测；微信测试商户走同一个 API 域名（未实测）。
- [ ] 通知公网可达与限流：`PAY_NOTIFY_BASE_URL` 的 https 证书、网关放行、不重定向、限流（BR-PAY-08 ③）。
- [ ] 切换步骤按 `infra/staging/README.md` 1.9；生产网关与 `PAY_CHANNEL_IMPL` 的启动拒绝已有规则测试。

## 3. 已知的保守行为（实测前保持，上线前要知道）

- **账单解析前 B2-15j 对账不跑**：账单下载成功也返回 `unknown` / `bill_format_unverified`，对账跳过该渠道：不补跑、不记 `pay_bill_recon_abandoned`，每个账单日一条 warn `pay_bill_format_unverified`，该日不记为已对账。所以 worker 重启后，没有已对账记录的 App 会从首个账单日重放这条链（每天重新下载一次账单、再记一条 warn）。拿到真实样例后另开单写解析。
- **没有账单的日子**：只有文档写明的码才算（微信 HTTP 400 `NO_STATEMENT_EXIST`，`docs-mirror/wechat-pay/pages/4013071227.txt:527`；支付宝 40004 `NO_BILL_DATA`，`docs-mirror/alipay/app-pay/02e7gr.md:271`）。适配器返回 `bill_not_available`，对账跳过该渠道：不补跑、不记 `pay_bill_recon_abandoned`、不记为已对账，只记 debug，也绝不当空账单读。微信 `STATEMENT_CREATING`、支付宝 `BILL_NOT_EXIST` 等其他码仍按「账单暂不可得」补跑。**解析器上线时要重新审视这一条**：实测这两个码是否也会在账单未生成时返回，避免把未生成的账单当成没有账单，那天的差错就没人发现了。
- **支付宝「查无此单」的错误应答可被复用（已知残余，请上线负责人权衡）**：外层接口键不在签名范围内，不带单号的 40004 + `ACQ.TRADE_NOT_EXIST` 已签名应答可被挪到别的单或别的接口上（支付宝应答没有时间窗）。这样一张实际已付款的单可能被判成查无此单，过了 BR-PAY-05 ② 的宽限再查一次仍被同样的应答欺骗时就会关单。**账单解析器上线前没有对账兜底，这张单若实际已付款，只能靠支付通知走异常收款（BR-PAY-05 ④）；通知也没到时当下没有其他发现手段。** 拿到真实样例后，若错误应答带单号，就收紧 `not_exist` 的判定（要求带单号且相等）。
- **每笔支付宝退款预期都有一条通知告警，结果靠查询**：退款通知的 `refund_fee` 是该笔交易的总退款金额（`docs-mirror/alipay/app-pay/00dn78.md:43`），状态是交易状态、不在 `refund_success_states` 里；适配器如实带回、不做差额推算，所以通知处理判不符：只留存、告警、不迁移（BR-PAY-06 ④），结果以退款查询为准。**开通前决定是否改成只触发查询。**
- **`channel_unconfigured`**：缺配置的渠道下单 50306、通知不处理，进程照常启动，只有启动时一条 `pay_channel_unavailable` warn。

## 上线前要复核的已接受残余

- 不带单号的已签名「查无此单」应答可被复用（编排 2026-11-01 接受，要对渠道接口做 TLS 中间人才能触发）。账单解析上线后复核本残余；拿到真实样例后，若错误应答带单号就收紧 `not_exist` 的判定。
- 微信账单只支持三个月内（docs-mirror/wechat-pay/pages/4013071227.txt），文档没写更早日期的错误码。解析器上线前没有已对账记录，worker 重启会从首个账单日重放：收款满三个月后，超限的日子可能各报一条 error 级 `pay_bill_recon_abandoned`。拿到真实错误码后映射成固定原因，或让重放止于三个月。
