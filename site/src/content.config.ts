import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

function isCalendarDate(value: string): boolean {
  try {
    return Temporal.PlainDate.from(value).toString() === value;
  } catch {
    return false;
  }
}

const explainers = defineCollection({
  loader: glob({ pattern: "*.md", base: "./src/content/explainers" }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    example_date: z
      .string()
      .refine(
        isCalendarDate,
        "example_date must be a calendar date YYYY-MM-DD",
      ),
  }),
});

export const collections = { explainers };
