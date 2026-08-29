import type { AstroIntegration } from "astro";
import { fileURLToPath } from "node:url";

import { siteConfig } from "../../config/siteConfig";
import { generateMarkdownForAgents } from "./generate.mjs";

/**
 * Builds Markdown versions of every page (plus the nginx/Caddy negotiation
 * maps) when `siteConfig.enableMarkdownNegotiation` is enabled.
 */
export function markdownForAgents(): AstroIntegration {
  let root = process.cwd();

  return {
    name: "markdown-for-agents",
    hooks: {
      "astro:config:done"({ config }) {
        root = fileURLToPath(config.root);
      },
      async "astro:build:done"({ dir, logger }) {
        if (!siteConfig.enableMarkdownNegotiation) {
          logger.info(
            "Markdown Negotiation is disabled in siteConfig; skipping .md generation. " +
              "Remember to also disable the nginx/Caddy negotiation rule on the server.",
          );
          return;
        }

        const { files } = await generateMarkdownForAgents({
          root,
          distDir: fileURLToPath(dir),
          siteConfig,
        });
        logger.info(`Generated ${files.length} markdown page(s) for agents.`);
      },
    },
  };
}
