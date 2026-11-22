# staging 部署底座（B1-01zc）

一个后端镜像 `couli-api:<标签>` 跑五个常驻进程（api / stream / worker / admin / payout）和一次性的迁移步骤。镜像在开发机构建，传到节点后由 `deploy.sh` 部署：先迁移、再切换五个进程并等健康检查，失败就回到上一个成功的标签。

| 文件 | 作用 |
| --- | --- |
| `Dockerfile` | 多阶段镜像：Node 24，按 `pnpm-lock.yaml` 离线安装，构建 `@couli/api`；运行阶段用非 root 用户 `node` |
| `compose.yaml` | 五个服务，同一个镜像，`command` 选入口；只用 `image:`，不构建、不拉取 |
| `boot.mjs` | 五个进程启动时先加载（`node --import`）：记录容器启动次数供健康检查用；api 从挂载文件读签名私钥 |
| `deploy.sh` | 部署与回退脚本，参数是镜像标签（可选第二个参数 `--with-current-compose`，见第 4 节） |
| `../../.dockerignore` | 构建上下文排除环境文件、证书与密钥文件、SSH 私钥、`.git`、`node_modules`、构建产物 |

## 1. 首次准备（节点上，一次）

环境文件由负责人 / 编排者直接放在节点上，**不进仓库、不进镜像**，属主 root、权限 600：

| 文件 | 给谁用 | 内容（只列变量名） |
| --- | --- | --- |
| `/etc/couli/staging.env` | api、stream、worker、admin | API_PORT / STREAM_PORT / ADMIN_PORT、DATABASE_URL、DATABASE_READ_URL、DATABASE_MAINT_URL、REDIS_URL、FIELD_KEY_PROVIDER、FIELD_KEYRING_FILE、FIELD_MASTER_KEY_FILE；可选 SMS_ACCESS_KEY_ID、SMS_ACCESS_KEY_SECRET、SMS_SIGN_NAME、SMS_TEMPLATE_VERIFY_CODE（见 1.6），AGENT_REVIEW_ALIYUN_ACCESS_KEY_ID、AGENT_REVIEW_ALIYUN_ACCESS_KEY_SECRET、AGENT_REVIEW_ALIYUN_ENDPOINT（见 1.13） |
| `/etc/couli/staging-payout.env` | 只给 payout | payout 自己的 DATABASE_URL，以及同样的三个 FIELD_* 变量（payout 不连 Redis，ADR-0001 §4.2 第 20 项） |
| `/etc/couli/staging-migrator.env` | 只给迁移步骤 | MIGRATOR_DATABASE_URL |

`APP_ENV` 不放在环境文件里：`compose.yaml` 给五个服务都直接写死 `APP_ENV: staging`（它不是口令）。三个环境文件里都**不要**写 JWT_ 开头的变量：签名私钥与 kid 只给 api，经 1.4 的挂载文件注入（stream / worker / admin 共用 `staging.env`，只有 kid 没有私钥会被拒绝启动）。

`deploy.sh` 在迁移之前检查下面这些节点文件都存在（只看是否存在，不读内容），缺任何一个直接报错退出，不迁移、不碰正在运行的进程：三个环境文件、`/etc/pki/ca.crt`、`/etc/couli-keys/master.key` 与 `keyring.json`、`/etc/couli-jwt/es256.pem` 与 `key-id`。

注意事项：

- 进程跑在容器的桥接网络里，连接串里的主机要写节点的内网地址（数据库走 HAProxy 5433 主 / 5434 只读，Redis 走内网地址），不能写 `127.0.0.1`。
- 端口变量不写时用应用默认值（3100 / 3101 / 3102）；三个 HTTP 端口只发布到节点的 `127.0.0.1`，worker 与 payout 不发布端口。
- 部署文件放在节点的一个目录里（例如 `/opt/couli/staging/`），`compose.yaml` 与 `deploy.sh` 放在同一目录；`deploy.sh` 按自身位置找 `compose.yaml`。
- 上一次成功的标签记在 `/var/lib/couli/staging-api.tag`；五个进程在跑的标签记在 `/var/lib/couli/staging-api.switched`：已有成功标签时，脚本在开始切换前先把它写成「不确定」标记，等本次部署完整成功（健康检查和 RestartCount 核对都通过）或自动回退完成后才写回标签；所以切换中途任何失败、出错退出或被中断（例如 SSH 断开），这里留下的都是「不确定」而不是目标标签。脚本会自动创建这个目录和这两个文件；旧版脚本留下的现场没有切换记录，这时按「不知道在跑哪个标签」处理。
- 同一时间只允许一次部署：脚本用 `flock` 锁住 `/run/lock/couli-staging-deploy.lock`，拿不到锁直接非零退出。

### 1.1 数据库证书（自签）

数据库用自签证书，CA 放在节点的 `/etc/pki/ca.crt`。五个服务和迁移容器都把它只读挂到容器内同一路径。三个环境文件里的数据库连接串末尾都要带 `?sslmode=verify-ca&sslrootcert=/etc/pki/ca.crt`（已有查询参数时用 `&` 接上）。

**迁移连接串还要多带一个 `&uselibpqcompat=true`**（只加在 `staging-migrator.env` 的 MIGRATOR_DATABASE_URL 上）。迁移经 pg-connection-string 2.x 解析连接串，它默认把 `verify-ca` 当成 `verify-full`，会校验证书里的主机名；staging 按内网 IP 连 HAProxy，证书不一定写了这个 IP，迁移就会报 `ERR_TLS_CERT_ALTNAME_INVALID`。带上这个参数后按 libpq 的 `verify-ca` 语义：校验 CA，不校验主机名。**应用的连接串不要加**：应用自己处理 `verify-ca`，它的参数白名单也不收这个参数。`deploy.sh` 在迁移前检查：迁移环境文件里有 `sslmode=verify-ca` 却没有 `uselibpqcompat=true` 时直接报错退出（只做匹配判断，不打印文件内容）。

### 1.2 环境文件的写法

- 每行写成「变量名=值」，值不加引号。口令里若有 `@ / ? # :` 等字符要先 percent 编码（日志打码按标准写法识别口令）。`compose.yaml` 用 `format: raw` 读取服务的环境文件，值里的 `$` 不会被展开。
- `deploy.sh` 还会用 `--env-file /etc/couli/staging.env` 让 Compose 读出端口号，这一步会对整个文件做 `$` 展开（可能把 `$` 后面的字符当变量名打印成警告）。所以**口令只用字母和数字**；节点上现有口令已经是字母数字。

### 1.3 字段加密密钥环（ADR-0003）

五个服务都把节点目录 `/etc/couli-keys` 只读挂到容器内 `/run/couli-keys`。注意不是 `/etc/couli/keys`：规则测试禁止任何服务挂载 `/etc/couli` 下的路径（那里放着环境文件），所以密钥单独放在 `/etc/couli-keys`。

两个环境文件（`staging.env` 与 `staging-payout.env`）都要写：

| 变量 | 值 |
| --- | --- |
| FIELD_KEY_PROVIDER | `local` |
| FIELD_KEYRING_FILE | `/run/couli-keys/keyring.json` |
| FIELD_MASTER_KEY_FILE | `/run/couli-keys/master.key` |

首次生成（节点上以 root 执行一次；`keyring-init.ts` 由任务 B1-01zd 提供，文件格式以它为准）：

```sh
install -d -m 700 /etc/couli-keys
(umask 077 && openssl rand -hex 32 > /etc/couli-keys/master.key)
docker run --rm --pull never --network none --user 0 \
  --volume /etc/couli-keys:/keys couli-api:<标签> \
  node apps/api/scripts/keyring-init.ts /keys/master.key /keys/keyring.json
chown -R 1000:1000 /etc/couli-keys
chmod 400 /etc/couli-keys/master.key /etc/couli-keys/keyring.json
chmod 500 /etc/couli-keys
```

`keyring-init.ts` 的两个参数都是**文件路径**（主密钥文件、输出的密钥环文件），由程序自己读主密钥文件。任何地方都不要用命令替换把主密钥内容放进命令行参数或环境变量：那样它会出现在进程列表和 `docker inspect` 里，文件权限挡不住。若 B1-01zd 的接口只收主密钥内容，要先让它改为收文件路径再做这一步。

容器以 `node` 用户（uid 1000）运行，所以目录和文件属主是 1000，目录 500、文件 400。主密钥丢失后已加密的字段无法解开，生成后另行离线备份。

#### 1.3a 旧身份隔离存储的第二套字段密钥环（B1-27e）

实名更正时，旧身份放在隔离存储里，用独立的数据密钥加密（B1-27e，`keyring-prior-identity.ts`）。这需要第二套密钥环，和 1.3 的密钥环分开。

节点上再放两个文件：`/etc/couli-keys/prior-identity-master.key`（另一把主密钥）与 `/etc/couli-keys/prior-identity-keyring.json`（第二套密钥环，由镜像内的 `keyring-init.ts` 用这把主密钥生成）。
两个文件与 1.3 放在同一节点目录 `/etc/couli-keys`，随五个服务现有的只读挂载出现在容器内 `/run/couli-keys`，`compose.yaml` 不用改。

