# 交接文档 — ZCode + Cowork 监测集成

> 本文档记录了在 token-monitor（github.com/Javis603/token-monitor）基础上所做的全部修改，供后续 agent 接手。
> 基线版本：上游 main（v0.27.0+）。所有改动在本地分支 `feature/zcode-cowork-support`，**未 push**。

## 一、总体目标

为 token-monitor 增加 **Claude Cowork** 的 token 监测，并让 **ZCode** 走上游 tokscale 路径。

- **ZCode**：上游 tokscale 已能扫描 `~/.zcode/cli/db/db.sqlite`。周期用量与历史 graph 都走 tokscale，不再原生 merge（避免与上游双计）。会话详情仍读本地 SQLite（tokscale 没有 ZCode transcript 路径）。
- **Cowork**：上游仍扫不到 Claude Desktop 沙盒，继续原生读取，用量归到 `claude`。

## 二、ZCode 的本地数据位置（关键）

ZCode 把 token 数据存在 CLI 运行时数据库里，**不是** `~/.zcode/projects`（上游 tokscale 假设的路径，ZCode 从不写那里）：

| 路径 | 内容 | 是否采用 |
|---|---|---|
| `%USERPROFILE%\.zcode\cli\db\db.sqlite` | `model_usage` 表（权威）：每条 LLM 调用的 input/output/cacheRead/cacheCreate/total + provider/model/session/timestamp | ✅ **主源** |
| `%USERPROFILE%\.zcode\cli\rollout\model-io-sess_*.jsonl` | 每次 LLM 调用一行 JSON，`response.usage` 块 | ✅ 备用源 |
| `%USERPROFILE%\.zcode\cli\log\zcode-*.jsonl` | 结构化日志，token 值被 `[Redacted]` | ❌ 不可用 |
| `%USERPROFILE%\.zcode\v2\` | Electron 端会话（只存 characterCount） | ❌ 无 token |

**重要数据约定**：ZCode 的 `input_tokens` 是 **cache-inclusive** 的（已包含 cache_read + cache_creation 部分，对应上游 fix #68）。因此：
- 总量 = `input + output`（不要再加 cacheRead/cacheWrite）
- 计费用的"净输入" = `input - cacheRead - cacheWrite`

### ZCode DB 关键表
- `model_usage`：每条 LLM 调用的 token 明细（`session_id`, `model_id`, `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `computed_total_tokens`, `completed_at`）
- `turn_usage`：每个 user→assistant 交换的聚合 token（会话详情用）
- `input_history`：用户提问原文 `text`（会话详情的 prompt 来源）
- `tool_usage`：每轮用到的工具名（会话详情用）
- `session`：`directory` 列 = 工作区路径（**项目归因**用）

## 三、Cowork 的本地数据位置

Claude Cowork（桌面应用的 agent 模式）在 MSIX 沙盒里跑嵌入式 Claude Code，写标准 Claude Code JSONL：
```
%LOCALAPPDATA%\Packages\Claude_<publisher>\LocalCache\Roaming\Claude\
  local-agent-mode-sessions\<session>\<workspace>\local_<vm>\…\
    .claude\projects\<encoded>\<id>.jsonl   ← 标准 Claude 格式（type:"assistant" + message.usage）
    audit.jsonl                              ← 最新的实时流
```
- 格式与 Claude Code 完全一致（`input_tokens`/`output_tokens`/`cache_creation_input_tokens`/`cache_read_input_tokens`）
- **Cowork 的 token 归到 `claude` 客户端**（不单独显示 cowork 行），这样 Claude Code + Cowork 合并成一个 claude 工具行 + 一个 claude-opus 模型行

## 四、修改/新增的文件清单

### 新增文件
| 文件 | 作用 |
|---|---|
| `src/shared/zcodeSession.js` | **ZCode 适配器**：读 `db.sqlite` 的 `model_usage`（JSONL 兜底），输出标准 period 结构；含 cache-inclusive 修正、自定义单价算成本、`loadSessionProjects`（项目归因）、`readSessionEvents`（会话详情） |
| `src/shared/coworkSession.js` | **Cowork 适配器**：动态发现 MSIX 沙盒路径，读所有 `*.jsonl`，解析 assistant 行的 usage；归到 `claude` 客户端 |
| `tests/shared/zcodeSession.test.js` | ZCode 单测（周期分桶/成本/项目归因/会话详情/JSONL 兜底） |
| `tests/shared/coworkSession.test.js` | Cowork 单测（归到 claude/模型合并/成本） |
| `launch-background.vbs` | Windows 后台静默启动脚本（无 cmd 黑窗） |
| `install-autostart.bat` / `uninstall-autostart.bat` | 开机自启安装/卸载 |
| `assets/icons/zcode.svg` / `site/assets/icons/zcode.svg` | ZCode 图标（复用 zai.svg） |
| `HANDOFF.md` | 本文档 |

### 修改文件（核心改动）
| 文件 | 改动 |
|---|---|
| `src/shared/collector.js` | ① `tokscaleClientsCsv()` 按 `PARSE_LOCAL_CLIENTS`（proma, qodercn）剔原生客户端：ZCode/DSH/Reasonix 走 tokscale ② tokscale 扫描包 **try/catch**（失败不连累 cowork 原生读取）③ `coworkEnabled`/`zcodePricingMap` ④ cowork 监听路径并入 `claude`（独立于 `CLAUDE_CONFIG_DIR`）⑤ `collectUsageOnce` 在 tokscale+WSL 后只 merge cowork |
| `src/shared/sessionDetail.js` | 新增 `readZcodeSessionDetail` 分支 + `readSessionDetail` 的 `if (client === 'zcode')` 分发 |
| `src/shared/clientTracking.js` | `DEFAULT_CLIENTS` 加 `zcode`（cowork 不加，归 claude） |
| `src/shared/usage.js` | `normalizeClientName` 加 `zcode`/`z-code` 归一化 |
| `src/electron/renderer/app.js` | `KNOWN_CLIENTS`/`clientLabels`/`clientsWithIcon` 加 zcode；**会话点击白名单**加 `'zcode'`（否则点不开） |
| `src/electron/main.js` | 两处 `startCollector` 加 `customModelPricing: () => settings.customModelPricing \|\| []`（函数式 getter，改单价立即生效） |
| `package.json` | `check` 脚本注册新文件 |

## 五、关键设计决策与坑

1. **zcode 走 tokscale**：上游已 watch `cli/db`（`zcode-cli-db`）并用 tokscale 扫 `db.sqlite`。周期与 graph 都交给 tokscale。`zcodeSession.js` 只服务会话详情。
2. **cowork 归到 claude**：避免出现"opus(code)"和"opus(cowork)"分开显示。无重复计数（tokscale 读 `~/.claude/projects`，cowork 读沙盒路径，磁盘不重叠）。
3. **cache-inclusive 修正**（#68）：ZCode input_tokens 含缓存，总量 = input+output，净输入 = input-cacheRead-cacheWrite。不修会**翻倍**。
4. **tokscale try/catch**：tokscale 卡住/失败时（尤其 watch tick 的 `--today`），不能让整个 tick reject 抹掉原生数据，否则仪表盘闪烁 active↔waiting。
5. **会话点击白名单**：`app.js` 的 `els.breakdown.addEventListener('click')` 有硬编码客户端列表，必须同时保留上游的 `'dsh'`/`'reasonix'` 和我们的 `'zcode'` 才能点开会话详情。
6. **项目归因**：ZCode 会话需要 `projectId`/`projectLabel` 才能进「项目」视图；从 `session.directory` 用 `hashKey`+`normalizeProjectPath` 算（复刻 collector.js 的 `projectIdentity`，避免循环依赖）。

## 六、更新维护流程（rebase）

上游频繁更新。维护方式：
1. `git fetch origin`
2. `git rebase origin/main`
3. 解决冲突（主要在 `collector.js` 的 `clientWatchCandidates` 和 `collectUsageOnce` 区域；`clientTracking.js` 的 DEFAULT_CLIENTS；`app.js` 的 KNOWN_CLIENTS；`main.js` 的 startCollector）
4. 冲突解决原则：**双方特性都保留**。上游新客户端加进 DEFAULT_CLIENTS/KNOWN_CLIENTS，我们的 zcode 保留；collector 里上游的新结构（Proma/projects/onProgress/collectedAt）采用，套进我们的 tokscaleClientsCsv+try/catch。
5. `npm install`（tokscale 版本升级时）；`npm run check` + `npx eslint src/shared/zcodeSession.js src/shared/coworkSession.js` + `node --test tests/shared/zcodeSession.test.js tests/shared/coworkSession.test.js`
6. 删除每次 rebase 会误提交的 `_resolve_pkg.js` 调试文件

### 2026-07-15 rebase：v0.27.0 → v0.28.1 ✅ 干净合并
- `git fetch origin` 后 `origin/main` 从 `667681a`(v0.27.0) 前进 8 个提交到 `292b29c`(v0.28.1)。`git rebase origin/main` **零冲突**自动完成 —— 11 个本地提交全部干净重放。
- 上游 v0.27→v0.28 改动集中在 `main.js`(tray 菜单/通知/appUpdater 重构 + `rememberLatestAppUpdate`)、`tray.js`、`app.js`(release-notes popover、codex accountIdentity 抽取、settings panel)、新增 `src/electron/renderer/accountIdentity.js`、`appUpdater.js`、`sessionUsageArchive.js` 线性时间化。我们与上游**重叠的 3 个文件**改动区域互不重叠，故无冲突：
  - `main.js`：我们的两处 `startCollector` 加 `customModelPricing: () => settings.customModelPricing || []`（行号迁至 1782/2077），上游 tray/appUpdater 改动共存。
  - `app.js`：我们的会话白名单加 `'zcode'`（行号迁至 6078），上游 release-notes/codex 改动在文件别处。
  - `package.json`：上游只 bump 版本号到 0.28.1，我们的 `check` 脚本保留（注：`check` 是本地辅助脚本，其文件清单未随上游新增文件自动扩充，不影响功能，需要时手动补）。
- 依赖版本 v0.27→v0.28 无变化（仅 `version` 字段 bump），无需 `npm install`；`node_modules` 沿用。
- **验证（三方对比）**：用临时 worktree 在 rebase 前(`819bcc8`)、rebase 后、上游 `origin/main` 各跑完整 `npm test`：
  | 版本 | tests | pass | fail |
  |---|---|---|---|
  | rebase 前 `819bcc8` | 1292 | 1283 | 9 |
  | rebase 后（当前） | 1301 | 1292 | **9（同一集合）** |
  | 上游 `origin/main` | 1299 | 1297 | 2 |
  - rebase 后测试数 +9（上游新增测试）、pass +9，**失败集合与 rebase 前逐字相同**（仅毫秒级耗时差异），证明**零回归**。
  - 那 9 个失败全是**预先存在的本机环境问题**，与本次 rebase 无关：①2 个 `clientDataDirPresence`（上游 origin/main 自身也失败，环境/路径相关）；②7 个 collector 测试（`collectUsageOnce`/`watchPathsForClients`/progressive/anchored tick/WSL warm preview）——这些测试用 mock 的 tokscale 子进程设期望值（如 claude month=120），但本机有真实 zcode(~17.4B tokens)/cowork 沙盒/tokscale 数据，`collectUsageOnce` 在 `claude` 被跟踪时会触发 `coworkEnabled`→真实 cowork 原生读取，把真实用量 merge 进 mock，导致断言不符。这些测试在干净 CI 环境（无真实 AI 工具数据）会通过。
  - 我们的 4 个专项测试文件（zcodeSession/coworkSession/sessionDetail/history）本地全绿：**60 pass / 0 fail**。
  - `npx eslint`（8 个改动文件）无任何告警。
- 真实数据读取验证通过：`collectZcodeUsage` 返回 ~17.46B tokens，`clients: ["zcode"]`。

