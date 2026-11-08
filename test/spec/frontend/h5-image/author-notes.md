# DSX-48c 规则测试作者说明（独立 Claude，test 阶段第 1 次）

作者无 shell：没跑 typecheck / lint / 任何测试，请编排在容器里核对。

## 选定的接口（contract.ts）

- 名字：`AsyncImage`，由 `apps/h5/src/components/base/index.ts` 具名转出。
- 属性：`src`（null / undefined / '' 为无图）、`alt`、`aspectRatio`、`referrerPolicy`、`failedText`、`className`。
- 标记：占位框 `data-slot="image-frame"`，状态写在 `data-state`：`loading` / `loaded` / `error` / `empty`。
- 无图：选「显示无图态」——组件渲染空占位框、不建 img；邀请页 `poster_url` 为空时照旧不渲染海报卡（WIRING#4）。
- 海报失败：选「显示失败态、卡片不隐藏」（design/ui-rules §3.6「占位 + 渐显 + 缓存 + 失败态」）。
- 失败文案：默认取字典 `state.load_failed.title`，调用方可传 `failedText`；组件源码不得有中文（SOURCE#1）。

## 与规格措辞的取舍

- 加载中**不用** `aria-busy="true"`（规格允许「或等价」，这里用 `data-state="loading"`）：冻结用例
  [AC-F1-05a-STATES#1]、[AC-F1-03c-NOTICE-DETAIL#7] 等在内容出现后断言页面里没有
  `[aria-busy="true"], [data-slot="skeleton-block"]`；jsdom 里图片永不加载，用 aria-busy 会让它们变红。
- 懒加载钉为 `loading="lazy"`（不用 IntersectionObserver）：jsdom 没有 IntersectionObserver，冻结用例
  （h5-help ARTICLE#6、h5-notices DETAIL#14、h5-rules IMAGE#1）一渲染就读 img 的 src。
- 加载中 img 必须仍是可访问的 `img`（名字 = alt），同样是为了上面几条冻结用例。

## 包体（bundle.test.ts）

- 容器里没有 `.git`，取不到主干文件，所以同一次运行里再构建一次「主干基线」：用 vite 插件把
  `base/index.ts`、`article-body.tsx`、`invite-page.tsx` 换成 `trunk/*.txt` 里的主干原文（主干
  0cac27eee，2026-11-08，从工作区逐字抄写，行数已对上），其余文件不变。请编排
  `diff` 一下这三份和主干原文。
- 局限：若实现在别的文件里改动了共用代码（例如 shared/**），这部分增量两次构建都有，量不出来；
  若别的文件从 base/index.ts 引入了新导出，基线构建会因主干 index 没有该导出而失败。
- 主干上两次构建相同，所以两条用例都先断言「base/index.ts 转出 AsyncImage 且正文 / 邀请路由打进了
  图片件」，主干上红在这一句（不会开始构建）。

## 预计不受影响的冻结用例

没找到钉住「海报失败整块隐藏」或正文 img 精确属性集合的冻结用例。h5-invite 浏览器用例
[AC-F1-05a-BROWSER#5]（320 宽、两倍字号不横向溢出）在海报失败时会显示失败文字，实现需让失败文字换行。
