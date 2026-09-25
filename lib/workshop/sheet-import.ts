import { normalizeProductCode } from "@/lib/constants/workshop-ledger";

/**
 * ═══════════ NHẬP SỔ ĐẶT XƯỞNG TỪ BẢNG TÍNH "BÁO CÁO ĐẶT HÀNG" (hàm THUẦN) ═══════════
 *
 * Chủ shop yêu cầu (25/09/2026): "mapping số liệu từ file GG sheet lên ERP; phần nào không mapping
 * được thì để trống cho tôi điền". Tệp này chỉ BIẾN DÒNG BẢNG TÍNH THÀNH KẾ HOẠCH GHI — không đọc
 * mạng, không đọc/ghi CSDL — nên chạy thử và chạy thật đi qua ĐÚNG một phép ghép.
 *
 * ─── ĐỌC THEO VỊ TRÍ CỘT, KIỂM BẰNG TIÊU ĐỀ ───
 *
 * Hai trang "Thành phẩm" và "Vải" cùng bố cục (A…S). Google trả tiêu đề qua gviz không đủ (nhiều ô
 * tiêu đề rỗng), nên cột đọc theo VỊ TRÍ và chỉ những tiêu đề còn đọc được mới dùng để kiểm bố cục —
 * bố cục đổi thì DỪNG, không đọc lệch cột.
 *
 * ─── ĐỂ TRỐNG, KHÔNG ĐOÁN ───
 *
 * Bảng tính không có: xưởng may · nhà vải · đơn vị vải · ngày trả tiền · lô nào dùng đợt vải nào (trừ
 * khi ghi chú nói "lô N"). Những ô ấy để trống, hoặc — khi CSDL bắt buộc có (ngày trả tiền) — ghi một
 * ngày tạm KÈM ghi chú nói rõ là tạm, để người đọc thấy và sửa.
 */

export const SHEET_TABS = { finished: "Thành phẩm", fabric: "Vải" } as const;

/** Vị trí cột (0 = cột A). Hai trang cùng bố cục. */
export const COL = {
  code: 0,
  batchNo: 1,
  orderedAt: 2,
  orderedQty: 3,
  agreedQty: 4,
  dueDate: 5,
  unitPrice: 6,
  marketerPrice: 7,
  total: 8,
  deposit: 9,
  adjustment: 10,
  paid: 11,
  remaining: 12,
  payState: 13,
  deliveryState: 14,
  note: 15,
  penalty: 16,
  month: 17,
  marketer: 18,
} as const;

/** Tiêu đề còn đọc được qua gviz — dùng để chắc là đang đọc đúng bố cục. */
const EXPECTED_HEADERS: [number, string][] = [
  [COL.code, "Mã"],
  [COL.marketerPrice, "Giá Báo MKT"],
  [COL.adjustment, "Thưởng/Phạt"],
  [COL.note, "Ghi chú"],
  [COL.penalty, "Hoàn phạt MKT"],
];

export function checkLayout(header: string[] | undefined): string | null {
  if (!header) return "Bảng tính trống";
  for (const [i, name] of EXPECTED_HEADERS) {
    if ((header[i] ?? "").trim().toLowerCase() !== name.toLowerCase()) return `Cột ${String.fromCharCode(65 + i)} phải là "${name}" nhưng đang là "${(header[i] ?? "").trim()}" — bố cục bảng tính đã đổi, dừng để không đọc lệch cột`;
  }
  return null;
}