两份应用环境文件（`staging.env` 与 `staging-payout.env`）都要写下面同样三行，每个变量单独一行、行首就是变量名：

```text
PRIOR_IDENTITY_KEY_PROVIDER=local
PRIOR_IDENTITY_KEYRING_FILE=/run/couli-keys/prior-identity-keyring.json
PRIOR_IDENTITY_MASTER_KEY_FILE=/run/couli-keys/prior-identity-master.key
```

缺这组变量时，五个入口（api、stream、worker、admin、payout）启动即失败（`keyring-prior-identity.ts` §2）。

首次生成（在 1.3 做完之后，节点上以 root 执行一次）。1.3 结束时目录已是 500，下面先临时改成 700，写完再改回 500：

```sh
chmod 700 /etc/couli-keys
(umask 077 && set -o noclobber && openssl rand -hex 32 > /etc/couli-keys/prior-identity-master.key)
docker run --rm --pull never --network none --user 0 \
  --volume /etc/couli-keys:/keys couli-api:<标签> \
  node apps/api/scripts/keyring-init.ts /keys/prior-identity-master.key /keys/prior-identity-keyring.json
chown 1000:1000 /etc/couli-keys/prior-identity-master.key
chown 1000:1000 /etc/couli-keys/prior-identity-keyring.json
chmod 400 /etc/couli-keys/prior-identity-master.key
chmod 400 /etc/couli-keys/prior-identity-keyring.json
chmod 500 /etc/couli-keys
```

做完后目录属主仍是 1000、权限 500，两个新文件属主 1000、权限 400，与 1.3 相同。

中途断开时不要自行续做，也不要删除任何文件：保持现场，先确认原会话的命令都已结束，再找 ops / 编排核对后处理。

契约允许旧身份主密钥文件与 FIELD_MASTER_KEY_FILE 共用（`keyring-prior-identity.ts` §1、§4 g），只要求两套密钥环的数据密钥不同（否则 `shares_main_data_key` 拒绝启动）。

staging 照编排 D10-336 用独立主密钥 `prior-identity-master.key`。

PRIOR_IDENTITY_KEYRING_FILE 不得与 FIELD_KEYRING_FILE 相同。不要复制 `keyring.json` 充当第二套密钥环：复制出来的数据密钥和主密钥环相同，启动会被拒绝。

主密钥只经文件路径交给程序，不经命令行参数或环境变量传（理由同 1.3）。

两把主密钥（`/etc/couli-keys/master.key` 与 `/etc/couli-keys/prior-identity-master.key`）都要另行离线备份；丢了任何一把，对应的字段就无法解开。

prod 走 KMS，不照此做。

### 1.4 访问令牌密钥（api 签名私钥、stream 验签公钥）

api 在 staging 必须有 ES256 签名私钥（P-256，PKCS#8 PEM）和 kid，否则启动即退出。私钥不放环境文件（`format: raw` 的环境文件放不了多行值，规则测试也只允许每个服务一个环境文件），而是放在节点目录 `/etc/couli-jwt`，只读挂给 api（容器内 `/run/couli-jwt`）。api 启动时由 `boot.mjs` 把两个文件读进本进程的环境变量 JWT_PRIVATE_KEY_PEM 与 JWT_KEY_ID：私钥不进命令行、不进 `docker inspect`、不打印；读不到就报错（只报路径与错误码）并退出。

| 文件 | 内容 |
| --- | --- |
| `/etc/couli-jwt/es256.pem` | PKCS#8 格式（首行标签是 `BEGIN PRIVATE KEY`，不带 `EC`）的 P-256 私钥；`openssl ecparam` 默认写出的 SEC1 格式（`EC PRIVATE KEY`）会被拒绝 |
| `/etc/couli-jwt/key-id` | kid，一行，只能用字母、数字和 `.` `_` `~` `-`，1 到 64 个字符；用环境加年月，例如 `staging-2026-10`，换私钥时换新的 kid |

由节点上已有的 `/etc/couli/jwt/es256.pem` 生成（以 root 执行一次；输出直接写文件，私钥不经过终端）：

```sh
install -d -m 700 /etc/couli-jwt
(umask 077 && openssl pkcs8 -topk8 -nocrypt -in /etc/couli/jwt/es256.pem -out /etc/couli-jwt/es256.pem)
printf '%s\n' staging-2026-10 > /etc/couli-jwt/key-id
chown -R 1000:1000 /etc/couli-jwt
chmod 400 /etc/couli-jwt/es256.pem /etc/couli-jwt/key-id
chmod 500 /etc/couli-jwt
```

`openssl pkcs8 -topk8` 对 SEC1 与 PKCS#8 输入都输出 PKCS#8。核对曲线用 `openssl pkey -in /etc/couli-jwt/es256.pem -noout -text_pub`（只打印公钥，应看到 `prime256v1` 或 `P-256`），不要用会打印私钥的 `-text`。

stream 只验访问令牌、不签发，所以只拿公钥：节点目录 `/etc/couli-jwt-pub` 只读挂给 stream（容器内 `/run/couli-jwt-pub`，compose 里没有 `create_host_path`，目录缺失时部署直接失败，不会让 stream 带着空目录起来）。stream 启动时由 `boot.mjs` 把两个文件读进本进程的环境变量 JWT_PUBLIC_KEY_PEM 与 JWT_KEY_ID，不给 JWT_PRIVATE_KEY_PEM（目录里误放了私钥也不读）；读不到就报错（只报路径与错误码）并退出。私钥目录 `/etc/couli-jwt` 仍只挂给 api，worker / admin / payout 两个目录都不挂。

| 文件 | 内容 |
| --- | --- |
| `/etc/couli-jwt-pub/es256.pub.pem` | 由 `/etc/couli-jwt/es256.pem` 导出的 P-256 公钥，SPKI 格式（首行标签是 `BEGIN PUBLIC KEY`） |
| `/etc/couli-jwt-pub/key-id` | `/etc/couli-jwt/key-id` 的原样副本（两份 kid 必须一致） |

在上面的私钥目录建好之后生成（以 root 执行；只读私钥、只写公钥，私钥不经过终端）：

```sh
install -d -m 700 /etc/couli-jwt-pub
(umask 022 && openssl pkey -in /etc/couli-jwt/es256.pem -pubout -out /etc/couli-jwt-pub/es256.pub.pem)
cp /etc/couli-jwt/key-id /etc/couli-jwt-pub/key-id
chown -R 1000:1000 /etc/couli-jwt-pub
chmod 400 /etc/couli-jwt-pub/es256.pub.pem /etc/couli-jwt-pub/key-id
chmod 500 /etc/couli-jwt-pub
```

属主必须是 1000（容器内进程的用户）。上面写的是最小权限（目录 500、文件 400）；公钥与 kid 不是机密，节点上已经按目录 555、文件 444 导出的现有目录同样可用，不必重做。

核对（三条都应成功；任何一条都不打印私钥）：

```sh
openssl pkey -in /etc/couli-jwt/es256.pem -pubout | cmp - /etc/couli-jwt-pub/es256.pub.pem && echo public-key-matches
cmp /etc/couli-jwt/key-id /etc/couli-jwt-pub/key-id && echo key-id-matches
openssl pkey -pubin -in /etc/couli-jwt-pub/es256.pub.pem -noout -text
```

第一条确认公钥与现有私钥是一对，第二条确认两份 kid 一致，第三条按公钥解析公钥文件（应看到 `prime256v1` 或 `P-256`；它只含公钥，`-text` 在这里不会打印私钥）。换私钥（换 kid）时，公钥目录要按同样步骤重新导出并核对，再部署。

### 1.5 拼多多（准备，不切 live）

本节只做接线准备，不切 live：**pdd 切 live 暂不可用 — blocked on 真实返利报价器（B2-03）**。api 入口只要有一个联盟端点是 live，就按 live 装配，而演示返利报价器在 live 下拒绝启动（资金安全设计），真实报价器由 B2-03 提供。所以下面三个端点文件现在都保持 demo，pdd.json 也不例外；本节不提供切换步骤。

compose 给 admin、api、stream 与 worker（装配联盟模块的四个入口）只读挂载节点目录 `/etc/couli-pdd`（容器内 `/run/couli-pdd`）。这个挂载可缺：节点没有该目录时部署照常进行，`deploy.sh` 也不检查它。

节点文件由负责人放入（容器以 uid 1000 运行）：

| 节点路径 | 内容 | 属主与权限 |
| --- | --- | --- |
| `/etc/couli-pdd/` | 目录 | 属主 1000，目录 500 |
| `/etc/couli-pdd/client_secret` | 拼多多开放平台应用的密钥原文，文件里只放这一个值 | 属主 1000，文件 400 |
| `/etc/couli-pdd/union-endpoints/` | 子目录，放三平台端点文件 | 属主 1000，目录 500 |
| `/etc/couli-pdd/union-endpoints/jd.json`、`pdd.json`、`taobao.json` | 三个端点文件，现在都是 demo，与镜像内 `config/union-endpoints/` 相同 | 属主 1000，文件 400 |

