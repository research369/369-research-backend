import { adminProcedure, router } from './trpc.js';
import { screenshotCustomersInputSchema, screenshotCatalogInputSchema, screenshotQuoteInputSchema, screenshotExecuteInputSchema, screenshotDraftInputSchema } from './screenshotOrderContract.js';
import { lookupScreenshotCustomers, lookupScreenshotCatalog, quoteScreenshotOrder, executeScreenshotOrder, statusScreenshotOrder, resultScreenshotOrder, prepareScreenshotOrderMessage, screenshotSafeError } from './screenshotOrderService.js';
import { screenshotExtractionInputSchema, extractScreenshotOrder, getScreenshotExtractionCapabilities, ScreenshotExtractionError } from './screenshotOrderExtraction.js';
import { TRPCError } from '@trpc/server';
const procedure=adminProcedure.use(({ctx,next})=>{ctx.res?.setHeader?.('Cache-Control','no-store, private');ctx.res?.setHeader?.('Pragma','no-cache');return next();});
async function safe<T>(work:()=>Promise<T>):Promise<T>{try{return await work();}catch(e){return screenshotSafeError(e);}}
export const screenshotOrderRouter=router({
  capabilities:procedure.query(()=>getScreenshotExtractionCapabilities()),
  extract:procedure.input(screenshotExtractionInputSchema).mutation(async({input,ctx})=>{
    try{return await extractScreenshotOrder(input,ctx.user!.id);}catch(e){throw new TRPCError({code:'PRECONDITION_FAILED',message:e instanceof ScreenshotExtractionError?e.message:'SCREENSHOT_EXTRACTION_UNAVAILABLE'});}
  }),
  // POST keeps contact/customer data out of query URLs and proxy access logs.
  customers:procedure.input(screenshotCustomersInputSchema).mutation(({input})=>safe(()=>lookupScreenshotCustomers(input))),
  catalog:procedure.input(screenshotCatalogInputSchema).query(({input})=>safe(()=>lookupScreenshotCatalog(input))),
  quote:procedure.input(screenshotQuoteInputSchema).mutation(({input,ctx})=>safe(()=>quoteScreenshotOrder(input,ctx))),
  execute:procedure.input(screenshotExecuteInputSchema).mutation(({input,ctx})=>safe(()=>executeScreenshotOrder(input.quoteToken,ctx))),
  status:procedure.input(screenshotDraftInputSchema).query(({input,ctx})=>statusScreenshotOrder(input.draftId,ctx.user!.id)),
  prepareMessage:procedure.input(screenshotDraftInputSchema).mutation(({input,ctx})=>safe(()=>prepareScreenshotOrderMessage(input.draftId,ctx))),
  result:procedure.input(screenshotDraftInputSchema).query(({input,ctx})=>safe(()=>resultScreenshotOrder(input.draftId,ctx))),
});
