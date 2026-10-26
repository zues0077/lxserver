---
layout: home

hero:
  name: "LX Sync Server"
  text: "Private Cloud Music & Sync Hub"
  tagline: "Multi-source Universal Search · Local Hi-Res Library · LX Cloud Sync · Subsonic Ecosystem"
  image:
    src: /icon.svg
    alt: LX Sync Server
  actions:
    - theme: brand
      text: Get Started
      link: /en/guide/getting-started
    - theme: alt
      text: Web Player Guide
      link: /en/guide/web-player
    - theme: alt
      text: Settings & Tutorials
      link: /en/guide/app-settings
    - theme: alt
      text: Deployment & Proxy
      link: /en/guide/deployment
    - theme: alt
      text: GitHub Repo
      link: https://github.com/zues0077/lxserver

features:
  - icon: 🎵
    title: Modern Web Player
    details: Feature-rich web player supporting dynamic light/dark themes, multi-platform search, high-res streaming, and synchronized lyrics.
  - icon: 🗄️
    title: Local Hi-Res Music Library
    details: Organize local and downloaded tracks with audio spec parsing (Hi-Res/lossless), Boolean search, and metadata curation.
  - icon: 🔄
    title: Robust Sync Backend
    details: Full compatibility with official LX Music clients for seamless cloud playlist synchronization, snapshots, and multi-user isolation.
  - icon: 📻
    title: Subsonic Ecosystem
    details: Native Subsonic API compatibility. Connect third-party clients like Yinliu, Feishin, and Symfonium for global search and local playback.
  - icon: 📊
    title: Visual Control Center
    details: Intuitive web console for monitoring devices, user permissions, snapshot rollbacks, and WebDAV incremental backups.
  - icon: 💻
    title: Cross-Platform & Easy Deployment
    details: One-click Docker deployment and cross-platform desktop clients (Win/Mac/Linux) with system tray and portable support.
  - icon: ⚙️
    title: Detailed Settings & Tutorials
    details: Two dedicated docs — "Application Settings & Rules" and "Quick Start Tutorial" — walk through user creation, client connection, download/cache, and casting end to end.
  - icon: 🚀
    title: Deployment, Proxy & HTTPS
    details: From Nginx / Caddy reverse proxy with Let's Encrypt auto-cert, to production Compose, upgrade/rollback, NAS practice, and deployment troubleshooting — run it stable and secure.
  - icon: 🐮
    title: Deploying on fnOS
    details: Step-by-step for FeiNiu private cloud — image mirror ghcr.nju.edu.cn, four mounts, verify with /health, built-in proxy for HTTPS, plus trim-cli commands and errno reference.
  - icon: 💾
    title: Data Backup & Migration
    details: Volume structure tree, what config.js / users / states.json / sources.json each do, WebDAV incremental backup and machine-migration steps, avoid double-write corruption.
  - icon: ❓
    title: FAQ & Troubleshooting
    details: Frequent gotchas — Soda scan "no change", signer usage, cache vs music, capacity cleanup deleting songs, cover_cache mount, XiaoAi casting — each explained as Symptom → Cause → Fix.

---

<div class="showcase-wrapper">
  <div class="showcase-header">
    <h2>✨ Immersive Web Player Preview</h2>
    <p>Enjoy your personal music universe anywhere, on any device and browser</p>
  </div>
  <div class="showcase-frame">
    <img src="/player.png" alt="LX Music Web Player Interface" />
  </div>
</div>

<div class="status-badge-container">
  <div class="status-badge-title">Open Source Ecosystem & Live Status</div>
  <div class="status-badges">
    <img src="https://img.shields.io/badge/build-passing-brightgreen?style=flat-square" alt="Build Status">
    <img src="https://img.shields.io/github/package-json/v/zues0077/lxserver?style=flat-square" alt="Version">
    <img src="https://img.shields.io/badge/node-%3E%3D20-green?style=flat-square" alt="Node Version">
    <img src="https://img.shields.io/github/license/zues0077/lxserver?style=flat-square" alt="License">
    <a href="https://github.com/zues0077/lxserver/stargazers"><img src="https://img.shields.io/github/stars/zues0077/lxserver?style=flat-square&color=ffe16b" alt="GitHub stars"></a>
    <a href="https://github.com/zues0077/lxserver/commits/main"><img src="https://img.shields.io/github/last-commit/zues0077/lxserver?style=flat-square&color=blueviolet" alt="Last Commit"></a>
  </div>
</div>
