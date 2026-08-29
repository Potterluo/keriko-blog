import type { FontConfig } from "@/types/fontConfig";

export const fontConfig = {
  // 字体按优先级从上到下排列；
  font: [
    { family: "system-ui" },

    // public 字体示例：文件放在 public/fonts/ProjectFont-VF.woff2
    // {
    //   family: "ProjectFont",
    //   src: "/fonts/ProjectFont-VF.woff2"
    // },

    // 外部字体示例：src 必须指向字体文件，而不是 CSS 样式表
    // {
    //   family: "ProjectFont",
    //   src: "https://example.com/fonts/ProjectFont-VF.woff2"
    // },
  ],
  // 代码字体按优先级从上到下排列；首选字体为 JetBrains Mono。
  codeFont: [
    { family: "JetBrains Mono", src: "/fonts/JetBrainsMono-Regular.woff2" },

    // public 字体示例：文件放在 public/fonts/JetBrainsMono-Regular.woff2
    // {
    //   family: "JetBrains Mono",
    //   src: "/fonts/JetBrainsMono-Regular.woff2"
    // },

    // 外部字体示例：src 必须指向字体文件，而不是 CSS 样式表
    // {
    //   family: "JetBrains Mono",
    //   src: "https://example.com/fonts/JetBrainsMono-Regular.woff2"
    // },
  ],
} as const satisfies FontConfig;
