import { eq } from 'drizzle-orm';
import { orders, orderItems } from '../drizzle/schema.js';
import { readCrmOrderContext } from './crmOrderCustomerService.js';
import { htmlToPlainText } from './crmCommunicationService.js';
import { escapeOrderMessageHtml, type OrderDiscountMessageSnapshot } from './orderDiscountMessageContract.js';
import { appendOrderDiscountHtml, appendOrderDiscountText, buildOrderDiscountMessagePresentation, stripManagedOrderDiscountBlock } from './orderDiscountMessagePresentation.js';

export function snapshotFromPersistedOrder(order: typeof orders.$inferSelect): OrderDiscountMessageSnapshot {
  return { orderId: order.orderId, status: order.status, subtotal: order.subtotal, discount: order.discount, discountCode: order.discountCode, discountBreakdown: order.discountBreakdown, creditUsed: order.creditUsed, kwkCreditUsed: order.kwkCreditUsed, shipping: order.shipping, total: order.total };
}

export async function readPersistedOrderMessageData(db: any, orderId: string) {
  const [order] = await db.select().from(orders).where(eq(orders.orderId, orderId)).limit(1) as Array<typeof orders.$inferSelect>;
  if (!order) throw new Error('Bestellung nicht gefunden');
  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId)).orderBy(orderItems.id) as Array<typeof orderItems.$inferSelect>;
  const orderSnapshot = {
    version: 1 as const, orderId: order.orderId, orderDate: order.orderDate,
    communicationLanguage: order.communicationLanguage === 'en' ? 'en' as const : 'de' as const,
    subtotal: order.subtotal, discount: order.discount, discountCode: order.discountCode,
    discountBreakdown: order.discountBreakdown, creditUsed: order.creditUsed, kwkCreditUsed: order.kwkCreditUsed,
    shipping: order.shipping, total: order.total,
    items: items.map(item => ({ name: item.name, dosage: item.dosage, variant: item.variant, type: item.type, price: item.price, quantity: item.quantity, isNasalSpray: Boolean(item.isNasalSpray), isNasalDiySet: Boolean(item.isNasalDiySet), isPlugPlay: Boolean(item.isPlugPlay) })),
  };
  return { order, orderSnapshot, emailData: {
    orderId, communicationLanguage: orderSnapshot.communicationLanguage,
    storeKey: order.storeKey === 'peps4pets' ? 'peps4pets' as const : '369research' as const, externalOrderReference: order.externalOrderReference,
    customer: { firstName: order.firstName, lastName: order.lastName, email: order.email, phone: order.phone, street: order.street, houseNumber: order.houseNumber, zip: order.zip, city: order.city, country: order.country, company: order.company },
    items: orderSnapshot.items.map(item => ({ ...item, price: Number(item.price) })),
    subtotal: Number(order.subtotal), discount: Number(order.discount), discountCode: order.discountCode,
    discountBreakdown: order.discountBreakdown, creditUsed: order.creditUsed, kwkCreditUsed: order.kwkCreditUsed,
    orderDiscountSnapshot: snapshotFromPersistedOrder(order),
    shipping: Number(order.shipping), total: Number(order.total), paymentMethod: order.paymentMethod,
  } };
}

export async function composeExplicitOrderMessage(db: any, input: {
  customerId?: number; orderId?: string; channel: 'email' | 'whatsapp'; subject?: string;
  body: string; plainText?: string; communicationLanguage?: 'de' | 'en'; bodyIsHtml?: boolean;
}) {
  // No order means no financial query, no latest-order heuristic and no fake zero.
  let order: typeof orders.$inferSelect | undefined;
  let canonicalOrderId: string | undefined;
  if (input.orderId) {
    const context = await readCrmOrderContext(db, input.orderId);
    if (input.customerId && input.customerId !== context.customerId) throw new Error('Kunde und Bestellung stimmen nicht überein');
    canonicalOrderId = context.canonicalOrderId;
    [order] = await db.select().from(orders).where(eq(orders.orderId, canonicalOrderId)).limit(1);
    if (!order) throw new Error('Bestellung nicht gefunden');
  }
  const language = input.communicationLanguage ?? (order?.communicationLanguage === 'en' ? 'en' : 'de');
  const editableBody = order ? stripManagedOrderDiscountBlock(input.body) : input.body;
  const baseHtml = input.bodyIsHtml ? editableBody : `<div style="font-family:Arial,sans-serif;line-height:1.6">${escapeOrderMessageHtml(editableBody).replace(/\n/g, '<br />')}</div>`;
  const baseText = input.plainText ?? (input.bodyIsHtml ? htmlToPlainText(editableBody) : editableBody);
  const presentation = order ? buildOrderDiscountMessagePresentation(snapshotFromPersistedOrder(order), language) : undefined;
  const htmlBody = presentation ? appendOrderDiscountHtml(baseHtml, presentation) : baseHtml;
  const plainText = presentation ? appendOrderDiscountText(baseText, presentation) : baseText;
  const whatsappBody = presentation ? appendOrderDiscountText(input.bodyIsHtml ? baseText : editableBody, presentation, 'whatsapp') : (input.bodyIsHtml ? baseText : editableBody);
  return { subject: input.subject ?? '', editableBody, htmlBody, plainText, whatsappBody,
    body: input.channel === 'whatsapp' ? whatsappBody : plainText,
    financialFingerprint: presentation?.fingerprint, canonicalOrderId,
  };
}
