const LINK_HEADER = '</.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"';

const MARKDOWN_ACCEPT = /text\/markdown/i;
const MARKDOWN_PATH = /\.md$/i;

let mapsPromise = null;

function parsePathsMap(text) {
  const paths = {};
  for (const line of text.split("\n")) {
    const match = line.match(/^(\S+)\s+(\S+);\s*$/);
    if (match) paths[match[1]] = match[2];
  }
  return paths;
}

function parseTokensMap(text) {
  const tokens = [];
  for (const line of text.split("\n")) {
    const match = line.match(/^~(\^.+)\$\s+(\d+);\s*$/);
    if (match) tokens.push([new RegExp(match[1]), Number(match[2])]);
  }
  return tokens;
}

function tokenCountFor(tokens, path) {
  for (const [pattern, count] of tokens) {
    if (pattern.test(path)) return count;
  }
  return null;
}

function loadMaps(env) {
  if (!mapsPromise) {
    mapsPromise = (async () => {
      const pathsResponse = await env.ASSETS.fetch(new Request(new URL("/markdown-paths.map", "https://assets.local")));
      const tokensResponse = await env.ASSETS.fetch(
        new Request(new URL("/markdown-tokens.map", "https://assets.local")),
      );
      if (!pathsResponse.ok || !tokensResponse.ok) {
        throw new Error("Markdown negotiation maps are unavailable");
      }
      return {
        paths: parsePathsMap(await pathsResponse.text()),
        tokens: parseTokensMap(await tokensResponse.text()),
      };
    })();
    mapsPromise.catch(() => {
      mapsPromise = null;
    });
  }
  return mapsPromise;
}

function withHeaders(response, headers) {
  const next = new Response(response.body, response);
  for (const [name, value] of Object.entries(headers)) {
    next.headers.set(name, value);
  }
  return next;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/.well-known/api-catalog") {
      const response = await env.ASSETS.fetch(new Request(new URL(path, url)));
      if (!response.ok) return response;
      return withHeaders(response, { "Content-Type": "application/linkset+json" });
    }

    let maps;
    try {
      maps = await loadMaps(env);
    } catch {
      return env.ASSETS.fetch(request);
    }

    const markdownUri = maps.paths[path];
    const acceptsMarkdown = MARKDOWN_ACCEPT.test(request.headers.get("accept") || "");
    const isMarkdownPath = MARKDOWN_PATH.test(path);

    if (isMarkdownPath || (markdownUri && acceptsMarkdown)) {
      const target = isMarkdownPath ? path : markdownUri;
      const response = await env.ASSETS.fetch(new Request(new URL(target, url)));
      if (!response.ok) return response;

      const headers = {
        "Content-Type": "text/markdown; charset=utf-8",
        Vary: "Accept",
        Link: LINK_HEADER,
      };
      const tokenCount = tokenCountFor(maps.tokens, target) ?? tokenCountFor(maps.tokens, path);
      if (tokenCount !== null) headers["x-markdown-tokens"] = String(tokenCount);
      return withHeaders(response, headers);
    }

    if (path === "/" || path === "/index.html") {
      const response = await env.ASSETS.fetch(new Request(new URL(path, url)));
      if (!response.ok) return response;
      return withHeaders(response, { Vary: "Accept", Link: LINK_HEADER });
    }

    return env.ASSETS.fetch(request);
  },
};
