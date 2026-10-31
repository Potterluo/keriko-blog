# AGENTS.md

Misthaven is a clean and minimalist Astro blog theme with calm colors, spacious layouts, and a comfortable reading experience. It is designed for sharing, ideas, and everyday life.

This checkout is a personal Chinese tech blog. The site keeps the theme's engineering conventions, and adds the writing conventions below: how a post is structured, how figures are made, and what counts as a finished draft.

## Writing

### 元数据

Frontmatter 的字段与校验规则在 `src/content.config.ts`，写错会在 `npm run check` 报错。

| 字段          | 要求                                                         |
| :------------ | :----------------------------------------------------------- |
| `title`       | 中文标题，可带副标题；不要用「一文读懂」「吐血整理」这类词   |
| `description` | 一到两句，说清这篇讲什么；不要用「本文将」开头               |
| `publishedAt` | `"YYYY-MM-DD"`，字符串，按实际日期                           |
| `category`    | 已用的五个：`项目笔记` `技术分享` `学习笔记` `AI思考` `生活` |
| `tags`        | 3–5 个，术语优先（`KV Cache`、`Transformer`、`UCM`）         |
| `draft`       | 必须是布尔值，未完成写 `true`                                |

### 文件与图片

- 正文放在 `src/content/posts/`，命名建议 `<三位编号>-<slug>.md`，编号在现有最大值上递增，不复用；少数旧文没有编号，新文请带上。
- 配图放在 `public/img/<slug>/`，命名 `fig-01.svg`、`fig-02.svg`。
- 正文引用写成 `![图 1 说明](/img/<slug>/fig-01.svg)`。`astro.config.mjs` 里的 `imageCaptionPlugin` 会把 alt 转成 `<figcaption>`，所以 **alt 就是图注**，要写成完整句子（图号 + 这张图说明了什么），不要留空或只写「示意图」。

### 排版

- 标题只用 `##` 分节、`###` 分小节。一节读一屏为准，太长的节要拆。
- 表格：主题给 `td` 设了 `white-space: nowrap`，超宽表格会横向滚动。单元格控制在十几个字内，内容长就改成段落或列表。
- 代码块标真实语言。默认全展开，确实需要折叠时在围栏后加 `collapse`。
- 公式用 `$$...$$`（行间）和 `$...$`（行内）。实现在 `src/integrations/mathKatex/`，由 satteri 的 `features.math` 解析、KaTeX 渲染。**不要**再用 ```text 代码块模拟公式。
- 提示块用 `> [!IMPORTANT]`、`> [!NOTE]`，由 `src/integrations/markdownCallout` 处理。
- 链接规则见下方 URL Conventions：站内路径结尾不加斜杠，优先用 `getPostHref` 这类 helper。

### 文章骨架

站内的技术长文基本是这个形状，新文可以对齐：

1. **开头直接给事由**：从一次调查、一个疑问或一组数字切入，别用「随着…的发展」起笔。
2. **材料与口径**：任何引用外部代码、文档、数据的文章，要有一节写清读了什么、什么版本、哪些没有复现。这一节也是后面每个数字的溯源入口。
3. **分节推进**：一节回答一个问题，节内可以有一格算术、一张表或一张图，但不重复结论。
4. **收尾落在具体判断**：允许有观点，但不要升华，也不要复述摘要。

### 长文结构（工程复盘类）

写「我做了个东西」这类长文，按这条脉络走，不要按「我做了什么」的时间顺序：

1. **运行原理**：先讲清楚这个东西在解决什么，读者没有背景也能跟上。用一张最小流程图。
2. **具体场景**：给一个能跑的例子，把问题具体化。把「裸方案会怎么失败」一步一步写出来，失败点就是需求。
3. **产品设计**：从失败点推能力清单，再补工程约束（可替换、可测试、可运行）、明确的非目标、可断言的验收标准。
4. **架构设计**：每一层都要从约束推导，不能直接宣布结论。写法是「如果不这样会怎样」→「所以切一刀」→「判断标准是什么」。抽象同理，每个抽象回答一个问题，检验方式是「删掉它，哪段代码会变形」。
5. **实现**：提交顺序即依赖顺序；每个关键选择补一句为什么，不要只贴代码。
6. **验证**：见下节。
7. **复盘**：把实测暴露的问题按「共同的错误假设」归类，比逐条罗列更有信息量。

### 图表要跟着论证走

凡是出现「N 个问题对应 N 个解法」「分几层」「一次运行经过哪几步」的地方，都该有图，不要用表格代替。图不是装饰，是论证的一部分。

- 映射关系画成左右两栏，左边问题、右边解法，中间箭头，每个解法标落点文件。
- 分层图画成上下堆叠，箭头只朝一个方向，并在每层里放它的代表组件。
- 过程图画成时间线，每一站写清「这一步在干什么」，下方列产物。
- 图注写指令，不写复述：「左边是场景里撞出来的，右边是解法和落点」，让读者知道该看什么。

### 验证一节必须交代四件事

只贴日志是没写完。按这四块组织：

1. **设置**：对象是什么、什么环境、**完整可复制的命令**、观察哪几个指标。
2. **过程**：逐段解释为什么这么做（例如「先 list_files 是因为任务约束只改一个文件，它要先确认文件存在」），而不是让读者自己猜。
3. **结果**：给 diff 或前后对比，并独立复验一次；说明是否满足任务约束。
4. **成本**：模型调用次数、耗时、钱。数字必须从实际运行记录里数出来，不能估。

## 文风：去 AI 味

依据 [blader/humanizer](https://github.com/blader/humanizer) 的 26 条模式，落到中文技术写作上，高频的是这七条：

1. **「不是 X，而是 Y」** —— 直接说 Y。
2. **「一句话：」「本质上」「归根结底」** —— 删掉，或换成能验证的断言。
3. **装饰性粗体** —— 段落开头的标签、要点前的粗体、表格单元格里的粗体，全部去掉，让句子承担结构。
4. **破折号「——」** —— 换成逗号、句号或括号，叙述句里不该到处是它。
5. **铺垫** —— 「先说结论」「这里要单独强调」「值得记一笔」，删掉，直接进正文。
6. **元叙述** —— 「这篇只回答一个问题」「我把修正过程留在第六节」，读者不关心文章怎么写的。
7. **升华式收尾** —— 「这就是真正的分水岭」这种，换成具体事实或判断。

自检（三个数应该都是个位数）：

```powershell
$f = 'src/content/posts/xxx.md'
$t = Get-Content $f -Raw
'bold={0} dash={1} notXbutY={2}' -f `
  ([regex]::Matches($t, '\*\*')).Count, `
  ([regex]::Matches($t, '——')).Count, `
  ([regex]::Matches($t, '不是[^。！？]{0,24}(而是|，是)')).Count
```