### 2026-07-19 rebase：v0.28.1 → v0.31.0 ⚠️ 手工合并 2 处冲突
- `git fetch origin` 后 `origin/main` 从 `292b29c`(v0.28.1) 前进 31 个提交到 `ce0c2ea`(v0.31.0)，跨越 v0.29/v0.30/v0.31 三次发布。`git rebase origin/main` 在 2 个提交上冲突，手工解决后 12 个本地提交全部重放（原 13 个里 `07c9bf5` 删调试脚本被自动 drop——上游基线已无 `_resolve_pkg.js`）。
- **冲突 1**（`87e67ed` feat：ZCode + Cowork 主体，collector.js）：上游在 v0.29-v0.31 重构了 `collectUsageOnce` 的 tokscale 块——把 `if (projectsEnabled) { decorate... }` 改成无条件装饰（项目身份经 `decorateLocalPeriods` 的 `resolveProjects: projectsEnabled` 参数门控，issue #182），并把 tokscale 调用包进新的 try/catch。**我们 87e67ed 当时也独立加了 try/catch（同样为防止 tokscale 失败抹掉原生读取）+ `tokscaleClientsCsv()`**。git 自动合并把双方 try/catch/decorate 逻辑搅在一起产生重复块。**解决**：采用上游新结构（无条件 decorate + `resolveProjects` 参数），保留我们的 `tokscaleClientsCsv(normalizedClients)` 和外层 try/catch（上游没有外层 try/catch，我们的更稳）。删除 git 产生的重复 anchored/else-if 块。
- **冲突 2**（`63b1dab` feat：cowork history graph，collector.js）：上游 v0.31 在 `collectHistoryOnce` 新增 `rawGraphs[]` 收集 + `dailyHistoryArchive`（issue #193：源 cleanup 后保留每日历史）分支，在 `mergeHistories` 之前 return。我们 63b1dab 加的 `coworkGraph` 分支在同区域。**解决**：保留上游 `rawGraphs` + `dailyHistoryArchive` 结构，把我们的 `coworkGraph` 也 push 进 `rawGraphs`（**改进**：daily history archive 现在也覆盖 cowork 历史，源 cleanup 后 cowork 用量同样被保留），同时 push 进 `histories` 供无 archive 路径合并。
- **依赖更新**：上游 `04ebf4d chore(deps): update tokscale to 4.5.3`，`npm install` 更新 3 个包。其余 `main.js`/`app.js`/`usage.js`/`history.js` 与上游重叠区域 git 全部自动合并（我们的 `customModelPricing` getter×2、会话白名单 `'zcode'`、`normalizeClientName` 等均保留）。
- **上游 v0.29-v0.31 其它值得注意的改动**（与 zcode/cowork 无直接冲突，但间接相关）：①`sessionTimestampMap` 加 `resolveProjects` 门控（项目可选，但时间戳总是回填——影响 Sessions 视图排序）；②`history.js` intensity 拆成 `tokenIntensity`/`costIntensity`（heatmap 加 Tokens/Cost 切换，#190）；③`usage.js` 新增 `sessionDetailsOmitted`/`periodProjectsOmitted`/`syncUploadIntervalMs` 透传 + `aggregateDevices` 按 sync 上传间隔调整 stale 判定。
- **验证（与 rebase 前对比）**：rebase 前完整 `npm test` = 1329 tests / 1320 pass / **9 fail**；rebase 后 = **1462 tests / 1453 pass / 9 fail**。测试数 +133（上游三版本新增大量测试），pass +133，**失败集合与 rebase 前逐字相同**（6 个 collector mock 被本机真实数据污染 + 3 个 clientDataDirPresence 环境失败），证明**零回归**。我们的 4 个专项测试文件全绿（64 pass / 0 fail，含时区修复新增的 3 个回归测试）。`npx eslint`（8 个改动文件）无告警。
- 真实数据验证：`collectZcodeUsage` 返回 today 7.75M / month 977M / allTime 1.64B，模型 `GLM-5.2`，时区修复后随使用实时增长。

### 2026-07-21 rebase：v0.31.0 → v0.32.0 ✅ 仅 1 处简单冲突
- `git fetch origin` 后 `origin/main` 从 `ce0c2ea`(v0.31.0) 前进 13 个提交到 `2edd0a1`(v0.32.0)。`git rebase origin/main` 仅在 `03e6b51`(feat：ZCode + Cowork 主体)冲突 1 处，解决后 13 个本地提交全部干净重放。**无 `_resolve_pkg.js` 残留**（这次没产生）。
- **冲突**（collector.js 第 24-30 行）：双方都在 `hashKey` require 后加新 import——上游加 `const { hostOsInfo, normalizeOsInfo } = require('./osVersion')`（v0.32 设备 OS 版本显示，#208），我们加 `zcodeSession`/`coworkSession` require。**解决**：两行都保留（顺序：上游 osVersion 在前、我们的 zcode/cowork 在后）。纯 import 冲突，无语义影响。
- **自动合并验证**：上一轮 v0.31 rebase 手工解决的 tokscale 块（无条件 decorate + `resolveProjects` + 我们的 `tokscaleClientsCsv` + 外层 try/catch）和 collectHistoryOnce 块（`rawGraphs` + `dailyHistoryArchive` + 我们的 `coworkGraph` push 进 rawGraphs）这次 git **全部正确自动合并**，无需再手工干预——说明上一轮的合并形态已成为基线，git 能识别。
- **summary 块**：上游在 `collectUsageOnce` 的 summary 加 `osName`/`osVersion` 字段（从 `osInfo` 解析），git 自动合并在我们的 zcode/cowork merge 块之后、history 块之前。验证 summary 输出含 osInfo（`hostOsInfo()` 返回 `{"name":"Windows 11","version":"25H2"}`）。
- **依赖**：tokscale 仍是 4.5.3，无变化，无需 `npm install`。
- **上游 v0.32 值得注意的改动**：①GUI 密钥移出 settings.json（`credentialStore.js`，#200——cursor/codex/mimo 等 cookie/凭证改用 OS keychain/加密存储）；②per-device 用量细分（`deviceBreakdown.js`，#206）；③OS 版本显示（`osVersion.js`，#208）；④grok 统一积分（`grokLimits.js`，#175）；⑤limits 重置窗口定时刷新（collector `scheduleLimitsResetBoundary`，#212）。这些都在我们的 zcode/cowork 集成区域之外。
- **验证（与 rebase 前对比）**：rebase 前完整 `npm test` = 1462 tests / 1453 pass / **9 fail**；rebase 后 = **1541 tests / 1530 pass / 9 fail**。测试数 +79（上游 v0.32 新增），pass +77（差 2 是上游新增测试里 2 个也踩到本机环境失败，已计入那 9 个），**失败集合与 rebase 前逐字相同**（6 个 collector mock 被本机真实数据污染 + 3 个 clientDataDirPresence 环境失败），证明**零回归**。我们的 4 个专项测试文件全绿（64 pass / 0 fail）。`npx eslint`（8 个改动文件）无告警。
- 真实数据验证：`collectZcodeUsage` 返回 today 3.91M / month 1.09B / allTime 1.66B，模型 `GLM-5.2`。

### 2026-07-22 rebase：v0.32.0 → v0.33.0 ⚠️ 大重构（limits/usage 解耦）+ customModelPricing 迁移
- `git fetch origin` 后 `origin/main` 从 `2edd0a1`(v0.32.0) 前进 10 个提交到 `3b752fd`(v0.33.0)。**这是上游最大的架构重构**：#225 把 limits 从 collector 完全剥离。`git rebase origin/main` 在 `d3edb41`(feat：ZCode + Cowork 主体)冲突 2 个文件，手工解决后 14 个本地提交全部干净重放。**无 `_resolve_pkg.js` 残留**。
- **上游 v0.33 核心重构**（影响我们的部分）：①`collectUsageOnce` 删除了 `summary.limits` 块——limits 不再在 usage 扫描里采集；②`startCollector` 签名移除 `limitsEnabled`/`limitsCollector`/`limitProviders` 等所有限制参数，`limitResetBoundary*` 函数从 collector.js 移到独立的 `limitResetBoundary.js`；③`startCollector` 新增 `refreshClient` 方法 + `forceCursorSync`（cursor 手动同步走 todayOnly tick）；④**main.js 用新的 `createDeviceRuntime`（deviceRuntime.js）替换了 `startCollector({...})` 调用**——所有三处 collector（local/sync/host）现在走 `deviceRuntimeHandle = createDeviceRuntime({ envelope, usageOptions: electronUsageConfig(...), limitsOptions: electronLimitsConfig(...), ... })`，limits 由独立的 limitsRuntime 驱动。
- **冲突 1**（collector.js import 区）：上游加 `limitResetBoundary` require，我们加 zcode/cowork require。**解决**：都保留（同前几轮）。
- **冲突 2**（collector.js tokscale 块）：上游 `maybeSyncCursor` 加 `{ force: options.forceCursorSync === true }` 第三参数，我们有外层 try/catch + 旧的无 force 参数调用。**解决**：采用上游的 force 参数 + 保留我们的外层 try/catch 结构。
- **冲突 3 + 4**（main.js `startSyncCollector`/`startLocalCollector`）：**这两处是整个 `startCollector({...})` 调用块 vs 上游新的 `createDeviceRuntime`/`orderedSink` 块的冲突**。我们原来的 `customModelPricing: () => settings.customModelPricing || []` getter 就嵌在旧的 `startCollector({...})` 参数里，上游重构后**整个调用块被替换**，getter 随之消失。**解决**：main.js 两处冲突都采用上游（HEAD）的 `createDeviceRuntime` 新结构——旧 `startCollector` 调用已不存在，不能硬塞回去。
- **关键后续修复：customModelPricing getter 迁移** ⭐：上游重构把 usage 配置抽到新的 `src/electron/runtimeConfig.js` 的 `usageConfigFromSettings(settings, context)`，但**上游没有把 `customModelPricing` 加进去**（上游的 tokscale 客户端走自己的 custom-pricing 文件，不需要）。如果不补，zcode 的自定义单价（GLM-5.2 等）会丢失，仪表盘 zcode 成本恒为 $0。**修复**：在 `usageConfigFromSettings` 返回对象里加 `customModelPricing: () => settings.customModelPricing || []`（函数式 getter，闭包捕获 `electronUsageConfig(settings)` 传入的全局 settings 引用，改单价立即生效）。链路：runtimeConfig → deviceRuntime（`{ ...options.usageOptions }` 透传）→ usageRuntime → startCollector → collectUsageOnce → zcodeSession。**验证**：带 pricing map 调 `collectZcodeUsage` 返回正确成本；`usageConfigFromSettings` 返回的 getter 解析出定价数组。
- **依赖**：tokscale 仍是 4.5.3，无变化；`npm install` 报 up to date。
- **上游 v0.33 其它值得注意的改动**：①limits 运行时解耦（`limitsRuntime.js`/`deviceRuntime.js`/`deviceState.js`/`orderedSink.js`/`probeDeadline.js`，limits 失败不再拖累 usage）；②Intel macOS 构建（#223）；③Kimi 会员配额窗口（#221）；④Antigravity 分组配额（#217）；⑤主题分离强调色/语义色（#214）；⑥WSL SQLite 引导（#222）。这些都在 zcode/cowork 集成区域之外。
- **验证（与 rebase 前对比）**：rebase 前完整 `npm test` = 1541 tests / 1530 pass / **9 fail**；rebase 后 = **1669 tests / 1658 pass / 9 fail**。测试数 +128（上游 v0.33 新增大量 deviceRuntime/limitsRuntime 测试），pass +128，**失败集合与 rebase 前逐字相同**（6 个 collector mock 被本机真实数据污染 + 3 个 clientDataDirPresence 环境失败），证明**零回归**。我们的 4 个专项测试文件全绿（64 pass / 0 fail）。`npx eslint`（9 个改动文件，含新增 runtimeConfig.js）无告警。
- 真实数据验证：`collectZcodeUsage` 返回 today 32.8M / month 1.23B；customModelPricing getter 链路验证通过。

