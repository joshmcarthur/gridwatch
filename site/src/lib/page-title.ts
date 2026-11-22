export const SITE_NAME = "Gridwatch NZ";

export function pageTitle(title: string): string {
  if (title === SITE_NAME || title.endsWith(` · ${SITE_NAME}`)) return title;
  return `${title} · ${SITE_NAME}`;
}
