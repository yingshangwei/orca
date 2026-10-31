# 移动端终端输出/滚动卡顿：实现与验收说明

症状（用户确认）：**移动数据下，终端输出或滚动不流畅**。本文记录本分支 `codex/mobile-link-latency` 的实现、测量边界、上游 PR 取舍和待验收项。

**状态：诊断功能已部署到实际使用的桌面，Android 更新包已交付；手机尚未安装，真机未验收，移动数据下卡顿的原因和是否改善都未知。** 结果和边界见下文“第三轮验证结果”和“部署与外部验收”。120 秒真实中转采样只有 1 个控制连接、没有手机终端流量，不能用来判定手机卡顿。

## 用户能看到什么

会话顶部 `3 tabs` 后面追加：

| 情况                 | 显示                                         |
| -------------------- | -------------------------------------------- |
| 正常                 | `3 tabs · 142 ms`                            |
| 有证据的原因         | `3 tabs · 820 ms · Output backlog`           |
| 慢，但证据指不出原因 | `3 tabs · 640 ms · Link slow, cause unknown` |
| 超时                 | `3 tabs · > 5 s · Link slow, cause unknown`  |
| 测量中或探针失败     | `3 tabs · —`                                 |
| 桌面太旧             | 不显示数字；只有手机侧证据成立时才显示原因   |

点这一行打开明细，每一行都注明含义，未测量的段写 `Not measured`。

## 测量边界

所有时长都用手机单侧单调时钟，不比较两端时钟。

| 数值                       | 起点 → 终点                                                         | 新鲜度                                                  | 不能证明                                                                                     |
| -------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| App round trip（主数字）   | 页面发出 `mobile.linkProbe` → 页面收到回复；近 5 次中位数           | 5 秒一次，明细打开时 1 秒一次；最新样本超过 15 秒就清空 | 不是纯网络 RTT，包含手机 App、E2EE、中转、桌面主进程排队和输出积压；也不是按键延迟或绘制延迟 |
| Desktop send queue         | 桌面处理探针时，本连接 E2EE JS 队列 + `ws.bufferedAmount`           | 随探针的瞬时值                                          | 看不到内核发送缓冲和中转内部缓冲；这里为 0 不代表下行没有积压                                |
| Desktop main process delay | 主进程事件循环延迟 p99/max，窗口为上次探针到本次探针                | 随探针。首次回复为 null；30 秒无人读取就停表            | 只说明主进程跑晚了，不说明原因                                                               |
| Page frame gap             | 输出或触摸活动期间，相邻 `requestAnimationFrame` 的间隔 p95/max     | 最近 10 秒，至少 20 帧                                  | 是主线程节奏，不是 GPU 实际呈现的帧                                                          |
| Waiting to parse           | 交给 document 的字符数中 xterm 尚未回调的部分，及最老一块的等待时长 | 随采样                                                  | 单位是 UTF-16 码元；不含还在路上或在 App 里的输出；计数口径见下                              |
| Phone app hop              | 页面 → App → 页面往返 + 收到回复时 App 为页面保留的输出字节         | 5 秒一次，明细打开时 1 秒一次；读数超过 15 秒就清空     | 只在新 APK 上有；不含线路时间。持有量是瞬时值，大于 0 不代表手机忙，不参与判定               |
| Mobile network alone       | 未测量                                                              | —                                                       | 明确不估算                                                                                   |

### 新鲜度与生命周期

- RTT、桌面证据、Phone app hop 各自按回复时刻判断新鲜度，超过 15 秒发布为空。RTT 序列中断超过 15 秒后从新样本重新累积，中位数不混入已隐藏的旧值。
- Phone app hop 单在途。bridge 没有自身超时，所以挂起的探针会一直占住在途位，同一生命周期内不再发第二个；上一次读数 15 秒后清空，明细显示 `Not measured`，切后台或重连后的新生命周期重新探测。这段时间里 `Not measured` 只表示没有新读数，不表示这一跳正常。
- 停止即作废：迟到的主机或 App 回复，不论成功还是失败，都不能写入下一次启动的读数。
- 明细采样频率随明细打开或卸载恢复默认。帧计时由正在采样的会话持有，最后一个持有者释放时立刻取消；切换会话时新会话先挂载也不会被旧会话关掉。

### Waiting to parse 的计数口径

xterm 按写入顺序逐块解析，所以每次解析完成结算最老的一项。

