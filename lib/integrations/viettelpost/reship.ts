/**
 * ═══════════ VẬN ĐƠN TẠO LẠI TRÊN WEB VIETTEL POST — GẮN VỀ ĐÚNG ĐƠN (P0 chủ shop 22/10/2026) ═══════════
 *
 * Đo production 22/10/2026 (code-erp-95): 330 vận đơn mồ côi «PKE» là vận đơn shop TẠO LẠI trên viettelpost.vn
 * cho CHÍNH đơn của mình. Mã vận đơn mới là số VTP 12 chữ, còn `ORDER_REFERENCE` (cột «Mã đơn hàng» của tệp) là
 * SỐ VẬN ĐƠN GỐC (PKE…) của một vận đơn ERP ĐÃ có đơn — 330/330 khớp đúng một vận đơn gốc, 1:1 với 330 đơn.
 * Đường ghép cũ chỉ so tham chiếu với `orders.id / custom_id / system_id`, nên trượt và đẻ ra dòng mồ côi; đơn
 * Pancake gốc thì bị huỷ hoặc đứng «Đã gửi hàng» ⇒ GTC tụt đúng bằng số đơn ấy.
 *
 * MỘT luật cho HAI đường (AGENTS 49): webhook (`applyVtpTracking`) và nhập tệp «Danh sách vận đơn»
 * (`matchVtpOrderList`) — và cho script vá dòng cũ (chạy thử trước). Hàm `reshipParentOf` là HÀM THUẦN; phần đọc
 * CSDL (`reshipCandidates`) chỉ gom ứng viên.
 *
 * Luật:
 *  · Mã chiều hoàn `[số]P[số]` (`legBaseCode`) KHÔNG BAO GIỜ đi nhánh này — Viettel Post cũng ghi mã gốc vào tham
 *    chiếu của vận đơn chiều hoàn, và đó là một dòng RIÊNG không đơn (AGENTS 3.7), không phải lần gửi kế.
 *  · Tham chiếu trùng `vtp_order_number` (mã DO VIETTEL POST CẤP, duy nhất) của vận đơn CÓ đơn, chiều đi ⇒ ứng viên.
 *    `tracking_code` chỉ được so khi dòng đó CHƯA có `vtp_order_number` (vận đơn Pancake chỉ mang mã tra cứu): cột
 *    «Mã đơn hàng» là mã VTP tự sinh và đã từng tình cờ trùng `tracking_code` của vận đơn thuộc ĐƠN KHÁC (ca
 *    PKE1508295104 → PKE10911261809, chú thích ở `matchVtpOrderList`). Đúng MỘT đơn ⇒ lần gửi kế của đơn đó. Nhiều
 *    đơn ⇒ KHÔNG đoán (giữ mồ côi, ghi lý do).
 *  · SĐT người nhận phải KHỚP (9 số cuối) khi CẢ HAI bên đều có ⇒ khác người nhận thì giữ mồ côi. Webhook VTP không
 *    gửi RECEIVER_PHONE (đo 22/10/2026, run 39809848044) nên ở đường webhook vế này hầu như không kích hoạt — hàng
 *    rào THẬT của webhook là mã do VTP cấp + AMBIGUOUS; vế SĐT chủ yếu có tác dụng ở đường nhập tệp.
 * *  · Đa tổ chức: ứng viên đọc bằng CSDL `db` mà nơi gọi truyền vào (CSDL của tổ chức đang xử lý) — vận đơn tổ chức khác
 *    không bao giờ là ứng viên; tệp này không tự mở CSDL nào.
 */