密钥内容不得出现在命令行里（会进 shell 历史和进程列表），也不得放进环境变量或 `staging.env`；用编辑器打开文件粘贴后保存，不要用 `echo` / `printf` 写入密钥。准备步骤（root 执行）：

```sh
install -d -m 700 /etc/couli-pdd /etc/couli-pdd/union-endpoints
vi /etc/couli-pdd/client_secret
for platform in jd pdd taobao; do
  printf '{"platform":"%s","mode":"demo","baseUrl":null,"quotaKey":"account:%s"}\n' \
    "$platform" "$platform" > "/etc/couli-pdd/union-endpoints/$platform.json"
done
chown -R 1000:1000 /etc/couli-pdd
chmod 400 /etc/couli-pdd/client_secret /etc/couli-pdd/union-endpoints/*.json
chmod 500 /etc/couli-pdd/union-endpoints /etc/couli-pdd
```

先放好上面的文件，再在 `/etc/couli/staging.env` 设下面四个变量（顺序不能反：设了 UNION_ENDPOINT_OVERRIDE_DIR 而目录缺文件时，admin、api、stream 与 worker 启动即失败，不会退回镜像内的端点）：

| 变量 | 取值 |
| --- | --- |
| `PDD_CLIENT_ID` | 拼多多开放平台应用的 client_id（不是密钥） |
| `PDD_CLIENT_SECRET_FILE` | `/run/couli-pdd/client_secret`（容器内路径；只写路径，不写密钥内容） |
| `PDD_QUERY_CUSTOM_PARAMETERS` | 商品查询带的 custom_parameters，JSON 对象文本，按 UTF-8 不超过 64 字节 |
| `UNION_ENDPOINT_OVERRIDE_DIR` | `/run/couli-pdd/union-endpoints`（容器内路径；只有 staging 认，必须是绝对路径） |

`staging.env` 由 api、stream、worker、admin 共用，这四个入口都有这个挂载。其余入口只有 payout：它没有这个挂载，也不装配联盟模块，不读端点目录，所以不受影响。

拼多多开放平台应用的 IP 白名单只加不删：把 staging 节点的出口 IP 加进去，已有的地址一律保留。

### 1.6 阿里云短信（验证码，可选）

在 `/etc/couli/staging.env` 设下面四个变量，api 与 admin 入口的验证码短信就走阿里云短信（SendSms）。**四个齐全才启用**；缺任一（未设、空串或全空白）时维持现状：每条验证码都拒发，入口启动时打一条 warn `sms_sender_unconfigured`。四个都设好时启动打一条 info `sms_sender_live`（只带环境名与供应商，不带任何值）。

| 变量 | 取值 |
| --- | --- |
| `SMS_ACCESS_KEY_ID` | 阿里云 AccessKey ID |
| `SMS_ACCESS_KEY_SECRET` | 阿里云 AccessKey Secret |
| `SMS_SIGN_NAME` | 短信签名名称，与阿里云短信控制台里审核通过的签名逐字相同 |
| `SMS_TEMPLATE_VERIFY_CODE` | 验证码模板的模板 CODE（形如 `SMS_` 加数字），模板正文为「您的动态码为：${code}，5分钟内有效，请勿泄露！」 |

- AccessKey 只用 RAM 子账号的，只授短信发送权限，不用主账号 AccessKey（规划/02 §14）。
- 1.2 说过 `deploy.sh` 会对整个 `staging.env` 做 `$` 展开：值里不要出现 `$`；签名名称是中文时照常写，不加引号。
- `APP_ENV` 为 local 或 test 时设了这四个中的任何一个都会拒绝启动；本地 `.env` 不放它们。

### 1.7 B1-01zd 之前

**B1-01zd 合并之前**，应用在 `APP_ENV=staging` 下仍拒绝 `FIELD_KEY_PROVIDER=local`，五个进程都会启动失败，部署会走失败分支。

### 1.8 京东（准备，不切 live）

本节只做接线准备，不切 live：镜像内和节点上的 `jd.json` 都保持 demo，本节不提供切换步骤。

compose 给 admin、api、stream 与 worker（装配联盟模块的四个入口）只读挂载节点目录 `/etc/couli-jd`（容器内 `/run/couli-jd`）；payout 不挂。这个挂载可缺：节点没有该目录时部署照常进行，`deploy.sh` 也不检查它。

节点文件由负责人放入（容器以 uid 1000 运行）：

| 节点路径 | 内容 | 属主与权限 |
| --- | --- | --- |
| `/etc/couli-jd/` | 目录 | 属主 1000，目录 500 |
| `/etc/couli-jd/app_secret` | 京东联盟应用的密钥原文，文件里只放这一个值 | 属主 1000，文件 400 |

密钥内容不得出现在命令行里（会进 shell 历史和进程列表），也不得放进环境变量或 `staging.env`；用编辑器打开文件粘贴后保存，不要用 `echo` / `printf` 写入密钥。准备步骤（root 执行）：

```sh
install -d -m 700 /etc/couli-jd
vi /etc/couli-jd/app_secret
chown -R 1000:1000 /etc/couli-jd
chmod 400 /etc/couli-jd/app_secret
chmod 500 /etc/couli-jd
```

先放好上面的文件，再在 `/etc/couli/staging.env` 设下面三个变量（值只写在节点上，不进仓库，也不写进本文档）：

| 变量 | 取值 |
| --- | --- |
| `JD_APP_KEY` | 京东联盟应用的 app key（不是密钥） |
| `JD_APP_SECRET_FILE` | `/run/couli-jd/app_secret`（容器内路径；只写路径，不写密钥内容） |
| `JD_SITE_ID` | 京东联盟的站点 id，十进制正整数 |

- `JD_APP_KEY` 与 `JD_APP_SECRET_FILE` 要么都设、要么都不设：只设一个时 admin、api、stream 与 worker 启动即失败。`JD_SITE_ID` 设了但不是十进制正整数时同样启动失败。
- 端点是 demo 时应用不打开密钥文件，所以文件读不到或内容为空要到切 live 后才暴露：那时这四个入口启动即失败。
- `JD_SITE_ID` 现在只校验格式，转链由 B1-04zd 接入，在那之前京东转链不可用。

切 live 走 `UNION_ENDPOINT_OVERRIDE_DIR` 下的 `jd.json`，本节不切。这个变量维持 1.5 的 `/run/couli-pdd/union-endpoints`：它是三平台共用的一个目录，里面的 `jd.json`、`pdd.json`、`taobao.json` 缺任何一个，这四个入口都启动失败，所以**不要把它改到 `/run/couli-jd`**。到切 live 的时候，改的是现有的节点文件 `/etc/couli-pdd/union-endpoints/jd.json`。

**部署检查 CHK-JD-STAGING-CRED**：jd 端点为 live 而 `JD_APP_KEY`、`JD_APP_SECRET_FILE` 两个变量都没设时，应用不报错、也不打日志，jd 保持未实现（D10-479 同款）。部署成功不代表京东已接通，所以切 live 前要人工核对 `JD_APP_KEY`、`JD_APP_SECRET_FILE`、`JD_SITE_ID` 这三项已设，并核对 `UNION_ENDPOINT_OVERRIDE_DIR` 已设，值是现有的 `/run/couli-pdd/union-endpoints`：节点没做 1.5 时这个变量没设，应用读的是镜像内的端点，改了 `/etc/couli-pdd/union-endpoints/jd.json` 也不生效，jd 静默留在 demo。

### 1.9 收款通道（B2-15k，默认假通道）

compose 给 api、worker、admin 写了 `PAY_CHANNEL_IMPL: fake`（不是口令）：这三个入口用假通道，不碰渠道。stream、payout 永远不读任何 `PAY_*`（BR-PAY-08 ①）。

切换到真实通道（测试商户 / 沙箱）的步骤，实测清单见 `specs/pay-channels-launch-checklist.md`：

1. 负责人把密钥文件放到节点目录 `/etc/couli-pay`（属主 1000，目录 500，文件 400；放的方式同 1.8，内容不进命令行、环境变量或 `staging.env`）；微信：商户 API 证书私钥、APIv3 密钥（文件里只有 32 字节密钥原文）、微信支付公钥；支付宝：应用私钥（PKCS#8 PEM），再加支付宝公钥，或应用公钥证书、支付宝公钥证书、支付宝根证书三件。
2. 在 compose 的 api、worker、admin 三个服务上只读挂载 `/etc/couli-pay` 到 `/run/couli-pay`（目前没有这个挂载：本任务不改挂载，切换时另开任务，stream、payout 不得挂载）。
3. 在 `/etc/couli/staging.env` 设下表变量（值只写在节点上，不进仓库）。这个文件 api、stream、worker、admin 共用：stream 的环境里会有这些路径和商户号（都不是密钥），但它不读，也没有挂载、打不开密钥文件。
4. 从 compose 删掉这三个服务的 `PAY_CHANNEL_IMPL: fake`，重新部署。启动日志出现 `pay_channel_unavailable` 表示该渠道没配齐：`variables` 字段只列变量名；该渠道下单 50306、通知不处理，进程照常启动，不回退假通道。

