import assert from "node:assert/strict";
import test from "node:test";
import { sourceMarkerForStore, withStoreSourceMarker } from "./storeSource.js";

test("Peps4pets-Aufträge erhalten eine sichtbare Quellenkennung", () => {
  assert.equal(sourceMarkerForStore("peps4pets"), "[QUELLE: PEPS4PETS]");
  assert.equal(withStoreSourceMarker("peps4pets", ["evidence:abc"]), "[QUELLE: PEPS4PETS] | evidence:abc");
});

test("LADYPEPS-Aufträge erhalten eine sichtbare Quellenkennung", () => {
  assert.equal(sourceMarkerForStore("ladypeps"), "[QUELLE: LADYPEPS]");
  assert.equal(withStoreSourceMarker("ladypeps", ["evidence:abc"]), "[QUELLE: LADYPEPS] | evidence:abc");
});

test("Bestehende 369-Research-Aufträge erhalten keinen neuen Quellenmarker", () => {
  assert.equal(sourceMarkerForStore("369research"), null);
  assert.equal(withStoreSourceMarker("369research", ["bestehende Notiz"]), "bestehende Notiz");
});