import { and, isNotNull, or, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { audit } from "@/lib/audit";
import { materializeShipmentState } from "@/lib/integrations/viettelpost/state";
import { rematerializeOutcomes } from "@/lib/queries/canonical-outcome";
import { legBaseCode } from "@/lib/integrations/viettelpost/statement";

export type ReshipCandidate = {
  id: string;
  orderId: string | null;
  vtpOrderNumber: string | null;
  trackingCode: string | null;
  direction: string | null;
  /** SĐT người nhận của vận đơn gốc / đơn (ưu tiên vận đơn, rồi đơn). */
  phone: string | null;
};

export type ReshipInput = { orderNumber: string; orderReference: string | null | undefined; receiverPhone: string | null | undefined };

export const RESHIP_HOLD_REASONS = ["AMBIGUOUS", "PHONE_MISMATCH"] as const;
export type ReshipHoldReason = (typeof RESHIP_HOLD_REASONS)[number];

export type ReshipVerdict =
  | { kind: "ATTEMPT"; orderId: string; parentShipmentId: string }
  /** Không phải vận đơn gửi lại (không tham chiếu · chiều hoàn · tự tham chiếu · không có vận đơn gốc) ⇒ đường cũ. */
  | { kind: "NONE"; reason: "NO_REFERENCE" | "RETURN_LEG" | "SELF_REFERENCE" | "NO_PARENT" }
  /** Có dấu hiệu gửi lại nhưng không đủ chắc ⇒ giữ mồ côi + lý do, người quyết. */
  | { kind: "HOLD"; reason: ReshipHoldReason; candidates: number };

export const RESHIP_HOLD_TEXT: Record<ReshipHoldReason, string> = {
  AMBIGUOUS: "Mã tham chiếu trùng vận đơn của nhiều đơn — không đoán, giữ mồ côi",
  PHONE_MISMATCH: "Mã tham chiếu trùng một vận đơn gốc nhưng SĐT người nhận khác — không gắn, giữ mồ côi",
};

/** 9 số cuối: đủ phân biệt thuê bao mà không lệ thuộc 0 / 84 / +84 hay khoảng trắng. */
export function phoneTail(value: string | null | undefined): string {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length >= 9 ? digits.slice(-9) : "";
}

const up = (v: string | null | undefined) => String(v ?? "").trim().toUpperCase();

/** Tham chiếu chỉ vào vận đơn này: trùng mã VTP cấp; mã tra cứu chỉ tính khi dòng chưa có mã VTP. */
function referencedBy(c: Pick<ReshipCandidate, "vtpOrderNumber" | "trackingCode">, ref: string): boolean {
  const vtp = up(c.vtpOrderNumber);
  return vtp ? vtp === ref : up(c.trackingCode) === ref;
}

/** Vận đơn mới này có phải LẦN GỬI KẾ của một vận đơn ERP đã có đơn không. HÀM THUẦN. */
export function reshipParentOf(input: ReshipInput, candidates: readonly ReshipCandidate[]): ReshipVerdict {
  const ref = up(input.orderReference);
  const code = up(input.orderNumber);
  if (!ref) return { kind: "NONE", reason: "NO_REFERENCE" };
  if (legBaseCode(code)) return { kind: "NONE", reason: "RETURN_LEG" };
  if (ref === code) return { kind: "NONE", reason: "SELF_REFERENCE" };
  const pool = candidates.filter((c) => c.orderId && (c.direction ?? "OUTBOUND") !== "RETURN" && referencedBy(c, ref));
  if (!pool.length) return { kind: "NONE", reason: "NO_PARENT" };
  const orders = new Set(pool.map((c) => c.orderId));
  if (orders.size > 1) return { kind: "HOLD", reason: "AMBIGUOUS", candidates: orders.size };
  const parent = [...pool].sort((a, b) => (up(a.vtpOrderNumber) === ref ? 0 : 1) - (up(b.vtpOrderNumber) === ref ? 0 : 1) || (a.id < b.id ? -1 : 1))[0];
  const mine = phoneTail(input.receiverPhone);
  const theirs = phoneTail(parent.phone);
  if (mine && theirs && mine !== theirs) return { kind: "HOLD", reason: "PHONE_MISMATCH", candidates: 1 };
  return { kind: "ATTEMPT", orderId: parent.orderId!, parentShipmentId: parent.id };
}

/** Ứng viên vận đơn gốc cho các mã tham chiếu (theo mã VIẾT HOA). Chỉ vận đơn CÓ đơn. Không ghi. */
export async function reshipCandidates(db: Db, refs: readonly string[]): Promise<Map<string, ReshipCandidate[]>> {
  const keys = [...new Set(refs.map(up).filter(Boolean))];
  const out = new Map<string, ReshipCandidate[]>();
  if (!keys.length) return out;
  const s = schema.shipments;
  const o = schema.orders;
  const rows = await db
    .select({
      id: s.id,
      orderId: s.orderId,
      vtpOrderNumber: s.vtpOrderNumber,
      trackingCode: s.trackingCode,
      direction: s.direction,
      phone: sql<string | null>`coalesce(nullif(${s.receiverPhone}, ''), nullif(${o.shipPhone}, ''), nullif(${o.billPhone}, ''))`,
    })
    .from(s)
    .leftJoin(o, sql`${o.id} = ${s.orderId}`)
    .where(
      and(
        isNotNull(s.orderId),
        or(sql`upper(${s.vtpOrderNumber}) in (${sql.join(keys.map((k) => sql`${k}`), sql`, `)})`, sql`upper(${s.trackingCode}) in (${sql.join(keys.map((k) => sql`${k}`), sql`, `)})`),
      ),
    );
  for (const r of rows) {
    for (const k of keys.filter((x) => referencedBy(r, x))) {
      const list = out.get(k) ?? [];
      list.push(r);
      out.set(k, list);
    }
  }
  return out;
}

/** Số thứ tự lần gửi kế của một đơn (lần gửi lớn nhất + 1; đơn chưa đánh số coi như lần 1). */
export async function nextAttemptNo(db: Pick<Db, "select">, orderId: string): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`coalesce(max(coalesce(${schema.shipments.attemptNo}, 1)), 0)::int` })
    .from(schema.shipments)
    .where(sql`${schema.shipments.orderId} = ${orderId}`);
  return Number(r?.n ?? 0) + 1;
}

