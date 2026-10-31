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
- 代码块标真实语言；需要默认展开时在围栏后加 `nocollapse`（例如 ` ```text nocollapse `）。
- 公式用 `$$...$$`（行间）和 `$...$`（行内）。实现在 `src/integrations/mathKatex/`，由 satteri 的 `features.math` 解析、KaTeX 渲染。**不要**再用 ```text 代码块模拟公式。
- 提示块用 `> [!IMPORTANT]`、`> [!NOTE]`，由 `src/integrations/markdownCallout` 处理。
- 链接规则见下方 URL Conventions：站内路径结尾不加斜杠，优先用 `getPostHref` 这类 helper。

### 文章骨架

站内的技术长文基本是这个形状，新文可以对齐：

1. **开头直接给事由**：从一次调查、一个疑问或一组数字切入，别用「随着…的发展」起笔。
2. **材料与口径**：任何引用外部代码、文档、数据的文章，要有一节写清读了什么、什么版本、哪些没有复现。这一节也是后面每个数字的溯源入口。
3. **分节推进**：一节回答一个问题，节内可以有一格算术、一张表或一张图，但不重复结论。
4. **收尾落在具体判断**：允许有观点，但不要升华，也不要复述摘要。

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

## Skills

日常用到的技能，需要时在会话里直接点名即可（如「用 svg-diagram 画一张…」）。

| 技能          | 用途                                                                | 什么时候用                |
| :------------ | :------------------------------------------------------------------ | :------------------------ |
| `svg-diagram` | 生成 CJK 友好的架构图、流程图、时序图 SVG                           | 新文章配图、旧图重画      |
| `humanizer`   | 去 AI 味的 26 条模式（[仓库](https://github.com/blader/humanizer)） | 交稿前、批量改旧文        |
| `archify`     | 可交互架构图，支持导出 PNG/SVG/WebM                                 | 需要比静态 SVG 更强的表达 |
| `oil-ui`      | 界面设计方向探索与视觉评审                                          | 改主题 UI、做对比页       |
| `office`      | docx/pptx/xlsx 的生成、编辑与转换                                   | 把文章导出成文档交付      |

## 发布前检查

1. `npm run format` —— 只格式化，会重排表格列宽。
2. `npm run check` —— 类型与内容校验，必须 0 errors。
3. `npm run build` —— 全部页面构建成功，新增或删改文章都会改变页面数。
4. `git diff --check` —— 无空白问题。
5. 逐字核对：frontmatter、代码块、数字。改旧文时尤其要做，可用脚本比对 `git show HEAD:<file>` 与工作区。
6. `git push origin main` —— Cloudflare Pages 自动构建。
7. 部署后 `HEAD` 文章页与配图，返回 200 才算完。构建失败要去 Cloudflare 的构建日志里看。

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
