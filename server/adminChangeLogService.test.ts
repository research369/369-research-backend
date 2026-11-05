import test from "node:test";
import assert from "node:assert/strict";
import { safeChangedFieldNames } from "./adminChangeLogService.js";

test("admin change log records only safe field names and never values", () => {
  const fields = safeChangedFieldNames({
    orderId: "369-11001",
    status: "shipped",
    trackingNumber: "123456789",
    email: "kunde@example.org",
    phone: "+491234567",
    password: "not-recorded",
    internalNote: "not-recorded",
    nested: { visible: true, customerName: "not-recorded" },
  });

  assert.deepEqual(
    fields.sort(),
    [
      "nested.customerName",
      "nested.visible",
      "orderId",
      "status",
      "trackingNumber",
    ].sort(),
  );
  assert.equal(JSON.stringify(fields).includes("369-11001"), false);
  assert.equal(JSON.stringify(fields).includes("not-recorded"), false);
});