### 2026-07-23 rebase：v0.33.0 → v0.34.0 ✅ 零冲突 + 依赖大升级
- `git fetch origin` 后 `origin/main` 从 `3b752fd`(v0.33.0) 前进 13 个提交到 `38c3789`(v0.34.0)。**`git rebase origin/main` 零冲突**——16 个本地提交全部干净重放。原因：v0.34 **没有改动 `collector.js`**（我们 zcode/cowork 集成的核心文件不变），且 `main.js`/`runtimeConfig.js` 的改动区域与我们的不重叠——上一轮 v0.33 手工解决的 `createDeviceRuntime` + `customModelPricing` getter 形态这次 git 正确自动合并。
- **依赖大升级**（`#237` + `42d8f5c`）：Electron + Node 包升级，tokscale 4.5.3 → **4.6.1**（二进制分发方式改变：平台二进制从 `@tokscale/cli` 内置改为 optionalDependencies 的独立包 `@tokscale/cli-win32-x64-msvc` 等）。`npm install` 更新 4 added / 247 removed / 38 changed。**注意**：升级 electron 时若有 token-monitor 实例在运行，会 EBUSY 锁住 `node_modules/electron/dist/electron.exe`——需先 `taskkill` 所有 electron.exe 进程（本次终止 PID 41556/38628/44816/8104）。
- **tokscale 4.6.1 二进制陷阱**：optionalDependencies 的平台二进制首次 `npm install` 因网络 ECONNRESET 未装上（只装了 `@tokscale/cli` JS wrapper，缺 `@tokscale/cli-win32-x64-msvc`），需单独 `npm install @tokscale/cli-win32-x64-msvc@4.6.1 --no-save` 补装。装上后 exe 还可能被 Windows Defender 实时扫描短暂锁住（"file being used by another process"），等扫描结束或重启后恢复——这是环境问题，非代码问题。
- **上游 v0.34 值得注意的改动**（与 zcode/cowork 无直接冲突）：①opt-in 自动更新下载（`#239`，appUpdater）；②Accent Blur glass 模式（`#229`，windowsBackdrop）；③limits 探测性能优化 + Retry-After（`#227`，limitsRetryPolicy/probeDeadline）；④Home 上下文返回控件（`#238`）；⑤活动日范围同步设置（`#210`）。这些都在 zcode/cowork 集成区域之外。
- **验证（与 rebase 前对比）**：rebase 前完整 `npm test` = 1669 tests / 1658 pass / **9 fail**；rebase 后 = **1729 tests / 1722 pass / 5 fail**。测试数 +60（上游 v0.34 新增），失败数 **9→5（反而少了 4 个）**——rebase 前 6 个 collector mock 被本机真实数据污染的失败，这次因 tokscale 4.6.1 行为变化只剩 1 个（`watchPathsForClients`）。
- **5 个失败全部是环境/上游问题，零代码回归**：①`clientDataDirPresence detects Cline...`（预存环境失败）；②`clientDataDirPresence requires...`（预存）；③`watchPathsForClients watches Pi...`（预存）；④`default tracked clients are accepted by bundled tokscale`（tokscale.exe 被 Defender 锁定，环境问题）；⑤`reset boundaries enqueue...`（上游 v0.34 新加的计时敏感 flaky test，重跑一次即过）。我们的 4 个专项测试文件全绿（64 pass / 0 fail）。`npx eslint`（9 个改动文件）无告警。
- 真实数据验证：`collectZcodeUsage` 返回 today 9.43M / month 1.24B / allTime 1.58B，模型 `GLM-5.2`；customModelPricing getter 链路验证通过。

### 2026-07-26 rebase：v0.34.0 → v0.35.0 ✅ 零冲突
- `git fetch origin` 后 `origin/main` 从 `38c3789`(v0.34.0) 前进 12 个提交到 `2e3ea2d`(v0.35.0)。**`git rebase origin/main` 零冲突**——17 个本地提交全部干净重放。v0.35 **没有改动 `collector.js`/`usage.js`/`history.js`**（我们的 zcode/cowork 集成核心文件不变）；`runtimeConfig.js` 上游只在 `limitsConfigFromSettings`（不同函数）加了 `openrouterProfiles`，与我们改的 `usageConfigFromSettings`（customModelPricing getter）不冲突，自动合并。
- **依赖**：tokscale 4.6.1 → **4.7.0**（`npm install` 改 3 个包）。electron 仍是 43.2.0，**未升级**，所以不触发 postinstall 重下，即使有 electron 进程在跑也不会 EBUSY——electron.exe（225MB）保持完整。
- **上游 v0.35 值得注意的改动**（与 zcode/cowork 无直接冲突）：①OpenRouter 账户额度（`#247`，runtimeConfig/limits）；②自定义菜单栏布局（`#251`，tray）；③Windows 静默更新安装（`#253`）；④Codex 工作区账户身份（`#254`/`#257`）；⑤limits tooltip/credits 语义解耦（`#252`）；⑥macOS Space 菜单窗口（`#250`）；⑦DeepSeek 余额历史紧凑化（`#246`）。这些都在 zcode/cowork 集成区域之外。
- **验证（与 rebase 前对比）**：rebase 前完整 `npm test` = 1729 tests / 1722 pass / **5 fail**；rebase 后 = **1816 tests / 1811 pass / 3 fail**。测试数 +87，失败数 **5→3（又少了 2 个）**——剩余 3 个全是预存环境失败（1 个 clientDataDirPresence + 2 个 collectorLoadGuards 被本机真实数据污染），零代码回归。我们的 4 个专项测试文件全绿（64 pass / 0 fail）。`npx eslint`（9 个改动文件）无告警。
- 真实数据验证：`collectZcodeUsage` 返回 today 3.83M / month 1.37B / allTime 1.60B，模型 `GLM-5.2`。

### 2026-07-28 rebase：v0.35.0 → v0.36.0 ✅ 零冲突（94 文件大版本）
- `git fetch origin` 后 `origin/main` 从 `2e3ea2d`(v0.35.0) 前进 29 个提交到 `5f36b34`(v0.36.0)。这是迄今最大版本（94 文件 +10829 行）。**`git rebase origin/main` 零冲突**——18 个本地提交全部干净重放。尽管 `collector.js`(+88)和 `runtimeConfig.js`(+14)上游有改动，但都在与我们不同的区域：①collector 的 #160 改动全在 `startCollector` 内部（activityRevision/watchers 重构/loop 智能调度），不碰 `collectUsageOnce`（我们的 zcode/cowork 集成所在）；②runtimeConfig 上游在 `usageConfigFromSettings` 加了 `watchUsePolling`/`watchTriggersCollection`/`intervalRequiresActivity`（紧邻我们的 `customModelPricing` getter），git 正确做了相邻行合并，两者共存。
- **依赖**：tokscale/electron 版本均未变，`npm install` 报 up to date，**electron.exe（225MB）保持完整**，VBS/BAT 启动不受影响。
- **上游 v0.36 核心改动**（与 zcode/cowork 无直接冲突）：①**activity-gated smart collection**（`#160`，collector——native fs events 替代轮询、无活动时跳过 interval tick、每小时强制 full scan 对账）；②**Claude Web 登录 + 稳定账户身份**（`#259`，limits——sessionKey/cookie + OAuth profile）；③**第三方余额适配器**（`#261`，thirdPartyProfiles）；④Claude 用量积分/预付余额（`#269`）；⑤limits provider 统一重构（`#273`/`#274`/`#276`——共享 browser user-agent/note row/tooltip）；⑥tray 余额驱动 + 实时预览（`#266`/`1b6b913`）。这些都在 zcode/cowork 集成区域之外。
- **验证（与 rebase 前对比）**：rebase 前完整 `npm test` = 1816 tests / 1811 pass / **3 fail**；rebase 后 = **1997 tests / 1991 pass / 4 fail**。测试数 +181（v0.36 新增大量 Claude Web/third-party/smart-collection 测试），失败数 3→4（+1 是上游 #160 新加的 `smart collection retries a failed activity scan` 计时测试，在本机高负载环境下超时，属环境问题）。
- **4 个失败全部是环境/上游问题，零代码回归**：①`clientDataDirPresence`（预存）；②`collectUsageOnce runs three tokscale scans serially`×2（预存，本机真实 cowork 数据污染 mock——`coworkEnabled('claude')` 触发真实读取）；③`smart collection retries a failed activity scan`（上游 #160 新加计时测试，2s 超时，本机 4 个 electron 进程 + 磁盘活动干扰）。我们的 4 个专项测试文件全绿（64 pass / 0 fail）。`npx eslint`（9 个改动文件）无告警。
- 真实数据验证：`collectZcodeUsage` 返回 today 27.2M / month 1.50B，模型 `GLM-5.2`。

### 2026-07-29 rebase：v0.36.0 → v0.37.0 ✅ 零冲突
- `git fetch origin` 后 `origin/main` 从 `5f36b34`(v0.36.0) 前进 6 个提交到 `ad76d66`(v0.37.0)。**`git rebase origin/main` 零冲突**——19 个本地提交全部干净重放。我们所有核心文件（collector.js/runtimeConfig.js/zcodeSession.js/coworkSession.js/usage.js/history.js/sessionDetail.js）上游**均无改动**（`git diff --stat` 为空）；v0.37 的 6 个提交全是 limits/settings/renderer UI 改动。
- **依赖**：无 `chore(deps)` 提交，tokscale/electron 版本未变，无需 `npm install`；electron.exe 保持完整。
- **上游 v0.37 改动**（与 zcode/cowork 无关）：①provider 账户合并进 AI 工具限额（`#281`）；②provider 行拖拽排序（`#279`）；③DeepSeek 详细消费历史（`#278`）；④provider 状态点尺寸/拖拽 blur 修复。全在 limits/settings UI 区域。
- **验证（与 rebase 前对比）**：rebase 前完整 `npm test` = 1997 tests / 1991 pass / **4 fail**；rebase 后 = **2048 tests / 2042 pass / 4 fail**。测试数 +51，**失败集合与 rebase 前逐字相同**（1 个 clientDataDirPresence + 2 个 collectorLoadGuards serial scan 被本机真实数据污染 + 1 个 smart collection 计时超时），零代码回归。我们的 4 个专项测试文件全绿（64 pass / 0 fail）。`npx eslint`（7 个核心改动文件）无告警。
- 真实数据验证：`collectZcodeUsage` 返回 today 69.4M / month 1.57B，模型 `GLM-5.2`。

### 2026-07-31 rebase：v0.37.0 → v0.38.0 ⚠️ 2 处冲突 + cowork watch key 修复
- `git fetch origin` 后 `origin/main` 从 `ad76d66`(v0.37.0) 前进 19 个提交到 `64e1fd6`(v0.38.0)。`git rebase origin/main` 在 `620164c`(feat：ZCode + Cowork 主体)冲突 1 个文件（collector.js），手工解决 2 处冲突后 20 个本地提交全部干净重放（`git merge-base --is-ancestor origin/main HEAD` 确认 v0.38 是 HEAD 祖先，`origin/main..HEAD` = 20 commits）。**无 `_resolve_pkg.js` 残留**。
- **冲突 1**（collector.js `collectUsageOnce` tokscale 块，~170 行）：上游 v0.38 的 #290（forceSelfSync）+ #282（targeted watch scan）重构了 tokscale 块——新增 `targetRequested`/`targetTokscaleClients`/`targetClients` 变量驱动靶向扫描，`maybeSyncCursor`/`maybeSyncAntigravity` 改用 `selfSyncForced(options.forceSelfSync, 'cursor'/'antigravity')` 替代旧的 `options.forceCursorSync === true`，anchored tick 用 `replaceTodayPartitions`/`completeTodayPartitions`/`mergeTodayPartitions` 替代旧的简单 `extractUsageFromTokscale`。我们 620164c 当时也独立加了外层 try/catch（同样为防止 tokscale 失败抹掉原生读取）。git 把双方逻辑搅在一起。**解决**：采用上游 v0.38 新结构（targetRequested/selfSyncForced/replaceTodayPartitions 等，逐行 +2 空格缩进进 try 块），保留我们的外层 try/catch（上游没有，我们的更稳——tokscale 失败时原生 zcode/cowork 读取仍能填充用量）。
- **冲突 2**（collector.js `clientWatchCandidates` 区域，~55 行）：上游 v0.38 的 #285 把 `watchPathsForClients`（返回扁平路径数组）重构为 `watchClientRootsForClients`（返回 `{client: [dirs]}` map）+ 薄包装 `watchPathsForClients` + 新增 `clientsForWatchPath(filePath, rootsByClient)` 用于路径→客户端映射。我们 620164c 在同区域加了 `NATIVE_ONLY_CLIENTS`/`tokscaleClientsCsv`/`enabledZcode`/`coworkEnabled`/`zcodePricingMap` 辅助函数。git 把函数签名和辅助函数搅在一起。**解决**：保留我们的全部辅助函数，采用上游新的 `function watchClientRootsForClients(clientsCsv) { const rootsByClient = {};` 签名（共享 body 用 `rootsByClient`，自动接上）。
- **关键后续修复：cowork watch key 迁移** ⭐：上游 v0.38 新增 `tests/shared/clientPartitionInvariants.test.js`，断言 `clientWatchCandidates(DEFAULT_CLIENTS)` 返回的每个 key 都在 `DEFAULT_CLIENTS` 中。我们原来在 `clientWatchCandidates` 里用 `byClient.cowork = roots` 添加 cowork watch 路径——但 `cowork` 不在 `DEFAULT_CLIENTS`（cowork 归 `claude`，这是第三节的设计决策），违反不变量，会导致每个 watch tick 静默降级为 full scan。**修复**：改为 `byClient.claude = [...(byClient.claude || []), ...roots]`——cowork 的 watch roots 合并进 `claude` 键（而非独立 `cowork` 键）。路径映射返回 `claude`，靶向扫描可处理；cowork 原生读取仍由 `coworkEnabled('claude')` 触发，不受影响。
- **依赖**：tokscale/electron 版本均未变（仍是 4.7.0 / 43.2.0），无需 `npm install`，**electron.exe 保持完整**，VBS/BAT 启动不受影响。
- **上游 v0.38 值得注意的改动**（与 zcode/cowork 无直接冲突）：①**native fs.watch 全平台**（`#285`，collector——`watchClientRootsForClients` 重构 + `clientsForWatchPath` + Windows 路径规范化防 abort）；②**forceSelfSync**（`#290`，collector——cursor/antigravity 手动刷新绕过 5 分钟节流，`forceCursorSync` → `forceSelfSync`）；③**减少后台/隐藏渲染开销**（`#282`，collector+renderer——watch 事件映射到客户端只刷新 `--today`，隐藏窗口合并重渲染）；④**compact token units 国际化**（`#287`，settings/renderer）；⑤landing page 重设计（`#283`，site）；⑥limits reset expiry 精确显示 + MiMo/Kimi 配额比读取修复。#282 和 #285 都改了 collector.js 但都在 `collectUsageOnce`/`startCollector` 内部，与我们的 zcode/cowork 集成区域（tokscale 块之后的 merge、`clientWatchCandidates` 的 zcode/cowork 路径）通过 try/catch 和辅助函数隔离。
- **验证（与 rebase 前对比）**：rebase 前完整 `npm test` = 2048 tests / 2042 pass / **4 fail**；rebase 后 = **2085 tests / 2078 pass / 5 fail**。测试数 +37（v0.38 新增 clientPartitionInvariants/watcherNativeEvents/statsRenderScheduler 等），失败数 4→5（+1 是 #282 新加的 `live collection retries all clients after a failed targeted watch scan` 计时测试）。
- **5 个失败全部是环境/上游问题，零代码回归**：①`clientDataDirPresence detects Cline VS Code task storage`（预存环境失败）；②`clientDataDirPresence requires an actual VS Code Copilot chat source`（预存）；③`watchPathsForClients watches Pi...`（预存，本机路径不匹配）；④`smart collection retries a failed activity scan on the next interval`（v0.36 #160 计时测试，2s 超时，本机高负载）；⑤`live collection retries all clients after a failed targeted watch scan`（v0.38 #282 计时测试，2s 超时——本机超时是因为 `coworkEnabled('claude')` 触发真实 cowork 原生读取，与 HANDOFF v0.34 记录的"本机真实数据污染 mock"同一类环境问题，干净 CI 会通过）。我们的 4 个专项测试文件 + clientPartitionInvariants 全绿（47 pass / 0 fail）。`npx eslint`（9 个核心改动文件）无告警。
- 真实数据验证：`collectZcodeUsage` 返回 today 18.59M / month 1.71B / allTime 1.71B，模型 `GLM-5.2`；customModelPricing getter 链路验证通过（`usageConfigFromSettings` 返回函数 getter → 解析定价数组 → `collectZcodeUsage` 带 pricing map 返回 today $0.27 / month $39.57，inputPerM=1/outputPerM=2 测试单价）。

