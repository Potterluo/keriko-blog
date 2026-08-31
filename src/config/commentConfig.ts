import type { CommentConfig } from "@/types/commentConfig";

export const commentConfig = {
  // 评论系统总开关
  enabled: true,

  // 评论系统类型；giscus 基于 GitHub Discussions，需要仓库公开并安装 giscus App
  type: "giscus",

  artalk: {
    // Artalk 后端 API 地址；启用评论前请填写
    server: "",

    // 是否启用正式站点的文章浏览量统计
    visitorCount: false,
  },

  giscus: {
    // GitHub 仓库与 Discussion 分类（在 giscus.app 或 GitHub 设置中获取）
    repo: "Potterluo/keriko-blog",
    repoId: "R_kgDOUHsMzA",
    category: "General",
    categoryId: "DIC_kwDOUHsMzM4DEbMZ",

    // 每篇文章通过页面路径映射到独立 Discussion
    mapping: "pathname",
    reactionsEnabled: true,
    inputPosition: "top",
    lang: "zh-CN",
    loading: "lazy",
  },
} as const satisfies CommentConfig;

export const isCommentViewCountEnabled =
  commentConfig.enabled && commentConfig.type === "artalk" && commentConfig.artalk.visitorCount;
