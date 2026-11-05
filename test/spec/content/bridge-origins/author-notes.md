# F1-02zzzb 测试交接

依据为任务补充 D10-608 / D10-610 / D10-612 与 SPEC_REF 对应的规划原文；不扩展到客户端 LKG、换钥发布流程或生产 KMS 实现。

## 冻结资产逐条变更（D10-327，交编排者按 #24 报核）

- `config/delivery.int.test.ts` 的 `[AC-F1-02c#1]`：原 `bridge_origins: {}` 改为独立公钥验证签名、检查默认 origin / app_id / env，再把已验证对象纳入原完整响应比较，其他键的比较保留。
- `[AC-F1-02c#2]`：旧未定义的 `{allow}` 夹具改为 `{origins}`，包含该用例的 h5_base_url origin；响应改为验证 ES256、精确载荷及配置版本 1，原其他字段比较保留。
- `[AC-F1-02c#20]`：仅从参数表移出 `bridge_origins` 的 `null`、`[]`、`'text'` 三行；共用用例体、标题及其他行恢复为与 `origin/main` 逐字相同。
- `delivery.int.test.ts` 恢复原 `config/kit.ts` 的公共 `harness` / `Harness` 导入与生命周期；仅 `#1`、`#2` 各自创建本任务的签名夹具，取得独立验签公钥，并经 `onTestFinished` 关闭。其余用例继续使用原公共夹具，原 `config/kit.ts` 未改。
- `config-etag/domain.int.test.ts`：整份恢复为 `origin/main`，包括 import 和 `bridge_origins: {}`；此文件最终无差异。

## 第二次修改（D10-620 / D10-621）

- 原 `#20` 的三个 bridge_origins 非法值移到新文件 `invalid-stored-values.int.test.ts` 的 `[AC-F1-02zzzb#21]`，不是删除覆盖：仍逐项要求成功响应、独立公钥验签、默认 origins / app_id / env，以及仅本次请求日志中的 `warn`（level 40，key 为 bridge_origins）。相较原 `{}` 缺省比较，签名与载荷断言收紧，warn 断言不变。
- 移动是为了消除共用用例体中的条件分支，避免其他参数行随之改变；签名夹具仅在 `#1`、`#2` 内启用，避免整份冻结测试更换公共夹具。
- ETag 纯函数只对给定 data 求摘要，无需合法签名夹具，撤回上轮扩大范围的修改。
- 冻结文件最终剩余改动仅为：delivery 的签名夹具 / 验签 / 清理导入，`#1`、`#2` 的局部签名夹具及 bridge_origins 夹具和期望，`#20` 参数表移出上述三行；其余用例标题、用例体和断言与 `origin/main` 相同。

## 第三次修改（D10-623 更正 / D10-624，供 #24 报核）

- `save.int.test.ts` 的 `#16`（17 行）与 `#17`：原 config-items `setup()` 生成不符合 X-App-Id 契约的 id → 本目录内使用 config `appId()`，为该 id 创建管理员、登录并写入配置；保留原路由存在检查。非法值的 20001 / fields=[value]、不落库断言，以及合格保存后立即变更白名单和版本的断言均未改，冻结的 config-items kit 未动。
- `delivery.int.test.ts` 的 `#14`：原比较整个响应信封 → 仅比较 data，避开每次请求变化的 trace_id；明确逐字节比较 jws，原 ETag 相等、变更版本后 JWS / ETag 都改变的断言保留。
- 冻结 `agreements-min-version/delivery.int.test.ts` 的 `#8`（10 行）：原「不同 app 的 data 完全相等、ETag 相同」→「业务字段逐字段相等；两份 JWS 用同一测试公钥验签，各自 app_id 正确且其余载荷完全相等；各自 config_version 等于现有 versionOf(data)，ETag 等于现有 configEtag(自身内容) 且与自身 config_version 一致」。原最低版本省略、warn 次数 / 字段 / 不含原值断言全部保留。
- 冻结 `config-etag/delivery.int.test.ts` 的 `#2`：原「另一个 app 的 data 与 ETag 都相同」→ 同上三组断言；同一 viewer 重读与推进 60 秒后的 ETag 不变断言逐字保留。仅此用例局部启用已知签名公钥的 HTTP 夹具并在结束时清理，其余用例继续使用原夹具；标题保留，跨 app 这一步的语义以本对照为准。
- 两处比较均单独取出派生的 `config_version` 验证，不要求不同 JWS 的摘要彼此相等；除 `bridge_origins` 和这个派生字段外，没有排除任何 data 字段。摘要使用仓库现有函数，不手写哈希，也不以「ETag 不同」替代原无隐藏盐约束。
- 新辅助函数只放 `bridge-origins/http-kit.ts` / `jws-kit.ts`。上述两个冻结文件除 import 外只改指定用例；与 origin/main 对照时，其余用例标题、用例体保持逐字相同；本轮未修改 config/delivery 或任何源码、骨架。
- 本轮未触碰 `config-etag/domain.int.test.ts`，保留 HEAD 的 signedFixture 改动；上文第二次修改中关于撤回该夹具及该文件无差异的说明已被后续裁定收回，以本条和本轮任务书为准。

## 实现接口与验证

- `BridgeOriginsSigner` 与 `loadConfigSignKey` 是仅抛 NotImplemented 的新骨架；AppConfig 只增加可选配置类型，loadConfig / 组装根接线由实现者完成。缺项版本仅约束为非负安全整数且不大于首次写入版本 1，未擅自指定其值。
- 新测试通过 Node crypto 独立验签；HTTP 与后台用真实应用及测试数据库，不替换 content provider。密钥文件均由容器内运行的测试临时生成到仓库 `.tmp/`，从不读取部署密钥。
- 新增测试文件应全部进入先红对账；冻结的 `config/delivery.int.test.ts` 包含本任务之外的绿色用例，属于冻结形状迁移回归，不能当作“整个文件必须全红”的新增测试。新测试里的后台无效值用例先核对默认签名响应，避免旧的 object 类型校验导致部分用例假绿。
- staging 挂载、契约源文件与生成物在实现阶段修改。本轮只做静态检查，容器先红和实现后的完整回归由编排者执行。
