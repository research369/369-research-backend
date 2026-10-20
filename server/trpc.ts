import {checkCustomerCreationMaintenance} from './customerCreationMaintenance.js';
import {getPool} from './db.js';
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { Request, Response } from "express";

export interface Context {
  /** Internal diagnostic principal only. Never accepted in a public request. */
  operationsPreview?: {partnerId?:number;kwkCreditAccountId?:number};
  jarvyOrder?: import('./jarvyOrderContract.js').JarvyOrderContext;
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
const creationGuard=t.middleware(async ({path,type,next})=>{
 if(type==='mutation'&&['order.create','customer.create','customer.backfillFromOrders'].includes(path))await checkCustomerCreationMaintenance(path,type,await getPool());
 return next();
});
const guardedProcedure=t.procedure.use(creationGuard);
export const publicProcedure = guardedProcedure;
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

export const protectedProcedure = guardedProcedure.use(isAuthed);
export const adminProcedure = guardedProcedure.use(isAdmin);

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

// Goodies: product managers maintain the catalog while packing users assign
// items to orders. Neither role receives unrelated financial or user access.
const isGoodieOperator = middleware(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Bitte anmelden" });
  }
  if (!["admin", "product_manager", "packing"].includes(ctx.user.role)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Keine Berechtigung für Goodies" });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

export const goodieProcedure = t.procedure.use(isGoodieOperator);

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