| 变量 | 取值 |
| --- | --- |
| `PAY_APP_ID` | 这个商户身份归属的我方 app_id |
| `PAY_NOTIFY_BASE_URL` | 通知入口的 https 基址（只取源，路径由代码决定：`/notify/pay/wechat`、`/notify/pay/alipay`） |
| `PAY_WECHAT_APPID`、`PAY_WECHAT_MCHID` | 测试商户绑定的 AppID、商户号 |
| `PAY_WECHAT_MERCHANT_SERIAL` | 商户 API 证书序列号 |
| `PAY_WECHAT_PUBLIC_KEY_ID` | 微信支付公钥 ID（应答与通知只认它） |
| `PAY_WECHAT_PRIVATE_KEY_FILE`、`PAY_WECHAT_APIV3_KEY_FILE`、`PAY_WECHAT_PUBLIC_KEY_FILE` | `/run/couli-pay/` 下的文件路径 |
| `PAY_WECHAT_TEST_MERCHANT` | 必须是 `1`：声明这是测试商户（BR-PAY-08 ②），否则微信不可用 |
| `PAY_ALIPAY_APPID`、`PAY_ALIPAY_SELLER_ID` | 沙箱应用的 app_id、卖家 id |
| `PAY_ALIPAY_PRIVATE_KEY_FILE` | `/run/couli-pay/` 下的文件路径 |
| `PAY_ALIPAY_PUBLIC_KEY_FILE`，或 `PAY_ALIPAY_APP_CERT_FILE`、`PAY_ALIPAY_PUBLIC_CERT_FILE`、`PAY_ALIPAY_ROOT_CERT_FILE` | `/run/couli-pay/` 下的文件路径（设了任何一个证书变量就按证书模式，三件都要） |
| `PAY_ALIPAY_GATEWAY` | 沙箱网关的 https 地址，不得是生产网关，否则支付宝不可用；地址未实测 |

- 密钥文件只在入口启动时读一次；换文件要重启。
- 这一节只适用于 staging。prod 不读任何 `PAY_*_FILE`（裁定 D10-554）：密钥从 KMS 读（B1-30a，见 `specs/pay-channels-launch-checklist.md`），没配 KMS 时两个渠道都不可用（`kms_unavailable`），不要照这里的做法把密钥文件放到 prod 节点。
- `pay.enabled` 与渠道开关仍是关（BR-PAY-09）：切到真实通道也不等于开放收款。

### 1.10 淘宝接线与三平台切 live

依据 approvals 第 43 条（staging 连真实联盟：淘宝、京东、拼多多）。本节先给淘宝的节点文件与变量，再给三平台一起切 live 的步骤。1.5 与 1.8 的准备照旧，本节在它们之上做。

注：1.5 写的「pdd 切 live 暂不可用 — blocked on 真实返利报价器（B2-03）」已由 B2-03d / B2-03n 解除：真实返利报价器已经接入，pdd 可以随本节一起切 live。

#### 淘宝节点文件

compose 给 admin、api、stream 与 worker（装配联盟模块的四个入口）只读挂载节点目录 `/etc/couli-taobao`（容器内 `/run/couli-taobao`）；payout 不挂。这个挂载可缺：节点没有该目录时部署照常进行，`deploy.sh` 也不检查它。

节点文件由负责人放入（容器以 uid 1000 运行）：

| 节点路径 | 内容 | 属主与权限 |
| --- | --- | --- |
| `/etc/couli-taobao/` | 目录 | 属主 1000，目录 500 |
| `/etc/couli-taobao/app_secret` | 淘宝联盟（阿里妈妈）应用的密钥原文，文件里只放这一个值 | 属主 1000，文件 400 |

密钥内容不得出现在命令行里（会进 shell 历史和进程列表），也不得放进环境变量或 `staging.env`；用编辑器打开文件粘贴后保存，不要用 `echo` / `printf` 写入密钥。准备步骤（root 执行）：

```sh
install -d -m 700 /etc/couli-taobao
vi /etc/couli-taobao/app_secret
chown -R 1000:1000 /etc/couli-taobao
chmod 400 /etc/couli-taobao/app_secret
chmod 500 /etc/couli-taobao
```

#### 淘宝变量

先放好上面的文件，再在 `/etc/couli/staging.env` 设下面三个变量（值只写在节点上，不进仓库，也不写进本文档）：

| 变量 | 取值 |
| --- | --- |
| `TAOBAO_APP_KEY` | 淘宝联盟应用的 app key（不是密钥） |
| `TAOBAO_APP_SECRET_FILE` | `/run/couli-taobao/app_secret`（容器内路径；只写路径，不写密钥内容） |
| `TAOBAO_SEARCH_SOURCE` | 商品搜索来源，三选一：`official`（官方接口）、`dataoke`（大淘客）、`official_first`（先官方，需要大淘客凭据，否则启动失败）；未设即 `official` |

- `TAOBAO_APP_KEY` 与 `TAOBAO_APP_SECRET_FILE` 要么都设、要么都不设：只设一个时 admin、api、stream 与 worker 启动即失败。
- 端点是 demo 时应用不打开密钥文件，所以文件读不到或内容为空要到切 live 后才暴露：那时这四个入口启动即失败。
- `TAOBAO_SEARCH_SOURCE` 设为 `dataoke` 而没配 `DATAOKE_APP_KEY`、`DATAOKE_APP_SECRET_FILE` 这两项时，四个入口照常启动、不报错，但淘宝搜索全部失败，不会自动改走官方；只有 `official_first` 缺大淘客凭据时拒绝启动。要用大淘客搜索，须先在 `staging.env` 配齐这两项（两项要么都设、要么都不设）；否则把 `TAOBAO_SEARCH_SOURCE` 设为 `official` 或不设。

#### 三平台切 live

顺序：先放好三家密钥文件与三个 live 端点文件，再在 `staging.env` 设变量，再跑 `deploy.sh <标签>`。不能反过来。

1. 三家密钥文件：`/etc/couli-taobao/app_secret`（本节上文）、`/etc/couli-jd/app_secret`（1.8）、`/etc/couli-pdd/client_secret`（1.5）。
2. 三个端点文件：改现有的 `/etc/couli-pdd/union-endpoints/` 下的 `jd.json`、`pdd.json`、`taobao.json`，把 `"mode": "demo"` 改成 `"mode": "live"`，并把 `baseUrl` 从 `null` 改成该联盟网关的 https 地址（live 的 baseUrl 必须是 https，否则启动失败）。形如 `{"platform":"jd","mode":"live","baseUrl":"https://<联盟网关>","quotaKey":"account:jd"}`。改完按 1.5 保持属主 1000、文件 400、目录 500。镜像内的 `config/union-endpoints/*.json` 保持 demo，不改。
3. 三个端点文件缺一个时，admin、api、stream 与 worker 四个入口启动即失败（不会退回镜像内的端点）。`UNION_ENDPOINT_OVERRIDE_DIR` 维持 1.5 的 `/run/couli-pdd/union-endpoints`，不改。
4. 变量：在 `/etc/couli/staging.env` 设齐淘宝三项（上文）、京东三项（1.8）、拼多多三项与 `UNION_ENDPOINT_OVERRIDE_DIR`（1.5）。
5. 部署：`deploy.sh <标签>`，然后按 1.8 的 CHK-JD-STAGING-CRED 人工核对变量都已设。

#### 真实返利报价器的配置

live 下 api 用真实返利报价器（B2-03d / B2-03n），它读下面三个配置键；缺任何一项时报价失败：

| 配置键 | 说明 |
| --- | --- |
| `tech_fee_bp` | 技术服务费比例（万分之一整数），按平台分项，每个平台都要有 |
| `rebate.taobao.compare_rate_ratio_bp` | 淘宝比价用的佣金比例系数（万分之一整数） |
| `commission.platforms` | 参与分佣的平台列表 |

- `tech_fee_bp` 与 `rebate.taobao.compare_rate_ratio_bp` 要先在 staging 配好（取值由负责人定，本文不写），再切 live。
- `commission.platforms` 已在种子里（`db/seeds/0002_commission-rules.sql`），部署时种子会写入，不用另配。
- 拼多多商品另读 `union.pdd.self_buy_factor_bp`、`union.pdd.account_level_factor_bp` 两个系数键（万分之一整数）：种子里已有（`db/seeds/0002_commission-rules.sql`），但只是待核实的占位值；而且这两个键还不在 config 登记表里，后台改不了，要改得走登记任务（FU-PDD-FACTOR-REGISTRY）。
- 报价要求有一条已发布的分佣规则版本：种子里已有一条（`db/seeds/0002_commission-rules.sql`），部署时种子会写入，不用另发布。
- `tech_fee_bp` 与 `rebate.taobao.compare_rate_ratio_bp` 现在可以经后台（config.business，B2-03t 已登记）修改：在后台改好取值后再切 live。

