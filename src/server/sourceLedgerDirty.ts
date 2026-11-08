/**
 * 「账本有更新」的最小标记 —— 单独一个文件是为了避免循环依赖。
 *
 * 三个播放侧账本（playRank / playFailSink / qualityLedger）都在各自的模块里，
 * 它们只需要打个脏标记；真正的落盘逻辑在 `sourceLedgerStore.ts`（它反向 import 这三个模块）。
 * 如果让账本模块去 import store，就会和 store → 账本 形成环。
 */

let dirty = false

/** 记一次「账本变了」（任何取链结果都会调用，必须极轻量） */
export const markLedgerDirty = (): void => {
    dirty = true
}

/** 取出并清空脏标记（落盘前调用） */
export const takeLedgerDirty = (): boolean => {
    const was = dirty
    dirty = false
    return was
}
