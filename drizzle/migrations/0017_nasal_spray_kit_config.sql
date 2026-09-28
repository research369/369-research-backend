-- Versionierter Nasenspray-Kit-Vertrag.
-- Quelle der Geschäftsregeln: WaWi-Shop-Einstellung, nicht Frontend-/Checkout-Code.
-- Bestehende Konfigurationen werden bewusst nicht überschrieben.

INSERT INTO shop_settings (key, value)
VALUES (
  'nasal_spray_kit_config_v2',
  '{
    "version": 2,
    "displayName": "Nasenspray Kit",
    "surcharge": 7,
    "products": [
      {"shopProductId": "adamax", "nasalKitEligible": true, "injectable": false},
      {"shopProductId": "selank", "nasalKitEligible": true, "injectable": false},
      {"shopProductId": "semax", "nasalKitEligible": true, "injectable": false},
      {"shopProductId": "semax-selank", "nasalKitEligible": true, "injectable": false},
      {"shopProductId": "oxytocin", "nasalKitEligible": true, "injectable": false},
      {"shopProductId": "pt-141", "nasalKitEligible": true, "injectable": true},
      {"shopProductId": "kisspeptin-10", "nasalKitEligible": true, "injectable": true}
    ],
    "components": [
      {
        "name": "Nasenspray Kit · BAC Wasser 10 ml",
        "variant": "10 ml · enthalten",
        "articleShopProductId": "bac-wasser",
        "inventoryTracked": true,
        "quantityPerKit": 1
      },
      {
        "name": "Nasenspray Kit · Leere Nasensprayflasche",
        "variant": "enthalten",
        "inventoryTracked": false,
        "quantityPerKit": 1
      },
      {
        "name": "Nasenspray Kit · 10-ml-Aufziehspritze + Kanüle",
        "variant": "enthalten",
        "inventoryTracked": false,
        "quantityPerKit": 1
      }
    ]
  }'
)
ON CONFLICT (key) DO NOTHING;
