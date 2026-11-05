import assert from "node:assert/strict";
import test from "node:test";
import {
  CUSTOMER_DATA_CHANGE_RECONFIRMATION_CODE,
  getChangedCustomerDataFields,
  normalizeCustomerMatchPhone,
  resolveCheckoutCustomerDataChange,
} from "./customerDataChangeService.js";

const existingCustomer = {
  id: 17,
  customerNumber: "1217",
  name: "Muna Sroukhan",
  firstName: "Muna",
  lastName: "Sroukhan",
  email: "muna@example.com",
  phone: "+49 171 1234567",
  company: "",
  street: "Alte Straße",
  houseNumber: "3",
  zip: "50667",
  city: "Köln",
  country: "Deutschland",
  dhlPostNumber: "",
};

test("a unique e-mail match requires an explicit confirmation before a changed address is adopted", () => {
  const result = resolveCheckoutCustomerDataChange([existingCustomer], {
    ...existingCustomer,
    street: "Neue Straße",
  });
  assert.equal(result.kind, "matched");
  if (result.kind !== "matched") return;
  assert.equal(result.matchedBy, "email_and_phone");
  assert.equal(result.requiresConfirmation, true);
  assert.deepEqual(result.changedFields, ["street"]);
  assert.equal(result.previousSnapshot.street, "Alte Straße");
  assert.equal(result.submittedSnapshot.street, "Neue Straße");
});

test("a matching name alone can never attach or change an existing customer", () => {
  const result = resolveCheckoutCustomerDataChange([existingCustomer], {
    ...existingCustomer,
    email: "different@example.com",
    phone: "+49 172 9999999",
  });
  assert.deepEqual(result, { kind: "no_unique_match", reason: "none", requiresConfirmation: false });
});

test("e-mail and phone pointing to different customers create a conflict instead of selecting either record", () => {
  const result = resolveCheckoutCustomerDataChange([
    existingCustomer,
    { ...existingCustomer, id: 18, email: "other@example.com", phone: "+49 172 9999999" },
  ], {
    ...existingCustomer,
    email: "muna@example.com",
    phone: "+49 172 9999999",
  });
  assert.deepEqual(result, { kind: "conflict", requiresConfirmation: false });
});

test("a duplicated contact is ambiguous and never selects an arbitrary customer profile", () => {
  const result = resolveCheckoutCustomerDataChange([
    existingCustomer,
    { ...existingCustomer, id: 18, customerNumber: "1218" },
  ], existingCustomer);
  assert.deepEqual(result, { kind: "no_unique_match", reason: "ambiguous", requiresConfirmation: false });
});

test("the German local and international form of the same phone normalize consistently", () => {
  assert.equal(normalizeCustomerMatchPhone("0171 123 4567"), "491711234567");
  assert.equal(normalizeCustomerMatchPhone("+49 (171) 123-4567"), "491711234567");
  assert.deepEqual(
    getChangedCustomerDataFields(
      { ...existingCustomer, name: "Muna Sroukhan" },
      { ...existingCustomer, name: "Muna Sroukhan", phone: "0171 123 4567" },
    ),
    [],
  );
  assert.equal(CUSTOMER_DATA_CHANGE_RECONFIRMATION_CODE, "CUSTOMER_DATA_CHANGE_RECONFIRMATION_REQUIRED");
});

test("an omitted optional company or DHL Post Number does not erase established customer data", () => {
  const result = resolveCheckoutCustomerDataChange([
    { ...existingCustomer, company: "Muster GmbH", dhlPostNumber: "12345678" },
  ], {
    ...existingCustomer,
    company: "",
    dhlPostNumber: "",
  });
  assert.equal(result.kind, "matched");
  if (result.kind !== "matched") return;
  assert.equal(result.requiresConfirmation, false);
  assert.equal(result.submittedSnapshot.company, "Muster GmbH");
  assert.equal(result.submittedSnapshot.dhlPostNumber, "12345678");
});
