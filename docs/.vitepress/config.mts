import { defineConfig } from 'vitepress'
import pkg from '../../package.json'

export default defineConfig({
  base: "/lxserver/",
  lastUpdated: true,
  head: [
    ['link', { rel: 'icon', href: '/lxserver/icon.svg' }]
  ],
  themeConfig: {
    logo: '/icon.svg',
    socialLinks: [
      { icon: 'github', link: 'https://github.com/zues0077/lxserver' }
    ],
    search: {
      provider: 'local'
    }
  },
  locales: {
    root: {
      label: '简体中文',
      lang: 'zh-CN',
      title: "LX Sync Server",
      description: "一个增强版的 LX Music 数据同步服务端与 Web 播放器",
      themeConfig: {
        nav: [
          { text: '首页', link: '/' },
          { text: '用户指南', link: '/guide/getting-started' },
          { text: '配置指南', link: '/guide/configuration' },
          { text: 'API 文档', link: '/api/reference' },
          { text: '关于', link: '/about' },
          {
            text: `v${pkg.version}`,
            items: [
              { text: `最新版本: v${pkg.version}`, link: 'https://github.com/zues0077/lxserver/releases' },
              { text: '更新日志 (Changelog)', link: 'https://github.com/zues0077/lxserver/blob/main/changelog.md' },
              { text: '发布历史 (Releases)', link: 'https://github.com/zues0077/lxserver/releases' },
              { text: '源码仓库 (GitHub)', link: 'https://github.com/zues0077/lxserver' }
            ]
          }
        ],
        sidebar: [
          {
            text: '用户指南',
            items: [
              { text: '快速开始', link: '/guide/getting-started' },
              { text: '部署、反代与 HTTPS 实战', link: '/guide/deployment' },
              { text: '应用设置与配置规则', link: '/guide/app-settings' },
              { text: '快速上手教程', link: '/guide/tutorial' },
              { text: '常见问题与排错', link: '/guide/faq' }
            ]
          },
          {
            text: '核心功能',
            items: [
              { text: '同步服务器设置', link: '/guide/sync-server' },
              { text: 'Web 播放器指南', link: '/guide/web-player' },
              { text: '小爱音箱投播', link: '/guide/xiaoai' }
            ]
          },
          {
            text: '自定义源治理',
            items: [
              { text: '音源自检护栏', link: '/guide/source-guard' },
              { text: '平台可用性巡检', link: '/guide/source-probe' }
            ]
          },
          {
            text: '配置指南',
            items: [
              { text: '配置文件及环境变量', link: '/guide/configuration' }
            ]
          },
          {
            text: 'API 文档',
            items: [
              { text: '服务端 API 参考', link: '/api/reference' }
            ]
          }
        ],
        lastUpdated: {
          text: '最后更新于',
          formatOptions: {
            dateStyle: 'full',
            timeStyle: 'medium',
            timeZone: 'Asia/Shanghai'
          }
        },
        docFooter: {
          prev: '上一页',
          next: '下一页'
        },
        editLink: {
          pattern: 'https://github.com/zues0077/lxserver/edit/main/docs/:path',
          text: '在 GitHub 上编辑此页'
        },
        footer: {
          message: `Released under the Apache-2.0 License. (v${pkg.version})`,
          copyright: 'Copyright © 2026 zues0077 (基于 xcq0607/lxserver) & Contributors'
        }
      }
    },
    en: {
      label: 'English',
      lang: 'en-US',
      link: '/en/',
      title: "LX Sync Server",
      description: "An enhanced data synchronization server and Web player for LX Music",
      themeConfig: {
        nav: [
          { text: 'Home', link: '/en/' },
          { text: 'Usage Guide', link: '/en/guide/getting-started' },
          { text: 'Config Guide', link: '/en/guide/configuration' },
          { text: 'API Docs', link: '/en/api/reference' },
          { text: 'About', link: '/en/about' },
          {
            text: `v${pkg.version}`,
            items: [
              { text: `Latest: v${pkg.version}`, link: 'https://github.com/zues0077/lxserver/releases' },
              { text: 'Changelog', link: 'https://github.com/zues0077/lxserver/blob/main/changelog.md' },
              { text: 'Release History', link: 'https://github.com/zues0077/lxserver/releases' },
              { text: 'Repository', link: 'https://github.com/zues0077/lxserver' }
            ]
          }
        ],
        sidebar: [
          {
            text: 'Usage Guide',
            items: [
              { text: 'Getting Started', link: '/en/guide/getting-started' },
              { text: 'Deployment, Proxy & HTTPS', link: '/en/guide/deployment' },
              { text: 'App Settings & Rules', link: '/en/guide/app-settings' },
              { text: 'Usage Tutorial', link: '/en/guide/tutorial' },
              { text: 'FAQ & Troubleshooting', link: '/en/guide/faq' }
            ]
          },
          {
            text: 'Core Features',
            items: [
              { text: 'Sync Server Settings', link: '/en/guide/sync-server' },
              { text: 'Web Player Guide', link: '/en/guide/web-player' },
              { text: 'XiaoAi Speaker Casting', link: '/en/guide/xiaoai' }
            ]
          },
          {
            text: 'Source Governance',
            items: [
              { text: 'Source Guard', link: '/en/guide/source-guard' },
              { text: 'Platform Availability Probe', link: '/en/guide/source-probe' }
            ]
          },
          {
            text: 'Config Guide',
            items: [
              { text: 'Config & Env Vars', link: '/en/guide/configuration' }
            ]
          },
          {
            text: 'API Docs',
            items: [
              { text: 'Server API Ref', link: '/en/api/reference' }
            ]
          }
        ],
        lastUpdated: {
          text: 'Last updated',
          formatOptions: {
            dateStyle: 'full',
            timeStyle: 'medium',
            timeZone: 'Asia/Shanghai'
          }
        },
        docFooter: {
          prev: 'Previous page',
          next: 'Next page'
        },
        editLink: {
          pattern: 'https://github.com/zues0077/lxserver/edit/main/docs/:path',
          text: 'Edit this page on GitHub'
        },
        footer: {
          message: `Released under the Apache-2.0 License. (v${pkg.version})`,
          copyright: 'Copyright © 2026 zues0077 (基于 xcq0607/lxserver) & Contributors'
        }
      }
    }
  }
})
