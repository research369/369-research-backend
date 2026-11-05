/** Canonical contact comparison only; no inference from names or addresses. */
export function normalizeWhatsappContactPhone(value: string) {
  let digits = value.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("490")) return "49" + digits.slice(3);
  if (digits.startsWith("0")) return "49" + digits.replace(/^0+/, "");
  return digits;
}
