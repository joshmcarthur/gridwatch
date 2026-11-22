export type SparkLabels = {
  id: string;
  title: string;
  summary: string;
};

const svgOpen = (viewBox: string, labels: SparkLabels, extra = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" role="img" aria-labelledby="${labels.id}-title ${labels.id}-summary"${extra}><title id="${labels.id}-title">${escapeXml(labels.title)}</title><desc id="${labels.id}-summary">${escapeXml(labels.summary)}</desc>`;

const escapeXml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** A compact polyline of earlier days, with the latest value as a branded dot. */
export function sparklineSvg(values: number[], labels: SparkLabels): string {
  if (values.length === 0) return "";
  const width = 160;
  const height = 36;
  const pad = 3;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const lastIndex = values.length - 1;
  const points = values.map((value, index) => {
    const x =
      lastIndex === 0
        ? width - pad
        : pad + (index / lastIndex) * (width - 2 * pad);
    const y = height - pad - ((value - min) / span) * (height - 2 * pad);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const [lastX, lastY] = (points.at(-1) ?? "0,0").split(",");
  const line =
    points.length < 2
      ? ""
      : `<polyline fill="none" stroke="currentColor" stroke-width="1.5" points="${points.join(" ")}"/>`;
  return `${svgOpen(`0 0 ${width} ${height}`, labels, ' class="spark"')}${line}<circle cx="${lastX}" cy="${lastY}" r="2.5" fill="var(--color-brand)"/></svg>`;
}

/** A track showing where today sits in the past year. Position, not a traffic-light colour. */
export function rankTrackSvg(percentile: number, labels: SparkLabels): string {
  const x = (2 + Math.min(1, Math.max(0, percentile)) * 96).toFixed(1);
  return `${svgOpen("0 0 100 10", labels, ' class="rank-track"')}<rect x="2" y="3" width="96" height="4" rx="2" fill="var(--color-rule)"/><circle cx="${x}" cy="5" r="3.5" fill="var(--color-ink)"/></svg>`;
}

/** Gas and coal versus the rest of primary generation. */
export function shareBarSvg(share: number, labels: SparkLabels): string {
  const clipped = Math.min(1, Math.max(0, share));
  const thermal = (clipped * 100).toFixed(1);
  const rest = ((1 - clipped) * 100).toFixed(1);
  return `${svgOpen("0 0 100 10", labels, ' class="share-bar"')}<rect x="0" y="2" width="${thermal}" height="6" fill="var(--color-fuel-gas)"/><rect x="${thermal}" y="2" width="${rest}" height="6" fill="var(--color-rule)"/></svg>`;
}