## 配图

技术长文默认配 3–5 张图，每张都要能在正文里「指回去」：图注写清它对应哪几个文件、接口或算例。

| 项   | 约定                                                                                                                              |
| :--- | :-------------------------------------------------------------------------------------------------------------------------------- |
| 画布 | 宽 1000px。正文栏约 760px，缩放 0.72 后 13px 字号仍可读                                                                           |
| 底色 | `#F8FAFC`；节点分组描边 `#E2E8F0` 或对应语义色                                                                                    |
| 字体 | `'PingFang SC','Microsoft YaHei','Noto Sans CJK SC',system-ui,sans-serif`                                                         |
| 字号 | 标题 15，节点文字 12–13，辅助说明 10.5–11                                                                                         |
| 配色 | 靛蓝 `#6366F1`（知识/输入）、蓝 `#0284C7`（过程）、绿 `#10B981`（产出/正常）、琥珀 `#F59E0B`（代价）、玫红 `#F43F5E`（风险/命门） |
| 结构 | 节点 `rx="10"`，箭头 `stroke="#64748B"`，首尾留 40px 以上边距                                                                     |

画完必须渲染核对（`oil_ui_shoot` 可以直接截 SVG）：确认没有文字溢出、没有被裁切、箭头指向正确。图错的代价比文字错更大，因为排版整齐的图更容易被信任。

### 视频素材

把视频整理成文章时，转写只覆盖说话，讲解用的画面要另外取。`scripts/video-frames.py` 负责这一步：

```powershell
python scripts/video-frames.py --bvid BV15z4C6SEHT --part 9 --out .frames/p9 --interval 10 --crop-bottom 0.09
```

它按分 P 取 480p 流，定长抽帧，用「饱和度低 + 边缘密」筛掉真人出镜和空镜，按相邻帧差异去重，最后拼成 `sheet.png` 联系表。先看联系表挑图，再决定怎么用。

取舍顺序：

1. 通用结构（架构图、流程图、对比表）按上面的配图规范重绘成 SVG，风格和站内一致。
2. 原论文插图、真实产品界面、作者手写的公式，重绘会失真，可以直接引用截图，但图注要写清出处与时间戳，并裁掉烧进画面的字幕条。
3. 过渡动画和装饰性画面不要放进文章。

截图默认只作重绘参照，不进仓库；确需引用的放 `public/img/<slug>/` 并注明来源。

