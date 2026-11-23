import type { APIRoute } from "astro";
import { dailyStaticPaths, dateFromParams } from "../../../../lib/daily-page";
import { mixComparePayload } from "../../../../lib/generation-mix-chart";
import { loadSiteDay, loadSiteIndex } from "../../../../lib/site-data";

export function getStaticPaths() {
  return dailyStaticPaths(loadSiteIndex());
}

export const GET: APIRoute = ({ params }) => {
  const { year, month, day: dayParam } = params;
  if (!year || !month || !dayParam) throw new Error("Missing date params");
  const date = dateFromParams(year, month, dayParam);
  const payload = mixComparePayload(loadSiteDay(date, loadSiteIndex()));
  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
};