/** Vết trên `shipments.raw` của dòng do luật này tạo — chỉ để người đọc / đo, KHÔNG luật kết quả nào đọc nó. */
export function reshipTrace(v: ReshipVerdict, source: string, at: Date): Record<string, unknown> {
  if (v.kind === "ATTEMPT") return { reship: { of: v.parentShipmentId, by: source, at: at.toISOString() } };
  if (v.kind === "HOLD") return { relink: { status: v.reason, candidates: v.candidates, note: RESHIP_HOLD_TEXT[v.reason], by: source, at: at.toISOString() } };
  return {};
}

export type RelinkOrphanResult = { ok: true; orderId: string; attemptNo: number } | { ok: false; why: "NOT_ATTEMPT" | "NOT_FOUND" | "ALREADY_LINKED" | "RETURN_LEG" };

/**
 * GẮN MỘT DÒNG MỒ CÔI CÓ SẴN về đơn theo phán quyết `ATTEMPT` — đường ghi của script vá dòng cũ (chạy thử trước, phiên
 * code-erp-95). Đường webhook / tệp TẠO dòng mới bằng cùng phán quyết; hàm này SỬA dòng đã có, cùng một tệp lõi.
 *  · Khoá dòng trong giao dịch; chỉ ghi khi dòng còn `order_id IS NULL` ⇒ chạy lại không ghi gì (`ALREADY_LINKED`).
 *  · Không tạo dòng, không đụng `shipment_events`. Trạng thái của dòng gốc và dòng vừa gắn dựng lại từ lịch sử
 *    (`materializeShipmentState` — người ghi DUY NHẤT của chặng), KẾT QUẢ ĐƠN dựng lại ngay (`rematerializeOutcomes` —
 *    báo cáo vốn đã rơi về tính trực tiếp nhờ điều kiện tươi mới, nhưng ai đọc thẳng `canonical_order_outcome`, kể cả
 *    phép đo SAU của script, sẽ thấy kết luận cũ tới lượt job `outcome-materialize` kế — tối đa 5 phút), rồi một dòng
 *    `audit_logs`. Đường webhook KHÔNG dựng lại tại chỗ: VTP đòi trả lời < 1 giây; job 5 phút nhặt đơn có đầu vào đổi.
 */
export async function relinkOrphanShipment(
  db: Db,
  p: { shipmentId: string; verdict: ReshipVerdict; source: string; reason: string; actor: string; now?: Date },
): Promise<RelinkOrphanResult> {
  const v = p.verdict;
  if (v.kind !== "ATTEMPT") return { ok: false, why: "NOT_ATTEMPT" };
  const now = p.now ?? new Date();
  const out = await db.transaction(async (tx): Promise<RelinkOrphanResult> => {
    const s = schema.shipments;
    const [row] = await tx.select({ id: s.id, orderId: s.orderId, code: s.vtpOrderNumber }).from(s).where(sql`${s.id} = ${p.shipmentId}`).limit(1).for("update");
    if (!row) return { ok: false, why: "NOT_FOUND" };
    if (row.orderId !== null) return { ok: false, why: "ALREADY_LINKED" };
    if (legBaseCode(row.code ?? "")) return { ok: false, why: "RETURN_LEG" };
    const attemptNo = await nextAttemptNo(tx, v.orderId);
    await tx
      .update(s)
      .set({ orderId: v.orderId, attemptNo, direction: "OUTBOUND", raw: sql`coalesce(${s.raw}, '{}'::jsonb) || ${JSON.stringify(reshipTrace(v, p.source, now))}::jsonb`, updatedAt: now })
      .where(sql`${s.id} = ${row.id} and ${s.orderId} is null`);
    return { ok: true, orderId: v.orderId, attemptNo };
  });
  if (!out.ok) return out;
  await materializeShipmentState(db, p.shipmentId);
  await materializeShipmentState(db, v.parentShipmentId);
  await rematerializeOutcomes([out.orderId]);
  await audit({
    userId: null,
    userEmail: p.actor,
    actorKind: "SYSTEM",
    action: "SHIPMENT_RESHIP_RELINK",
    entity: "SHIPMENT",
    entityId: p.shipmentId,
    before: { orderId: null },
    after: { orderId: out.orderId, attemptNo: out.attemptNo, parentShipmentId: v.parentShipmentId },
    reason: p.reason,
  });
  return out;
}