### 裁定：重绘还是引用

不预设默认，逐张判。先对着联系表回答三个问题，两个以上答「是」就引用原图，否则重绘：

| 问题                                                                     | 答「是」的含义                           |
| :----------------------------------------------------------------------- | :--------------------------------------- |
| 不看原图，这张图的信息能用两三句话说清吗                                 | 能说清就该重绘，说明它只是结构，不是证据 |
| 图里是否贴着官方口径：论文插图、协议字段名、产品真实界面、真实代码或配置 | 是就该引用，转述会改掉细节               |
| 重绘会不会改变断言的强度：具体数字、模型名、参数规模、版本号、字段顺序   | 会就该引用，重绘写错一个数就是造谣       |

冲突时信息保真优先于风格统一。一张图只能有一个用途，不要既当证据又当插图。

引用截图的硬约束：裁掉字幕条与水印；图注写「原视频 mm:ss，作者」，并在「材料与口径」里交代获取方式；单张不超过正文栏高度的一半；一篇不超过两张。

重绘的硬约束：遵循本节前面的画布、字号、配色规范；图注指回正文里的具体小节或算例；图里不出现原视频的吉祥物、口播台词和二次创作的梗。

## Skills

日常用到的技能，需要时在会话里直接点名即可（如「用 svg-diagram 画一张…」）。

| 技能          | 用途                                                                | 什么时候用                |
| :------------ | :------------------------------------------------------------------ | :------------------------ |
| `svg-diagram` | 生成 CJK 友好的架构图、流程图、时序图 SVG                           | 新文章配图、旧图重画      |
| `humanizer`   | 去 AI 味的 26 条模式（[仓库](https://github.com/blader/humanizer)） | 交稿前、批量改旧文        |
| `archify`     | 可交互架构图，支持导出 PNG/SVG/WebM                                 | 需要比静态 SVG 更强的表达 |
| `oil-ui`      | 界面设计方向探索与视觉评审                                          | 改主题 UI、做对比页       |
| `office`      | docx/pptx/xlsx 的生成、编辑与转换                                   | 把文章导出成文档交付      |

## 内容模型与模板约定

### 排序

`src/utils/posts.ts` 的 `getVisiblePosts()` 先按 `publishedAt` 倒序；同一天发布时按编号数字倒序（`032` 在 `031` 前面）。改排序时保住这条，否则同日期文章的次序会变成字符串比较，看起来像按编号正序。

### 精选

`featured: true` 写在 frontmatter 里（schema 默认 `false`）。首页只展示精选，按上面的排序；一篇都没标时回退到最新 N 篇，避免首页空白。新增长文发布后，如果它值得放在首页，记得补 `featured: true`。

### 代码块

`src/config/expressiveCodeConfig.ts`：

| 配置                                 | 当前值  | 含义                                       |
| :----------------------------------- | :------ | :----------------------------------------- |
| `pluginCollapsible.lineThreshold`    | 40      | 超过 40 行才允许折叠                       |
| `pluginCollapsible.previewLines`     | 12      | 折叠后可见行数                             |
| `pluginCollapsible.defaultCollapsed` | `false` | 默认全展开，只有显式写 `collapse` 的块才折 |

短文里的示例代码不要折，读者需要直接看到；超长日志或完整文件另说。

### 侧边栏

首页侧栏顺序：站点概览 → 最近更新 → 热门标签 → 引言。最近更新按 `updatedAt ?? publishedAt` 倒序取 5 篇；改过旧文就补 `updatedAt`，它才会出现在这一栏。

### 看板娘

站里左下角那只来自 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)，是 640×360 的 **透明 webm**，不是 Live2D。交互参考 [live2d-widget](https://github.com/stevenjoezhang/live2d-widget)：贴角落、可拖可甩、点一下换动作、双击睡觉。

| 项     | 位置 / 约定                                                                                           |
| :----- | :---------------------------------------------------------------------------------------------------- |
| 组件   | `src/components/ui/BlogPet.astro`，挂在 `BaseLayout`，全站生效                                        |
| 素材   | `public/pet/*.webm`，**109 段全量**，约 53 MB                                                         |
| 清单   | `public/pet/manifest.json`：`file`、`label`、`kind`、`size`，运行时 fetch                             |
| 播放   | 两个 `<video>` 双缓冲：一个在播，另一个在后台 `load` 下一段，切换只换 opacity，不改正在播的 src       |
| 点击   | 用预载好的那段（从全量池子随机抽），所以点下去是瞬间换，不会闪                                        |
| 双击   | 睡觉：`sleep-in` → 循环 `sleep-loop` → 点一下 `sleep-out` 醒来                                        |
| 说话   | 气泡 + 表情包（`public/pet/memes/`，27 张，约 75% 概率配图），一起显示一起消失                        |
| 悬停   | 抬 3px、放大 1.03，并朝鼠标方向倾斜 ±4 度做视线跟随；悬停时按 `S` 睡觉、`Esc` 叫醒                    |
| 物理   | 拖动记速度，松手后重力 + 撞墙反弹 + 摩擦；挤压动画同一时刻只跑一个                                    |
| 状态   | `localStorage` 只存位置 `pet:pos`；没有关闭按钮，也不做隐藏                                           |
| 降级   | Safari 不认 webm 的 alpha，直接不挂载；`prefers-reduced-motion` 下不随机动作；`tablet` 以下不显示     |
| 画中画 | 视频 `pointer-events-none` + `disablepictureinpicture`，原生控件用 CSS 隐藏，否则悬停会冒出画中画按钮 |

署名是硬要求：形象许可 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh-hans)，作者约定二创作品在公开渠道须附项目地址。页脚一行、角色下方一行、`public/pet/README.md` 完整出处，改素材时都别删。