### 2026-07-31 rebase：v0.38.0 → v0.39.0 ⚠️ 1 处冲突（micode/zcode watch 路径）
- `git fetch origin` 后 `origin/main` 从 `64e1fd6`(v0.38.0) 前进 6 个提交到 `71cfcff`（含 `06a7f32` release v0.39.0）。`git rebase origin/main` 在 `620164c`(feat：ZCode + Cowork 主体)冲突 1 个文件（collector.js），手工解决 1 处冲突后 21 个本地提交全部干净重放（`git merge-base --is-ancestor origin/main HEAD` 确认 v0.39 是 HEAD 祖先）。**无 `_resolve_pkg.js` 残留**。
- **冲突**（collector.js `clientWatchCandidates` 的 micode/zcode watch 路径，~25 行）：上游 v0.39 的 #296（token throughput）附带把 micode 的 watch 路径从单个 `~/.local/share/mimocode` 扩展为两个（加 macOS orca hook-sandbox `~/Library/Application Support/orca/mimocode-hooks/shared/data`，tokscale 4.8.0 的 `discover_micode_dbs_in_dirs` 会 union 这两个目录）。我们 620164c 在同区域把 zcode 的 watch 路径从上游的 `~/.zcode/projects`（tokscale 假设的错路径）改为 `~/.zcode/cli/db` + `~/.zcode/cli/rollout`（原生读取的正确路径）。git 把双方对 micode/zcode 行的改动搅在一起。**解决**：采用上游的 micode 扩展（两个路径 + orca hook-sandbox 注释），保留我们的 zcode 路径（`cli/db` + `cli/rollout` + 原生读取注释）。双方特性都保留。
- **依赖更新**：`4bef169 chore(deps): bump tokscale to 4.8.0`，`npm install` 更新 3 个包。electron 版本未变（仍是 43.2.0），不触发 postinstall 重下，即使有 electron 进程在跑也不会 EBUSY。
- **上游 v0.39 核心改动**（与 zcode/cowork 无直接冲突）：①**token throughput 显示**（`#296`，usage.js 新增 `timedTokens`/`timedOutputTokens`/`timedDurationMs` 字段 + app.js `tokenRatePerSecond`/`tokenBurnPerMinute`/`renderTokenRate` + main.js `tokenRateMode` setting + 标题栏点击切换 speed/burn）；②**WSL 会话详情**（`#297`，新增 `sessionDetailResolver.js` + `sessionDetailWorker.js`，`readSessionDetail` → `readSessionDetailForPlatform`，Windows 上 claude/codex 会话在原生找不到时去 WSL home 找——**不修改 sessionDetail.js**，只是外层包装，我们的 zcode 会话详情分支不受影响）；③**窗口最大化状态恢复**（`#300`，新增 `windowState.js`，`windowMaximized` setting）；④tokscale 4.8.0（micode orca hook-sandbox union + 别的扫描改进）；⑤CodeQL 安全扫描（CI）。#296 改了 usage.js/collector.js/app.js/main.js 但都在与我们不同的区域（throughput 新字段 vs normalizeClientName zcode 归一化；micode 路径扩展 vs zcode/cowork watch 路径）。
- **自动合并验证**：上一轮 v0.38 手工解决的 tokscale 块（targetRequested/selfSyncForced/replaceTodayPartitions + 我们的外层 try/catch）和 cowork watch key 修复（`byClient.claude` 合并）这次 git **全部正确自动合并**，无需再手工干预——说明上一轮的合并形态已成为基线，git 能识别。
- **验证（与 rebase 前对比）**：rebase 前完整 `npm test` = 2085 tests / 2078 pass / **5 fail**；rebase 后 = **2140 tests / 2133 pass / 5 fail**。测试数 +55（v0.39 新增 tokenRate/windowState/sessionDetailResolver/usageThroughput 等），**失败集合与 rebase 前逐字相同**（2 个 clientDataDirPresence + 1 个 watchPathsForClients Pi 路径 + 2 个 collector 计时测试），零代码回归。我们的 4 个专项测试文件 + clientPartitionInvariants 全绿（47 pass / 0 fail）。`npx eslint`（9 个核心改动文件）无告警。
- 真实数据验证：`collectZcodeUsage` 返回 allTime 1.71B（与 v0.38 一致），模型 `GLM-5.2`；customModelPricing getter 链路验证通过（`usageConfigFromSettings` 返回函数 getter → 解析定价数组）。

### 2026-08-01 rebase：v0.39.0 → v0.40.0 ⚠️ 2 处冲突（tokscale 块新签名 + 辅助函数区）
- `git fetch origin` 后 `origin/main` 从 `71cfcff`(v0.39.0) 前进 13 个提交到 `9644a52`（含 `5b6f804` release v0.40.0）。`git rebase origin/main` 在 `1c8c4f2`(feat：ZCode + Cowork 主体)冲突 1 个文件（collector.js），手工解决 2 处冲突后 22 个本地提交全部干净重放（`git merge-base --is-ancestor origin/main HEAD` 确认 v0.40 是 HEAD 祖先）。**无 `_resolve_pkg.js` 残留**。
- **冲突 1**（collector.js `collectUsageOnce` tokscale 块，~80 行）：上游 v0.40 的 #319（watch Antigravity source roots）重构了 sync 节流——`selfSyncForced` → `selfSyncMinIntervalMs`/`selfSyncSelected`/`sourceSyncFloorMs`/`lastSyncFailed`/`beginSyncAttempt`/`completeSyncAttempt`，`maybeSyncCursor`/`maybeSyncAntigravity` 的 `force` 参数改为 `minIntervalMs` + `onFailure` 回调，`options.forceSelfSync` → `options.sourceSelfSync`。我们 1c8c4f2 当时也独立加了外层 try/catch（同样为防止 tokscale 失败抹掉原生读取）。git 把双方逻辑搅在一起。**解决**：采用上游 v0.40 新签名（`minIntervalMs: selfSyncMinIntervalMs(options, 'cursor'/'antigravity')` + `onFailure: options.onSelfSyncFailed`），保留我们的外层 try/catch（上游没有，我们的更稳——tokscale 失败时原生 zcode/cowork 读取仍能填充用量）。删除 git 产生的重复 anchored 块和多余 `}`。
- **冲突 2**（collector.js 辅助函数区，~70 行）：上游 v0.40 新增 `selfSyncSourceRootsForClients` 函数（antigravity IDE source roots watch，配合 #319 的 source-event 短节流）。我们 1c8c4f2 在同区域加了 `NATIVE_ONLY_CLIENTS`/`tokscaleClientsCsv`/`enabledZcode`/`coworkEnabled`/`zcodePricingMap` 辅助函数。git 把双方新增函数搅在一起。**解决**：双方都保留——上游的 `selfSyncSourceRootsForClients` 在前，我们的 5 个辅助函数在后（顺序无依赖，都在 `watchClientRootsForClients` 之前）。
- **依赖更新**：`019b544 chore(deps): update tokscale to 4.9.0`，`npm install` 更新 3 个包。electron 版本未变，不触发 postinstall 重下。
- **上游 v0.40 核心改动**（与 zcode/cowork 无直接冲突）：①**Antigravity source roots watch**（`#319`，collector——新增 `selfSyncSourceRootsForClients`/`antigravityDataRoots`/`ANTIGRAVITY_SOURCE_DIRS`/`ANTIGRAVITY_SHALLOW_SOURCE_DIRS`，sync 节流重构为 `selfSyncMinIntervalMs`/`sourceSyncFloorMs`/`lastSyncFailed`/`beginSyncAttempt`/`completeSyncAttempt`，watch 事件触发短节流 10s 而非空闲节流 5min，失败后回退空闲节流直到成功）；②**hold-to-boost token rate 动画**（`#306`，`tokenRatePresentation.js` 新增）；③**subscriptions 共享**（`#304`/`#305`，`subscriptionDisplay.js` 新增 720 行，记录每个 AI 账户成本并跨设备同步）；④**compact cost units 本地化**（`#307`/`#309`，`compactMoney.js`/`compactTokens.js` 新增）；⑤**i18n 本地化 release notes**（`#311`）；⑥**appUpdater 避免 GitHub REST rate limits**（`#312`）；⑦**inline subscriptions 编辑器交互改进**（`#308`）。#319 是唯一与 collector.js 冲突的，但都在 `collectUsageOnce` 的 sync 调用和 `clientWatchCandidates` 的 antigravity 路径，与我们的 zcode/cowork 集成区域（tokscale 块之后的 merge、辅助函数）通过 try/catch 和函数边界隔离。
- **自动合并验证**：上一轮 v0.39 手工解决的 micode watch 路径扩展这次 git **正确自动合并**；v0.38 手工解决的 cowork watch key 修复（`byClient.claude` 合并）和 tokscale targeted-scan 块也继续自动合并，无需再手工干预——说明这些合并形态已成为基线，git 能识别。
- **验证（与 rebase 前对比）**：rebase 前完整 `npm test` = 2140 tests / 2133 pass / **5 fail**；rebase 后 = **2334 tests / 2327 pass / 5 fail**。测试数 +194（v0.40 大版本新增 subscriptionDisplay/compactMoney/compactTokens/appUpdater/dashboardWindow/limitProviderPresentation 等），**失败集合与 rebase 前逐字相同**（2 个 clientDataDirPresence + 1 个 watchPathsForClients Pi 路径 + 2 个 collector 计时测试），零代码回归。我们的 4 个专项测试文件 + clientPartitionInvariants 全绿（47 pass / 0 fail）。`npx eslint`（9 个核心改动文件）无告警。
- 真实数据验证：`collectZcodeUsage` 返回 allTime 1.71B / costUsd $39.57（与 v0.39 一致），模型 `GLM-5.2`；customModelPricing getter 链路验证通过（`usageConfigFromSettings` 返回函数 getter → 解析定价数组 → `collectZcodeUsage` 带 pricing map 返回正确成本）。

