import assert from "node:assert/strict";
import {
  DEFAULT_SHIPMENT_LABEL_OVERRIDE_CONFIG,
  canOverrideShipmentWarning,
} from "./shipmentLabelOverrideConfig.js";

const config = DEFAULT_SHIPMENT_LABEL_OVERRIDE_CONFIG;

assert.equal(canOverrideShipmentWarning(config, "admin", ["zip_city_mismatch"]), true, "Admin darf eine reine PLZ-/Ort-Warnung freigeben");
assert.equal(canOverrideShipmentWarning(config, "admin", ["provider_unavailable"]), true, "Admin darf einen temporären Provider-Ausfall freigeben");
assert.equal(canOverrideShipmentWarning(config, "admin", ["zip_city_mismatch", "provider_unavailable"]), true, "Erlaubte Warnungen dürfen kombiniert freigegeben werden");
assert.equal(canOverrideShipmentWarning(config, "admin", ["house_number_format"]), false, "Unzulässige Pflichtfeldwarnung darf nicht freigegeben werden");
assert.equal(canOverrideShipmentWarning(config, "staff", ["zip_city_mismatch"]), false, "Nicht berechtigte Rollen dürfen nicht freigeben");
assert.equal(canOverrideShipmentWarning({ ...config, enabled: false }, "admin", ["zip_city_mismatch"]), false, "Deaktivierte Konfiguration sperrt jeden Override");
assert.equal(canOverrideShipmentWarning(config, "admin", []), false, "Ohne Warnung ist kein Override erforderlich");

console.log("shipmentLabelOverrideConfig: alle Schutzregeln erfolgreich geprüft");
