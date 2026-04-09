/**
 * App Router – combines all sub-routers into one tRPC router
 */
import { router } from "./trpc.js";
import { orderRouter } from "./orderRouter.js";
import { articleRouter } from "./articleRouter.js";
import { customerRouter } from "./customerRouter.js";
import { labelRouter } from "./labelRouter.js";
import { partnerRouter } from "./partnerRouter.js";

export const appRouter = router({
  order: orderRouter,
  article: articleRouter,
  customer: customerRouter,
  label: labelRouter,
  partner: partnerRouter,
});

export type AppRouter = typeof appRouter;
