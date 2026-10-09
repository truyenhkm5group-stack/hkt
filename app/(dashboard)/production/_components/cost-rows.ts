import { COST_LINE_KINDS, PERCENT_UNIT, type CostLineInput, type CostLineKind } from "@/lib/constants/production-os";

/**
 * ═══════════ DÒNG GIÁ THÀNH BỎ TRỐNG ĐƠN GIÁ LÀ **CHƯA BIẾT**, KHÔNG PHẢI 0 ₫ ═══════════
 *
 * Bản cũ đổi ô trống thành 0 (`Number(r.unitCost) || 0`): một dòng "vải" chưa hỏi giá xưởng lưu thành
 * 0 ₫, tổng giá thành thấp đi đúng bằng dòng ấy, rồi nút "Dùng làm giá ước tính" đẩy con số thấp đó
 * sang báo cáo lợi nhuận danh nghĩa (AGENTS.md mục 42).
 *
 * Cột `cost_sheet_lines.unit_cost` là NOT NULL nên chỗ trống không lưu được — bản này KHÔNG đổi lược đồ:
 * dòng còn trống thì KHÔNG cho lưu (điền giá thật, gõ 0 nếu thật sự không tốn, hoặc xoá dòng). Gõ "0" là
 * một lời khẳng định của người; ô trống thì không.
 *
 * Hàm THUẦN, không "use client", để bài kiểm gọi được.
 */

export type CostRow = { kind: CostLineKind; description: string; qty: string; unit: string; unitCost: string };

export type CostRowLine = Omit<CostLineInput, "unitCost"> & { unitCost: number | null };

export function isPercentRow(r: Pick<CostRow, "unit">): boolean {
  return r.unit.trim() === PERCENT_UNIT;
}

/** Ô đơn giá → số. Dòng % không có đơn giá (0 theo `computeCostSheet`); ô trống ở dòng tiền ⇒ `null`. */
export function costRowPrice(r: Pick<CostRow, "unit" | "unitCost">): number | null {
  if (isPercentRow(r)) return 0;
  const text = r.unitCost.trim();
  if (text === "") return null;
  const n = Number(text);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** Hàng trên màn hình → dòng gửi máy chủ. Còn một dòng tiền chưa có đơn giá ⇒ lỗi, không đổi thành 0. */
export function costRowsToLines(rows: readonly CostRow[]): { lines: CostLineInput[]; blankRows: [] } | { error: string; blankRows: number[]; draft: CostRowLine[] } {
  const draft: CostRowLine[] = rows.map((r) => ({
    kind: (COST_LINE_KINDS as readonly string[]).includes(r.kind) ? r.kind : "OTHER",
    description: r.description,
    qty: Number(r.qty.replace(",", ".")) || 0,
    unit: r.unit.trim(),
    unitCost: costRowPrice(r),
  }));
  const blankRows = draft.flatMap((l, i) => (l.unitCost === null ? [i + 1] : []));
  if (blankRows.length) return { error: `Dòng ${blankRows.join(", ")}: chưa có đơn giá — điền giá thật (gõ 0 nếu thật sự không tốn) hoặc xoá dòng`, blankRows, draft };
  return { lines: draft.map((l) => ({ ...l, unitCost: l.unitCost as number })), blankRows: [] };
}

/**
 * Bảng đã chốt có được "Dùng làm giá ước tính" không. Bản cũ lưu ô trống thành 0, và dòng 0 ₫ đã lưu
 * KHÔNG phân biệt được với ô bỏ trống — nên còn dòng tiền 0 ₫ (số lượng > 0) thì CHẶN, kèm lý do.
 */
export function estimateBlocker(sheet: { totalUnitCost: number; lines: readonly { unit: string; qty: number; unitCost: number }[] }): string | null {
  if (!(sheet.totalUnitCost > 0)) return "Tổng giá thành chưa có — không dùng làm giá ước tính";
  const zero = sheet.lines.flatMap((l, i) => (!isPercentRow(l) && l.qty > 0 && !(l.unitCost > 0) ? [i + 1] : []));
  if (zero.length) return `Dòng ${zero.join(", ")} đơn giá 0 ₫ — có thể là ô bỏ trống ở bản cũ; lập phiên bản mới với giá thật trước khi dùng làm giá ước tính`;
  return null;
}