export type LinkOrphanResult = { ok: true; orderId: string; attemptNo: number } | { ok: false; why: "NOT_FOUND" | "ALREADY_LINKED" | "RETURN_LEG" | "PHONE_MISMATCH" | "ORDER_NOT_FOUND" };

/**
 * NGƯỜI GẮN TAY một vận đơn mồ côi vào một đơn (vtp-direct-sync (4), 25/10/2026 — nút «Gắn đơn» trên /shipments). Cùng luật với
 * `relinkOrphanShipment`: khoá dòng, chỉ ghi khi còn `order_id IS NULL`, chiều hoàn không bao giờ gắn, đánh số lần gửi kế, dựng lại
 * trạng thái + kết quả đơn, một dòng `audit_logs` mang khoá NGƯỜI bấm. Khác ở chỗ đơn do người chọn (không cần vận đơn gốc) nên chặn
 * thêm một vế: SĐT người nhận của vận đơn và SĐT của đơn đều có mà KHÁC nhau ⇒ không gắn (webhook không mang SĐT, nên thiếu một bên
 * thì người bấm là bằng chứng). Không bao giờ ghép theo tên.
 */
export async function linkOrphanToOrder(
  db: Db,
  p: { shipmentId: string; orderId: string; actor: { id: string | null; email: string }; reason: string; now?: Date },
): Promise<LinkOrphanResult> {
  const now = p.now ?? new Date();
  const out = await db.transaction(async (tx): Promise<LinkOrphanResult> => {
    const s = schema.shipments;
    const o = schema.orders;
    const [row] = await tx.select({ id: s.id, orderId: s.orderId, code: s.vtpOrderNumber, phone: s.receiverPhone }).from(s).where(sql`${s.id} = ${p.shipmentId}`).limit(1).for("update");
    if (!row) return { ok: false, why: "NOT_FOUND" };
    if (row.orderId !== null) return { ok: false, why: "ALREADY_LINKED" };
    if (legBaseCode(row.code ?? "")) return { ok: false, why: "RETURN_LEG" };
    const [don] = await tx.select({ id: o.id, ship: o.shipPhone, bill: o.billPhone }).from(o).where(sql`${o.id} = ${p.orderId}`).limit(1);
    if (!don) return { ok: false, why: "ORDER_NOT_FOUND" };
    const mine = phoneTail(row.phone);
    const theirs = phoneTail(don.ship) || phoneTail(don.bill);
    if (mine && theirs && mine !== theirs) return { ok: false, why: "PHONE_MISMATCH" };
    const attemptNo = await nextAttemptNo(tx, don.id);
    await tx
      .update(s)
      .set({ orderId: don.id, attemptNo, direction: "OUTBOUND", raw: sql`coalesce(${s.raw}, '{}'::jsonb) || ${JSON.stringify({ manualLink: { orderId: don.id, by: p.actor.email, at: now.toISOString() } })}::jsonb`, updatedAt: now })
      .where(sql`${s.id} = ${row.id} and ${s.orderId} is null`);
    return { ok: true, orderId: don.id, attemptNo };
  });
  if (!out.ok) return out;
  await materializeShipmentState(db, p.shipmentId);
  await rematerializeOutcomes([out.orderId]);
  await audit({
    userId: p.actor.id,
    userEmail: p.actor.email,
    action: "SHIPMENT_MANUAL_LINK",
    entity: "SHIPMENT",
    entityId: p.shipmentId,
    before: { orderId: null },
    after: { orderId: out.orderId, attemptNo: out.attemptNo },
    reason: p.reason,
  });
  return out;
}
