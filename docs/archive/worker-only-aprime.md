# A' 开关（customSource.workerOnly.enabled）方案留档

**状态**：已废弃（2026-11-13 用户拍板「可有可无，不如删掉」）
**存活版本**：v1.5.55 ~ v1.5.56（两个正式版）
**代码快照**：分支 `backup/worker-only-aprime`（= v1.5.56 tag `bbc0c02`，A' 完整存在）
**删除执行**：分支 `fix/slow-callback-guard`

## 一、方案设计（原貌）

**目标**：让已被 governor 判为慢源的脚本「整实例」在加载时就进独立线程 eval，
主线程完全不 eval 脚本，省掉既有机制「先在主线程被慢一次、再转 worker」的那一次慢。

**启用口径**（`userApi.ts isWorkerOnlyEnabled()`）：
- 配置键 `customSource.workerOnly.enabled === true`（管理端设置页勾选）
- 环境变量 `CUSTOM_SOURCE_WORKER_ONLY=1`（A/B 测试用，优先级更高）
- 默认关。

**接线点**：`loadUserApi` 开头的 A' 前置分支 → `loadWorkerOnlyApi(apiInfo, fullApiInfo)`：
- `markWorkerEligible(owner, id, workerInfo, true)` 强制登记为 worker 常驻
- `sources`/契约由 worker ready 消息回填，`callRequest` 全部转发 worker
- worker 基础设施故障时惰性构建主线程 vm2 兜底实例（②缺陷修复，2026-11-12）
- 加载失败自动回退主线程原路径，不阻断音源可用性

**候选判定**（`isWorkerOnlyCandidate`）：读 governor 慢源记录
`listWorkerPresetCandidates()`，比对脚本指纹 `scriptHash`——指纹变了不认旧记录。

## 二、A/B 实测数据（17953，2026-11-13，各 8 轮）

| 指标 | 关闭（A） | 打开（B） | 判定 |
|---|---|---|---|
| 取链成功率 | 30/30 | 24/24 | 无差异 |
| 取链中位延迟 | 111ms | 85ms | 噪声范围内 |
| 列表接口中位 | 43ms | 46ms | 无差异 |
| 内存稳态 | 151–154MB | 154–155MB | 无差异 |
| activeRes 均值 | 27.6 | 34.8 | B 反而略高 |

采样脚本 `C:/tmp/ab_test.py` + `C:/tmp/memstat.py`；
B 组两次主线程卡顿（7652/7885ms）**关闭组同样复现 7596ms**
（重启后 60–75s 首轮巡检窗口，尖峰源 `豆包定制[聚合音源]` 共享回调）——与开关无关。

## 三、废弃原因（用户 2026-11-13 拍板）

1. **无实质优化**：它覆盖的是既有 `governor.worker.enabled`（默认开，P-1105/P-1106）
   的子集，唯一差别是「加载时就进 worker vs 运行中被判慢后进」，而实测中该场景
   根本遇不到（46 源只有 3 个慢源，且只在重启首轮巡检活动）。
2. **对目标卡顿无效**：豆包定制 8.3s 主线程卡顿的真因是**脚本后台健康探测的
   lx.request 回调**——该路径永远在主线程实例上执行（worker 只接管 callRequest），
   A' 救不了它。
3. **重复建设**：两个 worker 开关并存造成理解负担
   （「governor.worker.enabled 和 workerOnly.enabled 有什么区别」）。

## 四、删除清单（fix/slow-callback-guard 已执行）

| 文件 | 内容 |
|---|---|
| `src/server/userApi.ts` | `isWorkerOnlyEnabled()`、`isWorkerOnlyCandidate()`、`loadWorkerOnlyApi()`（~90 行）、`loadUserApi` A' 前置分支 |
| `src/server/server.ts` | config GET 暴露（11496）+ POST 写入（11608-11610） |
| `src/defaultConfig.ts` | 默认键 + env 注释（175-176） |
| `src/types/config.d.ts` | 类型声明（671-673） |
| `public/index.html` | 设置页 checkbox（2382） |
| `public/app.js` | 表单回显（2785-2787）+ 收集（3681） |
| `test/workerOnlySwitch.test.ts` | 整文件 |
| `test/configPageStructure.test.ts` | REQUIRED_FIELDS 期望项（72） |

**保留不动**：`governor.worker.*` 全套（真正在跑的慢源 worker 机制）、
`sourceWorkerHost.ts`、`customSourceWorker.ts`（它们被 governor 路径使用）。

## 五、后续修复方向（接棒者）

豆包定制 8.3s 卡顿的修复在 `fix/slow-callback-guard` 后续提交：
- 2-a：`reportSlowTimerCallback` 补 `noteScriptSyncCost`（定时器重活记账，当前完全漏）
- 2-b：lx.request 回调记账路径核实补全
- 1+2-c：自适应响应体上限持久化（TTL 30min → 24h 命中刷新），重启不再「先卡一次再学」；
  上限属于上游响应体属性，脚本更新不清除（governor 降速记录才带 scriptHash 指纹）。

## 六、回滚方式

如需恢复 A'：`git checkout backup/worker-only-aprime -- <上述文件>`，
或整个分支 cherry-pick 回 main。建议只回滚 userApi.ts + server.ts + defaultConfig.ts +
config.d.ts 四处核心，前端两处与测试按需补。
