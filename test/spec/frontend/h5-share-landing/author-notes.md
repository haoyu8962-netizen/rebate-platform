# F1-11a 规则测试作者说明（独立 Claude，test 阶段第 1 次）

作者无 shell：没跑 typecheck / lint / 任何测试，请编排在容器里核对。

## 测的是什么

- 挂真实入口 `apps/h5/src/entries/landing/main.tsx`（jsdom、`#root`、无桥），不另设骨架；主干上
  占位壳不发请求，所以各用例红在「等 GET 请求 / 等商品标题」的断言上；STATE#5 红在「不应仍是
  h5.shell.page_pending 占位」。
- 地址：`/<link_id>`（契约 `bridge.schema.json` share_page_paths.product_share.path_pattern 仍为
  null，只按「路径带 link_id」取最简形状；路径为 `/` 视为没有 link_id）。
- 构建变量：`VITE_API_BASE_URL`、`VITE_APP_ID`、`VITE_MEDIA_ORIGINS` 用 `vi.stubEnv` 注入；请求经
  `globalThis.fetch`（假实现，按方法 + 路径应答）。断言 `X-App-Id`、`X-Platform: h5`、无
  `Authorization`；不断言 `X-App-Version`（落地页在 App 外没有版本来源，契约却标 required，留给
  实现与编排定）。
- 文案只用字典里已有的键（share_page.*、state.retry、state.loading、error.30102 / 30111）。没有键
  的【去购买】、取价时间句、失效空态句只断言结构：`a[href=jump_url]` 且有文字、`09:30` 出现、
  空态有非空文字且无链接 / 重试 / 口令按钮。30102 与 30111 的 sharer_auth_invalid 空态文字须相同。
- 微信内（UA 含 MicroMessenger）即使响应带 tpwd_ticket 与 open_in_app_url 也都不显示，只显示
  share_page.open_in_browser_hint（BR-TEXT-14 表 C、BR-ATTR-05 细则）。
- 剪贴板写入失败时页面显示口令文本、不提示 share_page.copy_tpwd.done（摘录「展示 / 复制口令」）。
- 「不显示」按 DOM 判断（textContent / 可访问角色），只靠 CSS 隐藏不算。
