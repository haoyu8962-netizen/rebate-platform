# specs/client/：三端共享客户端向量

这里是安卓、鸿蒙、iOS 三端共用测试向量的**唯一源**（DSX-42，D10-683；规划 `docs/design-standard-fix-program.md` DSX-42 条、05 §3.11）。三端不再各自维护一份副本，只按本目录的文件与清单锁定。

## 来源

2026-11-06 由三端主干逐字比对后合并而来，合并方案见运行目录 `couli-runs/B3-lane/dsx42-merge-plan-20261106.md`（不入库）。入库时按本仓库 prettier 规则重排了格式（只改空白，JSON 值与合并结果逐项相同），所以 hash 与三端现有副本都不同，三端改锁时以本目录为准：

| 文件 | 合并前 | 合并版 |
| --- | --- | --- |
| `format-vectors.json`、`home-sdui-vectors.json`、`me-vectors.json`、`oauth-login-vectors.json` | 三端字节相同 | 内容原样 |
| `login-vectors.json` | iOS 与安卓 / 鸿蒙不同 | 内容同安卓 / 鸿蒙 |
| `order-vectors.json` | 鸿蒙与安卓 / iOS 不同 | 内容同安卓 / iOS |
| `clipboard-vectors.json` | 三端各不同 | 内容同安卓 |
| `clipboard-candidates-vectors.json` | 安卓 = 鸿蒙 | 内容原样 |
| `privacy-visual-vectors.json` | 鸿蒙 = iOS | 内容原样 |
| `risk-appeal-visual-vectors.json` | 只在鸿蒙 | 内容原样 |

`clipboard-harmony-vectors.json` 不收，留在鸿蒙仓库作端专属。合并时待各端确认的问题记在合并方案里，不在本目录。

## 分发清单 `manifest.json`

```json
{
  "format": "couli-client-vectors-manifest/1",
  "algorithm": "sha256",
  "files": {
    "<相对本目录的路径>": { "sha256": "<文件原字节的 sha256，64 位小写十六进制>", "bytes": 0 }
  }
}
```

- 本目录里除 `manifest.json` 与 `README.md` 以外的每个文件（含子目录，路径用 `/`）恰好一条；键按码点排序。
- `node tools/ci/client-vectors.ts --check` 校验清单与文件一一对应、sha256 与字节数一致；`ci.yml` 的 `verify-static` 跑这一步，不一致就失败。
- `node tools/ci/client-vectors.ts --write` 按文件重算并写回清单。

## 三端怎么锁

三端仓库的 `contract.lock` 在 `files` 表里用键 `specs/client/<文件>`、值为该文件的 sha256 锁这些文件（DSX-140～142 改锁）。`node tools/ci/tokens-lag.ts --client-vectors specs/client --lock <端>=<contract.lock>` 比对锁与本清单：hash 不同、某端没锁、两端锁的 hash 不同都会告警（目前只告警，何时升为失败由编排定）。

## 改动流程

1. 在本仓库开任务改这里的向量文件（不在三端仓库改副本）；文件保持 prettier 格式（CI 的 format:check 也查这里）；格式或内容一变 hash 就变，改完重写清单。
2. 跑 `node tools/ci/client-vectors.ts --write` 更新清单，与向量同一个 PR 提交；`--check` 通过。
3. 合并后，三端各自按新清单更新 `contract.lock` 的 `files` 表并跑自己的向量测试；在三端都更新前，TOKENS-LAG 会对没跟上的一端报 `client-vectors-mismatch`。
4. 新增或删除向量文件同样走这个流程；只属于某一端的向量不放这里。
