# staging 冒烟（QA-04）

直连 staging 的接口层冒烟脚本，只在测试机手动或定时运行；不进 `pnpm verify`、不在 CI 跑，也不连生产。

## 节点文件（只在测试机，`~/.couli-staging-smoke/`，目录 0700、文件 0600）

| 文件 | 谁写 | 内容 |
| --- | --- | --- |
| `target.json` | 人工写一次 | `{ "env": "staging", "admin_base_url": "https://…", "api_base_url": "https://…" }`，不含凭据 |
| `admin.json` | 只由 `enroll-admin.ts` 写 | 冒烟后台账号的登录名、密码、身份验证器种子 |

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
