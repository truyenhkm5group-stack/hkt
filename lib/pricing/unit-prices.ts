/**
 * ═══════════ GIÁ ĐƠN VỊ AI THEO MODEL — ƯỚC TÍNH (ESTIMATED), CHỈ MÁY CHỦ (docs/platform/pricing-billing-foundation.md §3) ═══════════
 *
 * Hai lớp, cả hai mang nhãn ESTIMATED — không bao giờ là hoá đơn của nhà cung cấp:
 *  1. BẢNG TRONG MÃ (`lib/ai/provider.ts::PRICE_PER_MTOK`) — giá niêm yết đọc tay từ trang giá của nhà cung cấp; chính bảng
 *     này định giá `cost_usd` LÚC GHI mỗi lượt AI. Model không có trong bảng ⇒ `cost_usd = NULL` (CHƯA BIẾT).
 *  2. GHI ĐÈ CỦA NGƯỜI VẬN HÀNH (`platform_settings` · `platform.ai.unit-prices`, bắt buộc lý do + nhật ký) — chỉ dùng để
 *     ƯỚC TÍNH LẠI lượt có token mà chưa định giá, và cho bộ đề xuất model. Nó KHÔNG sửa `cost_usd` đã ghi (sổ là chứng từ
 *     của lúc gọi), và màn hình in tách "đã định giá lúc ghi" với "ước tính lại theo bảng ghi đè".
 */
import { eq } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import { khoaGiaKhop, modelPriceTable } from "@/lib/ai/provider";

export const AI_UNIT_PRICES_KEY = "platform.ai.unit-prices";
export const UNIT_PRICE_MAX_USD = 1000;

export type UnitPrice = { input: number; output: number };
export type UnitPriceRow = UnitPrice & { model: string; source: "CODE_TABLE" | "OPERATOR_OVERRIDE"; confidence: "ESTIMATED" };

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const price = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= UNIT_PRICE_MAX_USD ? v : undefined);

/** Đọc ghi đè `{ model: { input, output } }` (USD / 1M token). Dòng sai hình bị bỏ, không đoán. */
export function parseUnitPriceOverrides(raw: unknown): Record<string, UnitPrice> {
  if (!isRec(raw)) return {};
  const out: Record<string, UnitPrice> = {};
  for (const [model, v] of Object.entries(raw)) {
    if (!/^[a-z0-9][a-z0-9.\-]{1,60}$/.test(model) || !isRec(v)) continue;
    const input = price(v.input);
    const output = price(v.output);
    if (input !== undefined && output !== undefined) out[model] = { input, output };
  }
  return out;
}

/** Bảng hợp nhất: ghi đè thắng bảng trong mã cho cùng khoá. */
export function mergeUnitPrices(code: Record<string, UnitPrice>, overrides: Record<string, UnitPrice>): UnitPriceRow[] {
  const keys = [...new Set([...Object.keys(code), ...Object.keys(overrides)])].sort();
  return keys.map((model) => (overrides[model] ? { model, ...overrides[model], source: "OPERATOR_OVERRIDE" as const, confidence: "ESTIMATED" as const } : { model, ...code[model], source: "CODE_TABLE" as const, confidence: "ESTIMATED" as const }));
}

export async function readUnitPriceOverrides(): Promise<{ overrides: Record<string, UnitPrice>; updatedAt: string | null; updatedByEmail: string | null }> {
  try {
    const pdb = await getPlatformDb();
    const r = await pdb.query.platformSettings.findFirst({ where: eq(schema.platformSettings.key, AI_UNIT_PRICES_KEY) });
    return { overrides: parseUnitPriceOverrides(r?.value), updatedAt: r?.updatedAt?.toISOString() ?? null, updatedByEmail: r?.updatedByEmail ?? null };
  } catch {
    return { overrides: {}, updatedAt: null, updatedByEmail: null };
  }
}

export async function resolveUnitPrices(): Promise<{ rows: UnitPriceRow[]; byModel: Record<string, UnitPrice>; updatedAt: string | null; updatedByEmail: string | null }> {
  const code = Object.fromEntries(Object.entries(modelPriceTable()).map(([k, v]) => [k, { input: v.input, output: v.output }]));
  const o = await readUnitPriceOverrides();
  const rows = mergeUnitPrices(code, o.overrides);
  return { rows, byModel: Object.fromEntries(rows.map((r) => [r.model, { input: r.input, output: r.output }])), updatedAt: o.updatedAt, updatedByEmail: o.updatedByEmail };
}

/** Khoá bảng giá của một tên model trả về (tiền tố dài nhất — cùng luật với lúc ghi). */
export function priceKeyFor(model: string, table: Record<string, UnitPrice>): string | null {
  return khoaGiaKhop(model, Object.keys(table));
}

/** Ước tính lại tiền một nhóm lượt chưa định giá từ token — `null` khi model không có giá. */
export function reestimateUsd(model: string | null, inputTokens: number, outputTokens: number, table: Record<string, UnitPrice>): number | null {
  if (!model) return null;
  const k = priceKeyFor(model, table);
  if (!k) return null;
  return (inputTokens * table[k].input + outputTokens * table[k].output) / 1_000_000;
}
