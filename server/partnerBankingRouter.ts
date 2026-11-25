import { TRPCError } from '@trpc/server';
import type { Request } from 'express';
import type { z } from 'zod';
import { router, publicProcedure, adminProcedure, middleware } from './trpc.js';
import { getAuthenticatedPartnerFromRequest } from './partnerAuth.js';
import { hasBearerAuthorization, cookieRequestIsTrusted } from './requestSecurity.js';
import { partnerBankSaveInput, partnerBankAdminGetInput, partnerBankMineInput } from './partnerBankingContract.js';
import { bankingOperation, partnerBankingReady, readOwnPartnerBankAccount, saveOwnPartnerBankAccount, readAdminPartnerBankAccount } from './partnerBankingService.js';

function safeBankInput<T extends z.ZodTypeAny>(schema: T) {
  return {
    _input: undefined as unknown as z.input<T>,
    _output: undefined as unknown as z.output<T>,
    parse(value: unknown): z.output<T> {
      const result = schema.safeParse(value);
      if (!result.success) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Bitte die Bankangaben und das aktuelle Passwort prüfen.' });
      return result.data;
    },
  };
}
// First middleware, including rejected auth/input requests. No plaintext cache.
const bankTransport = middleware(({ ctx, next }) => {
  ctx.res.setHeader('Cache-Control', 'private, no-store');
  ctx.res.setHeader('Pragma', 'no-cache');
  const bearer = hasBearerAuthorization(ctx.req);
  const ambient = /(?:^|;\s*)(?:369_session|369_partner_session)=/.test(ctx.req.headers.cookie || '');
  if (!bearer && ambient && !cookieRequestIsTrusted(ctx.req)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Ungültiger Ursprung der Sitzung.' });
  }
  // Bearer always selects its own principal, never an ambient cookie fallback.
  const req = bearer ? { ...ctx.req, headers: { ...ctx.req.headers, cookie: undefined } } as Request : ctx.req;
  return next({ ctx: { ...ctx, req } });
});
const bankProcedure = publicProcedure.use(bankTransport);
const ownBankProcedure = bankProcedure.use(middleware(async ({ ctx, next }) => {
  const partner = await bankingOperation(() => getAuthenticatedPartnerFromRequest(ctx.req));
  if (!partner) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Partner-Login erforderlich.' });
  return next({ ctx: { ...ctx, partner } });
}));
export const partnerBankingRouter = router({
  ready: bankProcedure.input(safeBankInput(partnerBankMineInput)).query(() => bankingOperation(partnerBankingReady)),
  mine: ownBankProcedure.input(safeBankInput(partnerBankMineInput)).query(({ ctx }) => bankingOperation(() => readOwnPartnerBankAccount(ctx.partner))),
  save: ownBankProcedure.input(safeBankInput(partnerBankSaveInput)).mutation(({ ctx, input }) => bankingOperation(() => saveOwnPartnerBankAccount(ctx.req, ctx.partner, input))),
  // concat keeps existing exact-role adminProcedure (not product_manager/scoped
  // account grants), with bank no-store/origin checks preceding role errors.
  adminGet: bankProcedure.concat(adminProcedure).input(safeBankInput(partnerBankAdminGetInput)).query(({ input }) => bankingOperation(() => readAdminPartnerBankAccount(input.partnerId))),
});
