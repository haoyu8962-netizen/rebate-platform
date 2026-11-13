# @couli/db

数据库访问包：Kysely + pg（ADR-0001 §2）。表结构的唯一来源是仓库根的 `db/schema.sql`；本包的类型文件 `src/db.gen.ts` 由它对应的迁移结果生成，不手改。

## 里面有什么

| 路径 | 内容 |
| --- | --- |
| `src/index.ts` | `createDb()`（连接池，int8 解析成 BigInt，默认 schema `app`）、`destroyDb()`、类型 `DB`、分区名与月份的纯函数 |
| `src/db.gen.ts` | kysely-codegen 生成的表类型（生成物） |
| `src/testing/` | 测试库：`@couli/db/testing` 的 `createTestDatabase()` 和 globalSetup 源文件 `src/testing/global-setup.ts` |
| `scripts/` | 建角色、迁移、分区、种子、快照、本地栈脚本 |
| `../../db/` | 迁移、角色与扩展、快照、种子、不变量 SQL（规则见 `db/AGENTS.md`） |
| `../../infra/local/` | 本地栈的 compose 文件 |

## 命令（在仓库根目录运行）

| 用途 | 命令 | 需要 |
| --- | --- | --- |
| 单元测试（不连库） | `pnpm --filter @couli/db test` | 无 |
| 集成测试（真实 PG，以业务角色连接） | `pnpm --filter @couli/db run test:int` | Docker，或 `TEST_PG_ADMIN_URL` |
| 重新生成 `db/schema.sql` 与 `db.gen.ts` | `pnpm db:snapshot` | Docker，或 `TEST_PG_ADMIN_URL` 加 pg_dump 18 |
| 检查生成物有没有漂移 | `pnpm db:check` | 同上 |
| 检查 pg-boss 迁移与已装版本一致 | `pnpm --filter @couli/db run gen:pgboss -- --check` | 无 |
| 启动本地栈并初始化 | `pnpm dev:stack` | Docker |
| 停止本地栈（保留数据） | `pnpm dev:stack:down` | Docker |
| 单独执行：建角色与库 / 迁移 / 预建分区 / 种子 | `pnpm db:bootstrap` / `db:migrate` / `db:partitions` / `db:seed` | `PG_ADMIN_URL` 或 `MIGRATOR_DATABASE_URL` |

除单元测试和 pg-boss 检查外，其余命令都要连数据库或 Docker，只能在 Codex 沙箱外运行（规划/11 §2.3、§4.1）。

## 测试库怎么工作（ADR-0001 §4.2 第 9 项）

1. 每次运行用一个一次性的 PostgreSQL：设了 `TEST_PG_ADMIN_URL` 就直连（verify 容器、CI），没设就用 Testcontainers 起 `pgvector/pgvector:0.8.6-pg18-trixie`。
2. globalSetup 以超级用户建角色和扩展，再以 `couli_migrator` 跑全部迁移，得到模板库 `couli_tpl_<运行号>`。迁移只跑这一次。
3. 每个测试文件调用 `createTestDatabase()`，从模板克隆自己的库（本机约 20–80 毫秒），用完 `drop()`。
   `drop()` 先轮询 `pg_stat_activity`（每 25 毫秒），等这个库上的其它连接自己退出，最多等 `DROP_GRACE_MS`（3 秒），再 `DROP DATABASE … WITH (FORCE)`；没有残留连接时第一次查询就删，不变慢。
   原因：pg-pool 的 `end()` 不等 socket 关就返回，立刻强制删库会把还没退完的后端杀掉，57P01 落到已经没人监听的池上成未处理错误。等满仍未退出的连接照常收到 57P01。
4. 测试只拿到一个只能建库的角色和四个业务角色的密码，**拿不到超级用户连接串**；用例以 `couli_app` 等身份连接，权限和触发器都被真实检验。
5. 脚本会拒绝含有 `couli` 库的集群，避免误连本地栈或真实环境。

写集成测试：文件名 `*.int.test.ts`，在 `beforeAll` 里 `createTestDatabase()`，用 `createDb({ connectionString: db.urlFor('couli_app') })` 连接。别的包要用时，在自己的 `vitest.integration.config.ts` 里把 globalSetup 写成这个源文件的相对路径（如 `test/vitest.integration.config.ts` 的 `'../packages/db/src/testing/global-setup.ts'`、`apps/api/vitest.integration.config.ts` 的 `'../../packages/db/src/testing/global-setup.ts'`），不要写包名 `@couli/db/testing/global-setup`：Vitest 解析 globalSetup 不认 `couli-src` 条件，包名会加载 `dist`（全新检出时不存在，改了源码不重建就跑旧的）。

## 改表结构的步骤

1. 在 `db/migrations/` 新增一个迁移（规则见 `db/AGENTS.md`；已合并的迁移不改）。
2. 在沙箱外运行 `pnpm db:snapshot`，提交 `db/schema.sql` 和 `src/db.gen.ts`。
3. 运行 `pnpm --filter @couli/db run test:int` 和 `pnpm db:check`。

## 已知限制

- `createDb()` 只传 `connectionString` 时自建的连接池不挂错误监听，只适合脚本和测试。应用进程的连接池由 platform 模块（`apps/api/src/modules/platform/db/`）经 `poolFactory` 提供：挂错误监听（记 `db_pool_error`）、有界关闭，admin 另有以 `couli_readonly` 连接的只读句柄 `dbRead`（`DATABASE_READ_URL`，会话默认只读事务）。
- `db:partitions` 以 `couli_migrator`（函数属主）执行，用在发布时；运行期由 worker 的分区维护定时任务（`apps/api/src/modules/platform/maintenance/`）以 `couli_maint` 调同一个函数，连接读 `DATABASE_MAINT_URL`（worker 必填；只有 `APP_ENV=test` 时可以不设，此时不做分区维护，记 `partition_maintenance_disabled`）。
- CHECK 约束和 `GENERATED ALWAYS` 在生成的类型里看不出（ADR-0001 §7），要靠集成测试。
