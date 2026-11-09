# 本地 k6 压测（QA-06a）

入口为 `script.ts`，参数、请求素材和阈值为同目录 `config.json`，纯参数构造器为
`options.ts`。不安装 npm k6 包；`k6-runtime.d.ts` 只声明本入口使用的容器 API，
不是 k6 实现。压测及规则测试均由编排者在隔离容器内执行。

同步场景见 QA-06c，尚未开工。`admin` 根地址及环境变量仅为后续任务保留，当前无场景使用。

## 接口与素材

三个请求均以 `contracts/openapi.yaml` 为准：搜索 `GET /v1/products/search`，
转链 `POST /v1/links/convert`，Agent `POST /v1/agent/sessions/{id}/messages`。
`{id}` 用本地夹具的 `session_id` 替换；Agent 请求由配置的 `text`、可选 `context`
和每次生成的 `client_msg_id` 组成，不发送幂等请求头。`context` 若填写，必须且只能含
`product_key`、`order_id`、`text` 之一，不能填空对象。转链单独生成签名和幂等键。
默认商品只是公开契约样例编号，本地演示适配器须准备对应商品和授权状态。

Agent 帧按 `contracts/agent-stream.schema.json` 检查 meta、递增 id、数据 seq 与 done，
meta 须匹配当前会话；拒绝未知事件、error、重复 run、非正常结束与未完成流。
只把 `done.finish_reason=stop` 且 `quota_left` 合法的结束计为成功。
这是压测成功判定，不代替完整 JSON Schema 验证；目前未执行实际压测。

## 负载与判定

基准来源是任务指定版本 `b3924b14787b7944f1aac97332f0d7131070ed36` 的规划/01 §7.3
公开首月：API 峰值 50 QPS、Agent 50 并发。规划没有请求占比，沿用首轮的搜索 30、
转链 15 QPS 分配作为可校准参数，非新增业务指标；移出的同步份额不并入其他场景，
当前两个请求场景合计 135 QPS，不宣称覆盖全部 API 的三倍峰值。
未使用“设计余量”500 QPS / 300 流作为基准。

| 场景 | 基准 → 三倍 | 执行器 | P95 | HTTP 错误率 |
| --- | --- | --- | --- | --- |
| `search` | 30 → 90 次/秒 | ramping-arrival-rate | <1500 ms | <1% |
| `convert` | 15 → 45 次/秒 | ramping-arrival-rate | <1500 ms | <1% |
| `agent_sse` | 50 → 150 个 VU | ramping-vus | 首字节 <1000 ms | <1% |

三个场景同时从零开始，30 秒升至各自峰值的三倍、保持 2 分钟、30 秒降至零。
P95 来自规划/01 §7.1；错误率 1% 为本地验收初值。场景参数、请求素材、P95 与
错误率全部在 `config.json` 调整；场景集合必须恰好是上述三项，其他名称拒绝启动。

HTTP 阈值按 `scenario` 分开；额外要求 `checks rate==1` 和 `dropped_iterations count==0`，
所以鉴权失败、HTTP 200 但 `code != 0`、非 JSON、错误/截断 SSE、负载机不能维持
请求率都会使运行失败。业务检查采用零容忍，不能仅看 HTTP 错误率。
VU 上限与请求超时在配置中，默认请求类上限按三倍每秒请求数乘 10 秒超时预留。
结束时按各场景的请求超时等待在途请求完成；SSE 降压也使用该等待时间，避免主动截断
正常回复造成错误率误报。因此实际退出可能晚于三分钟负载阶段结束。

SSE 每个 VU 串行等待一条流结束再发送下一条，不插入 sleep；各 VU 使用不同的设备与
会话，每条消息有独立 `client_msg_id`。`http_req_waiting` 仅是首字节代理指标，
提前返回响应头或心跳会使它早于首个业务事件。标准 `k6/http` 缓冲完整响应，本脚本
不声称测到了首个完整事件时间；严格事件延迟另看服务端 trace，长流也需关注负载机内存。

## 隔离与复用

遵守 **09 README §0.2** 硬规则 5：不压真实联盟接口，不连真实模型、短信或打款。
上游与故障只复用 `infra/fault`，本目录不创建 WireMock、不加载新桩。
参考 `infra/fault/README.md` 启动和装载、切换故障；联盟正常结果使用已有演示适配器，
QA-05a 的联盟桩只有传输故障，百炼正常桩也不是 Agent SSE 接口，不能拿 WireMock
的成功响应代替应用端三条链路的验收。

