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
});

export type AppRouter = typeof appRouter;
