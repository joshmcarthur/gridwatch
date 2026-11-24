import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";
import { EXPLAINER_CHARTS } from "./lib/explainer";

function isCalendarDate(value: string): boolean {
  try {
    return Temporal.PlainDate.from(value).toString() === value;
  } catch {
    return false;
  }
}

const explainers = defineCollection({
  loader: glob({ pattern: "*.md", base: "./src/content/explainers" }),
  schema: z
    .object({
      title: z.string(),
      description: z.string(),
      chart: z.enum(EXPLAINER_CHARTS).optional(),
      example_date: z
        .string()
        .refine(
          isCalendarDate,
          "example_date must be a calendar date YYYY-MM-DD",
        )
        .optional(),
    })
    .refine((entry) => entry.chart === undefined || entry.example_date, {
      message: "chart requires example_date",
      path: ["example_date"],
    }),
});

export const collections = { explainers };
