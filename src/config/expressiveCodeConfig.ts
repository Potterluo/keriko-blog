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

    // 超过这个行数才允许折叠（配合行内 collapse 标记使用）
    lineThreshold: 40,

    // 折叠后可见的预览行数
    previewLines: 12,

    // 默认不折叠：只有显式写了 collapse 的代码块才折起来
    defaultCollapsed: false,
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
