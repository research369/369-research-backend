import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDashboardProductNames } from "./dashboardProductNames.js";

test("dashboard product names discard blank and duplicate values", () => {
  assert.deepEqual(
    normalizeDashboardProductNames([
      { name: "BPC-157" },
      { name: "" },
      { name: "  " },
      { name: null },
      { name: " GHK-Cu " },
      { name: "BPC-157" },
    ]),
    ["BPC-157", "GHK-Cu"],
  );
});