### 1.11 测试手机号与固定验证码（只在 staging）

依据 approvals 第 48 条、编排裁定 D10-611（B1-02zza）。名单里的号码在 App 内短信登录与敏感操作二次验证（step_up）时不发真短信，验码时认节点文件里的固定码；其余规则照旧：随机码照常生成并存储，60 秒 / 每小时 5 条 / 每天 10 条等频控、黑名单、人机验证与设备 / IP 限额都不放宽，固定码同样 5 分钟内有效、只能用一次、错 5 次作废，而且每次都要先发码。绑定手机号与落地页注册不受影响，仍然发真短信、不认固定码。**只在 `APP_ENV=staging` 生效**：其他环境设了下面任何一个变量都拒绝启动。号码与码都不写进本仓库。

#### 节点文件

compose 只给 api 只读挂载节点目录 `/etc/couli-staging-test`（容器内 `/run/couli-staging-test`）；stream、worker、admin、payout 都不挂。这个挂载可缺：节点没有该目录时部署照常进行，`deploy.sh` 也不检查它；但只要设了下面两个变量，api 就要求能读到文件，读不到即启动失败。

| 路径 | 内容 | 权限 |
| --- | --- | --- |
| `/etc/couli-staging-test/` | 目录 | 属主 1000，目录 500 |
| `/etc/couli-staging-test/sms_code` | 固定验证码，文件里只放 6 位数字（可带一个结尾换行），不放别的 | 属主 1000，文件 400 |

```bash
install -d -m 700 /etc/couli-staging-test
vi /etc/couli-staging-test/sms_code
chown -R 1000:1000 /etc/couli-staging-test
chmod 400 /etc/couli-staging-test/sms_code
chmod 500 /etc/couli-staging-test
```

文件必须是普通文件（不能是目录、管道或设备），内容不是正好 6 位数字时 api 拒绝启动；报错只写变量名与原因，不带路径和内容。

#### 变量

在 `/etc/couli/staging.env` 里**两个一起设或都不设**，只设一个即拒绝启动：

| 变量 | 取值 |
| --- | --- |
| `STAGING_TEST_PHONES` | 测试号码，英文逗号分隔，11 位大陆手机号（不带 +86），1 到 10 个，不重复、不留空项 |
| `STAGING_TEST_SMS_CODE_FILE` | `/run/couli-staging-test/sms_code`（容器内路径；只写路径，不写码） |

具体号码见私有仓库的说明，不写在这里。启用时 api 启动打一条 warn `staging_test_phones_enabled`，只带号码个数。每次测试号登录或 step_up 成功，api 写一条审计日志 `staging_test_phone_login`（purpose、is_new_user、打码后的号码、user_id），不带完整号码和码。

#### 轮换与停用

- 换固定码：改 `/etc/couli-staging-test/sms_code` 后重启 api（`docker compose -f infra/staging/compose.yaml --env-file /etc/couli/staging.env restart api`，或重新部署）；api 只在启动时读一次文件。
- 增减号码：改 `staging.env` 里的 `STAGING_TEST_PHONES` 后重新部署（第 3 节）。
- 停用：从 `staging.env` 删掉两个变量后重新部署；节点目录可以留着，也可以删。

### 1.12 配置签名私钥（bridge_origins 签名白名单）

依据编排裁定 D10-608 / D10-610 / D10-612（F1-02zzzb）。`/v1/config` 的 `bridge_origins` 是 api 用 ES256 签过名的白名单（契约 `ConfigBridgeOrigins`），App 用包里带的公钥验签，验不过就不用。签名私钥只给 api，和访问令牌私钥（1.4）**分开**，不要复用同一把。**api 在 staging 没有这把私钥就拒绝启动**，所以合入这项改动之后的第一次部署之前，要先把下面的文件和变量准备好。

#### 节点文件

compose 只给 api 只读挂载节点目录 `/etc/couli-config-sign`（容器内 `/run/couli-config-sign`）；stream、worker、admin、payout 都不挂。挂载带 `create_host_path`，目录不存在不会让挂载本身失败，但 api 读不到私钥照样拒绝启动。

| 路径 | 内容 | 权限 |
| --- | --- | --- |
| `/etc/couli-config-sign/` | 目录 | 属主 1000，目录 500 |
| `/etc/couli-config-sign/es256.pem` | PKCS#8 格式（首行标签 `BEGIN PRIVATE KEY`，不带 `EC`）的 P-256 私钥，不加密 | 属主 1000，文件 400 |

```bash
install -d -m 700 /etc/couli-config-sign
(umask 077 && openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out /etc/couli-config-sign/es256.pem)
chown -R 1000:1000 /etc/couli-config-sign
chmod 400 /etc/couli-config-sign/es256.pem
chmod 500 /etc/couli-config-sign
```

核对曲线用 `openssl pkey -in /etc/couli-config-sign/es256.pem -noout -text_pub`（只打印公钥，应看到 `prime256v1` 或 `P-256`）。要放进 App 包里的公钥用 `openssl pkey -in /etc/couli-config-sign/es256.pem -pubout` 导出，交给三端，和 kid 一起登记。文件必须是普通文件；读不到、不是 P-256 私钥（RSA、P-384、只有公钥、乱码）时 api 拒绝启动，报错只写变量名，不带路径和内容；私钥不进日志。

#### 变量

在 `/etc/couli/staging.env` 里**两个一起设**；只设一个，或两个都不设，api 都拒绝启动：

| 变量 | 取值 |
| --- | --- |
| `CONFIG_SIGN_KEY_FILE` | `/run/couli-config-sign/es256.pem`（容器内路径） |
| `CONFIG_SIGN_KEY_ID` | kid，只能用字母、数字和 `.` `_` `~` `-`，1 到 64 个字符；用用途加环境加年月，例如 `config-staging-2026-11` |

api 只在启动时读一次私钥文件。本地与测试环境不设这两个变量时，每次启动临时生成一对（App 验不过是正常的）。prod 改走 KMS，是上线前的负责人事项，不在这里。

#### 换钥顺序

App 包里按环境带两把公钥（「现用」和「下一把」）。换钥按这个顺序，不要倒过来：

1. 生成新私钥（新文件名，例如 `es256-next.pem`，权限同上），导出公钥，连同新 kid 交给三端，作为「下一把」随新包发布；
2. 等带新公钥的包覆盖到足够多的用户后，把 `staging.env` 里的 `CONFIG_SIGN_KEY_FILE` 改成新文件、`CONFIG_SIGN_KEY_ID` 改成新 kid，重新部署（第 3 节）。之后同一配置版本的签名会换一次（kid 变了），`/v1/config` 的 ETag 也随之变一次；
3. 确认没有只认旧公钥的包在用之后，删掉旧私钥文件，三端在下一版里把旧公钥移出、新公钥变成「现用」。

### 1.13 阿里云内容安全（Agent 审核）

依据编排裁定 D10-1288 / D10-1290（B1-01zzu）。在 `/etc/couli/staging.env` 设下面三个变量，stream 入口的 Agent 输入审核与逐句审核就走阿里云内容安全。**三个齐全才启用**；缺任一（未设或空串）时维持现状（fail-closed）：每条消息都按「审核不可用」拒答，逐句审核一律按超时处理，不发任何网络请求。只设 ID 与 Secret 中的一个、或接入点不是 https 地址时，读 `staging.env` 的入口在启动时配置校验不过、拒绝启动（报错只写变量名）。

| 变量 | 取值 |
| --- | --- |
| `AGENT_REVIEW_ALIYUN_ACCESS_KEY_ID` | 阿里云 AccessKey ID，只含字母和数字 |
| `AGENT_REVIEW_ALIYUN_ACCESS_KEY_SECRET` | 阿里云 AccessKey Secret，只含字母和数字 |
| `AGENT_REVIEW_ALIYUN_ENDPOINT` | 内容安全的 https 接入点，例如 `https://green-cip.cn-beijing.aliyuncs.com` |

- 1.2 说过 `deploy.sh` 会对整个 `staging.env` 做 `$` 展开：三个值里都不能有 `$`；ID 与 Secret 只用字母和数字，接入点不含空白、`$` 与引号，都不加引号。
- `APP_ENV` 为 local 或 test 时设了两个 AccessKey 变量中的任何一个都会拒绝启动；本地 `.env` 不放它们。
- **应用没有专门的「审核已配置」启动日志**（不像 1.6 的 `sms_sender_live`）：启动日志看不出审核接没接通。接通与否只能部署后用合成文本实测：发一条普通的合成消息，能正常得到回答即已接通；仍按「审核不可用」拒答，说明三个变量没有齐全读到（或接入点、密钥不对）。

#### 值放在哪里、谁来同步