改尺寸：窗框 `w-[200px]` / `h-[217px]`，视频用 `w-[230%]`、`left-[-68%]`、`top-[-12.6%]` 三个百分数放大平移。这三个数由角色包围盒（x=189..467、y=38..342）算出，等比缩放时不用改；改宽高比要重算。两个 video 都要跟着改。

加新动作：从上游取 webm → 放 `public/pet/` → 在 `manifest.json` 加一条（`kind` 决定何时播）→ `README.md` 补一行。素材禁止商用，个人非商业博客可用。

体积注意：首屏只加载 `idle`（约 430 KB），其余按需预载；整个目录约 53 MB，别在构建里再做全量拷贝。

## 发布前检查

1. `npm run format` —— 只格式化，会重排表格列宽。
2. `npm run check` —— 类型与内容校验，必须 0 errors。
3. `npm run build` —— 全部页面构建成功，新增或删改文章都会改变页面数。
4. `git diff --check` —— 无空白问题。
5. 逐字核对：frontmatter、代码块、数字。改旧文时尤其要做，可用脚本比对 `git show HEAD:<file>` 与工作区。
6. 文中每个实测数字都要能指到证据（会话文件、日志、`git diff`），估算的数字宁可删掉。
7. `git push origin main` —— Cloudflare Pages 自动构建。
8. 部署后 `HEAD` 文章页与配图，返回 200 才算完。构建失败要去 Cloudflare 的构建日志里看。

### 依赖变更的坑

本地 npm 是 11.x，CI 用 npm 10.9.9。用本地 npm 改依赖会让 lock 变成 npm 11 的口径，CI 的 `npm ci` 直接报 `Missing: @emnapi/* from lock file` 而失败。改依赖后要重新生成 lock：

```powershell
npm install npm@10.9.9 --no-save --prefix .tmpnpm
node .tmpnpm/node_modules/npm/bin/npm-cli.js install --package-lock-only
node .tmpnpm/node_modules/npm/bin/npm-cli.js ci --dry-run   # 应无 sync 报错
```

网络受限时先设 `$env:HTTPS_PROXY='http://127.0.0.1:7890'`。

## Commands

| Command                   | Action                                           |
| :------------------------ | :----------------------------------------------- |
| `npm install`             | Installs dependencies                            |
| `npm run dev`             | Starts local dev server at `localhost:4321`      |
| `npm run build`           | Build your production site to `./dist/`          |
| `npm run preview`         | Preview your build locally, before deploying     |
| `npm run astro ...`       | Run CLI commands like `astro add`, `astro check` |
| `npm run astro -- --help` | Get help using the Astro CLI                     |
| `npm run format`          | Format code                                      |
| `npm run check`           | Check types                                      |

Manage the background server with `npm run astro dev stop`, `npm run astro dev status`, and `npm run astro dev logs`.

After completing work, run `npm run format` and `npm run check`. After source changes, also run `npm run build` and `git diff --check`.

## Repository Structure

| Path                | Purpose                                                                          |
| :------------------ | :------------------------------------------------------------------------------- |
| `.astro/`           | Astro-generated development metadata; should not be edited manually              |
| `dist/`             | Generated production build output for deployment; should not be edited manually  |
| `public/`           | Static assets copied directly to the final build without processing              |
| `src/`              | Main source code for pages, components, layouts, styles, content, and site logic |
| `astro.config.mjs`  | Astro configuration, integrations, Markdown processing, and build settings       |
| `package.json`      | Project metadata, scripts, dependencies, and supported Node.js version           |
| `package-lock.json` | Locked npm dependency graph; update it together with dependency changes          |
| `tsconfig.json`     | TypeScript and Astro compiler configuration                                      |

