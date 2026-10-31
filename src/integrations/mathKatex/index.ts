import katex from "katex";
import type { MdastPluginDefinition } from "satteri";

/**
 * 把 satteri 解析出的 math / inlineMath 节点渲染成 KaTeX 的 HTML。
 *
 * 主题的 Markdown 处理器是 satteri（原生实现，不接 unified 插件），所以
 * remark-math / rehype-katex 都用不上，只能在 mdast 阶段替换节点。
 * 行间公式包一层 div：raw 内容以块级标签开头才会被当成 HTML 块解析，
 * 否则会被塞进 <p> 里。公式节点常常是段落里唯一的子节点，这种情况下
 * 连段落一起替换，避免出现 <p><div>。
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
  inlineMath(node, context) {
    const tex = typeof node.value === "string" ? node.value : "";
    if (!tex.trim()) return;
    context.replaceNode(node, { raw: renderTeX(tex, false), mdxExpressions: false });
  },
};
