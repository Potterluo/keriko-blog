export const postConfig = {
  // 预计阅读时长使用的每分钟内容单位数
  readingUnitsPerMinute: 200,

  // 文章内容时效性提示
  outdatedWarning: {
    enabled: true,
    days: 30,
  },

  // 文章页末尾显示的许可协议；留空时不显示
  license: "CC BY-NC-SA 4.0",

  // TODO: 浏览量统计功能实现后，在此配置数据收集源。
} as const;
