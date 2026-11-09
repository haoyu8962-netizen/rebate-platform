# DSX-48d 规则测试作者说明（独立 Claude，test 阶段第 1 次；第 2 次只改包体基线，见文末）

作者无 shell：没跑 typecheck / lint / 任何测试，请编排在容器里核对。无骨架（任务说明「无需骨架」），
主干上各用例都红在断言上（没有动效样本 / 退出层没保留 / 令牌未引用）。

## 测量方式（motion-kit.ts）

- 浏览器用例不假设实现手法：每帧读 `document.getAnimations()`（另在 transitionrun / animationstart
  时补读），CSS transition、CSS animation、脚本动画都算。每个动画首见时记下目标、属性、时长、缓动
  （transition 取该属性在计算样式里的 timing-function；CSS animation 取 animation-timing-function；
  脚本动画取自身 easing）、关键帧起止值与目标尺寸。位移 / 缩放用同尺寸隐藏探针套上起止值量几何，
  所以 `transform` / `translate` / `scale`、矩阵或函数写法都一样。
- 期望值取已加载样式里 `var(--motion-*)` 的计算值，不在测试里写毫秒。
- 等待只用 expect.element（标记元素的 `data-quiet`：最近一次 mark 后连续 12 帧没有有限时长的
  动画在跑）；无限循环动画（骨架微光、转圈）不计。
- 退出用例在 window 捕获阶段拦掉 transitionend / transitioncancel / animationend / animationcancel，
  仍要求按时移除、焦点回到打开者。

## 选定的约定（实现须照此）

- **关闭要有退出动效，且由计时器驱动**（规格「关闭时滑出 / 淡出」；约束 ⑤ 里「关闭即卸载只做进入」的
  选项因此不再可用）：关闭的同一次提交里弹层就退出无障碍树（不再被 `getByRole('dialog')` 找到，
  如 aria-hidden / inert）、焦点回到打开者、Esc 与按钮不再响应；同一个面板元素留在 portal 容器里播
  退出，计时（令牌毫秒）到点后移除。这样冻结的 [AC-F1-01f-MODAL#4/#7/#10]（关闭后立即查不到 dialog、
  焦点立即归还）不受影响。退出中再次打开：只有一个可用弹层，旧退出到点不抢焦点、不删新弹层；退出中卸载：
  立即清空（CLOSE#4、#5）。
- Sheet：面板（或不含遮罩的外包层）从下滑入，起点下移 ≥ 面板高的一半，emphasized / emphasized-enter；
  关闭向下滑出 ≥ 半个面板高，emphasized-exit，时长为进入的 0.5–0.8（`calc(var(--motion-duration-emphasized) * 2 / 3)`
  或 normal 都落在区间内）。Sheet 正常动效下不强制同时淡入。
- Dialog：面板或整层淡入（起点 opacity ≤ 0.5）且面板起点 scale 0.85–0.99、不平移；关闭淡出到 ≤ 0.1。
  若淡入淡出放在整层（含遮罩）上，整层也按 emphasized 计时。
- 遮罩：只动 opacity，方向对即可，时长与缓动不限。
- Toast：只动 opacity；进入 normal / enter；到时前以 exit 缓动淡出（≤ normal），仍须在 `durationMs`
  到点时移除（冻结 [AC-F1-01f-TOAST#1–3]、[AC-F1-01o-TOAST#3] 要求 1999 ms 时仍在、2000 ms 时文字已清）。
- 页签（找回页）：新显示的面板（面板本身、其内部、或不含 tablist 的外包层）淡入，normal，standard 或 enter，
  无位移；两个方向都测。加载到内容：配置到达、表单替换骨架时，包含订单号输入框的元素淡入，normal，enter 或 standard。
- 减弱动态：上述一律只剩 opacity，进入时长 = `--motion-reduced-fade`，退出 ≤ 它。注意
  `@couli/ui-tokens/a11y.css` 在减弱动态下把 CSS animation 时长强制为 0（base 层 !important），
  所以减弱动态的淡入需用 transition（或脚本动画）实现。
- 静态：base / shared 须引用 emphasized 时长、emphasized-enter / -exit、exit 缓动、reduced-fade
  （CSS 变量、`duration-couli-*` / `ease-couli-*` 别名或 ui-tokens 具名常量均可）；计时器延时不写数字字面量；
  H5 CSS 的 transition / @keyframes 与 base / shared / 找回页的过渡类名、内联过渡只动 opacity / transform
  （display / overlay / visibility 离散项可随行；`transition`、`transition-all`、`transition-colors`、
  `transition-shadow` 不可用）。

## 可能与过渡冲突的冻结用例（不改，供编排判断）

- `test/spec/frontend/h5-components/components.browser.test.ts`：
  [AC-F1-01f-VISUAL#2] h5-components-sheet（可见后即读 `box.bottom ≈ 812`，若读时仍在滑入会差）；
  [AC-F1-01f-LAYOUT#1] sheet（读标题 / 操作区 `bottom ≤ 812`，同理）。两者都在 `toBeVisible` 之后、
  无等待即读几何；滑入 350 ms 未完时可能红。Dialog 以中心缩放，中心与高度上限不受影响。
- `test/spec/frontend/h5-find-order/find-order.browser.test.ts` [AC-F1-04b-BROWSER#3]：用
  `checkVisibility({ checkOpacity: true })` 数平台标识，若恰在淡入首帧（opacity 0）读取会少数。

## 包体（bundle.test.ts）

- 同 h5-image：容器无 `.git`，同一次运行再做一次「主干基线」构建。第 2 次（spec r1 S1）起基线覆盖
  任务台账 paths 下**全部**源码：`trunk/apps/h5/src/<相对路径>.txt` 是 components/base/**、shared/**、
  entries/app/pages/find-order/** 下每个 .ts / .tsx / .css 的主干原文（b9f5a222a，共 43 个，单元测试
  `*.test.ts(x)` 不进包、未拷；作者无 shell，是从与主干相同的工作区逐字抄写，请编排
  `git diff --no-index` 或逐个 `git show origin/main:<路径>` 核对）。
- 基线插件：相对导入落到这三处路径时按副本解析（实现新增 / 改名 / 删除文件都不影响基线导入图），
  这三处路径下的模块一律读副本；没有副本的记入 fromTree。H5 字典裁剪插件从磁盘扫 apps/h5/src，所以
  基线字典改为在临时目录里用主干副本替换三处路径后重跑 collectH5Texts，再在 JSON 处理前换掉。
- BUNDLE#1 断言：副本都在三处路径内且是 .ts / .tsx / .css；8 个核心文件都读自副本；fromTree 为空；
  基线 JS 块里三处路径下的每个 .ts / .tsx 模块都读自副本；字典按主干源码裁剪；两次构建懒加载路由相同。
  CSS 不计入包体（只量 JS 块），Tailwind 仍按工作区扫描类名，不影响测量。
- 旧的 8 个平铺副本 `trunk/*.txt` 已不再使用（作者无 shell 删不掉），请编排 `git rm`。
- 主干上两次构建相同，所以两条用例先断言「过渡已接入」（同 SOURCE#1 的令牌引用），主干上红在这一句，不构建。
