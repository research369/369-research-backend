export const LADYPEPS_CONTRACT_VERSION = "2026-09-v0.1" as const;

export const LADYPEPS_PRODUCT_FORMS = [
  "base_vial",
  "diy_nasal",
  "finished_nasal",
  "plug_play",
  "mix_and_go",
] as const;

export type LadypepsProductForm = (typeof LADYPEPS_PRODUCT_FORMS)[number];
export type LadypepsFormApproval = "enabled" | "requires_variant_approval";

export type LadypepsFormPolicy = {
  form: LadypepsProductForm;
  approval: LadypepsFormApproval;
  priceSurcharge: number | null;
  requiresColdChain: boolean;
  includedComponents: string[];
  fulfillmentFlags: string[];
  label: string;
};

export type LadypepsProductPolicy = {
  productId: string;
  forms: LadypepsFormPolicy[];
};

const baseVial: LadypepsFormPolicy = {
  form: "base_vial", approval: "enabled", priceSurcharge: 0, requiresColdChain: false,
  includedComponents: [], fulfillmentFlags: ["ships_as_vial"], label: "Basis-Vial",
};
const diyNasal: LadypepsFormPolicy = {
  form: "diy_nasal", approval: "enabled", priceSurcharge: 7, requiresColdChain: false,
  includedComponents: ["BAC Wasser 10 ml", "Leere Nasensprayflasche", "10-ml-Aufziehspritze + Kanüle"],
  fulfillmentFlags: ["ships_as_vial", "assemble_diy_nasal_set"], label: "Vial + DIY-Nasenspray-Set",
};
const finishedNasal: LadypepsFormPolicy = {
  form: "finished_nasal", approval: "enabled", priceSurcharge: 15, requiresColdChain: true,
  includedComponents: ["BAC Wasser 10 ml", "Fertig gemischt und abgefüllt"],
  fulfillmentFlags: ["pre_mixed_nasal", "requires_cold_chain"], label: "Fertig gemischtes Nasenspray",
};
const plugPlay: LadypepsFormPolicy = {
  form: "plug_play", approval: "requires_variant_approval", priceSurcharge: 15, requiresColdChain: true,
  includedComponents: ["BAC Wasser 3 ml", "Fertig gemischte Patrone"],
  fulfillmentFlags: ["pre_mixed_cartridge", "requires_cold_chain"], label: "Plug&Play-Patrone",
};
const mixAndGo: LadypepsFormPolicy = {
  form: "mix_and_go", approval: "requires_variant_approval", priceSurcharge: null, requiresColdChain: false,
  includedComponents: [], fulfillmentFlags: ["ships_as_vial", "customer_mix"], label: "Mix&Go",
};

export const LADYPEPS_PRODUCT_POLICIES: LadypepsProductPolicy[] = [
  { productId: "pt-141", forms: [baseVial, diyNasal, finishedNasal, plugPlay, mixAndGo] },
  { productId: "kisspeptin-10", forms: [baseVial, diyNasal, finishedNasal, plugPlay, mixAndGo] },
  ...["oxytocin", "selank", "semax", "semax-selank", "adamax"].map((productId) => ({
    productId, forms: [baseVial, diyNasal, finishedNasal],
  })),
];

export function getLadypepsProductPolicy(productId: string): LadypepsProductPolicy | null {
  return LADYPEPS_PRODUCT_POLICIES.find((policy) => policy.productId === productId) || null;
}