编排者提供仅接入 `couli-fault_fault` 内部网络的本地测试网关容器；网关在自身回环
3000、3001、3002 端口分别代理测试 API、stream、admin，应用与上游同样禁止外网出口。
Compose 使用 `network_mode: container:...` 共享该网关网络命名空间，回环地址因此指向
测试入口；不是 Docker 宿主机。不要使用 host 网络或接入生产环境的容器。

脚本与环境覆盖只接受 `127.0.0.1`、`localhost`、`[::1]`、`wiremock` 的 HTTP(S)
根地址；拒绝用户密码、路径、查询、片段、其他主机。每次请求禁止重定向，返回的跳转
链接不会被打开。此校验限制直接请求；应用的间接上游访问仍靠内部网络隔离和演示适配器约束。
Compose 关闭 k6 使用情况上报与 Web dashboard。

## 夹具和环境变量

夹具由编排者在隔离环境准备，放工作区被忽略的 `.tmp/qa-06a/fixtures.json`，
通过 `LOAD_FIXTURES_FILE` 的绝对路径只读挂载到 `/load/fixtures.json`；不能提交账号或令牌。
文件结构为包含 `users` 数组的对象。每个 user 必须有
`app_id`、`device_id`、`access_token`、`install_secret`、`session_id`，均来自本地种子，
所有设备和会话互异。Agent 用户须已同意 AI 第三方处理，已创建未过期且属于本人的会话。
默认需 1500 个条目（900 + 450 + 150，所有场景最大 VU 之和），按 k6 `idInTest - 1` 选取；不用
数组取模共享会话。修改 VU 参数后相应调整夹具数，设备/令牌必须匹配且在运行全程有效。

转链每次按契约 HMAC-SHA256 签名，动态生成时间戳、nonce、幂等键，不自动重试。
时间戳读取负载机时钟只用于 HTTP 验签，须与本地服务时钟同步；没有账务日期计算。
压测应用须使用隔离测试装配，提供足量配额、会话轮数与限流容量，不能修改生产限流规则。
这些前置条件不足时，连续发送会触发 42901、30502 或 30504，运行必须失败；
不能把拒绝请求的吞吐当作 Agent 容量结果。

| 变量 | 用途 |
| --- | --- |
| `LOAD_TARGET_CONTAINER` | 上述隔离网关容器名，必填 |
| `LOAD_FIXTURES_FILE` | 夹具的绝对路径，必填 |
| `LOAD_API_BASE_URL` | API 根地址，默认 `http://127.0.0.1:3000` |
| `LOAD_STREAM_BASE_URL` | stream 根地址，默认 `http://127.0.0.1:3001` |
| `LOAD_ADMIN_BASE_URL` | 保留的 admin 根地址，默认 `http://127.0.0.1:3002`，当前不发请求 |

## 编排者执行

镜像沿用首轮的 `grafana/k6:1.3.0` 精确版本及字面量 SHA256 摘要，本轮未联网核实。
TODO(规划/11 §4.5): 核实该版本多架构摘要与 `compose.yaml` 一致 — blocked on 编排者联网检查镜像。
先在允许联网的编排环境核实，若不一致则修正并重新评审，不可忽略摘要错误：

```sh
docker buildx imagetools inspect grafana/k6:1.3.0
```

隔离网络、演示上游、契约和本地夹具就绪后，从仓库根目录执行（环境变量由编排环境注入）：

```sh
docker compose -f infra/load/k6/compose.yaml config
docker compose -f infra/load/k6/compose.yaml run --rm k6
```

第二条命令执行全部三个场景，阈值失败时退出码非零；保留终端指标与退出码到编排产物目录，
不要把夹具或完整请求体写进报告。故障场景预期会触发性能门槛失败，与正常场景分开留证。
编排者还须在隔离验证容器运行冻结规则测试 `test/spec/load/k6/**`；本轮只执行静态检查。

## 同步场景（sync，QA-06c）

同步场景已由 QA-06c 实现；上文「同步场景见 QA-06c，尚未开工」「`admin` 根地址当前无场景使用」
是 QA-06a 时的说法，以本节为准。入口为独立的 `sync.ts`，参数、请求体和阈值在同目录
`sync.config.json`，纯参数构造器为 `sync-options.ts`（复用 `options.ts` 的场景与阈值构造，
不改 QA-06a 三场景的 `config.json`、`script.ts` 与校验）。`sync.config.json` 只能有 `sync`
一个场景，其他名称拒绝启动。

### 接口

