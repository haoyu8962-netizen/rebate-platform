# B1-08zy 规则测试作者说明

- 测试第 2 轮（编排 D10-1003）：新计数器改为计过一次才出该平台序列（与冻结的 [AC-B1-01zzh#5] 一致）——metrics.test.ts [AC-B1-08zy#1] 改钉「从未计数无序列、计 pdd 后只有 pdd=1、再计 taobao 后两条各 1」（重载模块取新进程状态），#2 先各计一次再比增量；pipeline.int.test.ts 的 counters() 把没有序列的平台按 0，#11 先各计一次确认计数在走再核「不变」；test/spec/platform/metrics-followups/rules.test.ts [AC-B1-01zzo#10] 在 CouliPddServiceFeeMissing 之后追加 CouliServiceFeeMissing 一项。
- 测试第 3 轮（机械修正，只修 TS2322）：主干把 UnionOrder['platform'] 加宽到平台全集后，pipeline.int.test.ts 里 stored() 的 patch 与 ATTR 的 `Partial<UnionOrder>` 展开会覆盖夹具只收 taobao / jd / pdd 的 platform；两者改为不含 platform 的 `Partial<Omit<UnionOrder, 'platform'>>`（类型别名 Patch），断言、用例、期望值与其他文件都不动。
- 测试第 4 轮（编排 D10-1051，approvals 55）：只改 metrics.test.ts [AC-B1-08zy#1]——为满足冻结的 [AC-B1-25b#8]（告警引用的指标启动即有样本行）且不碰 [AC-B1-01zzh#5]（worker 不出 platform="pdd"），改钉「未计数时只有 {platform="taobao"} 0、无 pdd 序列；计 pdd 后 pdd=1、taobao 仍 0；再计 taobao 后 taobao=1」；pipeline.int.test.ts 的 counters() 本就把没有序列的平台按 0，与新语义兼容，未改；其他用例与冻结文件不动。
