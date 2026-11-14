import katex from "katex";
import type { HastPluginDefinition, MdastPluginDefinition } from "satteri";

/**
 * 把 satteri 解析出的 math / inlineMath 节点渲染成 KaTeX 的 HTML。
 *
 * 主题的 Markdown 处理器是 satteri（原生实现，不接 unified 插件），所以
 * remark-math / rehype-katex 都用不上，只能在 mdast / hast 阶段替换节点。
 *
 * 行间公式在 mdast 阶段换成 raw HTML 块，以块级标签开头，避免被塞进 <p>。
 * 行内公式不能在 mdast 阶段换 raw：替换后的 HTML 会被当成块级内容重新解析，
 * 把所在段落劈成三段。这里只留下 satteri 生成的 `code.math-inline` 元素，
 * 到 hast 阶段再原地换成 raw HTML，父段落不会被破坏。
 */
const escapeHtml = (text: string): string =>
  text.replace(/[<>&]/g, (char: string): string => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[char] as string);

const renderTeX = (tex: string, displayMode: boolean): string => {
  try {
    return katex.renderToString(tex.trim(), {
      displayMode,
      throwOnError: false,
      strict: false,
      output: "htmlAndMathml",
      trust: false,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[katex] 渲染失败：${tex.slice(0, 60)}（${reason}）`);
    return `<code class="math-error">${escapeHtml(tex)}</code>`;
  }
};

/** 行间公式：`$$...$$` 在 mdast 里是 math 节点，换成块级 raw HTML。 */
export const mathKatexPlugin: MdastPluginDefinition = {
  name: "katex-math",
  math(node, context) {
    const tex = typeof node.value === "string" ? node.value : "";
    if (!tex.trim()) return;
    const raw = `<div class="math-display">${renderTeX(tex, true)}</div>`;
    const parent = context.parent(node);
    if (parent && parent.type === "paragraph" && parent.children.length === 1) {
      context.replaceNode(parent, { raw, mdxExpressions: false });
      return;
    }
    context.replaceNode(node, { raw, mdxExpressions: false });
  },
};

/** 行内公式：`$...$` 先由 satteri 转成 `code.math-inline`，再原地替换成 KaTeX。 */
export const mathKatexHastPlugin: HastPluginDefinition = {
  name: "katex-inline-math",
  element: {
    filter: ["code"],
    visit(node, context) {
      const classes = node.properties?.className;
      if (!Array.isArray(classes) || !classes.includes("math-inline")) return;

      const child = node.children?.[0];
      const tex = child?.type === "text" ? child.value : undefined;
      if (typeof tex !== "string" || !tex.trim()) return;

      context.replaceNode(node, { type: "raw", value: renderTeX(tex, false) });
    },
  },
};