### 2026-08-04 rebase：v0.40.0 → v0.41.0 ⚠️ 2 处冲突 + clientHealth allowlist/cowork roots 格式适配
- `git fetch origin` 后 `origin/main` 从 `9644a52`(v0.40.0) 前进 12 个提交到 `dd4d81c`（含 `2ad0b8d` release v0.41.0）。`git rebase origin/main` 在 `6d7d943`(feat：ZCode + Cowork 主体)冲突 1 个文件（collector.js），手工解决 2 处冲突后 23 个本地提交全部干净重放。**无 `_resolve_pkg.js` 残留**。
- **冲突 1**（collector.js `collectUsageOnce` tokscale 块，~80 行）：上游 v0.41 的 #323（extract self-sync throttle）把 self-sync 节流逻辑从 collector.js 抽到独立的 `selfSyncThrottle.js`——`selfSyncMinIntervalMs` → `selfSyncThrottle.minIntervalForTick`，`beginSyncAttempt`/`completeSyncAttempt` → `selfSyncThrottle.beginAttempt`/`completeAttempt`，`syncDue` → `selfSyncThrottle.claim`，`sourceSyncFloorMs`/`lastSyncFailed` 等全部移走。我们 6d7d943 的外层 try/catch 与上游的签名变更在同区域冲突。**解决**：采用上游 v0.41 新签名（`selfSyncThrottle.minIntervalForTick(options, 'cursor'/'antigravity')`），保留我们的外层 try/catch。删除 git 产生的重复 anchored 块和多余 `}`。（与 v0.40 rebase 的解决模式一致，仅签名从 `selfSyncMinIntervalMs` → `selfSyncThrottle.minIntervalForTick`。）
- **冲突 2**（collector.js `clientSourceRoots` 的 zcode watch 路径，~12 行）：上游 v0.41 把 `clientWatchCandidates` 重构为 `clientSourceRoots`（返回 `{client: [{id, dir}, ...]}` 带标签格式），`add` 函数签名从 `add(client, ...paths)` 改为 `add(client, ...[id, dir])`。上游 zcode 行用 `add('zcode', ['zcode-projects', path...])`，我们用 `add('zcode', path1, path2)`（旧格式）。**解决**：采用新标签格式 `add('zcode', ['zcode-db', path...], ['zcode-rollout', path...])`，保留我们的 `cli/db` + `cli/rollout` 路径。
- **关键后续修复 1：clientHealth allowlist 更新** ⭐：上游 v0.41 新增 `clientHealth.js` + `clientHealth.test.js`，测试断言 `clientSourceRoots` emit 的每个 root id 都在 `CLIENT_SOURCE_CHECK_IDS` allowlist 中，且 allowlist 中无 dead weight。我们把 zcode 的 watch 标签从 `zcode-projects` 改为 `zcode-db` + `zcode-rollout`，但 allowlist 仍是旧的 `zcode-projects`，导致 2 个测试失败（`every source-root id...` + `deriveClientHealth...`）。**修复**：在 `src/shared/clientHealth.js` 和 `worker/src/shared/clientHealth.js`（worker 镜像）的 `CLIENT_SOURCE_CHECK_IDS` 中把 `zcode-projects` 替换为 `zcode-db` + `zcode-rollout`，同时新增 `cowork-sessions`（见修复 2）。
- **关键后续修复 2：cowork roots 新格式适配** ⭐：上游 v0.41 的 `clientSourceRoots` 返回 `{client: [{id, dir}, ...]}` 格式，但我们 cowork roots 合并代码 `byClient.claude = [...(byClient.claude || []), ...roots]` 仍用旧的字符串路径数组（`coworkSession.sessionsRoots({})` 返回字符串数组）。合并后 claude roots 中混入裸字符串，`dir` 变成 `undefined`，触发 `claude emitted undefined` 断言。**修复**：改为 `...roots.map((dir) => ({ id: 'cowork-sessions', dir }))`，把 cowork 的字符串路径转为带标签对象。同时把 `cowork-sessions` 加到 `CLIENT_SOURCE_CHECK_IDS` allowlist（src + worker 镜像）。
- **依赖更新**：`dce525e chore(deps): update tokscale to 4.10.0` + `00b375b chore(deps): refresh Electron and runtime dependencies`，`npm install` 更新 20 个包（含 Electron 43.2.0 → 43.3.0 + tokscale 4.9.0 → 4.10.0）。Electron 升级需先关闭 electron 进程再 install（否则 EBUSY）。
- **上游 v0.41 核心改动**（与 zcode/cowork 无直接冲突）：①**self-sync throttle 抽取**（`#323`，`selfSyncThrottle.js` 新增 359 行，collector.js 的 sync 节流逻辑移走，新增 `createSourceSyncQueue` 处理 deferred source events）；②**per-client health 诊断**（`#328`/`#331`，`clientHealth.js` 新增 359 行 + `diagnosticReport.js` 1010 行 + `diagnosticJournal.js` + `diagnosticSnapshot.js` + `diagnosticsPanel.js` + `clientHealthPresentation.js`）；③**on-demand diagnostic report**（`#340`，main.js + 诊断面板）；④**MiMo watcher bound to SQLite files**（`#338`，collector.js micode watch 路径——不影响 zcode 路径）；⑤**trends preserve empty calendar days**（`#335`）；⑥**settings row drag controller**（`#326`/`#327`，`rowDragController.js` 新增 301 行）；⑦**runtimeConfig 重构**（`runtimeConfig.js` +32 行，可能影响 customModelPricing getter——验证通过）。#323 和 #338 都改了 collector.js 但都在 sync 节流和 micode 路径，与 zcode/cowork 集成区域通过 try/catch 和函数边界隔离。
- **验证（与 rebase 前对比）**：rebase 前完整 `npm test` = 2334 tests / 2327 pass / **5 fail**；rebase 后（修复前）= 2484 tests / 2474 pass / **8 fail**（+3 新失败：2 个 clientHealth allowlist + 1 个 coalesced targeted refresh）；修复后 = **2484 tests / 2476 pass / 6 fail**。测试数 +150（v0.41 新增 clientHealth/diagnosticReport/selfSyncThrottle/rowDragController/diagnosticsPanel 等），修复后失败数 5→6（+1 是 v0.41 新增的 `coalesced targeted refresh reports the replay failure` 计时测试——**在 origin/main 上也失败**，本机真实数据污染 mock，非我们的回归）。我们的 4 个专项测试文件 + clientPartitionInvariants + clientHealth（35 pass / 0 fail）全绿。`npx eslint`（9 个核心改动文件）无告警。
- 真实数据验证：`collectZcodeUsage` 返回 allTime 1.71B / costUsd $39.57（与 v0.40 一致），模型 `GLM-5.2`；customModelPricing getter 链路验证通过。

### 2026-08-06 rebase：v0.41.0 → v0.42.0 ⚠️ 2 处冲突（zcode watch 标签 + clientHealth allowlist）
- `git fetch origin` 后 `origin/main` 从 `dd4d81c`(v0.41.0) 前进 9 个提交到 `a4fddec`（含 `daf23d0` release v0.42.0）。`git rebase origin/main` 在 2 个提交上冲突，手工解决后 24 个本地提交全部干净重放。**无 `_resolve_pkg.js` 残留**。
- **冲突 1**（`60d8fc7` feat：ZCode + Cowork 主体，collector.js `clientSourceRoots` zcode watch 路径，~15 行）：**上游 v0.42 首次纳入 zcode watch**（#350/#352/#353 collector watcher 大重构）——上游用 `['zcode-projects', ~/.zcode/projects]` + `['zcode-cli-db', zcodeDbDir, db.sqlite]` 标签 watch zcode 路径，我们用 `['zcode-db', cli/db]` + `['zcode-rollout', cli/rollout]`。git 把双方对 zcode 行的改动搅在一起。**解决**：采用上游的 `zcode-projects` + `zcode-cli-db` 标签（与上游 allowlist 已对齐），**额外保留** `['zcode-rollout', cli/rollout]`（rollout 是我们的 JSONL 备用源，watch 它可在 db.sqlite 被锁时仍触发刷新）。最终 zcode watch 有 3 个标签：`zcode-projects`（空目录，无害）+ `zcode-cli-db`（主源）+ `zcode-rollout`（备用源）。
- **冲突 2**（`33ddc28` fix：clientHealth allowlist，src/shared/clientHealth.js + worker/src/shared/clientHealth.js 各 ~7 行）：我们 v0.41 把 allowlist 的 `zcode-projects` 替换为 `zcode-db` + `zcode-rollout`，但上游 v0.42 的 allowlist 已自带 `zcode-cli-db` + `zcode-projects`（对应上游的 watch 标签）。git 把双方对 zcode 行的替换搅在一起。**解决**：保留上游的 `zcode-cli-db` + `zcode-projects`，**额外添加** `zcode-rollout`（对应冲突 1 中保留的 rollout watch 标签）。最终 allowlist 含 3 个 zcode 标签 + `cowork-sessions`（上游 v0.42 已自带）。
- **collector.js 其它区域自动合并**：v0.41 手工解决的 tokscale 块（selfSyncThrottle 签名 + 我们的外层 try/catch）、cowork watch key 修复（`byClient.claude` 合并 + `{id: 'cowork-sessions', dir}` 格式）、辅助函数（NATIVE_ONLY_CLIENTS/tokscaleClientsCsv/enabledZcode/coworkEnabled/zcodePricingMap）全部 git **正确自动合并**，无需再手工干预。
- **依赖更新**：`tokscale 4.10.0 → 4.11.0`，`npm install` 更新 3 个包。Electron 版本未变（仍是 43.3.0），不触发 postinstall 重下，electron.exe（225MB）保持完整。
- **上游 v0.42 核心改动**（与 zcode/cowork 交互）：①**collector watcher 大重构**（#350/#352/#353/#354——OpenCode/Antigravity watcher bound to tokscale sources、overlapping watch roots union、hide unused headless capture roots，collector.js +610 行）；②**GLM CREDIT_LIMIT quota windows**（#351，zaiLimits/kimiLimits）；③**Kimi quota display aligned with web console**（#344）；④**self-sync failure details in diagnostics**（#342）；⑤**trends preserve live totals across date rollover**（#341）；⑥**credentialStore**（上游新增 `credentialStore.js`，private credential 文件读写——Windows 上 `lstatSync().ino` vs `fstatSync(fd).ino` 不一致导致 7 个测试在 origin/main 上也失败，是环境兼容性问题）。#350/#352/#353/#354 改了 collector.js 但都在 watcher roots 去重/边界逻辑，与我们的 zcode/cowork 集成区域（tokscale 块之后的 merge、辅助函数）通过 try/catch 和函数边界隔离。
- **验证（与 rebase 前对比）**：rebase 前完整 `npm test` = 2484 tests / 2476 pass / **6 fail**；rebase 后 = **2526 tests / 2512 pass / 12 fail**。测试数 +42（v0.42 新增 credentialStore/watcherNativeEvents/collectorLoadGuards/kimiLimits/selfSyncThrottle 等），失败数 6→12（+7 是 v0.42 新增 credentialStore 在 Windows 上的 `ino` 不一致兼容性问题——**在 origin/main 上也 7 fail**；+1 是 `live collection retries all clients after a failed targeted watch scan` 计时测试——v0.38 就有的预存环境失败，本机真实数据污染 mock）。**5 个预存失败**（2 clientDataDirPresence + smart collection + live collection + coalesced targeted refresh）与 v0.41 逐字相同。我们的 4 个专项测试文件 + clientPartitionInvariants + clientHealth（84 pass / 0 fail）全绿。`npx eslint`（7 个核心改动文件）无告警。
- 真实数据验证：`collectZcodeUsage` 返回 allTime 1.71B / costUsd $39.57（与 v0.41 一致），模型 `GLM-5.2`；customModelPricing getter 链路验证通过（`usageConfigFromSettings` 返回函数 getter → 解析定价数组 → `collectZcodeUsage` 带 pricing map 返回正确成本）。

