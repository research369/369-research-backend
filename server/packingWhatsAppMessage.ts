import { appendOrderDiscountText, buildOrderDiscountMessagePresentation } from "./orderDiscountMessagePresentation.js";
import type { OrderDiscountMessageSnapshot } from "./orderDiscountMessageContract.js";
import { normalizeCommunicationLanguage, type CommunicationLanguage } from "./communicationLanguageService.js";

export function buildPackingWhatsAppMessage(input: {
  customerName: string;
  orderId: string;
  orderDiscountSnapshot?: OrderDiscountMessageSnapshot;
  communicationLanguage?: CommunicationLanguage | string | null;
}): string {
  const language = normalizeCommunicationLanguage(input.communicationLanguage);
  const finish = (base: string) => input.orderDiscountSnapshot ? appendOrderDiscountText(base, buildOrderDiscountMessagePresentation(input.orderDiscountSnapshot, language), "whatsapp") : base;
  if (language === "en") {
    return finish(`Hello ${input.customerName} 👋\n\nyour parcel for order *${input.orderId}* is currently being packed and prepared for shipping! 📦🔬\n\nAs soon as your parcel is on its way, you will receive another message with your tracking number. 🚚📬\n\nThank you for your trust! 🙏\n\n369 Research 🔬`);
  }
  return finish(`Hallo ${input.customerName} 👋\n\ndein Paket für Bestellung *${input.orderId}* wird gerade gepackt und für den Versand vorbereitet! 📦🔬\n\nSobald dein Paket auf dem Weg zu dir ist, bekommst du von uns eine weitere Nachricht mit deiner Sendungsnummer. 🚚📬\n\nVielen Dank für dein Vertrauen! 🙏\n\n369 Research 🔬`);
}