三个值只存在负责人本机的 `~/.couli/aliyun-review.env`（属主本人、权限 600，只放这三行，可以有空行和 `#` 注释），由 ops 用本目录的 `sync-aliyun-review.sh` 写进节点的 `/etc/couli/staging.env`。各开发线、评审与其他会话都不读这个文件，也不读节点上的 `staging.env`；值不进本仓库、不进任何日志与对话。

脚本只用 shell 内建处理值：值不出现在任何命令的参数、进程列表、shell 历史与输出里，只经 ssh 的标准输入传到节点；节点上执行的是脚本里一段固定的命令（不含值），目标路径作为它的参数。脚本显式关闭命令跟踪，任何输出只有键名、yes/no、ok/bad、行号、步骤与原因。

```sh
infra/staging/sync-aliyun-review.sh --check
infra/staging/sync-aliyun-review.sh --apply <staging 节点> [--identity <私钥文件>]
```

- `--check`：只在本机核对，不连节点。核对文件存在、是普通文件、权限恰好 600；三个键各恰好一行（写成「变量名=值」，等号前后不留空格）；除这三个键外只有空行和 `#` 开头的注释；ID 与 Secret 非空、只含字母和数字；接入点以 `https://` 开头、不含空白、`$` 与引号。每个键打印一行 `present=yes/no format=ok/bad`，文件打印一行 `exists / regular / mode600`，最后一行 `check: ok` 或 `check: failed`（失败退出码 1；格式不对的行只报行号）。
- `--apply`：先做同样的核对，不过就不连节点；通过后以 `ssh [-i <私钥文件>] <节点>` 连到节点，以 root 执行。参数写错退出码 2，节点上的步骤没有完成退出码 3。

节点上的步骤（任何一步失败都不动目标文件，不留新文件）：

1. 要求 `/etc/couli/staging.env` 已存在、是普通文件（不是链接）、属主就是执行者（root）、权限 600；旁边不能有上次留下的备份 `staging.env.bak-sync-aliyun-review`（有就先人工核对再删）；
2. 从标准输入读三行，只认这三个键、各一行、格式同上；目标文件里这三个键中任何一个出现多于一行时直接退出，先人工合并成一行；
3. 在同一目录留备份 `staging.env.bak-sync-aliyun-review`（同属主、权限 600）；
4. 在同一目录生成临时文件（权限 600）：逐行复制原文件，遇到这三个键的行原位换成新行，原来没有的键追加在末尾，其余行（注释、空行、别的变量）一字不动；原文件末行没有换行时补一个。写的过程中任何一处出错（例如磁盘满）都直接退出，删掉临时文件和备份，不改名；
5. 改名之前先把临时文件与原文件逐行比对：行数等于原行数加追加数，其余行逐字相同，键行是对应的新行，末尾追加的恰好是原来缺的键；不符就退出、不改名。比对通过后把临时文件改名到 `staging.env`（原子替换），再核对三个键各一行、属主与权限 600 都对，然后删备份；这一步核对不过就用备份改名回去；
6. 打印一行 `apply: <目标文件>: replaced <n>, added <m>, other lines unchanged; backup removed`。

同步只改了文件，正在运行的进程不会读到新值。同步之后按第 3 节用**当前在跑的标签**重新部署一次（`deploy.sh <当前标签>`），再按上面的方法用合成文本实测。轮换密钥：本机文件换成新值后重跑 `--check`、`--apply`，再重新部署；停用：从 `staging.env` 删掉三行后重新部署，回到 fail-closed。

## 2. 在开发机构建并传到节点

在代码仓库根目录：

```sh
TAG=$(git rev-parse --short=12 HEAD)
docker buildx build --platform linux/amd64 -f infra/staging/Dockerfile -t couli-api:$TAG --load .
docker save couli-api:$TAG | gzip | ssh <staging 节点> 'gunzip | docker load'
scp infra/staging/compose.yaml infra/staging/deploy.sh <staging 节点>:/opt/couli/staging/
```

标签用提交号，不用 `latest`。节点连不上 Docker Hub 以外的部分源，所以镜像一律在开发机构建后 `docker save | ssh … docker load` 传过去，节点上不构建、不拉取（compose 里 `pull_policy: never`）。

## 3. 部署

在节点上以 root 运行：

```sh
/opt/couli/staging/deploy.sh <标签>
```

脚本依次打印每一步结果：

1. 检查镜像已经 `docker load` 到节点，检查第 1 节列出的节点文件都存在；
2. 用新镜像一次性运行迁移（`node packages/db/scripts/migrate.ts`，只读 `staging-migrator.env`，挂载数据库 CA），迁移成功后在同一个一次性容器里接着跑种子（`node packages/db/scripts/seed.ts`，按文件名顺序执行 `db/seeds/*.sql`，同样只读 `staging-migrator.env`、挂载数据库 CA）；种子可重复执行，所以每次部署（包括重复部署同一标签）都会再跑一遍，健康失败后的自动回退不再跑迁移和种子；迁移失败或种子失败都直接停下、非零退出，不切换进程，正在运行的进程不受影响，也不记录标签；迁移和种子脚本出错时只打印错误类型和去掉口令的消息，日志里的连接串也去掉口令；
3. `docker compose up -d --force-recreate --wait` 重建全部五个进程并等五个健康检查都通过（上限 240 秒）：api / stream / admin 要求本进程 `/healthz` 返回 2xx，worker 与 payout 要求依赖探测通过（第 7 节），五个进程都要求容器已连续运行 30 秒，并且在本次部署被标记为稳定（`/tmp/couli-settled`）之前**只启动过一次**。`boot.mjs` 每次进程启动往容器内 `/tmp/couli-starts` 追加一行：这个文件在容器的可写层里，自动重启后还在，重建容器后清空。所以本次部署中任何一个进程（包括没有端口的 worker 与 payout）哪怕只崩溃、重启过一次，健康检查就一直不通过，这一步失败并回退。健康检查自己不写稳定标记，崩溃重启过的进程以后一直不健康；但 `up --wait` 对已经见过健康的服务不一定再看一遍，所以从任一服务首次健康后到 `up --wait` 返回这一整段里发生的崩溃重启，这一步可能发现不了，要靠第 4 步核对；
4. 五个都健康后，再用 `docker inspect` 核对五个容器的 RestartCount 都是 0；通过后才往五个容器里写 `/tmp/couli-settled`（以后节点重启等情况下的自动重启只需重新等 30 秒，不会一直不健康），然后先把这次用的 `compose.yaml` 存一份为 `/var/lib/couli/compose.<标签>.yaml`（先写临时文件再改名到位；磁盘满等原因写不成时脚本就此失败，标签不记录，上一个成功标签和它的副本仍可用来回退），再把新标签写入 `/var/lib/couli/staging-api.tag`；
5. 删除更早的 `couli-api` 镜像和对应的 compose 副本，只保留本次和上一次成功的标签（回退要用），避免写满与数据库共用的 20G 系统盘。本次标签与上一次成功的标签相同（重复部署同一版本）时不删任何镜像，之前留下的回退镜像保留。

脚本不打印任何环境文件的内容，也不开启命令跟踪。

健康判定的边界：worker 与 payout 没有端口，健康检查除了「进程只启动过一次、连续活了 30 秒」，还会实际探一次依赖（见第 7 节）：连不上数据库（worker 还有 Redis）就不健康，这一步失败并回退；但它看不到队列是否已经开始消费，部署后仍要看日志确认。第 4 步核对 RestartCount 不为 0（崩溃发生在任一服务首次健康后到 `up --wait` 返回这一段里）时，脚本不记录标签、以非零退出并提示手动回退命令 `deploy.sh <上一个成功标签>`，不会自动回退（自动回退只挂在第 3 步的切换结果上），这时要按第 4 节手动回退。已有成功标签时，切换记录保持「不确定」（切换中途出错退出或被中断也一样）：在下一次部署成功之前，`deploy.sh <标签>` 一律用该标签存下的 `/var/lib/couli/compose.<标签>.yaml`，没有这份副本就在迁移和切换之前拒绝并说明；全新 staging（还没有任何成功标签）不做这个标记，可以直接用当前 `compose.yaml` 重试。脚本结束之后才发生的崩溃要靠看状态发现。

## 4. 回退

