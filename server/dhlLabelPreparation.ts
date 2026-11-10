import { orders } from "../drizzle/schema.js";
import { getPool } from "./db.js";
import { DhlLabelError } from "./dhlRelabelService.js";
import { getActiveProfile, type DhlProfileKey } from "./dhlProfiles.js";
import { normalizeCountryToAlpha3, validateConsignee, createDhlShipmentCH, createDhlShipmentDE, createDhlShipmentEU, type DhlConsignee, type DhlShipmentResult } from "./dhlService.js";
import { buildSwissCommercialInvoicePdf, buildSwissCustomsDocumentsPdf, buildSwissThermalLabelPackagePdf, validateSwissCustomsDeclaration, type SwissCommercialInvoice, type SwissCustomsDeclaration, type ValidatedSwissCustomsDeclaration } from "./swissCustomsService.js";
const alpha3ToAlpha2: Record<string,string> = {
  DEU: "DE", AUT: "AT", CHE: "CH", FRA: "FR", NLD: "NL", BEL: "BE", LUX: "LU",
  POL: "PL", CZE: "CZ", SVK: "SK", HUN: "HU", ROU: "RO", BGR: "BG", HRV: "HR",
  SVN: "SI", ITA: "IT", ESP: "ES", PRT: "PT", GRC: "GR", CYP: "CY", MLT: "MT",
  IRL: "IE", FIN: "FI", SWE: "SE", DNK: "DK", EST: "EE", LVA: "LV", LTU: "LT",
  NOR: "NO", ISL: "IS", LIE: "LI",
};


async function loadSwissCustomsForLabel(order: typeof orders.$inferSelect, poolProvider: typeof getPool): Promise<{
  declaration: ValidatedSwissCustomsDeclaration;
  invoice: SwissCommercialInvoice;
}> {
  const pool = await poolProvider();
  if (!pool) throw new Error("Datenbank für Schweizer Zolldaten nicht verfügbar");
  const result = await pool.query(`
    SELECT
      declaration.package_weight_grams,
      declaration.invoice_number,
      declaration.created_at,
      declaration.compliance_confirmed_at,
      item.order_item_id,
      item.item_description,
      item.hs_code,
      item.country_of_origin,
      item.unit_weight_grams,
      item.unit_customs_value_eur,
      order_item.quantity
    FROM order_swiss_customs_declarations declaration
    JOIN order_swiss_customs_items item ON item.declaration_id = declaration.id
    JOIN order_items order_item ON order_item.id = item.order_item_id
    WHERE declaration.order_id = $1
    ORDER BY order_item.id ASC
  `, [order.orderId]);
  if (result.rows.length === 0) {
    throw new Error("Für diese Schweizer Bestellung fehlen gespeicherte Zolldaten.");
  }
  const first = result.rows[0];
  if (!first.compliance_confirmed_at) {
    throw new Error("Die Compliance-Prüfung für diese Schweizer Sendung wurde nicht bestätigt.");
  }
  const declaration: SwissCustomsDeclaration = {
    orderId: order.orderId,
    packageWeightGrams: Number(first.package_weight_grams),
    shippingEur: Number(order.shipping ?? 0),
    subtotalEur: Number(order.subtotal ?? 0),
    discountEur: Number(order.discount ?? 0),
    lines: result.rows.map((row) => ({
      orderItemId: Number(row.order_item_id),
      description: row.item_description,
      hsCode: row.hs_code,
      countryOfOrigin: row.country_of_origin,
      unitWeightGrams: Number(row.unit_weight_grams),
      quantity: Number(row.quantity),
      unitCustomsValueEur: Number(row.unit_customs_value_eur),
    })),
  };
  const validated = validateSwissCustomsDeclaration(declaration);
  if (!validated.ok) throw new Error(validated.error);
  if (validated.value.goodsValueEur > 1000) {
    throw new Error("Warenwert über 1.000 €: Ausfuhrbegleitdokument (ABD) ist zusätzlich erforderlich und wird nicht automatisch erzeugt.");
  }
  return {
    declaration: validated.value,
    invoice: {
      invoiceNumber: String(first.invoice_number),
      invoiceDate: new Date(first.created_at),
      seller: {
        name: "369 RESEARCH Sp. z o.o.",
        street: "Hoża 86/210",
        zip: "00-682",
        city: "Warszawa",
        country: "Poland",
        taxId: "PL5214161163",
      },
      consignee: {
        name: `${order.firstName ?? ""} ${order.lastName ?? ""}`.trim(),
        street: String(order.street ?? ""),
        houseNumber: String(order.houseNumber ?? ""),
        zip: String(order.zip ?? ""),
        city: String(order.city ?? ""),
        country: "Switzerland",
      },
      declaration: validated.value,
    },
  };
}