以 `contracts/openapi.yaml` 为准：`adminCreateOrderSync`（`POST /admin/v1/order-syncs`），
权限点 `order.view`，无二次验证、无 `Idempotency-Key`。请求体二选一：

- 按订单号：`platform` + `order_nos`（1–50 个，每个 1–64 字符）；默认配置用这种，不读 limits。
- 按时间窗：`platform` + `from` + `to`（带时区偏移的 ISO 8601，`from` 早于 `to`），可选
  `status_filter`（须是该平台登记过的值）。`setup()` 先 `GET /admin/v1/order-syncs/limits`
  （`adminGetOrderSyncLimits`）取一次，`from` 不得早于该平台 `earliest_from`；取不到、401
  或窗口越界时在加压前就失败退出。`earliest_from` 随时钟后移，窗口起点应离边界留足余量。

请求体原样发送，不带 `app_id`、管理员编号等身份字段，身份只来自管理员令牌。每次迭代
只发一次 POST，不重试、不跟随跳转。只有 HTTP 200、`code=0` 且返回 `sync_id`、合法
`status` 和 `reused` 才算成功；401、429、5xx、30156（同步流暂停）、非 JSON、跳转都计失败。

注意去重：同一筛选条件在排队或执行中再次提交不会新建，返回原请求并带 `reused=true`。
固定请求体加压时绝大多数请求命中去重，压测结果主要反映去重查找与鉴权的开销，
**不等于新建同步的容量**，也不代表 worker 执行同步的吞吐。

### 负载与判定

基准来源是任务指定规格版本的规划/01 §7.3 公开首月 API 峰值 50 QPS。01 §7.3 只给总峰值，
没有按接口的占比；QA-06a 已分给搜索 30、转链 15，余量 50 − 30 − 15 = 5 QPS 作为本地分配给
同步，三倍即 15 次/秒。这是可校准的本地参数，不是规划给出的占比。

| 场景 | 基准 → 三倍 | 执行器 | P95 | HTTP 错误率 |
| --- | --- | --- | --- | --- |
| `sync` | 5 → 15 次/秒 | ramping-arrival-rate | <1500 ms | <1% |

与 QA-06a 同口径：30 秒升至三倍、保持 2 分钟、30 秒降至零；VU 预分配 30、上限 150
（三倍每秒请求数乘 10 秒请求超时）。01 §7.1 对后台写接口无专条，没有专门的延迟指标；
P95 1500 ms 与错误率 1% 沿用 QA-06a 的本地验收初值，不是规划给定的目标。
同样额外要求 `checks rate==1` 与 `dropped_iterations count==0`。峰值、阶段、阈值都只在
`sync.config.json` 调整，倍数固定为 3。

### 隔离

遵守 09 README §0.2 硬规则 5：不压真实联盟接口。订单同步的联盟上游只用 `infra/fault` 的
WireMock，应用须用演示适配器或指向该 WireMock 的测试装配；本目录不另起 WireMock、不加载新桩。
根地址只接受 `127.0.0.1`、`localhost`、`[::1]`、`wiremock` 的 HTTP(S) 根地址；`LOAD_ENV`
只能是 `local`（缺省）或 `wiremock`，`prod`、`staging` 及其他值在初始化时就拒绝，不发任何请求。

### 环境变量与运行

| 变量 | 用途 |
| --- | --- |
| `LOAD_ADMIN_BASE_URL` | admin 根地址，默认 `http://127.0.0.1:3002`（`compose.yaml` 已透传） |
| `LOAD_ADMIN_TOKEN` | 本地种子管理员令牌，须有 `order.view`，必填；只从环境变量读，不写入配置、报告或日志 |
| `LOAD_ENV` | `local` 或 `wiremock`，缺省 `local` |

`compose.yaml` 默认运行 `script.ts`，只透传三个 `LOAD_*_BASE_URL`，且要求 `LOAD_FIXTURES_FILE`。
同步场景不读夹具，但 Compose 仍要求该变量，可指向任意存在的本地 JSON 文件（如工作区被忽略的
`.tmp/qa-06c/fixtures.json`，内容 `{}`）。令牌与 `LOAD_ENV` 用 `-e 变量名`（不写值）从编排环境
传入，令牌不出现在命令行，也不要写进 `compose.yaml`（否则 `docker compose config` 会打印它）。
从仓库根目录执行：

```sh
docker compose -f infra/load/k6/compose.yaml run --rm -e LOAD_ADMIN_TOKEN -e LOAD_ENV k6 run --no-usage-report /load/sync.ts
```

阈值失败时退出码非零；保留终端指标与退出码，不要把令牌或完整请求体写进报告。
