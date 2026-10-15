# 关于

**LX Sync Server** 修改自 [xcq0607/lxserver](https://github.com/xcq0607/lxserver)，后者修改自原版的 [lx-music-sync-server](https://github.com/lyswhut/lx-music-sync-server)。在两者的基础上，本项目额外集成和改进了各项能力，使其从一个简单的本地数据交换中转站变为了全功能的个人私有云音乐平台。

本仓库（[zues0077/lxserver](https://github.com/zues0077/lxserver)）在上游之上重点增强了**自定义音源的稳定性治理**：脚本自检护栏与平台可用性巡检。详见 [自定义源平台可用性巡检](/guide/source-probe) 与 [自定义源自检护栏](/guide/source-guard)。

## 项目信息

| 项目信息 | 说明 |
| :--- | :--- |
| **最新版本** | ![Version](https://img.shields.io/github/package-json/v/zues0077/lxserver?style=flat-square) (动态识别 `package.json`) |
| **运行时要求** | Node.js >= 20 |
| **开源协议** | Apache-2.0 License |
| **更新日志** | [查看 Changelog](https://github.com/zues0077/lxserver/blob/main/changelog.md) |
| **源码仓库** | [GitHub: zues0077/lxserver](https://github.com/zues0077/lxserver) |
| **文档更新** | 文档底部自动基于 Git Commit 提交记录生成最后更新时间（已格式化为北京时间 UTC+8） |

## 开发意图

初衷是希望在外不方便开启电脑时，能以极低的门槛管理与播放收藏音乐。本项目是开源项目，使用了 Node.js 及基于大量 Vanilla JS 构建。在此对所有原作者致敬。

---

如果遇到软件缺陷，欢迎前往 GitHub 进行 Feedback。
此项目遵循 Apache-2.0 协议开源。
