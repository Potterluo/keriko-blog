import type { CommentConfig, CommentProvider } from "@/types/commentConfig";

export const commentConfig = {
  // 评论系统总开关
  enabled: true,

  // 评论系统类型；giscus 基于 GitHub Discussions，需要仓库公开并安装 giscus App
  // 显式拓宽为联合类型，保留与提供方分支（artalk）的可比性
  type: "giscus" as CommentProvider,

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
