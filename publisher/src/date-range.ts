import { parseArgs } from "node:util";

/** Parse `--from` and `--to` (`YYYY-MM-DD`). Both default to yesterday in NZ. */
export function parseDateRange(args: string[] = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: { from: { type: "string" }, to: { type: "string" } },
  });
  const yesterday = Temporal.Now.plainDateISO("Pacific/Auckland")
    .subtract({ days: 1 })
    .toString();
  const to = values.to ?? yesterday;
  const from = values.from ?? to;
  // PlainDate.from throws a RangeError for a bad date.
  if (Temporal.PlainDate.compare(from, to) > 0) {
    throw new RangeError(`--from ${from} is after --to ${to}`);
  }
  return {
    from: Temporal.PlainDate.from(from).toString(),
    to: Temporal.PlainDate.from(to).toString(),
  };
}

/** Every date from `from` to `to`, inclusive. */
export function eachDate(from: string, to: string): string[] {
  const dates: string[] = [];
  for (
    let day = Temporal.PlainDate.from(from);
    Temporal.PlainDate.compare(day, to) <= 0;
    day = day.add({ days: 1 })
  ) {
    dates.push(day.toString());
  }
  return dates;
}
