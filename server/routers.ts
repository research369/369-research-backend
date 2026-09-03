/**
 * App Router – combines all sub-routers into one tRPC router
 */
import { router } from "./trpc.js";
import { orderRouter } from "./orderRouter.js";
import { articleRouter } from "./articleRouter.js";
import { customerRouter } from "./customerRouter.js";
import { labelRouter } from "./labelRouter.js";
import { partnerRouter } from "./partnerRouter.js";
import { aiRouter } from "./aiRouter.js";
import { promoCodeRouter } from "./promoCodeRouter.js";
import { shopSettingsRouter } from "./shopSettingsRouter.js";
import { invoiceRouter } from "./invoiceRouter.js";
import { totpRouter } from "./totpRouter.js";
import { purchaseOrderRouter } from "./purchaseOrderRouter.js";
import { followUpRouter } from "./followUpRouter.js";
import { productAdminRouter } from "./productAdminRouter.js";
import { bundleRouter } from "./bundleRouter.js";
import { substitutionRouter } from "./substitutionRouter.js";
// KWK-Modul (Kunden-werben-Kunden) – isoliert, additiv
import { kwkRouter } from "./kwkRouter.js";
import { crmCommunicationRouter } from "./crmCommunicationRouter.js";
import { customerIntegrityRouter } from "./customerIntegrityRouter.js";
import { communicationTemplateRouter } from "./communicationTemplateRouter.js";
import { addressValidationRouter } from "./addressValidationRouter.js";
import { customerDossierRouter } from "./customerDossierRouter.js";
import { qrCampaignRouter } from "./qrCampaignRouter.js";
import { ladypepsChannelRouter } from "./ladypepsChannelRouter.js";

export const appRouter = router({
  order: orderRouter,
  article: articleRouter,
  customer: customerRouter,
  label: labelRouter,
  partner: partnerRouter,
  ai: aiRouter,
  promoCode: promoCodeRouter,
  shopSettings: shopSettingsRouter,
  invoice: invoiceRouter,
  totp: totpRouter,
  purchaseOrder: purchaseOrderRouter,
  followUp: followUpRouter,
  productAdmin: productAdminRouter,
  bundle: bundleRouter,
  substitution: substitutionRouter,
  kwk: kwkRouter, // KWK-Modul: Kunden-werben-Kunden
  crmCommunication: crmCommunicationRouter,
  customerIntegrity: customerIntegrityRouter,
  communicationTemplate: communicationTemplateRouter,
  addressValidation: addressValidationRouter,
  customerDossier: customerDossierRouter,
  qrCampaign: qrCampaignRouter,
  ladypeps: ladypepsChannelRouter,
});

export type AppRouter = typeof appRouter;
