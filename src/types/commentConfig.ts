export type CommentProvider = "artalk";

export interface ArtalkCommentConfig {
  server: string;
  visitorCount: boolean;
}

export interface CommentConfig {
  enabled: boolean;
  type: CommentProvider;
  artalk: ArtalkCommentConfig;
}