/** "60.000 ₫" → 60000 · "0 đ" → 0 · "" → null. Dấu chấm là phân cách nghìn. */
export function parseMoney(raw: string | undefined): number | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const neg = /^-|^\(/.test(s);
  const digits = s.replace(/[^\d]/g, "");
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

/** "1.039" → 1039 · "" → null. */
export const parseInt0 = parseMoney;

/** "28/7/2026" · "04/08/2026" → "2026-07-28". Sai / trống → null. */
export function parseDate(raw: string | undefined): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec((raw ?? "").trim());
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** "14/08" trong ghi chú không có năm ⇒ lấy năm của ngày đặt; sớm hơn ngày đặt quá 60 ngày ⇒ năm sau. */
function withYear(day: number, month: number, orderedAt: string): string {
  const y = Number(orderedAt.slice(0, 4));
  const key = (yy: number) => `${yy}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const cand = key(y);
  return new Date(cand).getTime() < new Date(orderedAt).getTime() - 60 * 86_400_000 ? key(y + 1) : cand;
}

export type NoteLine = { date: string; quantity: number | null; text: string };

/** Ghi chú dạng "14/08: 240" / "27/08: 115c đỏ" / "03/08: lót Q002" — mỗi dòng một mục. */
export function parseNoteLines(note: string, orderedAt: string): { lines: NoteLine[]; rest: string[] } {
  const lines: NoteLine[] = [];
  const rest: string[] = [];
  for (const raw of note.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const m = /^(\d{1,2})\/(\d{1,2})\s*:\s*(.*)$/.exec(raw);
    if (!m) {
      rest.push(raw);
      continue;
    }
    const body = m[3].trim();
    const q = /^(\d[\d.]*)\s*c?\b\s*(.*)$/i.exec(body);
    lines.push({ date: withYear(Number(m[1]), Number(m[2]), orderedAt), quantity: q ? parseMoney(q[1]) : null, text: q ? q[2].trim() : body });
  }
  return { lines, rest };
}

const cell = (r: string[], i: number) => (r[i] ?? "").trim();
const isDone = (v: string) => v.trim().toLowerCase() === "đã xong";

export type SheetPayment = { kind: "DEPOSIT" | "PAYMENT"; amount: number; paidAt: string; note: string };

export type SheetBatchPlan = {
  row: number;
  code: string;
  batchNo: number;
  /** Số lô ghi trên bảng tính khi ERP phải đổi (trùng mã + lô trong bảng tính). */
  batchNoOnSheet: number | null;
  orderedAt: string;
  orderedQty: number;
  agreedQty: number | null;
  dueDate: string | null;
  laborUnitPrice: number | null;
  adjustment: number;
  adjustmentNote: string;
  workshopPenalty: number;
  done: boolean;
  doneAt: string | null;
  deliveries: { date: string; quantity: number; note: string }[];
  payments: SheetPayment[];
  note: string;
  sheetTotal: number | null;
  warnings: string[];
};

export type SheetFabricPlan = {
  row: number;
  code: string;
  /** Lô sản xuất mà ghi chú nói rõ ("đặt lô 2 cho Q002"); `null` = để trống cho người điền. */
  batchNoRef: number | null;
  orderedAt: string;
  receivedAt: string | null;
  quantity: number | null;
  unitPrice: number | null;
  amount: number;
  description: string;
  payments: SheetPayment[];
  note: string;
  warnings: string[];
};

export type SheetPlan = { batches: SheetBatchPlan[]; fabrics: SheetFabricPlan[]; skipped: { tab: string; row: number; reason: string }[]; notices: string[] };

/**
 * "Thanh toán" trên bảng tính là tổng đã trả; "Số tiền cọc" có thể đã nằm trong đó hoặc chưa. Xét
 * bằng cột "Còn phải thanh toán": TỔNG − TT = còn ⇒ TT đã gồm cọc; TỔNG − TT − cọc = còn ⇒ chưa gồm.
 */
function paymentsOf(total: number | null, deposit: number, paid: number, remaining: number | null, paidAt: string, why: string): { payments: SheetPayment[]; warning: string | null } {
  const payments: SheetPayment[] = [];
  let depositIncluded = true;
  let warning: string | null = null;
  if (deposit > 0 && total != null && remaining != null) {
    if (total - paid === remaining) depositIncluded = true;
    else if (total - paid - deposit === remaining) depositIncluded = false;
    else warning = "Cọc / thanh toán / còn phải trả trên bảng tính không cộng khớp nhau — kiểm lại các đợt thanh toán";
  }
  const note = `Nhập từ bảng tính — ${why}`;
  if (deposit > 0) payments.push({ kind: "DEPOSIT", amount: deposit, paidAt, note });
  const rest = depositIncluded ? paid - deposit : paid;
  if (rest > 0) payments.push({ kind: "PAYMENT", amount: rest, paidAt, note });
  return { payments, warning };
}

export function planFinished(rows: string[][]): { batches: SheetBatchPlan[]; skipped: SheetPlan["skipped"]; notices: string[] } {
  const batches: SheetBatchPlan[] = [];
  const skipped: SheetPlan["skipped"] = [];
  const notices: string[] = [];
  const used = new Map<string, Set<number>>();
  rows.slice(1).forEach((r, idx) => {
    const row = idx + 2;
    const code = normalizeProductCode(cell(r, COL.code));
    if (!code) return;
    const orderedAt = parseDate(cell(r, COL.orderedAt));
    const orderedQty = parseMoney(cell(r, COL.orderedQty));
    if (!orderedAt || orderedQty == null) {
      skipped.push({ tab: SHEET_TABS.finished, row, reason: `${code}: thiếu ngày đặt hoặc số lượng đặt — không đủ để dựng một lô` });
      return;
    }
    const warnings: string[] = [];
    const set = used.get(code) ?? new Set<number>();
    used.set(code, set);
    const onSheet = parseMoney(cell(r, COL.batchNo));
    let batchNo = onSheet && onSheet > 0 ? onSheet : 0;
    let batchNoOnSheet: number | null = null;
    if (!batchNo || set.has(batchNo)) {
      batchNoOnSheet = batchNo || null;
      batchNo = Math.max(0, ...set) + 1;
      warnings.push(onSheet ? `Bảng tính ghi lô ${onSheet} — trùng với dòng trước của ${code}; ERP đặt tạm lô ${batchNo}, sửa nếu sai` : `Bảng tính không ghi số lô; ERP đặt tạm lô ${batchNo}`);
    }
    set.add(batchNo);

    const agreedQty = parseMoney(cell(r, COL.agreedQty));
    const laborUnitPrice = parseMoney(cell(r, COL.unitPrice));
    const sheetTotal = parseMoney(cell(r, COL.total));
    const noteRaw = cell(r, COL.note);
    const { lines, rest } = parseNoteLines(noteRaw, orderedAt);
    const deliveries = lines.filter((l) => l.quantity != null && l.quantity !== 0).map((l) => ({ date: l.date, quantity: l.quantity as number, note: l.text }));
    const khongDocDuoc = [...lines.filter((l) => l.quantity == null).map((l) => `${l.date}: ${l.text}`), ...rest];
    const delivered = deliveries.reduce((t, d) => t + d.quantity, 0);

    let adjustment = parseMoney(cell(r, COL.adjustment)) ?? 0;
    let adjustmentNote = adjustment ? "Thưởng/Phạt ghi trên bảng tính" : "";
    const qtyBasis = agreedQty ?? (delivered > 0 ? delivered : null);
    if (sheetTotal != null && laborUnitPrice != null && qtyBasis != null) {
      const lech = sheetTotal - (qtyBasis * laborUnitPrice + adjustment);
      if (lech !== 0) {
        adjustment += lech;
        adjustmentNote = `${adjustmentNote ? `${adjustmentNote}; ` : ""}chênh ${lech.toLocaleString("vi-VN")} ₫ giữa TỔNG trên bảng tính (${sheetTotal.toLocaleString("vi-VN")}) và SL × đơn giá — kiểm lại`;
        warnings.push(`TỔNG trên bảng tính lệch SL × đơn giá ${lech.toLocaleString("vi-VN")} ₫ — ghi vào Thưởng/Phạt để tiền công khớp bảng tính, kiểm lại`);
      }
    }
    if (agreedQty != null && delivered > 0 && delivered !== agreedQty) warnings.push(`Tổng các đợt trả hàng trong ghi chú (${delivered}) khác SL chốt (${agreedQty})`);

    const lastDelivery = deliveries.map((d) => d.date).sort().at(-1) ?? null;
    const done = isDone(cell(r, COL.deliveryState));
    const paidAt = lastDelivery ?? parseDate(cell(r, COL.dueDate)) ?? orderedAt;
    const pay = paymentsOf(sheetTotal, parseMoney(cell(r, COL.deposit)) ?? 0, parseMoney(cell(r, COL.paid)) ?? 0, parseMoney(cell(r, COL.remaining)), paidAt, `bảng tính không có ngày trả, tạm lấy ${paidAt.split("-").reverse().join("/")} (ngày xưởng trả hàng cuối); sửa nếu cần`);
    if (pay.warning) warnings.push(pay.warning);

    const penalty = parseMoney(cell(r, COL.penalty)) ?? 0;
    if (penalty > 0) warnings.push("Có Hoàn phạt MKT nhưng bảng tính không có ngày ghi phạt — điền ngày ở lô thì tiền phạt mới cộng cho MKT");
    const mktPrice = parseMoney(cell(r, COL.marketerPrice));
    if (mktPrice != null) notices.push(`${code} lô ${batchNo}: bảng tính có Giá báo MKT ${mktPrice.toLocaleString("vi-VN")} ₫ — khai ở mục "Giá báo MKT theo mã" (một giá cho cả mã), không nhập theo lô`);
    const mkt = cell(r, COL.marketer);
    if (mkt) notices.push(`${code}: bảng tính ghi Tên MKT "${mkt}" — khai ở Lương › Marketer phụ trách mã`);

    batches.push({
      row,
      code,
      batchNo,
      batchNoOnSheet,
      orderedAt,
      orderedQty,
      agreedQty,
      dueDate: parseDate(cell(r, COL.dueDate)),
      laborUnitPrice,
      adjustment,
      adjustmentNote,
      workshopPenalty: Math.max(0, penalty),
      done,
      doneAt: done ? (lastDelivery ?? parseDate(cell(r, COL.dueDate))) : null,
      deliveries,
      payments: pay.payments,
      note: [`[Nhập từ bảng tính · ${SHEET_TABS.finished} dòng ${row}]`, ...khongDocDuoc].join(" "),
      sheetTotal,
      warnings,
    });
  });
  return { batches, skipped, notices };
}

export function planFabric(rows: string[][]): { fabrics: SheetFabricPlan[]; skipped: SheetPlan["skipped"] } {
  const fabrics: SheetFabricPlan[] = [];
  const skipped: SheetPlan["skipped"] = [];
  rows.slice(1).forEach((r, idx) => {
    const row = idx + 2;
    const code = normalizeProductCode(cell(r, COL.code));
    if (!code) return;
    const orderedAt = parseDate(cell(r, COL.orderedAt));
    const amount = parseMoney(cell(r, COL.total));
    if (!orderedAt || amount == null) {
      skipped.push({ tab: SHEET_TABS.fabric, row, reason: `${code}: thiếu ngày đặt hoặc thành tiền` });
      return;
    }
    const warnings: string[] = [];
    const noteRaw = cell(r, COL.note);
    const { lines, rest } = parseNoteLines(noteRaw, orderedAt);
    const text = [...lines.map((l) => l.text), ...rest].filter(Boolean).join(" · ");
    // Chỉ gắn lô khi ghi chú NÓI RÕ; cột "Lô" của trang Vải là số đợt vải, không phải lô sản xuất.
    const loRo = /lô\s*(\d+)/i.exec(noteRaw);
    const quantity = parseMoney(cell(r, COL.agreedQty)) ?? parseMoney(cell(r, COL.orderedQty));
    let unitPrice = parseMoney(cell(r, COL.unitPrice));
    if (unitPrice != null && quantity != null && Math.abs(unitPrice * quantity - amount) > Math.max(1000, amount * 0.01)) {
      warnings.push(`Đơn giá trên bảng tính (${unitPrice.toLocaleString("vi-VN")}) × SL ${quantity} không ra thành tiền ${amount.toLocaleString("vi-VN")} — để trống đơn giá, điền lại cho đúng đơn vị`);
      unitPrice = null;
    }
    if (!loRo) warnings.push("Chưa biết đợt vải này dùng cho lô nào — chọn lô ở đợt vải");
    const receivedAt = isDone(cell(r, COL.deliveryState)) ? parseDate(cell(r, COL.dueDate)) : null;
    const paidAt = receivedAt ?? orderedAt;
    const pay = paymentsOf(amount, parseMoney(cell(r, COL.deposit)) ?? 0, parseMoney(cell(r, COL.paid)) ?? 0, parseMoney(cell(r, COL.remaining)), paidAt, `bảng tính không có ngày trả, tạm lấy ${paidAt.split("-").reverse().join("/")}; sửa nếu cần`);
    if (pay.warning) warnings.push(pay.warning);
    fabrics.push({
      row,
      code,
      batchNoRef: loRo ? Number(loRo[1]) : null,
      orderedAt,
      receivedAt,
      quantity,
      unitPrice,
      amount,
      description: text,
      payments: pay.payments,
      note: `[Nhập từ bảng tính · ${SHEET_TABS.fabric} dòng ${row}${cell(r, COL.batchNo) ? ` · cột Lô = ${cell(r, COL.batchNo)}` : ""}${cell(r, COL.unitPrice) && unitPrice == null ? ` · đơn giá ghi ${cell(r, COL.unitPrice)}` : ""}]`,
      warnings,
    });
  });
  return { fabrics, skipped };
}

export function planFromSheets(finishedRows: string[][], fabricRows: string[][]): SheetPlan | { error: string } {
  const e1 = checkLayout(finishedRows[0]);
  if (e1) return { error: `Trang "${SHEET_TABS.finished}": ${e1}` };
  const e2 = checkLayout(fabricRows[0]);
  if (e2) return { error: `Trang "${SHEET_TABS.fabric}": ${e2}` };
  const a = planFinished(finishedRows);
  const b = planFabric(fabricRows);
  return { batches: a.batches, fabrics: b.fabrics, skipped: [...a.skipped, ...b.skipped], notices: a.notices };
}
