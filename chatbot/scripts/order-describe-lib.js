/**
 * Ham THUAN cho ops "bot-order-describe" (chatbot/scripts/order-describe.js) — tach rieng de bai kiem nap duoc ma khong nap
 * config.js (ESM chi nap mot lan: nap config trong bai kiem se chot DATA_DIR cua bot cho cac bai sau).
 */

export const MAX_ORDERS = 5;

/** Doi so ops: cac ma don POS (so), cach nhau dau cach / dau phay, toi da MAX_ORDERS. Sai ⇒ { error }. */
export function parseOrderIds(argv) {
  const ids = [...new Set(argv.flatMap((a) => String(a).split(",")).map((x) => x.trim()).filter(Boolean))];
  if (!ids.length) return { error: `can it nhat mot ma don POS (toi da ${MAX_ORDERS})` };
  if (ids.length > MAX_ORDERS) return { error: `toi da ${MAX_ORDERS} ma don moi luot` };
  if (ids.some((x) => !/^[0-9]{1,24}$/.test(x))) return { error: "ma don POS chi gom chu so" };
  return { ids };
}

/**
 * Ban RUT GON cho kenh tom tat CONG KHAI: giu trang thai + ma van don + chang; bo phan "gom …" (ten / ma hang) va "thu ho …" (so
 * tien). Cau day du chi di vao phan MA HOA.
 */
export function publicLine(sentence) {
  return String(sentence || "")
    .split(" – ")
    .filter((p) => !p.startsWith("gồm ") && !p.startsWith("thu hộ "))
    .join(" – ")
    .slice(0, 260);
}