- **自动回退**：第 3 步健康检查不通过时，脚本把五个进程切回状态文件里记录的上一个成功标签，再等一次健康检查，然后以非零退出。回退用该标签成功部署时存下的 `/var/lib/couli/compose.<标签>.yaml`（旧镜像不一定配得上新版 compose）；没有这份副本（例如该标签是本版本脚本之前部署的）时用脚本旁当前的 `compose.yaml` 并如实打印，不会沿用失败那次部署选用的别的标签的副本。首次部署没有上一个标签，脚本只报错退出，容器保留用于排查。
- **手动回退**：直接用旧标签再部署一次，`deploy.sh <旧标签>`。该标签成功部署时存下的 `/var/lib/couli/compose.<旧标签>.yaml` 还在时就用它（与自动回退一致）；不在时用脚本旁当前的 `compose.yaml`，并打印一行说明。第 4 步 RestartCount 不为 0 之后按提示执行的 `deploy.sh <上一个成功标签>` 也算回退（这时在跑什么不确定），同样用存下的副本；即使失败的正是重部署当前标签（例如改了 `compose.yaml`），也用存下的旧副本，不再用改过的 `compose.yaml`。这次回退成功后，再跑一次 `deploy.sh <当前标签>` 才会重新用脚本旁的 `compose.yaml`。
- **「不确定」时上一个成功标签没有副本**：只用本版本之前的脚本部署过的节点（当前 staging 就是这样）没有任何 `compose.<标签>.yaml`。这时切换记录为「不确定」，`deploy.sh <标签>` 会被拒绝，拒绝时列出现有副本可以部署的标签。唯一的出路是：先把脚本旁的 `compose.yaml` 恢复成与上一个成功标签配套、确认可用的版本，再运行 `deploy.sh <上一个成功标签> --with-current-compose`。脚本会打印警告后用脚本旁的 `compose.yaml` 部署，成功后存为该标签的副本。这个参数只在三个条件同时成立时接受：切换记录为「不确定」、请求的是上一个成功标签、该标签没有存下的副本。其他任何情况（现场不是「不确定」、全新节点没有成功标签、请求的不是上一个成功标签、该标签已有副本）带了这个参数，脚本都在选用 compose 文件和迁移之前报错退出（退出码 2），一条提示里写全三个条件并指出哪几条不满足，不会静默忽略这个参数；去掉参数按上面的规则重新运行即可。
- **重部署当前版本**：请求的标签既是上一次成功的标签、又是切换记录里当前在跑的标签时（没有切换记录或标记为「不确定」都不算），不算回退：脚本用脚本旁当前的 `compose.yaml`（不用存下的副本），成功后把它重新存为该标签的副本。所以只改了 `compose.yaml` 时，把它放到节点上再跑一次 `deploy.sh <当前标签>` 即可生效。
- 迁移只向前执行，回退不会撤销已经执行的迁移；新迁移必须与上一个版本的代码兼容（先加后删）。

## 5. 看状态与日志

```sh
cd /opt/couli/staging
docker compose -f compose.yaml --env-file /etc/couli/staging.env ps
docker compose -f compose.yaml --env-file /etc/couli/staging.env logs --since 30m api
cat /var/lib/couli/staging-api.tag
```

`docker compose` 需要 `COULI_API_TAG` 才能解析镜像名，手工执行前先 `export COULI_API_TAG=$(cat /var/lib/couli/staging-api.tag)`。日志用 json-file 驱动，每个容器最多保留 5 个 20 MB 的文件。

## 6. 资源上限

五个服务在 `compose.yaml` 里各有三项硬上限：`cpus`（最多用几个核）、`mem_limit`（内存上限，超出由内核在该容器内结束进程，容器按 `restart: unless-stopped` 重启）、`pids_limit`（容器内进程与线程总数上限，挡住失控的线程或子进程把整机拖垮）。

| 进程 | cpus | mem_limit | pids_limit |
| --- | --- | --- | --- |
| api | 1.0 | 768m | 256 |
| stream | 0.5 | 512m | 256 |
| worker | 1.0 | 768m | 256 |
| admin | 0.5 | 512m | 256 |
| payout | 0.5 | 384m | 256 |
| 合计 | 3.5 | 2944m | — |

取值理由：

- 节点容量：staging 是一台 4 核 8G 的机器，数据库（Pigsty：PostgreSQL、etcd、监控栈）和 Redis 与这五个进程同机；首装后整机内存占用约 2.1G（规划仓库 `docs/changes/20261007-部署精简与数据库单节点.md`、ADR-0002 §10 第 7 项）。按 ADR-0002，Redis 的最大内存设为 2GB，它会随使用涨上去，所以按「8G − 2.1G − Redis 余量约 2G」留给应用约 3.9G，五个进程合计 2944m，余下的给系统、Docker 和一次性的迁移容器。
- 内存：api 与 worker 承担主要请求和全部队列任务，各 768m；stream（SSE 长连接）与 admin（后台，连接池最小）各 512m；payout 只处理打款队列、不连 Redis，384m。
- CPU：上限合计 3.5 核，不超过 4 核，给数据库至少留出半个核；`cpus` 是上限不是预留，空闲时不占。
- pids：Node 进程本身约十几个线程，每次健康检查还会再起一个 `node` 进程；256 远高于正常用量，只用来挡失控。
- 这些数值来自规划里记录的节点规格和首装占用，**还没有在节点上实测**：上线后用 `docker stats --no-stream` 看各容器实际占用，再连同 `nproc`、`free -m` 的结果回写本表。哪个进程长期贴近上限（内存超过上限的 80%，或 `docker inspect` 里出现 `OOMKilled: true`）就调本表；整机放不下时要拆分或加机器，那是另外的决定（负责人定）。
- 改数值：同时改 `compose.yaml` 与本表（规则测试核对两者一致），然后按第 4 节「重部署当前版本」跑一次 `deploy.sh <当前标签>` 生效。

## 7. 依赖不通时的表现

worker 与 payout 没有端口，它们的健康检查除了启动次数与 30 秒存活（第 3 节第 3 步）之外，每次（每 10 秒）还会在容器内运行一次镜像里构建好的探测程序 `apps/api/dist/modules/health/staging-dependencies.js`，用这个容器自己的连接串去连依赖：

- worker 会对自己的 PG 数据库执行一次 `SELECT 1`，并对 Redis 发一次 `PING`，两项都成功才算健康；连接串缺失也算失败，不会退回默认库或默认 Redis。
- payout 只探自己的 PG 数据库（payout 角色、`staging-payout.env` 里的连接串），payout 不探 Redis，也不连 Redis（ADR-0001 §4.2 第 20 项），即使环境里有 Redis 地址也不读。
- 每一步（连接、查询或 PING、断开）最多等 1.5 秒，超时、拒绝连接、证书校验失败都算失败。连接串原样交给驱动（口令不改动），带 `sslmode=verify-ca` 时按 libpq 语义校验 CA 证书链、不校验主机名，与应用自身的处理一致；节点上的连接串不用为此改动。
- 探测失败时这一次健康检查以非零退出，连续 3 次（约 30 秒）失败后 Docker 把容器标为 unhealthy。健康检查不重启进程，restart 策略不变：进程本身没有崩溃就一直跑着，等依赖恢复后下一次探测成功即回到 healthy。
- 部署时：`docker compose up --wait` 要等五个都 healthy，依赖不通的 worker / payout 一直 unhealthy，第 3 步因此失败并自动回退（第 4 节）。回退后的旧版本没有这项探测时可能显示健康，所以回退成功不代表依赖已经恢复，要先修好数据库或 Redis 再重新部署。
- 运行中：数据库或 Redis 中途不通时，`docker compose ps` 会显示对应容器 unhealthy；探测程序不打印连接串，也不打印驱动的错误消息，原因要看数据库、Redis 本身和进程日志。
- api / stream / admin 的健康检查不变，仍只看本进程的 `/healthz`。

## 8. 链路追踪（B1-31）

api / stream / worker 三个进程把 OpenTelemetry 链路以 OTLP/HTTP 导出到 Pigsty 节点自带的 VictoriaTraces（02 §13；只用于排障，不作资金判定依据，单节点期不承诺留存）。admin、payout 不导出。

- 开关：在节点上的 env 文件（§1.2 的写法）里给这三个进程加 `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=<VictoriaTraces 的 OTLP/HTTP 接收地址>`（形如 `http://<pigsty>:10428/insert/opentelemetry/v1/traces`，以 Pigsty 实际配置为准）；可选 `OTEL_TRACES_SAMPLER_ARG`（0..1 的采样比例，默认 1）与 `OTEL_SERVICE_NAME`（默认 `couli-<entry>`）。**不设即不导出、不装插桩**，进程行为与之前完全一样；删掉变量再 `deploy.sh` 即关闭。
- 对请求零影响：导出失败只计数并每分钟最多记一条 `otel_export_failed`（含 error_name 与 count），不会抛到请求或任务；进程退出时最多等 2 秒把未发出的 span 发完。
- 查一条链路：请求的响应头 `X-Trace-Id`（也是日志行的 `reqId`、错误信封的 `trace_id`）就是链路 id 的 UUID 写法；在 VictoriaTraces / Grafana 里按去掉连字符的 32 位十六进制查即可看到 api → pg → 外部 HTTP 的 span（server span 另带 `couli.trace_id` 属性为原 UUID）。span 只带方法、路径、状态码，不带请求体、查询参数值、鉴权头或数据库口令。
- 验收（B1-31）：部署后发一条真实请求，按其 `X-Trace-Id` 在 VictoriaTraces 查到 api → pg → 外部依赖的 span，且日志行 `reqId` 一致。VictoriaTraces 是否已开、接收地址是什么，待负责人 / ops 确认后填入 env 文件。