### 2026-08-06 rebase：v0.42.0 → v0.43.0 ✅ 零冲突自动合并
- `git fetch origin` 后 `origin/main` 从 `a4fddec`(v0.42.0) 前进 18 个提交到 `147c80f`(v0.43.0)，跨越 v0.42.1 + v0.43.0 两次发布。`git rebase origin/main` **零冲突**自动完成 —— 25 个本地提交全部干净重放。**无 `_resolve_pkg.js` 残留**。
- **零冲突原因分析**：上游 v0.42→v0.43 改动虽大（133 文件 +22650 行），但与我们的 zcode/cowork 集成区域**完全不重叠**：
  - `collector.js`（+91 行）：上游改了 watcher roots 去重/边界逻辑（#350/#352/#353/#354 的延续）和 anchor seed（#339），但都在 `clientSourceRoots` 之前的 watch 块和 `collectUsageOnce` 的 anchor 块，与我们的 tokscale try/catch + zcode/cowork merge 块（在 tokscale 块之后）通过函数边界隔离。git 自动合并。
  - `main.js`（+754 行）：上游加了 macOS Widget 生命周期管理（#194）、updater 修复（#356/#357）、quit hang 修复（#337）、boot anchor seed（#339），这些都在 tray/appUpdater/quit/bootstrap 区域，与我们的 `customModelPricing` getter（在 `runtimeConfig.js` 不在 `main.js`）无重叠。git 自动合并。
  - `app.js`（+192 行）：上游加了 Hunyuan icon（#370）、subscription display、widget UI，与我们的会话白名单 `'zcode'`（行号迁移）无重叠。git 自动合并。
  - `runtimeConfig.js`（+6 行）：上游改了 `usageConfigFromSettings` 的小细节，我们的 `customModelPricing: () => settings.customModelPricing || []` getter（第 100 行）保留。git 自动合并。
  - `clientHealth.js` / `clientTracking.js` / `usage.js` / `zcodeSession.js` / `coworkSession.js`：上游无改动，完全保留。
- **依赖更新**：`tokscale 4.11.0 → 4.13.0`（跨 2 个版本），`npm install` 更新多个包。新增 `@electron/osx-sign`（macOS 专属签名工具，不影响 Windows）。Electron 版本未变（43.3.0），不触发 postinstall 重下。
- **上游 v0.43 核心改动**（与 zcode/cowork 无交互）：①**macOS WidgetKit extension**（#194，ecbaadf——实验性 macOS 桌面小组件，新增大量 mac-widget 文件 + 测试，**在 Windows 上 14 个测试失败**，纯环境问题）；②**star-history charts**（#366/#367/#368——GitHub star 增长图表，CI 专属）；③**updater 修复**（#356/#357——install hand-off 确认 + quit flags 释放）；④**quit hang 修复**（#337——退出时不再挂起）；⑤**boot anchor seed**（#339——从 collector anchor 初始化本地 stats）；⑥**OpenCode local fallback opt-in**（#361）；⑦**widget snapshot pipeline**（#373/#372/#363——macOS 专属）；⑧**Hunyuan icon**（#370——hy3 模型显示混元图标）；⑨**tokscale 4.12→4.13**。
- **验证（与 rebase 前对比）**：rebase 前完整 `npm test` = 2526 tests / 2512 pass / **12 fail**；rebase 后 = **2854 tests / 2819 pass / 28 fail**。测试数 +328（v0.43 新增大量 macOS Widget/anchorSeed/updateInstallQuit/starHistory/limitCollector.opencode 等），失败数 12→28（+16）：
  - **+14 macOS Widget 测试**（#194，Windows 无法运行 macOS WidgetKit——环境问题）
  - **+2 credentialStore 测试**（v0.42 有 7 fail，v0.43 新增 2 个 credentialStore 测试也是 Windows `ino` 不一致——**在 origin/main 上也 9 fail**）
  - **+1 watchIgnoreMatcher Hermes runtime**（v0.43 新增的 Hermes watch ignore 测试，在 Windows 上 `expected: true, actual: false`——**在 origin/main 上也 fail**，已用 worktree 验证）
  - 其余 12 个失败与 v0.42 逐字相同（5 预存环境 + 7 credentialStore）
  - **零代码回归**：所有 28 个失败都是环境问题（macOS 专属 / Windows `ino` 不一致 / 本机真实数据污染 mock），我们的 4 个专项测试文件 + clientPartitionInvariants + clientHealth（84 pass / 0 fail）全绿。`npx eslint`（6 个核心改动文件）无告警。
- 真实数据验证：`collectZcodeUsage` 返回 allTime 1.71B / costUsd $39.57（与 v0.42 一致），模型 `GLM-5.2`；customModelPricing getter 链路验证通过（`usageConfigFromSettings` 第 100 行返回函数 getter → 解析定价数组 → `collectZcodeUsage` 带 pricing map 返回正确成本）。launch-background.vbs 启动验证通过（4 个 electron 进程正常启动）。

### 2026-08-14 rebase：v0.43.0 → v0.44.0 ⚠️ 5 处冲突（Reasonix 会话详情 + history 分量 + Hub registry）
- `git fetch origin` 后 `origin/main` 从 `147c80f`(v0.43.0) 前进 17 个提交到 `3afcfe0`（含 `d0b0063` release v0.44.0，以及随后的 adaptive limits / localized changelog 修复）。`git rebase origin/main` 在 4 个本地提交上冲突，手工解决后 25 个本地提交全部重放（`git merge-base --is-ancestor origin/main HEAD` 确认 v0.44 是 HEAD 祖先）。**无 `_resolve_pkg.js` 残留**。备份分支：`backup/pre-v0.44-rebase`。
- **冲突 1**（`75aefd4` feat：ZCode + Cowork 主体，collector.js `tokscaleClients`）：上游 v0.44 的 Reasonix 接入把过滤从「只剔 proma」改成注释「Reasonix 走 tokscale」。我们用 `tokscaleClientsCsv()` 剔 `zcode`+`proma`。**解决**：保留 `tokscaleClientsCsv(normalizedClients)`，并在注释里写明 Reasonix 不是 native-only、仍走 tokscale。
- **冲突 2**（同一提交，collector.js `collectUsageOnce` tokscale 之后）：我们插入 zcode/cowork merge，旧提交还带一份简单的 `onAnchorComputed`；上游已在 summary 之后有更完整的 `onAnchorComputed`（含 Reasonix `nativeSessions`/`nativeProjects`）。**解决**：保留 zcode/cowork merge，**不**保留旧的提前 `onAnchorComputed`，避免回调打两次。
- **冲突 3**（`3b47e19` feat：zcode session detail，sessionDetail.js）：上游加 Reasonix 原生详情，我们加 ZCode 原生详情。**解决**：两个 import、两个 `read*SessionDetail`、`readSessionDetail` 里两个 `if` 都保留。
- **冲突 4**（`06f8c13` fix：会话白名单，app.js）：上游白名单加 `'reasonix'` + `detailUnavailable` 守卫，我们加 `'zcode'`。**解决**：白名单同时含 reasonix 和 zcode，Reasonix 的 `detailUnavailable` 检查保留。
- **冲突 5**（`247a8a3` docs+fix：Cowork history graph，history.js / worker 镜像）：上游 v0.44 `#398` 把 `sumTokens` 收成 `input+output+cacheRead+cacheWrite`，并对 Reasonix 把 `reasoning` 当独立分量；同时新增 `sumOutputTokens`/`componentValues`/`applyComponentSummary`。我们当年加了 `totalTokens` 等别名，因为 Cowork graph 发的是 `{ tokens: { totalTokens } }`。纯采用上游会让 Cowork 历史变 0。**解决**：保留上游 Reasonix 分量 + `#398` 辅助函数，并叠回别名/`totalTokens` 直取（`firstNum` + `SUM_*_KEYS`）。合并时漏了 `applyComponentSummary` 的闭合 `}`，rebase 结束后补上（src + worker）。
- **后续适配：Hub build registry** ⭐：上游 v0.44 `#399` 用 `hubBuildRegistry.json` 给 Hub 部署状态做源码闭包指纹。改 `history.js`（core 共享模块）后测试 `Hub build registry matches the current core...` 失败，提示 `npm run update:hub-build`。**修复**：跑该脚本并 `sync:worker`，登记新的 core build id。这是 fork 改共享核心后的正常维护，不是上游回归。
- **自动合并验证**：v0.42/v0.41 手工解决的 tokscale try/catch、`tokscaleClientsCsv` 辅助函数、zcode watch 三标签（`zcode-projects`/`zcode-cli-db`/`zcode-rollout`）、cowork roots 并入 `claude` + `{id:'cowork-sessions'}`、`customModelPricing` getter、clientHealth allowlist，这次 git **全部正确自动合并**。`runtimeConfig.js` 的 getter 仍在 `usageConfigFromSettings`。
- **依赖**：tokscale 仍是 **4.13.0**，Electron 仍是 **43.3.0**，`npm install` 报 up to date；electron.exe 保持完整，VBS/BAT 启动不受影响。
- **上游 v0.44 核心改动**（与 zcode/cowork 的交界）：①**Reasonix 用量追踪**（#365/#384——新客户端，走 tokscale + 原生 session sidecar；会话详情/白名单/clientTracking/clientHealth 与我们并列保留）；②**固定用量区间**（#393/#398——`fixedPeriodRanges` + history 保留 token 分量）；③**tray 跟随最近活动工具 / 紧凑成本**（#397/#396）；④**Hub 远程部署状态**（#399——`hubBuildRegistry`）；⑤**配额燃烧自适应刷新**（#405）；⑥NSIS 可选安装目录（#390）；⑦Kiro globalStorage 不进 live watcher（#381）。Reasonix 明确走 tokscale，不进 `NATIVE_ONLY_CLIENTS`。
- **验证（与 rebase 前对比）**：rebase 前完整 `npm test` = 2854 tests / 2819 pass / **28 fail**（v0.43 记录，含 macOS Widget / credentialStore Windows `ino`）；rebase 后首次完整跑 = **3105 tests / 3090 pass / 8 fail**（含 Hub registry 指纹未更新）；`npm run update:hub-build` 后 Hub 测试 13/13 全绿，预期 **3105 / 3091 / 7 fail**。测试数 +251（v0.44 新增 Reasonix/fixedPeriod/hubBuild/limitsBurnRate 等）。
- **剩余 7 个失败全部是环境/预存问题，零代码回归**：①macOS Widget symlink（Windows 无法跑 WidgetKit）；②③`clientDataDirPresence` Cline / Copilot（预存路径）；④`watchIgnoreMatcher` Hermes runtime（v0.43 起 Windows 上 origin/main 也 fail）；⑤`smart collection retries...`（计时超时）；⑥`live collection retries all clients...`（本机真实 cowork 数据污染 mock）；⑦`coalesced targeted refresh reports the replay failure`（同样本机数据污染）。credentialStore Windows `ino` 本轮未复现。我们的专项测试 + clientPartitionInvariants + clientHealth + history + reasonix + hubBuild **全绿**。`npx eslint`（核心改动文件）无告警。
- 真实数据验证：`collectZcodeUsage` 返回 allTime **1.705B**，模型 `GLM-5.2`（本月/今日为 0，符合当前未使用窗口）；`usageConfigFromSettings` 的 `customModelPricing` 仍是函数 getter。

### 2026-08-14：ZCode 改走上游 tokscale，Cowork 仍原生
- 上游 tokscale 已扫描 `~/.zcode/cli/db/db.sqlite`（watch 标签 `zcode-cli-db` + `zcode-projects`）。继续原生 merge 会与 tokscale **双计**。
- **collector**：从 `NATIVE_ONLY_CLIENTS` 去掉 zcode；删除 `collectZcodeUsage` merge 与 `enabledZcode`；history graph 用 `tokscaleClients`（含 zcode，仍剔 proma）；watch 与上游对齐，去掉 `zcode-rollout`；clientHealth allowlist 同步去掉该 id。
- **保留**：Cowork 原生 merge + `coworkGraph`；tokscale 外层 try/catch；`customModelPricing` getter（Cowork 单价）；`zcodeSession.js` 仅用于会话详情 + 点击白名单 `'zcode'`。

