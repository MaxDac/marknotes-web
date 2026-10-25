// Prints the vitest coverage totals as a Markdown table (used for the CI job summary).
import { readFileSync } from "node:fs";

const { total } = JSON.parse(
  readFileSync(
    new URL("coverage/coverage-summary.json", import.meta.url),
    "utf8",
  ),
);
const metrics = ["statements", "branches", "functions", "lines"];
console.log(
  [
    "### Unit test coverage",
    "",
    "| Metric | % | Covered |",
    "| --- | --- | --- |",
    ...metrics.map(
      (m) =>
        `| ${m} | ${total[m].pct}% | ${total[m].covered}/${total[m].total} |`,
    ),
  ].join("\n"),
);
