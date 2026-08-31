export const aboutConfig = {
  pageTitle: "关于",
  pageDescription: "关于 Keriko：技术方向、开源项目与联系方式。",
  hero: {
    eyebrow: "ABOUT KERIKO",
    title: "你好，我是 Keriko。",
    description: [
      "LLM 基础设施工程师，现于北京的中科院大学（UCAS）学习和工作。",
      "这里记录技术探索、开源旅程和偶尔的发呆。",
    ],
  },
  // 联系方式图标来自 Iconify：https://icon-sets.iconify.design/。
  // `icon` 使用“图标集前缀:图标名称”；使用新的图标集前缀时，需要安装对应的 @iconify-json/<prefix> 包。
  links: [
    {
      name: "GitHub",
      icon: "fa7-brands:github",
      url: "https://github.com/Potterluo",
    },
    {
      name: "个人网站",
      icon: "fa7-solid:link",
      url: "https://keriko.fun",
    },
  ],
  techStack: {
    title: "技术栈",
    description: "日常使用的语言与工具。",
    // 图标来自 Iconify：https://icon-sets.iconify.design/。
    // `icon` 使用“图标集前缀:图标名称”；使用新的图标集前缀时，需要安装对应的 @iconify-json/<prefix> 包。
    items: [
      { icon: "devicon:python", name: "Python" },
      { icon: "devicon:go", name: "Go" },
      { icon: "devicon:bash", name: "Shell" },
      { icon: "devicon:docker", name: "Docker" },
      { icon: "devicon:kubernetes", name: "Kubernetes" },
      { icon: "devicon:linux", name: "Linux" },
    ],
  },
} as const;
