import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { orders } from "../drizzle/schema.js";
import { getPool } from "./db.js";
import { DhlLabelError, recipientFromOrder, type LabelGeneration, type LabelOperation, type LabelSession, type LabelStore } from "./dhlRelabelService.js";

export class PgDhlLabelStore implements LabelStore {
  constructor(private poolProvider: typeof getPool = getPool) {}
  async withOrder<T>(orderId: string, work: (session: LabelSession) => Promise<T>): Promise<T> {
    const pool = await this.poolProvider();
    if (!pool) throw new DhlLabelError(503,"DATABASE_UNAVAILABLE","Datenbank nicht verfügbar");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Row locks protect all creation/cancellation paths across server instances.
      const locked = await client.query("SELECT order_id FROM orders WHERE order_id=$1 FOR UPDATE",[orderId]);
      if (!locked.rowCount) throw new DhlLabelError(404,"ORDER_NOT_FOUND","Bestellung nicht gefunden");
      const [order] = await drizzle(client).select().from(orders).where(eq(orders.orderId,orderId)).limit(1);
      const gr = await client.query("SELECT * FROM dhl_label_generations WHERE order_id=$1 ORDER BY generation",[orderId]);
      const or = await client.query("SELECT * FROM dhl_label_operations WHERE order_id=$1 ORDER BY created_at",[orderId]);
      const generations = gr.rows.map((r):LabelGeneration=>({id:r.id,generation:r.generation,state:r.state,trackingNumber:r.tracking_number,shippingProfile:r.shipping_profile,recipient:r.recipient_snapshot,request:r.request_snapshot,orderSnapshot:r.order_snapshot,labelContent:r.label_content,originalLabelContent:r.original_label_content,customsDocContent:r.customs_document_content,commercialInvoiceContent:r.commercial_invoice_content,customsPrintContent:r.customs_print_content,priorLabelUrl:r.prior_label_url,reason:r.reason,actor:r.actor,cancellationSource:r.cancellation_source,createdAt:r.created_at,updatedAt:r.updated_at}));
      const operations = or.rows.map((r):LabelOperation=>({id:r.id,generationId:r.generation_id,idempotencyKey:r.idempotency_key,requestHash:r.request_hash,kind:r.kind,state:r.state,actor:r.actor,reason:r.reason,result:r.result,createdAt:r.created_at,finishedAt:r.finished_at}));
      const session: LabelSession = {
        order,generations,operations,
        async saveGeneration(g) {
          await client.query(`INSERT INTO dhl_label_generations(id,order_id,generation,state,tracking_number,shipping_profile,recipient_snapshot,request_snapshot,order_snapshot,label_content,original_label_content,customs_document_content,commercial_invoice_content,customs_print_content,prior_label_url,reason,actor,cancellation_source,created_at,updated_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
            ON CONFLICT(id) DO UPDATE SET state=EXCLUDED.state,tracking_number=EXCLUDED.tracking_number,label_content=EXCLUDED.label_content,original_label_content=EXCLUDED.original_label_content,customs_document_content=EXCLUDED.customs_document_content,commercial_invoice_content=EXCLUDED.commercial_invoice_content,customs_print_content=EXCLUDED.customs_print_content,cancellation_source=EXCLUDED.cancellation_source,updated_at=EXCLUDED.updated_at`,
            [g.id,orderId,g.generation,g.state,g.trackingNumber,g.shippingProfile,g.recipient,g.request,g.orderSnapshot,g.labelContent,g.originalLabelContent,g.customsDocContent,g.commercialInvoiceContent,g.customsPrintContent,g.priorLabelUrl,g.reason,g.actor,g.cancellationSource,g.createdAt,g.updatedAt]);
          const index=generations.findIndex(v=>v.id===g.id); if(index<0)generations.push(g);else generations[index]=g;
        },
        async saveOperation(o) {
          await client.query(`INSERT INTO dhl_label_operations(id,order_id,generation_id,idempotency_key,request_hash,kind,state,actor,reason,result,created_at,finished_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
            ON CONFLICT(id) DO UPDATE SET state=EXCLUDED.state,result=EXCLUDED.result,finished_at=EXCLUDED.finished_at`,
            [o.id,orderId,o.generationId,o.idempotencyKey,o.requestHash,o.kind,o.state,o.actor,o.reason,o.result,o.createdAt,o.finishedAt]);
          const index=operations.findIndex(v=>v.id===o.id);if(index<0)operations.push(o);else operations[index]=o;
        },
        async markNormalCreatePending() {
          const updated=await client.query("UPDATE orders SET tracking_carrier='DHL_PENDING' WHERE order_id=$1 AND tracking_number IS NULL AND shipping_label_url IS NULL AND tracking_carrier IS NULL",[orderId]);
          if(updated.rowCount!==1)throw new DhlLabelError(409,"LABEL_CONFLICT","Label-Erstellung bereits gesperrt");
        },
        async releaseRejectedNormalCreate() {
          await client.query("UPDATE orders SET tracking_carrier=NULL WHERE order_id=$1 AND tracking_number IS NULL AND shipping_label_url IS NULL AND tracking_carrier='DHL_PENDING'",[orderId]);
        },
        async publishLabel(g) {
          if(g.commercialInvoiceContent) {
            const stored=await client.query(`UPDATE order_swiss_customs_declarations SET commercial_invoice_content=$1,commercial_invoice_generated_at=NOW(),customs_print_content=$2,customs_print_generated_at=NOW(),updated_at=NOW() WHERE order_id=$3`,[g.commercialInvoiceContent,g.customsPrintContent,orderId]);
            if(stored.rowCount!==1)throw Error("Schweizer Zollunterlagen konnten nicht zugeordnet werden");
          }
          // Intentionally ONLY label/tracking fields. No timestamps, address, status or communication.
          await client.query(`UPDATE orders SET tracking_number=$1,tracking_carrier='DHL',shipping_label_url=$2,shipping_label_content=$3 WHERE order_id=$4`,[g.trackingNumber,`/api/shipping/dhl/label/${orderId}`,g.labelContent,orderId]);
        },
      };
      if(!generations.length && (order.trackingNumber || order.shippingLabelUrl) && (order.trackingCarrier==="DHL" || String(order.shippingLabelUrl).startsWith("/api/shipping/dhl/label/"))) {
        const customs = await client.query("SELECT commercial_invoice_content,customs_print_content FROM order_swiss_customs_declarations WHERE order_id=$1",[orderId]);
        await session.saveGeneration({id:randomUUID(),generation:1,state:order.deliveredAt?"delivered":"active",trackingNumber:order.trackingNumber,shippingProfile:null,recipient:recipientFromOrder(order),request:{legacy:true,originalRecipientUnverified:true},orderSnapshot:order,labelContent:order.shippingLabelContent,originalLabelContent:order.shippingLabelContent,customsDocContent:null,commercialInvoiceContent:customs.rows[0]?.commercial_invoice_content??null,customsPrintContent:customs.rows[0]?.customs_print_content??null,priorLabelUrl:order.shippingLabelUrl,reason:"Legacy-Label vor Storno unverändert archiviert; tatsächliche ursprüngliche DHL-Adresse nicht nachweisbar",actor:"system:legacy_archive",cancellationSource:null,createdAt:new Date(),updatedAt:new Date()});
      }
      const result=await work(session);
      await client.query("COMMIT");
      return result;
    } catch(error) {await client.query("ROLLBACK").catch(()=>{});throw error;} finally {client.release();}
  }
}
