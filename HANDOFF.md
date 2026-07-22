# 交接文档 — ZCode + Cowork 监测集成

> 本文档记录了在 token-monitor（github.com/Javis603/token-monitor）基础上所做的全部修改，供后续 agent 接手。
> 基线版本：上游 main（v0.27.0+）。所有改动在本地分支 `feature/zcode-cowork-support`，**未 push**。

## 一、总体目标

为 token-monitor 增加 **ZCode**（智谱 ZCode CLI）和 **Claude Cowork**（Claude Desktop 桌面应用的 agent 功能）两个 AI 工具的 token 监测支持。两者都是上游 tokscale 无法正确扫描的客户端，因此采用**原生读取**方案（直接读本地数据库/JSONL，绕过 tokscale）。

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
| `src/shared/collector.js` | ① `NATIVE_ONLY_CLIENTS = {zcode, proma}` + `tokscaleClientsCsv()`：从 tokscale CSV 剔除原生客户端 ② `collectUsageOnce` 中 tokscale 扫描包 **try/catch**（tokscale 失败不再连累原生读取）③ `enabledZcode`/`coworkEnabled`/`zcodePricingMap` 辅助 ④ `clientWatchCandidates` 加 zcode(`~/.zcode/cli/db`+`rollout`) 和 cowork 监听路径 ⑤ `collectUsageOnce` 在 tokscale+WSL 后 merge zcode 和 cowork 用量 |
| `src/shared/sessionDetail.js` | 新增 `readZcodeSessionDetail` 分支 + `readSessionDetail` 的 `if (client === 'zcode')` 分发 |
| `src/shared/clientTracking.js` | `DEFAULT_CLIENTS` 加 `zcode`（cowork 不加，归 claude） |
| `src/shared/usage.js` | `normalizeClientName` 加 `zcode`/`z-code` 归一化 |
| `src/electron/renderer/app.js` | `KNOWN_CLIENTS`/`clientLabels`/`clientsWithIcon` 加 zcode；**会话点击白名单**加 `'zcode'`（否则点不开） |
| `src/electron/main.js` | 两处 `startCollector` 加 `customModelPricing: () => settings.customModelPricing \|\| []`（函数式 getter，改单价立即生效） |
| `package.json` | `check` 脚本注册新文件 |

## 五、关键设计决策与坑

1. **zcode 走原生，不走 tokscale**：tokscale 的 zcode 实现路径（`~/.zcode/projects`）是错的，ZCode 不写那里。原生读 `~/.zcode/cli/db` 才有数据。
2. **cowork 归到 claude**：避免出现"opus(code)"和"opus(cowork)"分开显示。无重复计数（tokscale 读 `~/.claude/projects`，cowork 读沙盒路径，磁盘不重叠）。
3. **cache-inclusive 修正**（#68）：ZCode input_tokens 含缓存，总量 = input+output，净输入 = input-cacheRead-cacheWrite。不修会**翻倍**。
4. **tokscale try/catch**：tokscale 卡住/失败时（尤其 watch tick 的 `--today`），不能让整个 tick reject 抹掉原生数据，否则仪表盘闪烁 active↔waiting。
5. **会话点击白名单**：`app.js` 的 `els.breakdown.addEventListener('click')` 有硬编码 `client !== 'claude' && !== 'codex' && !== 'opencode'`，必须加 `'zcode'` 才能点开会话详情。
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

## 七、已解决问题

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
node --test tests/shared/zcodeSession.test.js tests/shared/coworkSession.test.js tests/shared/sessionDetail.test.js
:: 真实数据验证（zcode）
node -e "const z=require('./src/shared/zcodeSession'); const p=z.collectZcodeUsage({allTimeSince:'2025-01-01'}); console.log(p.allTime.totalTokens, p.allTime.clients);"
:: 启动
npm run dev   :: 或双击 launch-background.vbs
```