- `init` 和 `clear` 会丢弃未解析输出。计数同时清空，并按“写入时属于哪次重置”隔离：已交给旧 terminal 的回调迟到时不结算新快照，也不影响之后的输出。
- `initialData` 为空时不产生写入，也不计数。非空快照归一化后不会变空：`normalizeInitialData` 只会裁到备用屏起点，所以不存在“计了数却永远没有回调”的残留路径。
- 快照按归一化前的长度计数，备用屏快照在解析完成前可能偏大；document 另加的 4 个字符 SGR 前缀和状态点选择符的变化不计入。这些只影响字符数，不影响等待时长。
- 单个 document 超过 4096 项未解析时，新写入并入最新一项，每次解析仍有对应项，不会误结算或长期残留。合并项要等其中的写入全部解析才整体移除，在此之前字符数偏大；等待时长取合并项第一块的时间。这只发生在已积压 4096 块时。
- 测量只保存长度和时间，不保存输出文本。这些包裹都在页面专属的 `createTerminal` seam，没有改 `terminal/document/`。

### 判定规则

阈值是待校准的初值，见 `mobile/src/session/mobile-link-diagnosis.ts`。

| 标签                       | 条件                                                            |
| -------------------------- | --------------------------------------------------------------- |
| `Output backlog`           | 桌面队列 + socket 缓冲 ≥ 64 KiB                                 |
| `Desktop busy`             | 事件循环 p99 ≥ 100 ms                                           |
| `Phone busy`               | 帧间隔 p95 ≥ 50 ms，或最老待解析 ≥ 500 ms，或 App 往返 ≥ 100 ms |
| `Link slow, cause unknown` | 上述都不成立，且 RTT ≥ 400 ms 或探针超时                        |

App 持有的输出只显示，不参与判定：普通转发时也会短暂持有，单次字节数无法区分转发中和卡住，也没有依据定字节阈值。

**没有 “Network slow” 这个结论。** 没有任何单项能单独证明网络慢，用 RTT 相减出的估算值也不够，所以证据不足时就写原因未确定。

## 设计决定

- `mobile.linkProbe` 由桌面主进程直接回答，不碰 PTY 和 Agent，回复只含数字。模型生成时间不可能混入。
- 路由为 `paired-desktop`：服务器工作区也只测手机到受控电脑这一段，桌面到服务器的一跳不计入。
- 能力位 `mobile.link-probe.v1`，手机见到才发。不提高最低协议版本，不要求重新配对，不改鉴权。
- 单个在途，超时 5 秒。迟到回复丢弃。探针超时只影响显示，不进入活性判定、不触发重连。有一点需要知道：探针的回复和其他入站帧一样会刷新活性时间，但那确实证明了链路活着。
- 只在前台、会话屏聚焦、已连接、有活动终端时采样。任一条件变化都清空旧样本，所以切后台、重连、切主机后不会沿用。
- 读数不进 session controller 的 React state，由表头和明细订阅。否则每次采样都会重绘整条路由，诊断本身反而制造卡顿。
- 帧循环只在输出或触摸后 2 秒内运行，空闲终端没有常驻 rAF。
- 第一轮的两个设计已撤销：不再借用 `native.media.release` 当 ping，改为可选 grant 的只读 verb `native.link.snapshot`，旧 APK 显示未测量；不做输入回显的 `exact` 归类。
- 页面指标没有改 `terminal/document/`。那里的文本与原生 WebView 程序逐 token 固定，所以从页面专属的 `createTerminal` seam 包一层 `write`。

## 上游 PR 取舍

| PR                                | 状态       | 判断                                                                 | 作用的构建                                              | 与症状的关系                                                                                                                              |
| --------------------------------- | ---------- | -------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| #34741 队列线性排空               | 已合并     | **采用**，基线确有 `shift()`                                         | **仅 APK**（shell 内 `BridgeTerminalOutputBacklog`）    | 只在 App 已有大积压时有效。桌面更新不会让它生效                                                                                           |
| #34743 未访问终端延迟挂载         | 已合并     | **采用**，基线确有无条件挂载；已核对 web-ready 会订阅新选中的 tab    | 桌面 OTA 页面                                           | 减少多标签时的内存和初始化开销。隐藏 tab 本来不订阅输出，不会直接让输出变顺                                                               |
| #33405 output span                | 已合并     | **采用核心修复**，基线桌面确实向手机发 opcode 15，手机解码器静默丢弃 | 桌面端 `out/main` 修复全部已装手机；手机解码 **仅 APK** | 修的是输出丢失（如 TUI 退出后停在备用屏），不是流畅度。未引入 “未知帧结束流并限频重置” 部分；手机解码只在私有协议表加一项，没有删除私有表 |
| #30534 / #30546 / #30553 平滑滚动 | **未合并** | **暂缓**                                                             | 桌面 OTA 页面                                           | 见下                                                                                                                                      |
| #36008 桌面输入优化               | 已合并     | **不采用**，PR 写明 Mobile unaffected                                | —                                                       | 不能作为移动端证据                                                                                                                        |

