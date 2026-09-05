/** Bảng chốt đặt hàng sản xuất: thứ tự size, màu hiển thị theo tên màu tiếng Việt, trạng thái */
export const SIZE_ORDER = ["XXS", "XS", "S", "M", "L", "XL", "2XL", "XXL", "3XL", "XXXL", "4XL", "5XL", "FREESIZE", "FREE SIZE", "F"];

export function sizeRank(size: string) {
  const s = size.trim().toUpperCase();
  const i = SIZE_ORDER.indexOf(s);
  if (i >= 0) return i;
  const n = Number(s);
  return Number.isFinite(n) ? 100 + n : 1000;
}

export const PRODUCTION_STATUS = ["DRAFT", "SENT", "RECEIVED", "CANCELLED"] as const;
export type ProductionStatus = (typeof PRODUCTION_STATUS)[number];
export const PRODUCTION_STATUS_LABEL: Record<string, string> = { DRAFT: "Nháp", SENT: "Đã gửi xưởng", RECEIVED: "Đã nhận hàng", CANCELLED: "Huỷ" };
export const PRODUCTION_STATUS_TONE: Record<string, string> = {
  DRAFT: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  SENT: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  RECEIVED: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  CANCELLED: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
};

/** Màu nền ô tiêu đề theo tên màu (chữ trắng/đen tự chọn) */
const COLOR_MAP: [RegExp, string][] = [
  [/do do|do dam|bordeaux|burgundy|mận|man/, "#7f1d1d"],
  [/\bdo\b|red/, "#dc2626"],
  [/\bden\b|black/, "#111827"],
  [/\btrang\b|white|kem|be\b|beige|cream/, "#f5f5f4"],
  [/xanh la|xanh reu|reu|olive|green/, "#15803d"],
  [/xanh ngoc|ngoc|mint|teal/, "#0d9488"],
  [/xanh den|navy|xanh than/, "#1e3a8a"],
  [/xanh duong|xanh bien|blue/, "#2563eb"],
  [/\bxanh\b/, "#0369a1"],
  [/vang|yellow|mustard/, "#eab308"],
  [/cam|orange/, "#f97316"],
  [/hong|pink/, "#ec4899"],
  [/tim|purple|violet/, "#7c3aed"],
  [/nau|brown|cafe|ca phe|chocolate/, "#78350f"],
  [/xam|ghi|grey|gray/, "#6b7280"],
  [/bac|silver/, "#9ca3af"],
];

export function colorSwatch(name: string): { bg: string; fg: string } {
  const n = ` ${name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9 ]+/g, " ")
    .trim()} `;
  const hit = COLOR_MAP.find(([re]) => re.test(n));
  const bg = hit?.[1] ?? "#374151";
  const light = ["#f5f5f4", "#eab308", "#9ca3af"].includes(bg);
  return { bg, fg: light ? "#111827" : "#ffffff" };
}

export const cellKey = (color: string, size: string) => `${color}|${size}`;

export function matrixTotals(colors: string[], sizes: string[], cells: Record<string, number>) {
  const byColor: Record<string, number> = {};
  const bySize: Record<string, number> = {};
  let total = 0;
  for (const c of colors) for (const s of sizes) {
    const q = Math.max(0, Number(cells[cellKey(c, s)] ?? 0));
    byColor[c] = (byColor[c] ?? 0) + q;
    bySize[s] = (bySize[s] ?? 0) + q;
    total += q;
  }
  return { byColor, bySize, total };
}

/** Văn bản thuần để gửi Zalo / dán vào tin nhắn cho xưởng */
export function matrixAsText(o: { productCode: string; productName: string; code: string; colors: string[]; sizes: string[]; cells: Record<string, number>; note: string; dueDate: Date | null }) {
  const t = matrixTotals(o.colors, o.sizes, o.cells);
  const lines = [`BẢNG CHỐT SL ĐẶT HÀNG ${o.code} · ${o.productCode ? `${o.productCode} ` : ""}${o.productName}`];
  lines.push(["Size", ...o.colors, "Tổng"].join("\t"));
  for (const s of o.sizes) lines.push([s, ...o.colors.map((c) => String(o.cells[cellKey(c, s)] ?? 0)), String(t.bySize[s] ?? 0)].join("\t"));
  lines.push(["Tổng", ...o.colors.map((c) => String(t.byColor[c] ?? 0)), String(t.total)].join("\t"));
  if (o.dueDate) lines.push(`Ngày cần hàng: ${new Date(o.dueDate).toLocaleDateString("vi-VN")}`);
  if (o.note) lines.push(`Ghi chú: ${o.note}`);
  return lines.join("\n");
}