### 2026-08-17 rebase：v0.44.0 → v0.45.0 ⚠️ 多处冲突（Qoder CN 原生适配器 + Hub registry）
- `git fetch origin` 后 `origin/main` 从 `3afcfe0`(v0.44.0 后续) 前进到 `88a2927`（含 `42511d0` release v0.45.0，以及随后的 session clock / settings / antigravity Windows 路径修复）。`git rebase origin/main` 在 5 个本地提交上冲突，手工解决后本地提交全部重放（`git merge-base --is-ancestor origin/main HEAD` 确认 v0.45 是 HEAD 祖先）。**无 `_resolve_pkg.js` 残留**。备份分支：`backup/pre-v0.45-rebase`。
- **冲突要点**：上游 v0.45 `#301` 新增 Qoder CN 本地 SQLite 适配器（`qodercn` 进 `localClients`，独立 `qoderCnGraph`）。我们的 Cowork 原生 merge / `coworkGraph` / tokscale 外层 try/catch 与同区域冲突。**解决**：`NATIVE_ONLY_CLIENTS = {proma, qodercn}`，ZCode 仍走 tokscale；`collectHistoryOnce` 同时保留 `qoderCnGraph` 与 `coworkGraph`；history 调用用 `tokscaleClients`（不要把 `qodercn` 再送给 tokscale）；Hub registry 先取上游再 `npm run update:hub-build`。
- **后续适配**：rebase 结束后把 `collectUsageOnce` 里重复的 `localClients` 过滤改回 `tokscaleClientsCsv()`，避免 eslint unused；刷新 hub core 指纹。
- **依赖**：Electron **43.3.0 → 43.4.0**（升级前必须关掉 Token Monitor 的 electron，否则 `npm install` EBUSY）；tokscale 仍是 **^4.13.0**。
- **上游 v0.45 核心改动**（与 zcode/cowork 的交界）：①**Qoder CN 本地用量**（#301——原生 SQLite，不进 tokscale）；②**Command Code**（#411/#421——走 tokscale + 额度）；③**WSL CLI-only ZCode 检测**（#431——上游 watch/诊断，我们不再原生 merge zcode）；④history 日边界由 producer 推导（#428）；⑤会话 period 用注入时钟（#362）；⑥字体/托盘/settings 若干修复。Command Code / Reasonix / ZCode 均不进 `NATIVE_ONLY_CLIENTS`。
- **验证**：专项测试 zcodeSession / coworkSession / sessionDetail / clientHealth / clientPartitionInvariants / hubBuild **100 pass / 0 fail**。`npx eslint`（核心改动文件）无告警。

### 2026-08-19 rebase：v0.45.0 → v0.46.0 ⚠️ 会话详情/白名单冲突 + CLAUDE_CONFIG_DIR
- `git fetch origin` 后 `origin/main` 从 `88a2927` 前进 14 个提交到 `bed9fc3`（`chore: release v0.46.0`）。`git rebase origin/main` 在 4 个本地提交上冲突，手工解决后全部重放（`git merge-base --is-ancestor origin/main HEAD` 确认 v0.46 是 HEAD 祖先）。备份分支：`backup/pre-v0.46-rebase`。
- **冲突 1**（`sessionDetail.js`）：上游 v0.46 给 `readSessionDetail` 加了 `env`/`useEnvRoots`（配合 `#455` CLAUDE_CONFIG_DIR）。我们的 `readZcodeSessionDetail` 在同处分发。**解决**：保留上游签名，并叠回 zcode 分支。DSH 会话详情在独立模块 `dshSessionDetail.js`，经 `sessionDetailResolver` 分发，不进 `sessionDetail.js`。
- **冲突 2**（`app.js` 会话点击白名单）：上游加 `'dsh'`，我们加 `'zcode'`。**解决**：两边都留。
- **冲突 3**（`collector.js` `localClients`）：上游把 native-only 收成 `PARSE_LOCAL_CLIENTS`（`proma`,`qodercn`）。**解决**：`tokscaleClientsCsv()` 改为读该常量，避免再维护一份 `NATIVE_ONLY_CLIENTS`。
- **后续适配**：`CLAUDE_CONFIG_DIR` 只搬 Claude Code 的 projects/transcripts；Cowork 仍在 Desktop 沙盒，watch roots 继续并入 `claude`。上游新测试 `Claude source roots follow CLAUDE_CONFIG_DIR` 改为忽略 `cowork-sessions` 后再比精确列表。Hub registry 跑 `npm run update:hub-build`。
- **依赖**：Electron 仍是 **43.4.0**，tokscale 仍是 **^4.13.0**；`npm install` 更新 2 个包（含 Koffi Windows 启动修复 #447）。
- **上游 v0.46 核心改动**：①**DeepSeek Harness (dsh)** 用量 + 本地会话详情（#408/#427/#448）；②**CLAUDE_CONFIG_DIR** 贯穿 session 路径（#455）；③Windows 托盘图标尺寸（#345/#444）；④Hub 草稿在改上传频率时保留（#433）。DSH 走 tokscale，不进 `PARSE_LOCAL_CLIENTS`。

### 2026-08-23 rebase：v0.46.0 → v0.47.0 ⚠️ collector 冲突合并 + Watcher Worker + Cherry Studio / Trae CN / Workbuddy
- `git fetch origin` 后 `origin/main` 从 `bed9fc3` 前进 15 个提交到 `5ecc605`（`5b52b35` release v0.47.0 及后续 watcher 优化）。`git rebase origin/main` 在 3 个提交上冲突，手工解决后全部重放（`git merge-base --is-ancestor origin/main HEAD` 确认 v0.47 是 HEAD 祖先）。备份分支：`backup/pre-v0.47-rebase`。
- **冲突 1**（`collector.js` `localClients` 路由）：上游 v0.47 在 `collectUsageOnce` 引入 `targetTokscaleClientList` / `targetTokscaleClientSet` 并用 `localClients` 过滤。我们用 `tokscaleClientsCsv()`。**解决**：保留 `const localClients = new Set(PARSE_LOCAL_CLIENTS);`，两边结构自然对齐，避免 `unused-variable` 告警。
- **冲突 2**（`collector.js` targeted scan fallback）：上游 v0.47 #467 加强了不安全定向扫描回退检测（`hasUnsafeTargetedResult`），其内部原调用 `runTokscaleFn`。**解决**：将上游内部的 full scan 调用对接我们的 `scanUsageBundle(tokscaleClients, ['--today'])`，使 Antigravity 本地 SQLite 回退与上游安全防御机制完全互通。
- **冲突 3**（`hubBuildRegistry.json` / `worker/.../hubBuildRegistry.json`）：上游 v0.47 新增了 core/node/worker 的多项 revision。**解决**：先保留上游 registry，rebase 后执行 `npm run update:hub-build` + `npm run sync:worker` 登记新的 build id。
- **上游 v0.47 核心改动**：
  ①**Cherry Studio** 用量追踪（#387——`cherrystudio` 接入 tokscale 路径）；
  ②**Trae CN 额度**（#483——`traeLimits.js` 接入中国区企业/个人包）；
  ③**Workbuddy 本地应用额度**（#378——`workbuddyLimits.js` + `workbuddyLocalAuth.js`）；
  ④**Watcher Worker 异步解耦**（#486——`watcherHost.js` + `watcherWorker.js` 将 chokidar 关闭与事件处理移入 worker thread，消除主线程卡顿）；
  ⑤**托盘余额百分比**（#470——tray balance meter percentage）；
  ⑥**Codex OAuth 额度 fallback 优化**（#473）。
- **保留的本地修改**：
  ①ZCode 会话详情 (`zcodeSession.js`)、项目归因、点击白名单、自定义单价 getter；
  ②Claude Cowork 沙盒原生读取 (`coworkSession.js`)、归入 `claude`、历史图表 contribution、watch roots；
  ③谷歌反重力（Antigravity）Windows 本地 SQLite 只读会话解析与缓存路径修正（tokscale #1129）；
  ④`launch-background.vbs`、`install-autostart.bat` 等 Windows 守护脚本。
- **验证**：
  - 核心/定制测试：`cherryStudio` / `traeLimits` / `workbuddyLimits` / `watcherHost` / `collectorAntigravityLocalFallback` / `zcodeSession` / `coworkSession` / `sessionDetail` 等 140/140 测试通过（139 pass, 1 skipped）；
  - `clientHealth` (39/39 pass)、`clientPartitionInvariants` (6/6 pass)、`hubBuild` (21/21 pass) 全绿；
  - `npm run lint`（ESLint）全绿 0 报错；
  - 真实采集验证：`npm run agent:once -- --dry-run` 采集 Antigravity、Codex、Claude、ZCode 等数据正常。

### 2026-08-27 rebase：v0.47.0 → v0.48.0 ⚠️ history/collector/Hub registry 冲突
- `git fetch origin` 后 `origin/main` 从 `5ecc605` 前进到 `3e82f76`（含 v0.48.0 及其后的 upstream 修复）。`git rebase origin/main` 重放 34 个本地提交；备份分支：`backup/pre-v0.48-rebase`。
- **冲突 1**（`history.js` / Worker 镜像）：上游的 Codex/DSH/Reasonix disjoint reasoning 规则与本地 Cowork 图表的 token 字段别名合并保留；两边的历史归并语义均未丢失。
- **冲突 2**（`collector.js`）：以 v0.48 的 signal-aware tokscale 生命周期为基线，保留 Antigravity Windows fallback，并让本地 fallback 继续遵守 abort、termination 和 capability probe 规则。
- **冲突 3**（`hubBuildRegistry.json`）：先保留上游 registry，最终执行 `npm run update:hub-build` + `npm run sync:worker`，登记 core revision 17。
- **依赖**：`npm install` 更新到 `tokscale 4.14.0`、`electron 43.4.0`；`npm ls tokscale electron --depth=0` 核对通过。
- **上游 v0.48 重点**：Cursor managed multi-account、移除 vendored tokscale override、Kimi Work 用量/项目归因、collector lifecycle/cancellation 及第三方 API Sub2API 账户 preset。
- **本地未提交修改（rebase 前已存在，已保留）**：
  ①`antigravityLocalMirror.js`：用只读 `VACUUM INTO` 快照代替 Windows junction，避免实时数据库锁和 symlink 权限问题；
  ②`antigravityTimestampRepair.js`：从 generation step metadata 修复缺失的 Antigravity generation timestamp，无法安全配对时 fail-closed；
  ③`tests/shared/antigravityTimestampRepair.test.js`、`start.bat`。
- **验证**：定制/相关测试 85/85 通过；隔离本机 `DSH_HOME` 后 `npm run verify` 为 3748 tests / 3735 pass / 5 fail / 8 skipped。剩余 5 个失败均为 Windows 本机路径/权限或平台专属测试（macOS symlink、Cline/Copilot/Antigravity 本机数据、Hermes Windows path），不是本轮代码回归。`npm run check` 仍会命中本地旧 `check` 脚本引用的缺失文件 `scripts/build-icons.js`，与上游 v0.48 无关。

### 2026-08-28 rebase：v0.48.0 → v0.49.0 ✅ 零冲突
- `git fetch origin` 后 `origin/main` 从 `3e82f76` 前进到 `7c74e61`（v0.49.0）。`git rebase origin/main` 重放 34 个本地提交，零冲突；备份分支：`backup/pre-v0.49-rebase`。
- 上游 registry 的新 revision 17/18 已保留，随后执行 `npm run update:hub-build` + `npm run sync:worker`，重新登记当前本地 core revision。
- **依赖**：`npm install` 更新 1 个包；当前版本为 `0.49.0`，`tokscale 4.14.0`、`electron 43.4.0`，npm audit 为 0 vulnerabilities。
- **上游 v0.49 重点**：Volcengine Agent Plan quota、Windows 安装目录 AppContainer ACL、更新时保留规范化 settings、Grok/Trae/WSL 额度修复，以及 js-yaml 更新。
- **本地改动**：ZCode/Cowork/Antigravity 集成、Windows Antigravity 本地镜像与时间戳修复、启动脚本均已保留；本轮开始前的未提交改动已恢复且仍未提交。
### 2026-09-01 rebase：v0.50.0 → v0.51.0 ⚠️ collector / Hub registry 冲突合并
- `git fetch origin` 后 `origin/main` 从 `73542b8` 前进到 `36307e7`（包含发布提交 `f8fc74f` / tag `v0.51.0` 及其后续提交）。创建备份分支 `backup/pre-v0.51-rebase`，使用 `git rebase origin/main` 重放本地提交。
- **冲突 1**（`collector.js`）：上游 `1ca4175`（stale sync lock 修复，在 `maybeSyncAntigravity` 中增加 `syncLockPath` 参数）与本地 Antigravity Windows local fallback 分支合并，使 `maybeSyncAntigravity` 在受保护调用的同时传递 `syncLockPath`。
- **冲突 2**（`hubBuildRegistry.json` 及 Worker 镜像）：保留上游 registry 历史，rebase 完成后运行 `npm run update:hub-build` + `npm run sync:worker`，重新注册最新 build hashes。
- **依赖**：`npm install` 检查通过，当前版本 `0.51.0`，`tokscale 4.15.0`，0 vulnerabilities。
- **上游 v0.51 重点**：
  - Antigravity 独立多账号 OAuth 额度解析与登录面板 (`antigravityOAuth.js` / `antigravityOAuthLogin.js`)；
  - Codex 额度重置预测 (`codexResetForecast.js`)；
  - 仪表盘新增按工具模型细分 (`per-tool model breakdown`)；
  - 导出模块新增每日模型用量 CSV (`daily-models.csv`)；
  - Windows 任务栏 Z-order 保持与前台激活优化 (`windowsTaskbarZOrder.js`)；
  - 渲染器在隐藏/非激活状态下暂停渲染性能优化。
