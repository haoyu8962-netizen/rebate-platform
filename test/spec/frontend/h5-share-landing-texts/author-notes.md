# F1-11c 规则测试作者说明（独立 Claude，test 阶段第 1 次）

作者无 shell：没跑 typecheck / lint / 任何测试，请编排在容器里核对。

- 挂真实入口（复用 `../h5-share-landing/share-landing-kit.ts`），无骨架。文案全部从
  `contracts/texts.default.json` 读，不写死中文。
- 失效空态：30144、30102 / 30111 + `reason=sharer_auth_invalid`、地址无 link_id，页面全文（trim）须
  等于 `share_page.invalid`，且没有哪个元素的文字等于 `link_landing.invalid`（新句包含旧句「链接已失效」，
  所以不能用「不包含」判断）。主干上红在全文相等的断言。
- 取价句：降级（stale=true，或 stale=false 且 age_sec=301）时须有一个元素的文字整句等于
  `share_page.quote_time` 套入时间；时间按 BR-PRICE-11 取 `09:30` 或 `MM-DD 09:30`（跑测日期决定哪种，
  两种都接受，不冻结时钟）；页面不出现 `earnings.as_of` 的固定字样。age_sec=300 且未 stale 时不显示；
  该用例接着验 301 时显示，所以主干上同样红在断言。
