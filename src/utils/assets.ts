const assetModules = import.meta.glob<ImageMetadata>("/src/assets/**/*", {
  eager: true,
  import: "default",
});

export function resolveSiteAsset(configuredPath: string): ImageMetadata | null {
  const normalizedPath = configuredPath.trim().replaceAll("\\", "/");
  if (!normalizedPath) return null;

  const assetPath = normalizedPath.startsWith("/src/assets/")
    ? normalizedPath
    : normalizedPath.startsWith("src/assets/")
      ? `/${normalizedPath}`
      : `/src/assets/${normalizedPath}`;
  const asset = assetModules[assetPath];

  if (!asset) {
    throw new Error(`Asset not found: ${configuredPath}. Store it in src/assets/.`);
  }

  return asset;
}
