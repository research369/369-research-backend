import { Router } from "express";
import { timingSafeEqual, createHash } from "node:crypto";
import { z } from "zod";
import { WhatsappOrderService } from "./whatsappOrderService.js";
export function createWhatsappOrderRouter(
  service: WhatsappOrderService,
  keys: { read: string; write: string; owner: string },
  verifyOwner: (
    receipt: string,
  ) => Promise<{
    user: string;
    chat: string;
    private_chat: boolean;
    callback_verified: boolean;
  }>,
) {
  if (
    new Set(Object.values(keys)).size !== 3 ||
    Object.values(keys).some((k) => k.length < 40)
  )
    throw Error("separate_keys_required");
  const router = Router();
  const limits = new Map<string, { start: number; count: number }>();
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    const wanted =
      req.path === "/catalog/search"
        ? keys.read
        : req.path === "/owner-approvals"
          ? keys.owner
          : keys.write;
    const supplied = req.get("authorization") ?? "",
      expected = "Bearer " + wanted;
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
    ) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    if (req.method !== "POST" || Object.keys(req.query).length) {
      res.status(405).json({ error: "unsupported" });
      return;
    }
    const now = Date.now(),
      bucket = createHash("sha256").update(wanted).digest("hex");
    const conversation =
      typeof req.body?.bot_conversation_id === "string"
        ? req.body.bot_conversation_id
        : typeof req.body?.quote_id === "string"
          ? req.body.quote_id
          : "";
    for (const key of [bucket, bucket + ":" + conversation]) {
      const old = limits.get(key);
      if (!old || now - old.start > 60000)
        limits.set(key, { start: now, count: 1 });
      else if (++old.count > (key === bucket ? 60 : 10)) {
        res.status(429).json({ error: "rate_limited" });
        return;
      }
    }
    if (limits.size > 10000)
      for (const [k, v] of limits) if (now - v.start > 60000) limits.delete(k);
    next();
  });
  router.post("/:operation(*)", async (req: any, res) => {
    try {
      const tenant = "phase1-bot";
      switch (req.params.operation) {
        case "catalog/search":
          res.json(await service.search(req.body));
          break;
        case "quote":
          res.json(await service.quote(tenant, req.body));
          break;
        case "execute":
          res.json(await service.execute(tenant, req.body));
          break;
        case "status": {
          const b = z
            .object({ execution_id: z.string().uuid() })
            .strict()
            .parse(req.body);
          res.json(await service.status(tenant, b.execution_id));
          break;
        }
        case "owner-approvals": {
          const b = z
            .object({
              quote_id: z.string().uuid(),
              quote_hash: z.string().regex(/^[a-f0-9]{64}$/),
              quote_revision: z.number().int().positive(),
              callback_receipt: z.string().min(16).max(1000),
            })
            .strict()
            .parse(req.body);
          const verified = await verifyOwner(b.callback_receipt);
          res.json(await service.approveOwner(tenant, { ...b, ...verified }));
          break;
        }
        default:
          res.status(405).json({ error: "unsupported" });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "";
      const allowed =
        /^(stock_changed|quote_stale|quote_mismatch|both_approvals_required|quote_already_executed|intent_already_executed|idempotency_conflict|owner_not_authorized|approval_mismatch|unsupported_catalog_item|delivery_type_not_allowed_for_cart|customer_review_required|promotion_changed|invalid_catalog_item)$/;
      res
        .status(409)
        .json({
          error: allowed.test(message)
            ? message
            : "invalid_or_unavailable_request",
        });
    }
  });
  return router;
}
