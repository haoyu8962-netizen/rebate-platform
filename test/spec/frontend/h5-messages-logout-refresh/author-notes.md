# F1-04e 规则测试作者记录

- 测试第 2 轮（编排 §9.4，机械修正）：`messages-logout-in-flight.test.ts` l.31 `mountPage(http.api)` 改为 `mountPage(http.api!)`，修 TS2345（`AppApiClient | null` → `H5ApiClient`）；夹具 `messagesServer` 总带 env，`createAppApi` 不会返回 null；写法同 `h5-account-switch/switch-helpers.ts` 的 `observed!.api!`。未改任何断言、用例、期望值或其他文件。
