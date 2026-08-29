# kerikoの行星观察笔记

> 记录技术探索、开源旅程和偶尔发呆的地方。

个人博客，基于 [Misthaven](https://github.com/CnBarrier404/astro-theme-misthaven)（Astro 主题）搭建，内容从 Hugo + Blowfish 站点迁移而来。

## 技术栈

- [Astro](https://astro.build)（静态站点生成）
- Tailwind CSS 4、TypeScript
- 内容写作：Markdown（`src/content/posts/`）

## 本地开发

需要 Node.js `22.12.0` 或更高版本。

```bash
npm install
npm run dev        # 开发服务器，默认 http://localhost:4321
npm run build      # 产物输出到 dist/
npm run check      # 类型检查
npm run preview    # 本地预览构建产物
npm run format     # 代码格式化
```

## 站点配置

大多数设置集中在 `src/config/`：

- `siteConfig.ts`：站点名称、描述、域名（`siteUrl`）、头像、首页主视觉与引言
- `aboutConfig.ts`：关于页面与联系方式
- `navigationConfig.ts`：顶部导航
- `footerConfig.ts`：页脚链接
- `commentConfig.ts`：评论功能（默认关闭，启用需配置 Artalk 服务）

## 写作

文章位于 `src/content/posts/`，复制任意已有文章或新建文件，front matter 格式：

```yaml
---
title: 文章标题
description: 文章列表与搜索引擎使用的摘要
publishedAt: 2026-08-29
category: 分类
tags: [标签]
draft: false
---
```

将 `draft` 设为 `true` 的文章不会出现在生产构建中。

## 部署

静态产物位于 `dist/`，可部署到 GitHub Pages、Cloudflare Pages 或 Vercel：

1. 修改 `src/config/siteConfig.ts` 中的 `siteUrl` 为最终域名
2. 推送到 GitHub 仓库，选择任意托管平台：
   - **GitHub Pages**：仓库自带 `.github/workflows/pages.yml`
   - **Cloudflare Pages / Vercel**：连接仓库，构建命令 `npm run build`，输出目录 `dist`

## 注意事项

- 隐私政策页为起草模板，发布前请按实际情况完善（`src/content/pages/privacy.md`）。
- 评论功能默认关闭；如需启用，配置 `src/config/commentConfig.ts` 并部署 Artalk 服务。
- 源站图片位于 `public/img/`（头像 `avatr.jpg`、星球背景 `background.svg`）。

## License

[MIT](LICENSE) © CnBarrier、Keriko