export async function prepareDhlLabel(order: typeof orders.$inferSelect, input: {weightGrams?:number;shippingProfile?:string}, poolProvider: typeof getPool = getPool) {
 const profileKey = (input.shippingProfile ?? "DHL_DE_STANDARD") as DhlProfileKey;
 let activeProfile;
 try { activeProfile = getActiveProfile(profileKey); } catch (e:any) { throw new DhlLabelError(400, "INVALID_INPUT", e.message); }
 const weightGrams = input.weightGrams;
    // Das gewählte Vertragsprodukt darf nur für sein tatsächlich hinterlegtes
    // Zielland und innerhalb der serverseitigen Gewichtsgrenze verwendet werden.
    // Die Prüfung bleibt bewusst im Backend, damit sie nicht über einen direkten
    // API-Aufruf oder eine veraltete Browseransicht umgangen werden kann.
    const rawDestinationCountry = String(order.country ?? (order as any).shippingCountry ?? "").trim();
    const destinationCountry = alpha3ToAlpha2[normalizeCountryToAlpha3(rawDestinationCountry)] ?? rawDestinationCountry.toUpperCase();
    if (!activeProfile.countries.includes(destinationCountry)) {
      throw new DhlLabelError(422, "INVALID_INPUT", `Versandprofil \"${activeProfile.label}\" ist für das Zielland ${destinationCountry || "ohne Länderangabe"} nicht zulässig.`);
    }

    // Ein fehlender Gewichtsdatensatz darf niemals das Profil-Maximum als Sendungsgewicht
    // an DHL übergeben. Bei CH ist ausschließlich das zuvor gespeicherte, tatsächliche
    // Paketgewicht zulässig; Browserwerte werden bewusst nicht akzeptiert.
    let swissCustoms: { declaration: ValidatedSwissCustomsDeclaration; invoice: SwissCommercialInvoice } | null = null;
    if (profileKey === "DHL_CH") {
      try {
        swissCustoms = await loadSwissCustomsForLabel(order, poolProvider);
      } catch (error: any) {
        throw new DhlLabelError(422, "INVALID_INPUT", error.message || "Schweizer Zolldaten sind unvollständig.");
      }
    }
    const requestedWeightG = profileKey === "DHL_CH"
      ? swissCustoms!.declaration.packageWeightGrams
      : Number(weightGrams ?? (order as any).weightGrams ?? 1000);
    if (!Number.isFinite(requestedWeightG) || requestedWeightG <= 0) {
      throw new DhlLabelError(422, "INVALID_INPUT", "Gewicht für die DHL-Sendung fehlt oder ist ungültig.");
    }
    if (requestedWeightG > activeProfile.maxWeightG) {
      throw new DhlLabelError(422, "INVALID_INPUT", `${activeProfile.label} erlaubt maximal ${activeProfile.maxWeightG} g; angegeben sind ${requestedWeightG} g. Bitte DHL Paket Standard wählen.`);
    }

    // ── Adress-Validierung vor DHL-Call ──────────────────────────────────────
    // Normalisiere Land: "Deutschland", "Germany", "DEU", "de" → "DE"
    const normalizeCountry = (raw: string | null | undefined): string => {
      if (!raw) return "";
      const s = raw.trim().toUpperCase();
      if (s === "DEUTSCHLAND" || s === "GERMANY" || s === "DEU" || s === "DE") return "DE";
      return raw.trim();
    };
    // ── DHL-Abholort-Erkennung ────────────────────────────────────────────────
    // Prüft delivery_type aus DB ODER erkennt "Packstation" im street-Feld (Fallback)
    // Drei Erkennungswege (OR-Logik, alle idempotent):
    // 1. delivery_type = "packstation" (gesetzt beim Checkout)
    // 2. street-Feld enthaelt "Packstation" (manuell eingetragen oder aeltere Bestellungen)
    // 3. dhlPostNumber vorhanden + street leer (WaWi-Kunden mit Packstation-Nr. in houseNumber)
    const dhlPostNumberRaw = ((order as any).dhlPostNumber ?? "").trim();
    const isPackstation =
      (order as any).deliveryType === "packstation" ||
      /^packstation\b/i.test((order.street ?? "").trim()) ||
      (!!dhlPostNumberRaw && !(order.street ?? "").trim());
    const isPostfiliale =
      (order as any).deliveryType === "postfiliale" ||
      /^postfiliale\b/i.test((order.street ?? "").trim());

    const consignee: DhlConsignee = {
      name1:         `${order.firstName} ${order.lastName}`.trim(),
      addressStreet: order.street,
      addressHouse:  order.houseNumber,
      postalCode:    (order.zip ?? "").trim(), // trim() verhindert DHL-Fehler bei PLZ mit Leerzeichen
      city:          order.city,
      // DE: normalisiert auf "DE"; EU: Rohwert – normalizeCountryToAlpha3 läuft in createDhlShipmentEU
      country:       profileKey === "DHL_DE_STANDARD" ? normalizeCountry(order.country) : (order.country ?? ""),
      email:         order.email ?? undefined,
      phone:         order.phone ?? undefined,
    };

    if (profileKey === "DHL_DE_ECONOMY" && (isPackstation || isPostfiliale)) {
      throw new DhlLabelError(422, "INVALID_INPUT", "DHL Kleinpaket ist nicht für Packstation- oder Postfilial-Adressen zulässig. Bitte DHL Paket Standard wählen.");
    }

    if (isPackstation || isPostfiliale) {
      // DHL-Abholort-Adressformat:
      //   name1 = Kundenname
      //   name2 = DHL-Postnummer (Pflichtfeld)
      //   addressStreet = "Packstation" oder "Postfiliale"
      //   addressHouse  = Standortnummer
      const dhlPostNumber = dhlPostNumberRaw; // bereits oben aus order gelesen
      if (!dhlPostNumber) {
        // Sicherheitsnetz: Wenn keine Postnummer hinterlegt, Label-Erstellung blockieren
        throw new DhlLabelError(422, "INVALID_INPUT", `${isPostfiliale ? "Postfilial" : "Packstation"}-Lieferung: DHL-Postnummer fehlt. Bitte Bestellung manuell prüfen.`);
      }
      const pickupLocationLabel = isPostfiliale ? "Postfiliale" : "Packstation";
      consignee.addressStreet = pickupLocationLabel;
      // Standortnummer: aus houseNumber ODER aus street-Feld parsen.
      let pickupLocationNr = (order.houseNumber ?? "").trim();
      if (!pickupLocationNr) {
        // Fallback: street-Feld parsen → "Packstation 135 118" → erster Token nach "Packstation" ist die Nr.
        const streetParts = (order.street ?? "").trim().split(/\s+/);
        if (streetParts.length >= 2) pickupLocationNr = streetParts[1];
      }
      consignee.addressHouse = pickupLocationNr || "";
      // name2 = Postnummer (DHL-Pflichtfeld)
      consignee.name2 = dhlPostNumber.slice(0, 20);
      console.log(`[dhlRouter] ${pickupLocationLabel}-Lieferung: ${pickupLocationLabel} ${pickupLocationNr}, Post-Nr. ${dhlPostNumber}`);
    } else if (order.company?.trim()) {
      // Firmenname als name1 wenn vorhanden, Personenname dann in name2
      const fullName = `${order.firstName} ${order.lastName}`.trim();
      consignee.name1 = order.company.trim().slice(0, 50);
      if (fullName) consignee.name2 = fullName.slice(0, 50);
    }

    const validationError = validateConsignee(consignee);
    if (validationError) {
      throw new DhlLabelError(422, "INVALID_INPUT", validationError);
    }


 const shipmentInput = {
  orderId: order.orderId, consignee, weightGrams: requestedWeightG,
  productCode: activeProfile.product, billingNumber: activeProfile.billingNumber!,
  ...(swissCustoms ? {swissCustoms: swissCustoms.declaration} : {}),
 };
 return {profileKey, swissCustoms, shipmentInput};
}
export type PreparedDhlLabel = Awaited<ReturnType<typeof prepareDhlLabel>>;
export async function requestDhlLabel(prepared: PreparedDhlLabel) {
 return prepared.profileKey === "DHL_CH" ? createDhlShipmentCH(prepared.shipmentInput)
  : prepared.profileKey === "DHL_EU" ? createDhlShipmentEU(prepared.shipmentInput)
  : createDhlShipmentDE(prepared.shipmentInput);
}
/** Same CH/Vretti builders as the original create route, no changes to formats/scaling. */
export async function buildDhlLabelDocuments(prepared: PreparedDhlLabel, result: DhlShipmentResult) {
 const {profileKey, swissCustoms} = prepared;
 let labelContent = result.labelBase64 ?? null;
 const customsDocContent = result.customsDocBase64 ?? null;
 let commercialInvoiceContent: string | null = null;
 let customsPrintContent: string | null = null;
 if (profileKey === "DHL_CH") {
  if (!labelContent || !customsDocContent || !swissCustoms) throw Error(result.error || "DHL-Label, CN23 oder Zolldaten fehlen");
  const commercialInvoice = await buildSwissCommercialInvoicePdf({invoice:swissCustoms.invoice});
  commercialInvoiceContent = Buffer.from(commercialInvoice).toString("base64");
  const customsPrintPackage = await buildSwissCustomsDocumentsPdf({customsDocPdfBase64:customsDocContent,invoice:swissCustoms.invoice});
  customsPrintContent = Buffer.from(customsPrintPackage).toString("base64");
  const thermalLabelPackage = await buildSwissThermalLabelPackagePdf({shippingLabelPdfBase64:labelContent,customsDocPdfBase64:customsDocContent});
  labelContent = Buffer.from(thermalLabelPackage).toString("base64");
 }
 return {labelContent,customsDocContent,commercialInvoiceContent,customsPrintContent};
}
