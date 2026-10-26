---
layout: home

hero:
  name: "LX Sync Server"
  text: "私有云音乐与同步服务中心"
  tagline: "聚合全网多源检索 · 本地高保真曲库 · LX 云端同步 · Subsonic 生态互联"
  image:
    src: /icon.svg
    alt: LX Sync Server
  actions:
    - theme: brand
      text: 快速上手
      link: /guide/getting-started
    - theme: alt
      text: Web 播放器指南
      link: /guide/web-player
    - theme: alt
      text: 设置与教程
      link: /guide/app-settings
    - theme: alt
      text: 部署与反代
      link: /guide/deployment
    - theme: alt
      text: GitHub 仓库
      link: https://github.com/zues0077/lxserver

features:
  - icon: 🎵
    title: 现代 Web 播放器
    details: 内置功能完备的无缝 Web 播放器，支持浅/深色自适应、多源检索、高品质音频串流与动态歌词。
  - icon: 🗄️
    title: 本地高保真曲库
    details: 管理本地与下载音乐，支持 Hi-Res/无损规格解析、高级布尔逻辑搜索（&/|/!）与状态查漏。
  - icon: 🔄
    title: 完善的同步后端
    details: 深度兼容 LX Music 官方多端客户端，实现歌单无缝云端同步、快照备份与多账号权限隔离。
  - icon: 📻
    title: Subsonic 开放生态
    details: 原生支持 Subsonic 协议，音流、Feishin 等第三方客户端一键接入，支持全网点播与本地播放。
  - icon: 📊
    title: 可视化数据中枢
    details: 在线控制台直观管理设备连接、快照恢复、运行日志与 WebDAV 增量云端备份。
  - icon: 💻
    title: 全平台与多端支持
    details: 提供 Docker 一键部署与跨平台桌面客户端（Win/Mac/Linux），支持托盘常驻与便携模式。
  - icon: ⚙️
    title: 详细设置与教程
    details: 提供「应用设置与配置规则」与「快速上手教程」两个文档，从创建用户、连接客户端到下载缓存、投播串联全文。
  - icon: 🚀
    title: 部署、反代与 HTTPS
    details: 从 Nginx / Caddy 反代 + Let's Encrypt 自动证书，到生产级 Compose、升级回滚、NAS 实战与部署排错，把服务跑得稳又安全。
  - icon: 🐮
    title: fnOS 部署实战
    details: 飞牛私有云分步教程：镜像源 ghcr.nju.edu.cn、四挂载、用 /health 验证、内置反代做 HTTPS，附 trim-cli 命令行与 errno 速查。
  - icon: 💾
    title: 数据备份与迁移
    details: 卷结构树、config.js / users / states.json / sources.json 各自作用，WebDAV 增量备份与换机迁移步骤，避开双写损坏。
  - icon: ❓
    title: 常见问题与排错
    details: 汽水扫码「没变化」、签名器用法、cache/music 区别、容量清理误删歌、cover_cache 挂载、小爱投播等高频踩坑，按「现象 → 原因 → 解决」讲清。

---

<div class="showcase-wrapper">
  <div class="showcase-header">
    <h2>✨ 沉浸式 Web 播放器实景</h2>
    <p>随时随地在任何设备与浏览器中畅享您的私人音乐世界</p>
  </div>
  <div class="showcase-frame">
    <img src="/player.png" alt="LX Music Web Player Interface" />
  </div>
</div>

<div class="status-badge-container">
  <div class="status-badge-title">开源项目生态与实时状态</div>
  <div class="status-badges">
    <img src="https://img.shields.io/badge/build-passing-brightgreen?style=flat-square" alt="Build Status">
    <img src="https://img.shields.io/github/package-json/v/zues0077/lxserver?style=flat-square" alt="Version">
    <img src="https://img.shields.io/badge/node-%3E%3D20-green?style=flat-square" alt="Node Version">
    <img src="https://img.shields.io/github/license/zues0077/lxserver?style=flat-square" alt="License">
    <a href="https://github.com/zues0077/lxserver/stargazers"><img src="https://img.shields.io/github/stars/zues0077/lxserver?style=flat-square&color=ffe16b" alt="GitHub stars"></a>
    <a href="https://github.com/zues0077/lxserver/commits/main"><img src="https://img.shields.io/github/last-commit/zues0077/lxserver?style=flat-square&color=blueviolet" alt="Last Commit"></a>
  </div>
</div>
