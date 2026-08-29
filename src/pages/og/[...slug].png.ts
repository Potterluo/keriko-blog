import type { APIRoute } from "astro";

import { siteConfig } from "@/config/siteConfig";
import { renderOgCard } from "@/utils/ogImage";
import { getVisiblePosts } from "@/utils/posts";

export async function getStaticPaths() {
  if (!siteConfig.generateOpenGraph || import.meta.env.DEV) return [];

  const posts = await getVisiblePosts();
  return posts.map((post) => ({ params: { slug: post.id } }));
}

export const GET: APIRoute = async ({ params }) => {
  if (!siteConfig.generateOpenGraph || import.meta.env.DEV) return new Response("Not Found", { status: 404 });

  const slug = params.slug;
  if (!slug) return new Response("Not Found", { status: 404 });

  const posts = await getVisiblePosts();
  const post = posts.find((entry) => entry.id === slug);
  if (!post) return new Response("Not Found", { status: 404 });

  const png = await renderOgCard(post);
  return new Response(new Uint8Array(png), {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
};
