import type { ExpressiveCodeConfig } from "../types/expressiveCodeConfig";

// ExpressiveCode 设置，决定文章中代码块的显示效果
// 注意：更改后，需要重启开发服务器才能看到效果
export const expressiveCodeConfig: ExpressiveCodeConfig = {
  // 暗色主题
  darkTheme: "one-dark-pro",

  // 亮色主题
  lightTheme: "one-light",

  // 关闭代码块框架阴影
  styleOverrides: {
    codeFontFamily: "var(--code-font-family)",
    borderRadius: "calc(var(--radius-lg) - var(--ec-brdWd))",
    frames: {
      frameBoxShadowCssValue: "none",
      editorTabBorderRadius: "calc(var(--radius-lg) - var(--ec-brdWd))",
    },
  },

  // 代码块折叠配置
  pluginCollapsible: {
    // 是否启用
    enable: true,

    // 代码块的最大行数，超过会自动折叠
    lineThreshold: 15,

    // 被自动折叠后，可见的预览行数
    previewLines: 8,

    // 默认折叠长代码块
    defaultCollapsed: true,
  },

  pluginLanguageLogo: {
    enable: false,
    color: "mono",
    excludedLangs: [],
  },

  // 行号配置
  pluginLineNumbers: {
    enable: true,
  },
};
