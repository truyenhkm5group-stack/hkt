/**
 * Tự phát hiện case CSKH từ dữ liệu Pancake đã đồng bộ:
 *  - thẻ đơn (tags) và ghi chú đơn (note / note_print) khớp từ khoá,
 *  - phiếu đổi / trả hàng (order_returns),
 *  - (tuỳ chọn) thẻ hội thoại Pancake Pages nếu có access token.
 * Chống trùng bằng dedupeKey; case đã đóng không mở lại.
 */
import { and, desc, gte, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { CS_KIND_LABEL, CS_RULES_KEY, DEFAULT_CS_RULES, type CsKind, type CsRules } from "@/lib/constants/cs";
import { getSettingJson } from "@/lib/settings";
import { normalize } from "@/lib/text";

export async function loadCsRules(): Promise<CsRules> {
  const cfg = await getSettingJson<CsRules>(CS_RULES_KEY, DEFAULT_CS_RULES);
  return {
    ...DEFAULT_CS_RULES,
    ...cfg,
    tagRules: cfg.tagRules?.length ? cfg.tagRules : DEFAULT_CS_RULES.tagRules,
    noteRules: cfg.noteRules?.length ? cfg.noteRules : DEFAULT_CS_RULES.noteRules,
    chatRules: cfg.chatRules?.length ? cfg.chatRules : DEFAULT_CS_RULES.chatRules,
    ignorePatterns: cfg.ignorePatterns?.length ? cfg.ignorePatterns : DEFAULT_CS_RULES.ignorePatterns,
    failedDeliveryAuto: cfg.failedDeliveryAuto !== false,
    failedDeliveryShopName: cfg.failedDeliveryShopName || DEFAULT_CS_RULES.failedDeliveryShopName,
    failedDeliveryTemplates: { ...DEFAULT_CS_RULES.failedDeliveryTemplates, ...(cfg.failedDeliveryTemplates ?? {}) },
  };
}

/** Bỏ các đoạn ghi chú tự động (vd "[🤖 BOT ĐÃ TỰ ĐỘNG SỬA LẠI ĐỊA CHỈ SAI SANG …]") trước khi nhận diện */
export function stripIgnored(text: string, patterns: string[]) {
  let out = text;
  // xoá từng khối [...] chứa cụm bỏ qua
  out = out.replace(/\[[^\]]*\]/g, (block) => (patterns.some((p) => normalize(block).includes(` ${normalize(p).trim()} `) || normalize(block).includes(normalize(p).trim())) ? " " : block));
  const n = normalize(out);
  if (patterns.some((p) => n.includes(normalize(p).trim()))) return "";
  return out.trim();
}

type Candidate = { dedupeKey: string; orderId: string | null; customerId: string | null; kind: CsKind; source: string; title: string; detail: string; customerName: string; customerPhone: string };

function matchKind(text: string, rules: { keyword: string; kind: CsKind }[]): CsKind | null {
  const n = normalize(text);
  // ưu tiên từ khoá dài hơn
  const hit = [...rules].sort((a, b) => b.keyword.length - a.keyword.length).find((r) => n.includes(` ${normalize(r.keyword).trim()} `) || (r.keyword.length >= 6 && n.includes(normalize(r.keyword).trim())));
  return hit?.kind ?? null;
}

export async function collectCsCandidates(): Promise<Candidate[]> {
  const db = await getDb();
  const rules = await loadCsRules();
  const since = new Date(Date.now() - Math.max(1, rules.lookbackDays) * 86_400_000);
  const o = schema.orders;
  const out: Candidate[] = [];

  const orders = await db
    .select({ id: o.id, systemId: o.systemId, customerId: o.customerId, name: o.billFullName, phone: o.billPhone, tags: o.tags, note: o.note, notePrint: o.notePrint, stage: o.stage })
    .from(o)
    .where(and(or(gte(o.updatedAtExternal, since), gte(o.insertedAt, since)), sql`${o.stage} not in ('DELETED')`))
    .orderBy(desc(o.insertedAt))
    .limit(5000);
  for (const r of orders) {
    const label = `#${r.systemId ?? r.id} · ${r.name || "Khách"}${r.phone ? ` · ${r.phone}` : ""}`;
    for (const tag of r.tags ?? []) {
      if (!stripIgnored(tag, rules.ignorePatterns)) continue;
      const kind = matchKind(tag, rules.tagRules);
      if (kind) out.push({ dedupeKey: `pk-tag:${r.id}:${kind}`, orderId: r.id, customerId: r.customerId, kind, source: "PANCAKE_TAG", title: `${CS_KIND_LABEL[kind]} · ${label}`, detail: `Thẻ đơn Pancake: "${tag}"`, customerName: r.name ?? "", customerPhone: r.phone ?? "" });
    }
    const noteText = stripIgnored([r.note, r.notePrint].filter(Boolean).join(" | "), rules.ignorePatterns);
    if (noteText) {
      const kind = matchKind(noteText, rules.noteRules);
      if (kind) out.push({ dedupeKey: `pk-note:${r.id}:${kind}`, orderId: r.id, customerId: r.customerId, kind, source: "PANCAKE_NOTE", title: `${CS_KIND_LABEL[kind]} · ${label}`, detail: `Ghi chú đơn: ${noteText.slice(0, 300)}`, customerName: r.name ?? "", customerPhone: r.phone ?? "" });
    }
  }

  const returns = await db
    .select({ id: schema.orderReturns.id, displayId: schema.orderReturns.displayId, orderId: schema.orderReturns.orderId, isExchange: schema.orderReturns.isExchange, statusName: schema.orderReturns.statusName, name: schema.orderReturns.billFullName, phone: schema.orderReturns.billPhone, fee: schema.orderReturns.returnedFee })
    .from(schema.orderReturns)
    .where(gte(schema.orderReturns.insertedAt, since));
  for (const r of returns) {
    const kind: CsKind = r.isExchange ? "EXCHANGE_COLOR" : "RETURN";
    out.push({ dedupeKey: `pk-return:${r.id}`, orderId: r.orderId, customerId: null, kind, source: "PANCAKE_RETURN", title: `${r.isExchange ? "Đổi hàng" : "Trả hàng"} · phiếu #${r.displayId ?? r.id} · ${r.name || "Khách"}${r.phone ? ` · ${r.phone}` : ""}`, detail: `${r.statusName || ""}${r.fee ? ` · phí hoàn ${r.fee.toLocaleString("vi-VN")}đ` : ""}`.trim(), customerName: r.name ?? "", customerPhone: r.phone ?? "" });
  }
  return out;
}

/** Tạo case mới cho các dấu hiệu chưa có (theo dedupeKey). Trả về số case tạo mới. */
export async function detectCsCases(): Promise<{ created: number; scanned: number }> {
  const db = await getDb();
  const candidates = await collectCsCandidates();
  if (!candidates.length) return { created: 0, scanned: 0 };
  // gộp theo đơn + loại: một đơn cùng loại chỉ một case (ưu tiên nguồn thẻ > ghi chú)
  const seen = new Set<string>();
  const unique = candidates.filter((c) => {
    const k = c.orderId ? `${c.orderId}:${c.kind}` : c.dedupeKey;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const inserted = await db
    .insert(schema.csCases)
    .values(unique.map((c) => ({ ...c, status: "OPEN", createdBy: "auto" })))
    .onConflictDoNothing({ target: schema.csCases.dedupeKey })
    .returning({ id: schema.csCases.id });
  return { created: inserted.length, scanned: candidates.length };
}
