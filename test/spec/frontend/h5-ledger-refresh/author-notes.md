# F1-04d 规则测试作者说明

- 测试第 2 轮（spec-test r1 S1）：新增 `ledger-refresh-in-flight.test.ts` 的 REFRESH#5——两页游标 c1 / c2，刷新在途期间滚到底不得发 cursor=c2 的翻页，成功后只剩新的第一页、没有旧游标翻出的行；已有两个文件在 spec_commit 后冻结，故放在同目录新文件里，已有用例未改。
