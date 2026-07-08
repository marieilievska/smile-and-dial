import { test, expect } from "@playwright/test";
import { buildRubricText } from "../src/lib/review/rubric";

test("buildRubricText renders key/lens/label/guidance per line", () => {
  const text = buildRubricText([
    {
      key: "tool_error",
      label: "Tool error",
      lens: "bug",
      severity: 1,
      guidance: "A tool failed.",
    },
  ]);
  expect(text).toContain("tool_error (bug): Tool error. A tool failed.");
});
