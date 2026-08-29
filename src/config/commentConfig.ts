import type { CommentConfig } from "@/types/commentConfig";

export const commentConfig = {
  // 评论系统总开关
  enabled: false,

  // 评论系统类型；新增提供商时在对应配置块中填写选项
  type: "artalk",

  artalk: {
    // Artalk 后端 API 地址；启用评论前请填写
    server: "",

    // 是否启用正式站点的文章浏览量统计
    visitorCount: false,
  },
} as const satisfies CommentConfig;

export const isCommentViewCountEnabled =
  commentConfig.enabled && commentConfig.type === "artalk" && commentConfig.artalk.visitorCount;
