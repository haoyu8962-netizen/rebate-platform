# B1-04zzf 规则测试 author-notes

作者：Codex。依据本轮任务书及编排者补充，图片清洗口径直接复用 `normalizeItemImages`，地址全部合成；未读取私有录制，未新增实现或骨架。

按补充第 3 条（D10-327、#24 报核），更新冻结文件 `test/spec/union/item-images/pdd.test.ts` 的唯一用例 `[AC-B1-22s-PDD#1]`：由「不映射图片」改为主图及去重后的多图有值，保留无图 DTO 的其他字段完全相等、平台原始字段不泄露的断言，并增加不同值的 DTO 同名字段不能覆盖平台字段的断言。保留原有 search/detail/feed 参数化范围与清洗函数断言，仅同步过时说明和此用例的图片期望，其他冻结测试不动。

新增 `pdd-images/mapping.test.ts` 的 #1–#4 覆盖搜索和详情；`catalog/card-images/assembly.test.ts` 的 #5–#7 通过真实搜索、首页 product_pool 栏目和详情用例走卡片组装，只替换上游和存储端口，不连数据库。每个新用例同时包含应有图的样本，当前实现预期因图片断言失败而红；反例覆盖缺省、多图不补主图、缩略图不补主图、清洗和同名字段隔离。

静态检查结果见本轮 JSON；没有在宿主运行测试，先红须由编排者执行 `tools/ops/verify-container.sh B1-04zzf --red` 核对。本轮对冻结用例的修改按任务书明确授权进行，随实现同 PR，#24 报核由编排者处理。
