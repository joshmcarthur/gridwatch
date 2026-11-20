export const BLOB = "https://emidatasets.blob.core.windows.net/publicdata";

/**
 * List the blob names under `prefix` (Azure container listing). Follows `NextMarker`
 * until the listing ends. Shared by all Electricity Authority datasets.
 */
export async function listNames(
  baseUrl: string,
  prefix: string,
  doFetch: typeof fetch = fetch,
): Promise<string[]> {
  const names: string[] = [];
  let marker = "";
  do {
    const url = `${baseUrl}?restype=container&comp=list&prefix=${encodeURIComponent(prefix)}${marker && `&marker=${encodeURIComponent(marker)}`}`;
    const response = await doFetch(url);
    if (!response.ok)
      throw new Error(`Listing ${url}: HTTP ${response.status}`);
    const xml = await response.text();
    for (const [, name] of xml.matchAll(/<Name>([^<]+)<\/Name>/g)) {
      names.push(name as string);
    }
    marker = /<NextMarker>([^<]+)<\/NextMarker>/.exec(xml)?.[1] ?? "";
  } while (marker);
  return names;
}
