import { TRPCError } from '@trpc/server';
import type { z } from 'zod';
import { router, publicProcedure, adminProcedure } from './trpc.js';
import { enforceAuthRateLimit } from './accountSecurityService.js';
import { BEN_INVITATION_INFO, partnerInvitationSubmitInput, partnerInvitationStatusInput, partnerInvitationReviewInput } from './partnerInvitationContract.js';
import { submitPartnerInvitation, partnerInvitationStatus, pendingPartnerInvitations, approvePartnerInvitation, rejectPartnerInvitation } from './partnerInvitationService.js';

// Keep strict Zod parsing and inferred input/output types, but never expose Zod's
// received values (e.g. forged literal values or unknown field names) to logs.
function safeInvitationInput<T extends z.ZodTypeAny>(schema: T) {
  return {
    _input: undefined as unknown as z.input<T>,
    _output: undefined as unknown as z.output<T>,
    parse(value: unknown): z.output<T> {
      const result = schema.safeParse(value);
      if (!result.success) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Bitte die Einladungsangaben, Zustimmung und Passwörter prüfen.' });
      return result.data;
    },
  };
}
// DB errors can contain submitted values. Never propagate/log their text or cause.
async function invitationOperation<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof TRPCError) throw error;
    throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'Einladungsservice vorübergehend nicht verfügbar. Bitte später erneut versuchen.' });
  }
}
export const partnerInvitationRouter = router({
  info: publicProcedure.query(() => BEN_INVITATION_INFO),
  submit: publicProcedure.input(safeInvitationInput(partnerInvitationSubmitInput)).mutation(({ input, ctx }) => invitationOperation(async () => {
    await enforceAuthRateLimit(ctx.req, 'partner.invitation.submit', input.email);
    return submitPartnerInvitation(input);
  })),
  // Mutation by transport only; status is read-only. Prevents secrets in GET URLs.
  status: publicProcedure.input(safeInvitationInput(partnerInvitationStatusInput)).mutation(({ input, ctx }) => invitationOperation(async () => {
    await enforceAuthRateLimit(ctx.req, 'partner.invitation.status', input.registrationKey);
    return partnerInvitationStatus(input.registrationKey);
  })),
  pending: adminProcedure.query(() => invitationOperation(pendingPartnerInvitations)),
  approve: adminProcedure.input(safeInvitationInput(partnerInvitationReviewInput)).mutation(({ input, ctx }) => invitationOperation(() => approvePartnerInvitation(input.id, ctx.user.username))),
  reject: adminProcedure.input(safeInvitationInput(partnerInvitationReviewInput)).mutation(({ input, ctx }) => invitationOperation(() => rejectPartnerInvitation(input.id, ctx.user.username))),
});
