import { postConfig } from "@/config/postConfig";
import { i18n, I18nKey } from "@/i18n";
import { getCollection, type CollectionEntry } from "astro:content";

export type PostEntry = CollectionEntry<"posts">;

export async function getVisiblePosts() {
  const posts = await getCollection("posts", ({ data }) => (import.meta.env.PROD ? !data.draft : true));

  // 同一天发布时按编号倒序：032 排在 031 前面。
  // 之前用 localeCompare 升序，导致同日期里 001 反而排在最前，看上去像按编号正序。
  return posts.sort((left, right) => {
    const byDate = right.data.publishedAt.getTime() - left.data.publishedAt.getTime();
    if (byDate !== 0) return byDate;
    return right.id.localeCompare(left.id, undefined, { numeric: true });
  });
}

export async function getFeaturedPosts() {
  const posts = await getVisiblePosts();
  return posts.filter((post) => post.data.featured);
}

export function getRecentlyUpdatedPosts(posts: readonly PostEntry[], limit = 5) {
  return [...posts]
    .sort((left, right) => {
      const leftTime = (left.data.updatedAt ?? left.data.publishedAt).getTime();
      const rightTime = (right.data.updatedAt ?? right.data.publishedAt).getTime();
      return rightTime - leftTime;
    })
    .slice(0, limit);
}

export function getPostHref(post: PostEntry) {
  const encodedId = post.id.split("/").map(encodeURIComponent).join("/");
  return `/posts/${encodedId}`;
}

export function getAdjacentPosts(posts: readonly PostEntry[], post: PostEntry) {
  const currentIndex = posts.findIndex((candidate) => candidate.id === post.id);

  return {
    previousPost: currentIndex > 0 ? posts[currentIndex - 1] : undefined,
    nextPost: currentIndex >= 0 && currentIndex < posts.length - 1 ? posts[currentIndex + 1] : undefined,
  };
}

export function getPostOgImageHref(post: PostEntry) {
  const encodedId = post.id.split("/").map(encodeURIComponent).join("/");
  return `/og/${encodedId}.png`;
}

export function formatPostDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

export function getPostMetrics(post: PostEntry) {
  const body = post.body ?? "";
  const hanCharacterCount = body.match(/\p{Script=Han}/gu)?.length ?? 0;
  const latinWordCount = body.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g)?.length ?? 0;
  const wordCount = hanCharacterCount + latinWordCount;
  const minutes = Math.max(1, Math.ceil(wordCount / postConfig.readingUnitsPerMinute));

  return {
    wordCount: i18n(I18nKey.postWordCount, { count: wordCount }),
    readingTime: i18n(I18nKey.postReadingTime, { minutes }),
  };
}