## Source Layout

`src/` contains the main source code, content, styles, and configuration for the Astro site.

| Path            | Purpose                                                                     |
| :-------------- | :-------------------------------------------------------------------------- |
| `assets/`       | Images, fonts, and other assets processed and optimized by Astro            |
| `components/`   | Reusable UI components grouped by responsibility                            |
| `config/`       | Site metadata, navigation, home page, footer, and integration settings      |
| `content/`      | Markdown content collections for posts and standalone pages                 |
| `i18n/`         | Translation keys, locale strings, language settings, and helpers            |
| `integrations/` | Theme-level Astro integrations, such as the Markdown Negotiation build hook |
| `layouts/`      | Shared document shells and article layout                                   |
| `pages/`        | File-based routes, dynamic routes, and server endpoints                     |
| `styles/`       | Global styles, design tokens, typography, and prose rules                   |
| `types/`        | Shared TypeScript types and interfaces                                      |
| `utils/`        | General-purpose helpers, including post querying and sorting                |

### Component Source Layout

`src/components/`:

| Directory  | Purpose                                                        |
| :--------- | :------------------------------------------------------------- |
| `content/` | Content presentation components such as cards, lists, and tags |
| `layout/`  | Page-wide structure and site shell components                  |
| `search/`  | Search interfaces and interactions                             |
| `ui/`      | Reusable UI primitives and small composed display components   |
| `widget/`  | Standalone page widgets, such as the table of contents         |

## Workflows

### 1. Implementing a Feature

1. Read the user's requirements and inspect the relevant existing code, configuration, content, and documentation.
2. Before editing implementation files, present a concrete plan that describes the intended behavior, affected areas, and validation steps.
3. Do not modify source code or other implementation files, and do not run commands that rewrite or generate files, until the user explicitly approves the plan and authorizes implementation. Read-only inspection is allowed.
4. After approval, implement only the approved scope. If a materially different approach or broader scope becomes necessary, explain the change and request approval again before proceeding.
5. Validate the implementation with the commands required by this document and report the result.

### 2. Fixing a Bug

1. Start from the user's problem description. Inspect the relevant code and, when practical, reproduce the issue using read-only or non-mutating diagnostics.
2. Identify the root cause and support the diagnosis with concrete evidence from the code or reproduction. Do not present an unverified guess as the cause.
3. Explain the root cause, affected behavior, proposed fix, and validation plan to the user. Wait for explicit approval before modifying source code or other implementation files.
4. After approval, implement the fix within the agreed scope, add or update regression coverage when appropriate, and run the required validation commands.

## UI and Styling

- Use Tailwind utilities for component layout and visual styling. Keep global CSS for base styles, design tokens, prose,
  third-party integrations, and selectors that cannot be expressed clearly as utilities.
- Use only semantic theme colors defined in `src/styles/global.css`. Do not use Tailwind's default color palette or raw
  color literals in components.
- Prefer integer spacing utilities so layout, spacing, padding, and gaps remain multiples of `4px`.
- Use only the `tablet` and `wide` responsive variants. Do not add one-off breakpoints in component markup.
- Do not use arbitrary values when a theme token or standard utility exists. Add a reusable token when the same custom
  value is needed more than once.
- Keep letter spacing at `0`. Use font size, weight, and color for hierarchy.
- Reuse repeated visual structures as Astro components. Do not hide copied utility lists behind `@apply` or new CSS
  classes.

## URL Conventions

- The site enforces trailing-slash-free URLs (`trailingSlash: "never"` in `astro.config.mjs`). Every page URL must end
  without a trailing `/`, except the site root `/`.
- When generating or writing links (navigation, footer, cards, RSS, sitemap, redirects, or any `href`), never append a
  trailing `/` to non-root paths. Prefer the project's existing path helpers (e.g. `getPostHref`) over hand-building
  URLs so this convention stays consistent.

## Documentation

Full documentation: https://docs.astro.build

Consult these guides before working on related tasks:

- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Using React, Vue, Svelte, or other framework components](https://docs.astro.build/en/guides/framework-components/)
- [Adding or managing content](https://docs.astro.build/en/guides/content-collections/)
- [Adding styles or using Tailwind](https://docs.astro.build/en/guides/styling/)
- [Supporting multiple languages](https://docs.astro.build/en/guides/internationalization/)