- **保留的本地修改**：
  - ZCode 会话详情 (`zcodeSession.js`)、项目归因、点击白名单、自定义单价 getter；
  - Claude Cowork 沙盒原生读取 (`coworkSession.js`)、归入 `claude`、历史 contribution 图表、独立 watch roots；
  - 谷歌反重力（Antigravity）Windows 本地 SQLite 只读会话解析与缓存路径修正（tokscale #1129）；
  - `launch-background.vbs`、`start.bat`、`install-autostart.bat` 等 Windows 启动/守护脚本。
### 2026-09-03 rebase：v0.51.0 → v0.52.0 ⚠️ collector / Hub registry 冲突合并
- `git fetch origin --prune --tags` 后 `origin/main` 从 `36307e7` 前进到 `00ded79`（包含发布提交 `a2ff67a` / tag `v0.52.0` 及其后续提交）。创建备份分支 `backup/pre-v0.52-rebase`，使用 `git rebase origin/main` 重放本地提交。
- **冲突 1**（`collector.js`）：上游引入 `tokscaleHomeDir`，与本地导入的 `antigravityLocalMirrorHome` 合并。
- **冲突 2**（`hubBuildRegistry.json` 及 Worker 镜像）：保留上游 registry 历史，rebase 完成后运行 `npm run update:hub-build` + `npm run sync:worker`，重新注册最新 build hashes。
- **依赖**：`npm install` 自动升级 `tokscale` 到 `4.15.1`，当前版本 `0.52.0`。
- **上游 v0.52 重点**：
  - Zed 仪表盘计费限额 (`zedLimits.js`)；
  - 模型按 Token 或费用排序与柱状图对比 (`breakdownRenderPolicy.js`)；
  - 设置页面监控工具和限额提供商搜索过滤 (`settingsListFilter.js`)；
  - 隐藏任务栏/Dock 图标设置 (`trayModeSettings.js`)；
  - Cursor Tokscale 缓存主目录探测修复 (`tokscaleConfig.js`)；
  - 渲染器基础字号与隐藏规则重构。
- **保留的本地修改**：
  - ZCode 会话详情 (`zcodeSession.js`)、项目归因、点击白名单、自定义单价 getter；
  - Claude Cowork 沙盒原生读取 (`coworkSession.js`)、归入 `claude`、历史 contribution 图表、独立 watch roots；
  - 谷歌反重力（Antigravity）Windows 本地 SQLite 只读会话解析与缓存路径修正（tokscale #1129）；
  - `launch-background.vbs`、`start.bat`、`install-autostart.bat` 等 Windows 启动/守护脚本。
### 2026-09-05 rebase：v0.52.0 → v0.54.0 ⚠️ Hub registry 冲突合并
- `git fetch origin --prune --tags` 后 `origin/main` 从 `00ded79` 前进到 `52bed5f`（包含发布提交 `0b17b1e` / tag `v0.53.0` 与 `fce070c` / tag `v0.54.0` 及其后续提交）。创建备份分支 `backup/pre-v0.54-rebase`，使用 `git rebase origin/main` 重放本地提交。
- **冲突**（`hubBuildRegistry.json` 及 Worker 镜像）：仅在此处冲突，保留上游 registry 历史，rebase 完成后运行 `npm run update:hub-build` + `npm run sync:worker`，重新注册最新 build hashes。
- **依赖**：`npm install` 自动应用依赖安全补丁，当前版本 `0.54.0`，0 vulnerabilities。
- **上游 v0.53 & v0.54 重点**：
  - 统一客户端目录架构 (`clientCatalog.js`)：单点维护客户端标识、标签与显示配置，本地 `zcode` 自然融入；
  - 统一限额服务商目录架构 (`limitProviders.js`)：统一限额提供商定义；
  - 阿里百炼（Alibaba）Token Plan 额度监控 (`alibabaLimits.js`，支持个人与团队控制台)；
  - Unsloth Studio 用量追踪 (`unsloth`)；
  - Codex 重置预测类型展示 (`codexResetForecast.js`)；
  - 设置页面渲染性能提升（移除无用追赶重绘）；
  - 小工具标题栏悬停控件稳定性优化。
- **保留的本地修改**：
  - ZCode 会话详情 (`zcodeSession.js`)、项目归因、点击白名单、自定义单价 getter；
  - Claude Cowork 沙盒原生读取 (`coworkSession.js`)、归入 `claude`、历史 contribution 图表、独立 watch roots；
  - 谷歌反重力（Antigravity）Windows 本地 SQLite 只读会话解析与缓存路径修正（tokscale #1129）；
  - `launch-background.vbs`、`start.bat`、`install-autostart.bat` 等 Windows 启动/守护脚本。
- **验证**：
  - 核心/定制测试：168/168 全部通过（`zcodeSession`, `coworkSession`, `sessionDetail`, `collectorAntigravityLocalFallback`, `cherryStudio`, `traeLimits`, `workbuddyLimits`, `watcherHost`, `clientHealth`, `clientPartitionInvariants`, `hubBuild`）；
  - 上游新特性测试：79/79 全部通过（`clientCatalog`, `clientRegistrationConsistency`, `limitProviders`, `rendererClientLabels`, `alibabaLimits`, `unsloth`）；
  - ESLint：`npm run lint` 全绿（0 errors / 0 warnings）；
  - `git diff --check`：Clean；
  - 真实采集：`npm run agent:once -- --dry-run` 采集正常。

## 七、已解决问题

### Windows 下谷歌反重力（Antigravity）用量显示 0 token / 旧缓存卡死 ✅ 已修复（2026-08-23）
- **现象**：在 Windows 环境下，反重力（Antigravity）token 统计显示为 0 token 或长期停留在旧数据，状态异常。
- **根因**：Windows 下 tokscale antigravity sync 无法从 DesktopAgent RPC 同步当前会话，导致缓存停留在旧数据；这是上游仍在跟踪的 Windows 问题：[tokscale #1129](https://github.com/junhoyeo/tokscale/issues/1129)。
- **修复**：
  1. `src/shared/collector.js`（`runTokscaleAtHome` / `scanAntigravityConversationRoot` / `collectWindowsAntigravityLocalUsage`）：Windows 环境下直接只读解析反重力本地 SQLite 会话（当前通过 `antigravityLocalMirrorHome` 创建安全临时快照，避免直接 junction 读取实时数据库）。
  2. `src/shared/collector.js`（`mergeAntigravityLocalRows`）：按 session 比对并替换旧缓存，防止重复计数；对无法安全协调的聚合/嵌套格式保持 fail-closed。
  3. `src/shared/collector.js`（`clientSourceRoots`）：修正 Windows 下 tokscale antigravity 缓存路径，统一使用 `tokscaleConfigDir({ homeDir: home })`。
  4. `src/shared/antigravityTimestampRepair.js`：从可配对的 generation step metadata 修复缺失时间戳；`antigravityLocalMirror.js` 保留最后一次成功快照，数据库更新或修复失败时重试而不覆盖好快照。
  5. `tests/shared/collectorAntigravityLocalFallback.test.js` / `tests/shared/antigravityTimestampRepair.test.js`：覆盖缺失会话补全、旧会话替换、聚合保护、嵌套格式防护、threadId 会话标识、时间戳修复、快照复用和 fail-closed（12/12 全绿）。
- **结果**：真实采集恢复正常，Antigravity 活跃会话与 Token 准确呈现，状态为 active。

### 趋势主页（7.1B）与使用仪表盘（5B→6.75B）token 不一致 ✅ 已修复
- **根因**：主页读 `stats.periods.allTime.totalTokens`（live 周期扫描 + zcode/cowork 原生合并）；仪表盘读 `history.summary.totalTokens`（tokscale graph）。历史 graph 调用原先用 `tokscaleClients`（剔除了 zcode），导致 graph 漏算 zcode 的 1.75B，仪表盘只显示 ~5B。
- **关键发现**：tokscale 的 `graph` 命令能正确读 zcode（返回 1.75B），但 `--today`/`--month`/`--since` 周期扫描对 zcode 返回 0。所以 zcode 的周期用量必须走原生适配器，但 graph 历史**可以也必须**包含 zcode。
- **修复**（`collector.js` collectHistoryOnce 调用处）：graph 用完整客户端列表（含 zcode），只过滤 proma（proma 有独立 promaGraph 源，不能重复）。
- **cowork 补充**（`coworkSession.buildCoworkHistoryGraph`）：tokscale graph 看不到 cowork 沙盒，单独构造逐日 contribution merge 进历史。
- **结果**：仪表盘从 4.98B → 6.75B，与主页 7.1B 仅差 ~350M（cowork 原生贡献的窗口边界差异）。

### zcode/cowork 的 today/month 用了 UTC 分桶，与其它客户端（本地时区）错位 ✅ 已修复（2026-07-16）
- **现象**：用户今天（07-16）第一次打开 zcode，dashboard 却显示"今日 zcode 用了 2824333"。查 DB 发现 2824333 正好等于**昨天（07-15）全天的 zcode 用量**——今日窗口把昨天的数据算了进来。
- **根因**：`zcodeSession.js` 和 `coworkSession.js` 的 `utcDayBoundsMs`/`utcMonthBoundsMs` 用 `Date.UTC(d.getUTCFullYear()...)` 按 **UTC** 切日/月边界；但项目其它所有部分都按**设备本地时区**切边界——collector 的 `localTodayKey()`（`getFullYear()/getMonth()/getDate()`）、`computePeriodWindows()`（`new Date(y,m,d)`）、tokscale 的 `--today`。两者在 UTC 午夜（北京 08:00）/本地午夜（北京 00:00）附近会差一整天，导致一条本地 23:55 的会话被归到"昨天/明天"。原代码注释误以为 usage.js 的 `utcDayKey` 是用量分桶口径，其实它只用于跨记录去重（usage.js 第 271 行注释明说 today/month 是 device-local wall-clock）。
- **修复**：两个适配器新增 `localDayBoundsMs`/`localMonthBoundsMs`（`new Date(d.getFullYear(),d.getMonth(),d.getDate())`），替换 `collectZcodeUsage`/`collectCoworkUsage` 的 `utcDayBoundsMs`/`utcMonthBoundsMs` 调用；`coworkSession.buildCoworkHistoryGraph` 的逐日 date key 从 `new Date(ts).toISOString().slice(0,10)`（UTC）改为新增的 `localDateKeyFromMs(ts)`（本地），对齐 collector 注入 history 的 `todayKey`（本地）和 history.js 里 graph date 与 todayKey 的字符串比较口径。
- **验证**：修复后 `collectZcodeUsage` 在模拟 07-15 23:55 本地时刻返回 today=2824333（07-15 全天，正确）；跨到 07-16 00:00 后 today 归零重计。新增 3 个回归测试（zcodeSession/coworkSession 各一个本地午夜边界分桶、cowork graph 本地 date key），与既有测试合计 63/63 通过，eslint 无告警。

## 八、验证命令速查
```cmd
:: 语法检查
npm run check
:: lint 我们的文件
npx eslint src/shared/zcodeSession.js src/shared/coworkSession.js src/shared/collector.js src/electron/renderer/app.js src/electron/main.js
:: 测试
node --test tests/shared/zcodeSession.test.js tests/shared/coworkSession.test.js tests/shared/sessionDetail.test.js tests/shared/collectorAntigravityLocalFallback.test.js
:: 真实数据验证（zcode）
node -e "const z=require('./src/shared/zcodeSession'); const p=z.collectZcodeUsage({allTimeSince:'2025-01-01'}); console.log(p.allTime.totalTokens, p.allTime.clients);"
:: 启动
npm run dev   :: 或双击 launch-background.vbs
```
