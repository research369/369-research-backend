import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { Request, Response } from "express";

export interface Context {
  req: Request;
  res: Response;
  user: {
    id: number;
    username: string;
    name: string | null;
    email: string | null;
    role: string;
  } | null;
}

const t = initTRPC.context<Context>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;
export const middleware = t.middleware;

const isAuthed = middleware(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Bitte anmelden" });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

const isAdmin = middleware(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Bitte anmelden" });
  }
  if (ctx.user.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Keine Berechtigung" });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

export const protectedProcedure = t.procedure.use(isAuthed);
export const adminProcedure = t.procedure.use(isAdmin);

// Product Manager: role = "admin" OR role = "product_manager"
// Kein Zugriff auf orders, customers, invoices, payments, checkout, users, migrations
const isProductManager = middleware(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Bitte anmelden" });
  }
  if (ctx.user.role !== "admin" && ctx.user.role !== "product_manager") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Keine Berechtigung – product_manager oder admin erforderlich" });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

export const productManagerProcedure = t.procedure.use(isProductManager);

// Packing: role = "admin" OR role = "packing"
// Zugriff auf: Bestellungen, Labels, Kunden, Artikel (lesen+Bestand), Rechnungen, Eingang
// KEIN Zugriff auf: Artikel anlegen, Partner anlegen, Benutzer anlegen
const isPacking = middleware(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Bitte anmelden" });
  }
  if (ctx.user.role !== "admin" && ctx.user.role !== "packing") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Keine Berechtigung" });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

export const packingProcedure = t.procedure.use(isPacking);
