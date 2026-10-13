/** Pure rules: integers in VND, one item per comment, never infer missing digits. */
export type ParsedComment = { phone: string | null; price: number | null; sku: string | null; reason: string | null };

export function normalizePhone(input: string): string | null {
  let p = input.replace(/[\s.()-]/g, '');
  if (p.startsWith('+84')) p = '0' + p.slice(3);
  else if (p.startsWith('84') && p.length === 11) p = '0' + p.slice(2);
  return /^0[35789]\d{8}$/.test(p) ? p : null;
}

export function parseComment(text: string): ParsedComment {
  const input = text.normalize('NFKC');
  const matches = [...input.matchAll(/(?<![\w+])(?:\+84|84|0)[35789](?:[ .-]?\d){8}(?![\w])/g)];
  const phones = [...new Set(matches.map(m => normalizePhone(m[0])).filter(Boolean))] as string[];
  let rest = input;
  for (const m of matches) rest = rest.replace(m[0], ' ');
  const sku = /\b([a-z]{1,8}\d{1,8})\b/i.exec(rest)?.[1]?.toUpperCase() ?? null;
  if (sku) rest = rest.replace(new RegExp(`\\b${sku}\\b`, 'i'), ' ');
  const prices = [...rest.matchAll(/(?<![\w])([1-9]\d{0,8}(?:[.,]\d{1,3})?)\s*(k|ngh[iì]n|vnd|đ|₫)?(?![\w])/gi)]
    .map(m => {
      const suffix = m[2]?.toLowerCase();
      const raw = m[1];
      if (suffix === 'k' || suffix?.startsWith('ngh')) return Math.round(Number(raw.replace(',', '.')) * 1000);
      const n = Number(raw.replace(/[.,]/g, ''));
      return n >= 1000 ? n : NaN; // Bare 230 is ambiguous; require 230k or 230000.
    });
  const ambiguousPrice = prices.some(n => !Number.isSafeInteger(n) || n <= 0 || n > 100_000_000);
  const uniquePrices = [...new Set(prices.filter(n => Number.isSafeInteger(n) && n > 0 && n <= 100_000_000))];
  const result: ParsedComment = {
    phone: phones.length === 1 ? phones[0] : null,
    price: uniquePrices.length === 1 ? uniquePrices[0] : null, sku, reason: null
  };
  if (phones.length > 1) result.reason = 'Multiple phone numbers; staff must confirm.';
  else if (phones.length === 0) result.reason = 'Missing or incomplete Vietnamese phone number.';
  else if (uniquePrices.length > 1) result.reason = 'Multiple prices; staff must confirm.';
  else if (ambiguousPrice) result.reason = 'Ambiguous price or quantity; use a product code and an explicit price.';
  else if (!sku && result.price === null) result.reason = 'Missing product code or explicit price.';
  return result;
}

export function chooseProduct<T extends { id: string; sku: string; price: number; active: boolean }>(
  parsed: ParsedComment, products: T[], currentProductId: string | null,
): { product: T | null; reason: string | null } {
  if (parsed.reason) return {product: null, reason: parsed.reason};
  const active = products.filter(p => p.active);
  let candidates: T[];
  if (parsed.sku) candidates = active.filter(p => p.sku.toUpperCase() === parsed.sku);
  else if (currentProductId) candidates = active.filter(p => p.id === currentProductId);
  else candidates = active.filter(p => p.price === parsed.price);
  if (candidates.length !== 1) return {
    product: null,
    reason: candidates.length ? 'Price matches several products; use a product code.' : 'Product not found.'
  };
  const product = candidates[0];
  if (parsed.price !== null && product.price !== parsed.price) return {
    product: null,
    reason: 'Comment price differs from the seller price.'
  };
  return {product, reason: null};
}

export function amountDue(order: { total: number; deposit: number; amountPaid: number }, kind: 'deposit' | 'full') {
  return Math.max(0, (kind === 'deposit' ? order.deposit : order.total) - order.amountPaid);
}

export function paymentStatus(paid: number, total: number): 'PAID' | 'DEPOSIT_PAID' | 'AWAITING_PAYMENT' {
  return paid >= total ? 'PAID' : paid > 0 ? 'DEPOSIT_PAID' : 'AWAITING_PAYMENT';
}

export function maskPhone(phone: string) {
  return phone.slice(0, 3) + '••••' + phone.slice(-3);
}
