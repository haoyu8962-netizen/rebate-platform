# F1-02zzzh 规则测试说明（test 阶段，按 §9.5 修订）

只新增 `validation.test.ts`，全部走 `validateAppVersionSave` 出口，复用 `../app-versions-rules/kit.ts` 的 `row()`（只导入，未改）。未改 `apps/api/src/modules/content/domain/app-versions/index.ts`：`isStoreUrl` 已存在，红来自断言失败，不需要骨架。

§9.5：新文件不认 red_exempt，每条用例都须在主干上变红。原先独立的三条回归对照已删除，对照断言并进会变红的用例里，排在新规则断言之后；没有 red_exempt。

## 全部在主干上应为红

- `[AC-F1-02zzzh#1]`（普通 `it`）：先断言方括号内非 IPv6 字面量（`[abc]`、`[zz]`、`[1.2.3.4]`、`[::g]`、`[v1.fe80::1]` 等）拒收，结果精确为 `{ ok: false, fields: ['store_url'] }`——主干上第一条样例即断言失败；之后对照：其余拒收规则不变、非方括号主机与无 authority 写法照旧接受。
- `[AC-F1-02zzzh#2]`（`it.each`，5 行）：带 zone id（`%25eth0`、`%eth0`、`%`）拒收，每行主干上断言失败。
- `[AC-F1-02zzzh#3]`（性质测试）：先断言任意十六进制 / 冒号 / 点组成、`isIPv6` 为假的串放进方括号都拒收（回调内 `expect` 失败 → fast-check 反例）；之后对照：合法 IPv6 固定样例与 `fc.ipV6()`（过滤 `isIPv6`）照常接受。