### 为什么暂缓平滑滚动

用户报告的“滚动不流畅”可能有两种原因：渲染按整行跳（这三个 PR 解决的），或主线程/输出积压导致掉帧（这三个 PR 解决不了，#30553 还会增加每次滚动一次 WebGL 帧拷贝）。现在没有数据区分两者。

风险：#30534 依赖 xterm 私有接口（`_renderService`、行元素、WebGL `renderRows`），作者只做了 WebKit 合成触摸验证；三个 PR 都写明未做真机检查，手感也没有测过；#30546、#30553 是叠加分支，共改 34–38 个文件；#30546 还按 Claude Code 当前行为调参。

**推荐：** 先用本分支的 Page frame gap 在真机滚动时取数。滚动时 `p95 < 25 ms` 但用户仍觉得跳，才说明是逐行渲染问题，这时单独试 #30534；`p95` 高就先解决主线程问题。

## 分阶段交付

| 阶段 | 内容                                              | 需要                                                                               |
| ---- | ------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1    | 探针、表头、明细、页面指标、#34743、#33405 桌面端 | 桌面新包含 `out/main` 和 `out/mobile-web`，重启窗口后手机重新下载页面（约 9.8 MB） |
| 2    | Phone app hop、#34741、#33405 手机解码            | 新 APK，沿用同一签名                                                               |

阶段 1 不需要 APK 和中转部署。阶段 1 下 `Phone app hop` 显示 `Not measured`，`Phone busy` 只由页面指标触发。

当前进度：阶段 1 已部署；阶段 2 的 APK 已交付，手机安装后才生效。

## 验证

### 第三轮验证结果

证据在 `orca-mobile-performance/evidence/`。下表的全量结果是修正 fixture 之前跑的；修正后只定向重跑，见“最后复测”。

| 项目                 | 结果                                                                                                                                                                              | 证据                                                                  |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 移动端源码 typecheck | 通过                                                                                                                                                                              | `typecheck-mobile-source-round03.log`                                 |
| changed-code quality | 所有扫描 0 finding                                                                                                                                                                | `code-quality-round03.log`                                            |
| 移动端全量测试       | 1123 文件：1118 通过、2 跳过、3 失败；11574 项：11564 通过、6 跳过、4 失败                                                                                                        | `tests-mobile-full-round03.log`                                       |
| 本分支造成的失败     | 1 项：`mobile-link-diagnosis.test.ts` 的 fixture 缺 `shellAvailable: true`，已修正测试数据，未改产品代码                                                                          | 同上                                                                  |
| 原有基线失败         | 3 项，与本分支无关：`mobile-agent-launch-architecture.test.ts` 2 项 durable receipt 重开、`ai-vault-resume-launch.test.ts` 1 项本地 Claude 连接参数保护                           | `tests-existing-failures-baseline.log`（`c1b6276f7b89` 归档同样失败） |
| 测试 typecheck 棘轮  | 无新增失败；移除 1 条过期基线 `src/transport/mobile-relay-pairing-recovery.test.ts`                                                                                               | `typecheck-mobile-tests-round03.log`                                  |
| UI 渲染              | 真实 `MobileSessionHeader` + `MobileSessionLinkSheet`，Android 壳同等 CSP，headless Chrome 下 390x844、360x740、844x390：展开、手机 Back 关闭、超时显示、无横向溢出、无控制台错误 | `link-ui-render.json`、`link-details-*.png`                           |
| 构建                 | 桌面编译和 mobile-web 构建通过；页面 9,820,810 bytes，144 assets，buildId `82556cbb6d0c60b3c660151d4f345faa6176023f46fa05fd234f50c86cd8864c`                                      | `build-mobile-web-round03.log`                                        |

修正 fixture 后**没有重跑全量测试，全量没有全绿**。如果重跑，预期是 1119 文件通过、2 跳过、2 失败；11565 项通过、6 跳过、3 失败，失败项应恰好是上表 3 项原有基线失败。

这些结果不能证明的事：

- UI 渲染的读数是明确标识的模拟输入，只验证布局和交互，不是手机真实延迟。
- 自动化和 headless Chrome 都没有覆盖 Android WebView、移动数据、真实终端输出和手指滚动。
- 阈值未校准，诊断标签在真实流量下的准确性未验证。
- 卡顿没有被证明已解决。

原有 3 项失败属于启动、授权、回执逻辑，本分支未修改，也不在本分支范围内修复。

### 部署与外部验收

