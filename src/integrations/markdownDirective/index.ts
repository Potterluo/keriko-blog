import type { MdastPluginDefinition } from "satteri";

/**
 * satteri 打开 directive 解析后，正文里任何 `:word` 都会被当成 text directive，
 * 未知名字在转换阶段直接丢掉。结果是 `P:D` 变 `P`、`1:4` 变 `1`、
 * `arXiv:2401.09670` 丢中间一段，这类冒号在技术文章里太常见。
 *
 * 这里把未知的 text directive 还原成字面文本 `:name`，只放行已知指令
 * （`:spoiler[...]` 由 astro.config 里的 spoilerPlugin 处理）。
 */
const knownTextDirectives = new Set(["spoiler"]);

const textOf = (children: readonly { type: string; value?: unknown }[] | undefined): string => {
  if (!children) return "";
  let out = "";
  for (const child of children) {
    if (child.type === "text" && typeof child.value === "string") out += child.value;
  }
  return out;
};

export const directiveGuardPlugin: MdastPluginDefinition = {
  name: "directive-guard",
  textDirective(node, context) {
    if (knownTextDirectives.has(node.name)) return;
    context.replaceNode(node, { type: "text", value: `:${node.name}${textOf(node.children)}` });
  },
};
