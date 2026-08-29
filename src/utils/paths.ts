export function normalizeSitePath(pathname: string) {
  const pathWithoutIndexFile = pathname.replace(/\/index\.html$/, "/");
  const pathWithoutHtmlExtension = pathWithoutIndexFile.replace(/\.html$/, "");

  return pathWithoutHtmlExtension.replace(/\/+$/, "") || "/";
}