部署、设备与交付的逐项记录保存在仓库外的本地验证目录，不包含在公共源码中。
隔离桌面与同机中继探针通过不能证明 Android 真机、移动网络或手动滚动体验；这些验证仍需分别完成。

### 最后复测

修正 fixture 后没有再改产品代码。在 `mobile/` 目录执行：

```bash
node node_modules/vitest/vitest.mjs run src/session/mobile-link-diagnosis.test.ts
node scripts/check-tests-typecheck-ratchet.mjs
```

结果：

- 诊断测试 18 项全部通过（`tests-final-diagnosis.log`）。
- 测试类型棘轮通过：1119 个测试文件，115 个 grandfathered（`tests-final-typecheck-ratchet.log`）。
- 源码 typecheck 和 changed-code quality 沿用上表结果。

此前全量的 4 项失败中，1 项已定向修正通过，其余 3 项在未改动的 `c1b6276f7b89` 归档中复现。

`pnpm --filter orca-mobile ...` 在 worktree 根目录报 `No projects matched`，不要用它复测。

### 完整命令

在本 worktree 执行：

```bash
pnpm run generate:rpc-params-catalog
pnpm tc
pnpm test src/main/diagnostics/event-loop-delay-window.test.ts src/main/runtime/rpc/methods/mobile-link-probe.test.ts src/main/runtime/rpc/mobile-e2ee-desktop-outbound-owner.test.ts src/main/runtime/rpc/terminal-output-frame-chunks.test.ts src/main/runtime/rpc/terminal-subscribe-residual-metadata.test.ts src/main/runtime/runtime-rpc/runtime-rpc-mobile-method-routing.test.ts src/shared/protocol-version-published-capabilities.test.ts src/renderer/src/lib/typing-latency/diagnostic-summary.test.ts
pnpm test src/main/runtime/rpc/terminal
pnpm run check:code-quality:changed
pnpm format
```

`rpc-params-catalog.generated.ts` 是手工加的一行，上面第一条命令应当不再产生差异。

```bash
cd mobile
npx tsc --noEmit
pnpm run check:tests-typecheck
npx vitest run src/session/mobile-link src/session/MobileSessionLinkSheet.test.tsx src/session/use-mobile-link-monitor.test.tsx src/terminal/terminal-page-output-meter.test.ts src/terminal/terminal-web-document-mount.test.ts src/mobile-web-shell src/transport/rpc-client-terminal-binary-frame.test.ts src/layout/host-sidebar-reveal.test.tsx
```

路由声明和构建（回到 worktree 根目录）：

```bash
pnpm test config/scripts/mobile-web-page-routes.test.mjs
pnpm run build:electron-vite
pnpm run build:mobile-web
```

### 反向验证

确认测试不是摆设，临时还原后应当失败：

| 还原                                               | 应失败的测试                                                    |
| -------------------------------------------------- | --------------------------------------------------------------- |
| `bridge-terminal-output-backlog.ts` 改回 `shift()` | `stops paying for the whole queue on every drained frame`       |
| `TerminalPaneView.tsx` 去掉 `visited`              | `starts only the selected document among several terminal tabs` |
| `terminal-subscribe-binary.ts` 传 `'span'`         | `terminal-subscribe-residual-metadata.test.ts`                  |

## 真机验收（尚未进行）

先在手机上直接覆盖安装新 APK，不要先卸载。然后在**临时新建的纯 shell 终端**里跑，不碰业务会话。先记录阶段 1 页面确实已加载。日常遇到卡顿时，当场点开表头看明细并记录读数。

| 场景          | 操作                                                                | 判定                                                                                               |
| ------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| S1 空闲       | 不输出，看表头                                                      | 只有数字，无原因；记录移动数据下的 RTT 基线                                                        |
| S2 超带宽输出 | `while :; do head -c 65536 /dev/urandom \| base64; sleep 0.1; done` | 出现 `Output backlog` 或 `Phone busy`，**不应**只显示 RTT 而无原因；按 Ctrl-C 记录到屏幕停止的秒数 |
| S3 输出时滚动 | S2 运行时拖动回滚                                                   | 记录 Page frame gap，判断属于哪一类                                                                |
| S4 空闲时滚动 | 大量回滚后停止输出再滚动                                            | 按上文“为什么暂缓”的标准决定是否试 #30534                                                          |
| S5 切后台     | 切走 30 秒再回来                                                    | 回来后样本重新累积，不沿用旧数                                                                     |
| S6 切网络     | 移动数据与 Wi-Fi 各跑一次 S1、S2                                    | 对比同一场景下数字的变化                                                                           |

阈值按 S1–S4 校准后再视为可信。真机验收通过之前，不能宣称卡顿已修复：本分支主要提供定位能力，没有改变输出的流控。
