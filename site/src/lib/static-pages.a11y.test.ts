import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { SITE_NAME } from "./page-title.ts";

const dist = fileURLToPath(new URL("../../dist", import.meta.url));
const aboutPage = join(dist, "about/index.html");
const howPage = join(dist, "how/index.html");
const termsPage = join(dist, "terms/index.html");

const AUTHORITY_ROLE =
  "the independent public body that regulates New Zealand's electricity market and sets its rules";
const SYSTEM_OPERATOR_ROLE =
  "the organisation that keeps the high-voltage network working from minute to minute";

const documentTitle = (html: string): string => {
  const head = html.match(/<head[\s\S]*?<\/head>/)?.[0] ?? "";
  return head.match(/<title>([^<]*)<\/title>/)?.[1] ?? "";
};

const htmlFiles = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...htmlFiles(path));
    else if (entry.name.endsWith(".html")) out.push(path);
  }
  return out;
};

const count = (html: string, phrase: string): number =>
  html.split(phrase).length - 1;

test.skipIf(!existsSync(dist))(
  "every built page title is the site name or ends with it",
  () => {
    for (const file of htmlFiles(dist)) {
      const title = documentTitle(readFileSync(file, "utf8"));
      expect(
        title === SITE_NAME || title.endsWith(` · ${SITE_NAME}`),
        `${file} has title ${JSON.stringify(title)}`,
      ).toBe(true);
    }
  },
);

test.skipIf(!existsSync(aboutPage))(
  "built About names the page About and uses the shared roles",
  () => {
    const html = readFileSync(aboutPage, "utf8");
    expect(documentTitle(html)).toBe("About · Gridwatch NZ");
    expect(html).toMatch(/<h1[^>]*>About<\/h1>/);
    expect(html).not.toMatch(/What is this site\?/);
    expect(html).toContain(AUTHORITY_ROLE);
    expect(html).toContain("Transpower is the system operator");
    expect(html).toContain(SYSTEM_OPERATOR_ROLE);
    expect(html).toContain("aren't already in the industry");
    expect(html).not.toMatch(/work in the industry|work there/);
    expect(html).toMatch(/tomorrow's prices aren't in these files/i);
    expect(
      count(html.toLowerCase(), "tomorrow's prices aren't in these files"),
    ).toBe(1);
  },
);

test.skipIf(!existsSync(howPage))(
  "built How explains jargon once and uses the shared roles",
  () => {
    const html = readFileSync(howPage, "utf8");
    expect(documentTitle(html)).toBe("How we do this · Gridwatch NZ");
    expect(html).toContain(AUTHORITY_ROLE);
    expect(html).toContain("Transpower is the system operator");
    expect(html).toContain(SYSTEM_OPERATOR_ROLE);
    expect(html).toMatch(/Dispatch is the market's word/);
    expect(html).toMatch(/A node is a named place on the grid/);
    expect(html).toMatch(/Cleared means the market took/);
    expect(html).toMatch(/Reserve is spare generating capacity/);
    expect(html.indexOf("Dispatch reserve prices")).toBeGreaterThan(-1);
    expect(html.indexOf("Dispatch reserve prices")).toBeLessThan(
      html.indexOf("Downloaded, not on the pages yet"),
    );
    expect(html).not.toMatch(/reserve[^.]*not on the daily\s+pages yet/i);
    expect(html).toMatch(/One megawatt-hour is\s+1,000\s+kilowatt-hours/);
    expect(html).not.toMatch(/tomorrow's prices aren't in these files/i);
    expect(html).not.toMatch(/runs New Zealand's wholesale electricity market/);
    expect(html).not.toMatch(/keep the lights on/);
    expect(html).toContain('id="ai"');
    expect(html).toMatch(/How this site uses AI/);
    expect(html).toMatch(/still published/);
  },
);

test.skipIf(!existsSync(termsPage))(
  "built Terms names Transpower as system operator and uses the shared roles",
  () => {
    const html = readFileSync(termsPage, "utf8");
    expect(documentTitle(html)).toBe("Terms · Gridwatch NZ");
    expect(html).toContain(AUTHORITY_ROLE);
    expect(html).toContain("Transpower");
    expect(html).toContain("system operator");
    expect(html).toContain(SYSTEM_OPERATOR_ROLE);
    expect(html).not.toMatch(/grid operator/);
    expect(html).not.toMatch(/keep the lights on/);
    expect(html).toContain("Electricity Market Information, or EMI");
  },
);