## 9. 业务告警（B1-25a / B1-25b / B1-25c）

新 staging 是 Pigsty slim 单节点，节点上已由 ops 装好 VictoriaMetrics 单机、vmagent、vmalert、couli 专用 Alertmanager、pg_exporter 与 redis_exporter（都只听 127.0.0.1）。数据库与主机的告警仍走 Pigsty 自带的一套（vmalert、Alertmanager :9059、/infra/rules），本节不动它。

### 9.1 组件与端口

| 组件 | systemd 单元 | 监听 | 仓库里的配置 |
| --- | --- | --- | --- |
| VictoriaMetrics 单机（节点已有） | — | 127.0.0.1:8428 | — |
| couli vmagent：抓 api / worker / admin 的 /metrics（METRICS_PORT 9461 / 9462 / 9463），并接收容器健康推送 | couli-vmagent | 127.0.0.1:8429 | `infra/monitoring/scrape/vmagent.args`、`couli.yml` |
| 第二个 vmagent：只抓 pg_exporter（127.0.0.1:9630）与 redis_exporter（127.0.0.1:9121） | couli-vmagent-exporters | 127.0.0.1:8430 | `infra/monitoring/scrape/vmagent-exporters.args`、`exporters.yml`、`couli-vmagent-exporters.service` |
| couli vmalert：业务规则 `couli.yaml` 与资金规则 `couli-fund.yaml` | couli-vmalert | 127.0.0.1:8881 | `infra/monitoring/vmalert/couli.args` |
| 第二个 vmalert：宕机规则 `outage.yaml` | couli-vmalert-outage | 127.0.0.1:8882 | `infra/monitoring/vmalert/outage.args`、`couli-vmalert-outage.service` |
| couli Alertmanager：分流 finance / oncall、夜间静默、30 分钟合并 | couli-alertmanager | 127.0.0.1:9093 | `infra/monitoring/alertmanager/alertmanager.yml` |
| 群机器人转发器：Alertmanager webhook → 企业微信群机器人 markdown | couli-alert-forwarder | 127.0.0.1:9097 | `infra/monitoring/forwarder/webhook.ts`、`couli-alert-forwarder.service` |
| 容器健康推送：每 60 秒 `docker inspect` 五个 couli-staging-* 容器，推 `couli_container_healthy{name}` 到 couli vmagent | couli-container-health.timer / .service | 不监听 | `infra/monitoring/scripts/container-health.ts`、`couli-container-health.timer`、`couli-container-health.service` |
| 本地兜底：只记日志的接收端（可不跑） | 容器 couli-alert-sink | 127.0.0.1:9096 | `infra/monitoring/alertmanager/log-sink.mjs` |

- 两个 vmagent 写同一个 VictoriaMetrics，两个 vmalert 读同一个 VictoriaMetrics、通知同一个 couli Alertmanager；第二个 vmagent 的持久队列目录是 `/var/lib/couli-vmagent-exporters`，不和 couli vmagent 的 `/var/lib/couli-vmagent` 共用。
- 新加的四个单元都设了 MemoryMax（转发器 128M、第二个 vmagent 256M、第二个 vmalert 128M、容器健康推送 96M），都以 systemd 动态用户运行。转发器与容器健康推送用节点上的 Node 24 直接跑 `.ts` 文件（`/usr/bin/node`）；节点没有 Node 24 时要先由 ops 装好。
- 容器健康推送在节点上跑，不在任何容器里，也不给容器挂 docker.sock；它只读 `docker inspect`，运行时属 docker 组。容器在跑且健康检查是 healthy 记 1，其余（停止、启动中、unhealthy、不存在）记 0；推送被 vmagent 拒收时这次运行以非零退出（`systemctl status couli-container-health.service` 可见）。

### 9.2 文件位置

- 配置、规则、脚本的副本放 `/opt/couli/alerting/`，目录结构与仓库 `infra/monitoring/` 相同（`alertmanager/`、`forwarder/`、`rules/`、`scrape/`、`scripts/`、`vmalert/`）。
- 各 `.service` / `.timer` 复制到 `/etc/systemd/system/` 后 `systemctl daemon-reload`，再 `systemctl enable --now couli-alert-forwarder couli-vmagent-exporters couli-vmalert-outage couli-container-health.timer`；改了 `alertmanager.yml` 要重启 couli-alertmanager，改了规则或参数要重启对应的 vmalert / vmagent。
- 部署与演练脚本在 ops 的私有目录，结果记在私有运维手册。

### 9.3 Webhook 文件（群机器人地址）

- 两个群各建一个群机器人（企业微信群 → 添加群机器人），把它给出的 Webhook 地址各放进一个节点文件，文件里只放这一行：

| 节点路径 | 内容 | 属主与权限 |
| --- | --- | --- |
| `/etc/couli-alerting/` | 目录 | root，目录 700 |
| `/etc/couli-alerting/wecom-finance-webhook` | 财务群机器人的 Webhook 地址（资金类告警） | root，文件 600 |
| `/etc/couli-alerting/wecom-oncall-webhook` | 值班群机器人的 Webhook 地址（全部告警） | root，文件 600 |

- 地址里带着群机器人的 key，谁拿到都能往群里发消息：不进仓库、不写进本文档、不出现在命令行里；用编辑器打开文件粘贴后保存，不用 `echo` / `printf` 写入。
- 转发器每收到一次告警都重新读这两个文件（systemd 的 LoadCredential 在启动时把副本交给进程），换机器人后 `systemctl restart couli-alert-forwarder` 即生效。
- 地址与 key 不会出现在转发器的日志、群消息正文、报错与退出信息里，推送失败时也一样；日志只记接收组、尝试次数与固定的失败原因码（如 `http_503`、`errcode_45009`、`timeout`）。

### 9.4 告警怎么走

- 路由不变：资金告警（规则带 `fund: 'true'`）任何时间都发 finance 组和 oncall 组；其余是运维告警，只发 oncall 组，22:00–08:00（+08:00）静默，08:00 后汇总发出。同一告警 30 分钟内合并。
- 转发器把 `/finance` 发到财务群、`/oncall` 发到值班群；群消息只带告警名、级别、firing / resolved、开始与恢复时间（+08:00）和 summary；summary 里的链接、手机号、证件号、卡号、收款账号、token 一律去掉（与应用日志同一口径），不截留部分号码。
- 每次推送 5 秒超时；失败（网络、超时、HTTP 错误，或 HTTP 200 但 errcode 不为 0）最多重试 3 次（间隔 1、2、4 秒）；仍失败时回 502，Alertmanager 稍后会再投一次。
- 宕机规则（`outage.yaml`）：api / worker / admin 抓取失败（`up == 0`）持续 2 分钟；PostgreSQL 连不上（`pg_up == 0`）持续 2 分钟；五个容器任一不健康（`couli_container_healthy == 0`）持续 2 分钟；任一容器 5 分钟没有新的健康样本（推送定时器停了）。Redis 连不上仍只有 `couli.yaml` 的 CouliRedisDown 一条。宕机告警都是运维告警，夜里静默。
- 淘宝订单同步水位落后（CouliSyncWatermarkLag）不带 `fund` 标签，是运维告警：只发 oncall 组，22:00–08:00（+08:00）同样静默；夜里持续到 08:00 仍未恢复的，在静默结束后的下一个分组周期（30 分钟内）发到值班群。正文写明平台，并提示「若淘宝授权已过期，属预期，到后台重新授权即恢复」。

### 9.5 怎么证明它是好的

1. 单元都在跑：`systemctl is-active couli-alertmanager couli-vmagent couli-vmagent-exporters couli-vmalert couli-vmalert-outage couli-alert-forwarder`，六行都是 `active`；`systemctl list-timers couli-container-health.timer` 能看到下次运行时间。
2. 数据进来了：`curl -s 'http://127.0.0.1:8428/api/v1/query?query=up'` 里有 couli-api / couli-worker / couli-admin / couli-pg / couli-redis 五个 job 且值为 1；`query=couli_container_healthy` 有五个容器、正常时都是 1；`query=pg_up` 与 `query=redis_up` 为 1。
3. 规则加载了：`curl -s http://127.0.0.1:8882/api/v1/rules` 里有 couli-outage 组的四条规则，`http://127.0.0.1:8881/api/v1/rules` 里仍是原有两份规则。
4. 群里收得到：在节点上对 Alertmanager 发一条演练告警（ops 私有手册里的演练脚本，告警名带「演练」），值班群应在约 30 秒内收到 firing，演练结束后收到 resolved；带 `fund="true"` 的演练告警财务群和值班群都收到。`journalctl -u couli-alert-forwarder --since 10min` 里对应行是 `"status":200`，且整段日志里没有 Webhook 地址。
5. 宕机能报出来：停一个容器（如 `docker stop couli-staging-admin-1`）约 2 分钟后值班群收到 CouliContainerUnhealthy 与 CouliProcessDown（夜间静默时段内则次日 08:00 后汇总），`docker start` 后收到 resolved。演练结果记在私有运维手册。
