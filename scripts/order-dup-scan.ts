/*
  ops `order-dup-scan` — QUÉT CẶP ĐƠN NGHI TRÙNG CỦA MỘT TỔ CHỨC TRONG N NGÀY (CHỈ ĐỌC).

  Vì sao có (P0 HSLC 24/10/2026): hội thoại c49ccab9… — nhân viên bấm «Trả lại cho AI» (02:47:42Z) rồi lên đơn từ hộp thư ERP (#D2A8DE9B,
  02:47:56Z); lượt AI kế chạy lại tin khách gửi trong lúc người giữ và TỰ CHỐT đơn thứ hai (#A5CC67E2, 02:49:19Z): cùng khách, cùng món,
  cùng tiền, cả hai CONFIRMED. Đường tạo đơn của bot chỉ nhìn trạng thái của chính nó; bộ nghi trùng (`assessDuplicate`) chỉ gắn cờ sau
  đó, trên /work, trong 48 giờ gần nhất. Script này đo PHẠM VI lỗi trong N ngày để người (nhân viên / chủ shop) đối chiếu từng cặp TRONG
  ERP — script KHÔNG huỷ, không sửa, không ghi gì.

  Cặp ứng viên: hai đơn (chưa xoá) gần nhau ≤ `--max-gap-hours` và chung ÍT NHẤT một khoá danh tính: SĐT (9 số cuối — đúng khoá của bộ nghi
  trùng) · hội thoại bán hàng của ERP (`sales_conversation_id`) · hội thoại Pancake (page + `conversation_id`) · khách (`customer_id`).
  Phán quyết lấy ĐÚNG `assessDuplicate` (lib/constants/order-duplicate.ts) — không luật thứ hai. Cặp cùng hội thoại mà khác SĐT vẫn được
  in (phán quyết của bộ nghi trùng là «khác SĐT»), vì cùng hội thoại tự nó là một tín hiệu.

  Nguồn gốc mỗi đơn đọc từ `raw.agentKey` (`sales-chat:` = BOT · `chat:` = form hộp thư của NHÂN VIÊN · khoá khác = đường máy khác ·
  không khoá = đơn đồng bộ / tay) + cột `source` + `origin`.

  Kênh [ops:tom-tat] CHỈ số đếm + tiền tổng — KHÔNG họ tên, SĐT, địa chỉ, mã đơn, mã hội thoại. Mã đơn / mã hội thoại từng cặp chỉ ở phần
  MÃ HOÁ. Mở CSDL tổ chức bằng getDbForInspection (không migrate, không tạo), kiểm phiên chỉ đọc trước khi đọc.
*/
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("order-dup-scan.ts"));
if (CHAY_THANG) process.env.ERP_READ_ONLY = "1";
import "dotenv/config";
import { sql } from "drizzle-orm";
import { getDbForInspection, type Db } from "@/db";
import { manualOrderShortCode } from "@/lib/constants/manual-orders";
import { assessDuplicate, phoneKey, type DuplicateVerdict, type ItemLike } from "@/lib/constants/order-duplicate";
import { PRE_SHIP_STAGES } from "@/lib/constants/pancake";
import { findOrganization } from "@/lib/platform/organizations";
import { rowsOf } from "@/lib/sql-rows";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s.slice(0, 300)}`);

export const DUP_SCAN_DEFAULT_DAYS = 30;
export const DUP_SCAN_MAX_DAYS = 90;
export const DUP_SCAN_DEFAULT_GAP_HOURS = 72;
export const DUP_SCAN_MAX_ORDERS = 20_000;
/** Nhóm theo một khoá quá đông (SĐT dùng chung của shop, khách sỉ) thì không dựng cặp — nói ra số nhóm bị bỏ. */
export const DUP_SCAN_MAX_GROUP = 40;
const USAGE = `<mã tổ chức> [--days=1..${DUP_SCAN_MAX_DAYS} | --since=<ISO UTC, vd 2026-10-24T05:18:18Z>] [--max-gap-hours=1..720]`;

/**
 * `since` (khi có) THAY cho `days`: «từ mốc deploy này, còn sinh cặp mới không». Đơn TRƯỚC mốc trong `maxGapHours` vẫn được
 * đọc để làm ĐƠN TRƯỚC của cặp — một đơn bot tự chốt lúc 05:20 mà đơn người lên lúc 05:10 vẫn phải bị thấy.
 */
export type DupScanArgs = { code: string; days: number; maxGapHours: number; since: Date | null };

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/;

/** `now` là tham số (không đọc đồng hồ bên trong) để bài kiểm không mang hạn sử dụng (AGENTS mục 50). */
export function parseDupScanArgs(argv: readonly string[], now: Date = new Date()): DupScanArgs | { error: string } {
  const code = (argv.find((a) => !a.startsWith("--")) ?? "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(code)) return { error: "thiếu / sai mã tổ chức" };
  const val = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const days = val("days") === undefined ? DUP_SCAN_DEFAULT_DAYS : Number(val("days"));
  if (!Number.isInteger(days) || days < 1 || days > DUP_SCAN_MAX_DAYS) return { error: `--days phải là số nguyên 1..${DUP_SCAN_MAX_DAYS}` };
  const maxGapHours = val("max-gap-hours") === undefined ? DUP_SCAN_DEFAULT_GAP_HOURS : Number(val("max-gap-hours"));
  if (!Number.isInteger(maxGapHours) || maxGapHours < 1 || maxGapHours > 720) return { error: "--max-gap-hours phải là số nguyên 1..720" };
  const sinceRaw = val("since");
  let since: Date | null = null;
  if (sinceRaw !== undefined) {
    // Chỉ nhận mốc UTC có `Z`: «05:18» không múi giờ là đọc theo giờ máy chạy, lệch 7 giờ trên VPS so với máy người gõ.
    if (!ISO_UTC.test(sinceRaw) || Number.isNaN(new Date(sinceRaw).getTime())) return { error: "--since phải là mốc ISO UTC có Z, vd 2026-10-24T05:18:18Z" };
    since = new Date(sinceRaw);
    if (since.getTime() < now.getTime() - DUP_SCAN_MAX_DAYS * 86_400_000) return { error: `--since không được cũ hơn ${DUP_SCAN_MAX_DAYS} ngày` };
  }
  return { code, days, maxGapHours, since };
}

// ─────────────────────────── PHẦN THUẦN ───────────────────────────

export type ScanOrigin = "BOT" | "STAFF_FORM" | "MACHINE_OTHER" | "SYNC_OR_MANUAL";

export function originOf(agentKey: string | null | undefined): ScanOrigin {
  if (!agentKey) return "SYNC_OR_MANUAL";
  if (agentKey.startsWith("sales-chat:")) return "BOT";
  if (agentKey.startsWith("chat:")) return "STAFF_FORM";
  return "MACHINE_OTHER";
}

export type ScanOrder = {
  id: string;
  /** Mã Pancake hiển thị (`orders.system_id`); đơn tạo trên ERP không có ⇒ `null`. */
  systemId: number | null;
  insertedAt: Date;
  stage: string;
  source: string;
  origin: ScanOrigin;
  phone: string;
  receiverName: string;
  address: string;
  total: number;
  customerId: string | null;
  pageId: string | null;
  pancakeConversationId: string | null;
  salesConversationId: string | null;
  items: ItemLike[];
  /** Vận đơn chiều đi đã rời kho (khác PENDING / CANCELLED). */
  leftWarehouse: boolean;
  delivered: boolean;
  codCollected: number;
  paid: number;
};

export type ScanPair = {
  keeper: ScanOrder;
  suspect: ScanOrder;
  gapMinutes: number;
  verdict: DuplicateVerdict;
  signals: string[];
  sameSalesConversation: boolean;
  samePancakeConversation: boolean;
  sameCustomer: boolean;
  /** Cả hai đơn còn hiệu lực (không huỷ). */
  bothActive: boolean;
};

const DEAD = new Set(["CANCELLED", "DELETED"]);

/**
 * Mã đơn ĐÚNG như ERP in ở danh sách đơn (`app/(dashboard)/orders/columns.tsx`): `#` + mã Pancake, đơn tạo trên ERP thì
 * `#` + 8 ký tự `manualOrderShortCode` (vd `#D2A8DE9B`). Người đối chiếu gõ đúng chuỗi này vào ô tìm của /orders — mã cắt
 * 4 ký tự kiểu `erp-d2a8` không tra được ở đâu cả. Chỉ in ở phần MÃ HOÁ.
 */
export function orderLabel(o: Pick<ScanOrder, "id" | "systemId">): string {
  return `#${o.systemId ?? manualOrderShortCode(o.id)}`;
}

/** Đơn đã huỷ (hoặc đã xoá) — lượt quét lại sau khi nhân viên xử lý đếm được còn bao nhiêu cặp. */
export const isCancelled = (o: Pick<ScanOrder, "stage">) => DEAD.has(o.stage);

/** Dựng cặp ứng viên — HÀM THUẦN, tất định (sắp theo mốc rồi mã), mỗi cặp đúng một lần dù chung nhiều khoá. */
export function findCandidatePairs(orders: readonly ScanOrder[], maxGapHours: number): { pairs: ScanPair[]; skippedGroups: number } {
  const byKey = new Map<string, ScanOrder[]>();
  const add = (k: string | null, o: ScanOrder) => {
    if (!k) return;
    const list = byKey.get(k) ?? [];
    list.push(o);
    byKey.set(k, list);
  };
  for (const o of orders) {
    const p = phoneKey(o.phone);
    add(p ? `phone:${p}` : null, o);
    add(o.salesConversationId ? `sconv:${o.salesConversationId}` : null, o);
    add(o.pageId && o.pancakeConversationId ? `pconv:${o.pageId}|${o.pancakeConversationId}` : null, o);
    add(o.customerId ? `cust:${o.customerId}` : null, o);
  }
  const seen = new Set<string>();
  const pairs: ScanPair[] = [];
  let skippedGroups = 0;
  const maxGapMs = maxGapHours * 3_600_000;
  for (const list of byKey.values()) {
    if (list.length < 2) continue;
    if (list.length > DUP_SCAN_MAX_GROUP) {
      skippedGroups++;
      continue;
    }
    const sorted = [...list].sort((a, b) => a.insertedAt.getTime() - b.insertedAt.getTime() || a.id.localeCompare(b.id));
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const keeper = sorted[i];
        const suspect = sorted[j];
        const gap = suspect.insertedAt.getTime() - keeper.insertedAt.getTime();
        if (gap > maxGapMs) break;
        const key = `${keeper.id}|${suspect.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const a = assessDuplicate(
          { orderId: keeper.id, insertedAt: keeper.insertedAt, phone: keeper.phone, receiverName: keeper.receiverName, address: keeper.address, total: keeper.total, items: keeper.items },
          { orderId: suspect.id, insertedAt: suspect.insertedAt, phone: suspect.phone, receiverName: suspect.receiverName, address: suspect.address, total: suspect.total, items: suspect.items },
        );
        const sameSalesConversation = Boolean(keeper.salesConversationId && keeper.salesConversationId === suspect.salesConversationId);
        const samePancakeConversation = Boolean(keeper.pageId && keeper.pancakeConversationId && keeper.pageId === suspect.pageId && keeper.pancakeConversationId === suspect.pancakeConversationId);
        // Cặp in ra: bộ nghi trùng nói trùng / có thể trùng, HOẶC cùng hội thoại (tự nó là tín hiệu dù khác SĐT).
        if (a.verdict === "DISTINCT" && !sameSalesConversation && !samePancakeConversation) continue;
        pairs.push({
          keeper,
          suspect,
          gapMinutes: Math.round(gap / 60_000),
          verdict: a.verdict,
          signals: a.signals,
          sameSalesConversation,
          samePancakeConversation,
          sameCustomer: Boolean(keeper.customerId && keeper.customerId === suspect.customerId),
          bothActive: !DEAD.has(keeper.stage) && !DEAD.has(suspect.stage),
        });
      }
    }
  }
  pairs.sort((x, y) => x.suspect.insertedAt.getTime() - y.suspect.insertedAt.getTime() || x.suspect.id.localeCompare(y.suspect.id));
  return { pairs, skippedGroups };
}

export type ScanSummary = {
  orders: number;
  pairs: number;
  byVerdict: Record<string, number>;
  sameConversation: number;
  byOriginCombo: Record<string, number>;
  bothActiveSuspected: number;
  /** Cặp nghi trùng mà ĐƠN SAU đã huỷ — đã xử lý theo cách thường gặp nhất. */
  suspectCancelledSuspected: number;
  /** Cặp nghi trùng mà ĐƠN TRƯỚC đã huỷ (giữ đơn sau). */
  keeperCancelledSuspected: number;
  /** Tiền hàng của đơn SAU trong các cặp nghi trùng còn hiệu lực cả hai — tiền có thể bị giao / thu hai lần. */
  moneyAtRisk: number;
  suspectLeftWarehouse: number;
  suspectDelivered: number;
  suspectCodCollected: number;
  suspectPaid: number;
};

export function summarize(orders: number, pairs: readonly ScanPair[]): ScanSummary {
  const byVerdict: Record<string, number> = {};
  const byOriginCombo: Record<string, number> = {};
  let sameConversation = 0;
  let bothActiveSuspected = 0;
  let suspectCancelledSuspected = 0;
  let keeperCancelledSuspected = 0;
  let moneyAtRisk = 0;
  let suspectLeftWarehouse = 0;
  let suspectDelivered = 0;
  let suspectCodCollected = 0;
  let suspectPaid = 0;
  for (const p of pairs) {
    byVerdict[p.verdict] = (byVerdict[p.verdict] ?? 0) + 1;
    const combo = [p.keeper.origin, p.suspect.origin].join("→");
    byOriginCombo[combo] = (byOriginCombo[combo] ?? 0) + 1;
    if (p.sameSalesConversation || p.samePancakeConversation) sameConversation++;
    if (p.verdict === "DUPLICATE_SUSPECTED" && isCancelled(p.suspect)) suspectCancelledSuspected++;
    if (p.verdict === "DUPLICATE_SUSPECTED" && isCancelled(p.keeper)) keeperCancelledSuspected++;
    if (p.verdict === "DUPLICATE_SUSPECTED" && p.bothActive) {
      bothActiveSuspected++;
      moneyAtRisk += p.suspect.total;
      if (p.suspect.leftWarehouse) suspectLeftWarehouse++;
      if (p.suspect.delivered) suspectDelivered++;
      suspectCodCollected += p.suspect.codCollected;
      suspectPaid += p.suspect.paid;
    }
  }
  return { orders, pairs: pairs.length, byVerdict, sameConversation, byOriginCombo, bothActiveSuspected, suspectCancelledSuspected, keeperCancelledSuspected, moneyAtRisk, suspectLeftWarehouse, suspectDelivered, suspectCodCollected, suspectPaid };
}

/** Cặp MỚI kể từ `since`: ĐƠN SAU tạo từ mốc đó. «BOT sau người» = đơn sau do bot, đơn trước KHÔNG do bot — đúng ca P0 HSLC 24/10. */
export function newPairStats(pairs: readonly ScanPair[], since: Date) {
  const moi = pairs.filter((p) => p.suspect.insertedAt.getTime() >= since.getTime());
  const botSauNguoi = (list: readonly ScanPair[]) => list.filter((p) => p.suspect.origin === "BOT" && p.keeper.origin !== "BOT").length;
  const nghiTrung = moi.filter((p) => p.verdict === "DUPLICATE_SUSPECTED");
  return { pairs: moi.length, botAfterHuman: botSauNguoi(moi), suspected: nghiTrung.length, suspectedBotAfterHuman: botSauNguoi(nghiTrung) };
}

export type GuardBlockRow = { step: string | null; same: string | null; n: number | string };

/** Gộp số lần rào hội thoại chặn bot (`SALES_CHAT_DUPLICATE_ORDER_BLOCKED`) theo bước và «cùng đề xuất» — chỉ số đếm. */
export function guardBlockStats(rows: readonly GuardBlockRow[]) {
  const out = { total: 0, create: 0, createSame: 0, confirm: 0, confirmSame: 0, other: 0 };
  for (const r of rows) {
    const n = Number(r.n) || 0;
    const same = r.same === "true";
    out.total += n;
    if (r.step === "CREATE") {
      out.create += n;
      if (same) out.createSame += n;
    } else if (r.step === "CONFIRM") {
      out.confirm += n;
      if (same) out.confirmSame += n;
    } else out.other += n;
  }
  return out;
}

// ─────────────────────────── ĐỌC CSDL ───────────────────────────

const vnd = (n: number) => `${Math.round(n).toLocaleString("vi-VN")} ₫`;
const vnTime = (d: Date) => new Date(d.getTime() + 7 * 3_600_000).toISOString().slice(0, 16).replace("T", " ");
const short = (id: string | null) => (id ? id.slice(0, 8) : "—");

type OrderRaw = {
  id: string;
  system_id: number | string | null;
  inserted_at: string | Date;
  stage: string;
  source: string;
  agent_key: string | null;
  bill_phone: string | null;
  bill_full_name: string | null;
  ship_address: string | null;
  total: number | string | null;
  customer_id: string | null;
  page_id: string | null;
  conversation_id: string | null;
  sales_conversation_id: string | null;
  prepaid: number | string | null;
  transfer_money: number | string | null;
};

async function loadOrders(db: Db, since: Date): Promise<{ orders: ScanOrder[]; capped: boolean }> {
  const raw = rowsOf<OrderRaw>(
    await db.execute(sql`
      select o.id, o.system_id, o.inserted_at, o.stage::text as stage, o.source, o.raw->>'agentKey' as agent_key, o.bill_phone, o.bill_full_name,
             o.ship_address, o.total_price_after_discount as total, o.customer_id, o.page_id, o.conversation_id, o.sales_conversation_id,
             o.prepaid, o.transfer_money
        from orders o
       where o.inserted_at >= ${since.toISOString()}::timestamptz
         and o.stage::text <> 'DELETED'
       order by o.inserted_at asc
       limit ${DUP_SCAN_MAX_ORDERS + 1}
    `),
  );
  const capped = raw.length > DUP_SCAN_MAX_ORDERS;
  const list = capped ? raw.slice(0, DUP_SCAN_MAX_ORDERS) : raw;
  const n = (v: unknown) => (Number.isFinite(Number(v ?? 0)) ? Number(v ?? 0) : 0);
  const orders: ScanOrder[] = list.map((r) => ({
    id: r.id,
    systemId: r.system_id === null || r.system_id === undefined ? null : Number(r.system_id),
    insertedAt: new Date(r.inserted_at),
    stage: r.stage,
    source: r.source,
    origin: originOf(r.agent_key),
    phone: r.bill_phone ?? "",
    receiverName: r.bill_full_name ?? "",
    address: r.ship_address ?? "",
    total: n(r.total),
    customerId: r.customer_id,
    pageId: r.page_id,
    pancakeConversationId: r.conversation_id,
    salesConversationId: r.sales_conversation_id,
    items: [],
    leftWarehouse: false,
    delivered: false,
    codCollected: 0,
    paid: n(r.prepaid) + n(r.transfer_money),
  }));
  return { orders, capped };
}

async function attachDetails(db: Db, orders: ScanOrder[]): Promise<void> {
  const byId = new Map(orders.map((o) => [o.id, o]));
  const ids = [...byId.keys()];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const list = sql.join(chunk.map((id) => sql`${id}`), sql`, `);
    const items = rowsOf<{ order_id: string; variant_id: string | null; sku: string; product_name: string; variation_detail: string; quantity: number }>(
      await db.execute(sql`select order_id, variant_id, sku, product_name, variation_detail, quantity from order_items where order_id in (${list}) and is_bonus = false`),
    );
    for (const it of items) byId.get(it.order_id)?.items.push({ variantId: it.variant_id, sku: it.sku, productName: it.product_name, variationDetail: it.variation_detail, quantity: Number(it.quantity) });
    const ships = rowsOf<{ order_id: string; stage: string; cod_collected: number | string | null }>(
      await db.execute(sql`select order_id, stage::text as stage, cod_collected from shipments where order_id in (${list}) and coalesce(direction, 'OUTBOUND') <> 'RETURN'`),
    );
    for (const s of ships) {
      const o = byId.get(s.order_id);
      if (!o) continue;
      if (s.stage !== "PENDING" && s.stage !== "CANCELLED") o.leftWarehouse = true;
      if (s.stage === "DELIVERED") o.delivered = true;
      o.codCollected += Number(s.cod_collected ?? 0) || 0;
    }
  }
}

/**
 * Dòng do `lib/sales-chatbot/conversation-order-guard.ts::auditConversationOrderBlock` ghi; `audit()` đặt `after` BÊN TRONG
 * cột `detail` (lib/audit.ts), nên đường đọc là `detail->'after'->>…`.
 */
async function loadGuardBlocks(db: Db, since: Date): Promise<GuardBlockRow[]> {
  return rowsOf<GuardBlockRow>(
    await db.execute(sql`
      select l.detail->'after'->>'step' as step, l.detail->'after'->>'sameAsProposal' as same, count(*)::int as n
        from audit_logs l
       where l.action = 'SALES_CHAT_DUPLICATE_ORDER_BLOCKED'
         and l.created_at >= ${since.toISOString()}::timestamptz
       group by 1, 2
    `),
  );
}

/**
 * `since` = mốc ĐỌC (đơn trước cũng phải có mặt). `newSince` (tuỳ chọn, vd mốc deploy) = mốc tính cặp MỚI và mốc đếm rào;
 * không có thì cả hai lấy `since`.
 */
export async function runOrderDupScan(db: Db, opts: { since: Date; maxGapHours: number; label: string; now: Date; newSince?: Date | null }) {
  const { orders, capped } = await loadOrders(db, opts.since);
  await attachDetails(db, orders);
  const { pairs, skippedGroups } = findCandidatePairs(orders, opts.maxGapHours);
  const s = summarize(orders.length, pairs);
  const preship = new Set<string>(PRE_SHIP_STAGES);
  const liveCutoff = opts.now.getTime() - 48 * 3_600_000;

  console.log(`══ CẶP NGHI TRÙNG (${opts.label}, khoảng cách ≤ ${opts.maxGapHours} giờ) — mã đơn / mã hội thoại CHỈ ở phần mã hoá ══`);
  for (const p of pairs) {
    const k = p.keeper;
    const x = p.suspect;
    const ship = (o: ScanOrder) => (o.delivered ? "đã giao" : o.leftWarehouse ? "đã rời kho" : "chưa rời kho");
    const inLive = x.insertedAt.getTime() >= liveCutoff && preship.has(x.stage) && !x.leftWarehouse;
    const moi = opts.newSince && x.insertedAt.getTime() >= opts.newSince.getTime() ? " · MỚI (sau mốc)" : "";
    console.log(
      [
        `${vnTime(x.insertedAt)} VN · ${p.verdict} [${p.signals.join(",")}] · cách ${p.gapMinutes} phút${moi}`,
        `  đơn trước ${orderLabel(k)} · ${k.origin} · «${k.source}» · ${k.stage} · ${vnd(k.total)} · ${ship(k)} · COD đã thu ${vnd(k.codCollected)} · trả trước ${vnd(k.paid)}`,
        `  đơn sau   ${orderLabel(x)} · ${x.origin} · «${x.source}» · ${x.stage} · ${vnd(x.total)} · ${ship(x)} · COD đã thu ${vnd(x.codCollected)} · trả trước ${vnd(x.paid)} · đơn sau đã huỷ ${isCancelled(x) ? "RỒI" : "CHƯA"}`,
        `  cùng hội thoại ERP ${p.sameSalesConversation ? `CÓ (${short(k.salesConversationId)})` : "không"} · cùng hội thoại Pancake ${p.samePancakeConversation ? "CÓ" : "không"} · cùng khách ${p.sameCustomer ? "CÓ" : "không"} · cả hai còn hiệu lực ${p.bothActive ? "CÓ" : "không"} · đang trong hàng nghi trùng /work (48 giờ) ${inLive ? "CÓ" : "không"}`,
      ].join("\n"),
    );
  }

  const fmt = (r: Record<string, number>) =>
    Object.entries(r)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([k, v]) => `${k} ${v}`)
      .join(" · ") || "—";
  tomTat(`order-dup-scan ${opts.label}: ${s.orders}${capped ? "+ (chạm trần)" : ""} đơn chưa xoá · ${s.pairs} cặp ứng viên (≤ ${opts.maxGapHours} giờ)${skippedGroups ? ` · bỏ ${skippedGroups} nhóm > ${DUP_SCAN_MAX_GROUP} đơn` : ""}`);
  tomTat(`Theo phán quyết bộ nghi trùng: ${fmt(s.byVerdict)} · cùng hội thoại ${s.sameConversation}`);
  tomTat(`Theo nguồn gốc (đơn trước→đơn sau): ${fmt(s.byOriginCombo)}`);
  tomTat(`NGHI TRÙNG ${s.byVerdict.DUPLICATE_SUSPECTED ?? 0} cặp: đơn sau đã huỷ ${s.suspectCancelledSuspected} · đơn trước đã huỷ ${s.keeperCancelledSuspected} · cả hai còn hiệu lực ${s.bothActiveSuspected}`);
  tomTat(`NGHI TRÙNG, cả hai còn hiệu lực: ${s.bothActiveSuspected} cặp · tiền hàng đơn sau ${vnd(s.moneyAtRisk)} · đơn sau đã rời kho ${s.suspectLeftWarehouse} · đã giao ${s.suspectDelivered} · COD đã thu ${vnd(s.suspectCodCollected)} · trả trước ${vnd(s.suspectPaid)}`);
  const mocMoi = opts.newSince ?? opts.since;
  if (opts.newSince) {
    const m = newPairStats(pairs, opts.newSince);
    tomTat(`cặp mới từ ${opts.newSince.toISOString()}: ${m.pairs} (BOT sau người: ${m.botAfterHuman}) · trong đó nghi trùng ${m.suspected} (BOT sau người: ${m.suspectedBotAfterHuman})`);
  }
  const rao = guardBlockStats(await loadGuardBlocks(db, mocMoi));
  tomTat(`rào hội thoại chặn bot từ ${mocMoi.toISOString()}: ${rao.total} lần · CREATE ${rao.create} (cùng đề xuất ${rao.createSame}) · CONFIRM ${rao.confirm} (cùng đề xuất ${rao.confirmSame})${rao.other ? ` · bước khác ${rao.other}` : ""}`);
  tomTat("Danh sách từng cặp (mã đơn, nguồn, trạng thái vận đơn / tiền) ở phần MÃ HOÁ — không huỷ / sửa đơn nào; người đối chiếu trong ERP.");
  return { summary: s, pairs, capped, skippedGroups, guardBlocks: rao };
}

async function thoat(code: number): Promise<never> {
  // Xả stdout RỒI mới thoát: stdout vào ống là ghi bất đồng bộ — `process.exit()` ngay sau console.log cắt mất khối tóm tắt cuối.
  await new Promise<void>((done) => process.stdout.write("", () => done()));
  process.exit(code);
}

async function main() {
  const now = new Date();
  const args = parseDupScanArgs(process.argv.slice(2), now);
  if ("error" in args) {
    tomTat(`order-dup-scan: DỪNG · cách dùng sai — ${args.error} (arg: ${USAGE})`);
    return thoat(1);
  }
  const org = await findOrganization(args.code);
  if (!org) {
    tomTat(`order-dup-scan: DỪNG · không có tổ chức «${args.code}»`);
    return thoat(1);
  }
  const db: Db = await getDbForInspection({ code: org.code, isHome: org.isHome });
  const [ro] = rowsOf<Record<string, unknown>>(await db.execute(sql`show default_transaction_read_only`));
  if (String(ro?.default_transaction_read_only ?? "") !== "on") {
    tomTat("order-dup-scan: DỪNG · phiên CSDL KHÔNG ở chế độ chỉ đọc — không đọc gì");
    return thoat(1);
  }
  if (args.since) {
    // Đọc lùi thêm đúng khoảng ghép cặp trước mốc: đơn trước của một cặp mới có thể nằm trước mốc.
    const doc = new Date(args.since.getTime() - args.maxGapHours * 3_600_000);
    await runOrderDupScan(db, { since: doc, newSince: args.since, maxGapHours: args.maxGapHours, label: `từ ${args.since.toISOString()} tới ${now.toISOString()} (đọc lùi ${args.maxGapHours} giờ để ghép cặp)`, now });
    return thoat(0);
  }
  const since = new Date(now.getTime() - args.days * 86_400_000);
  await runOrderDupScan(db, { since, maxGapHours: args.maxGapHours, label: `${args.days} ngày tới ${now.toISOString()}`, now });
  return thoat(0);
}

// Chỉ chạy khi được gọi THẲNG từ dòng lệnh — `import` từ bài kiểm không được kéo theo `process.exit`.
if (CHAY_THANG) {
  main().catch(async (e) => {
    console.error("order-dup-scan lỗi:", e instanceof Error ? e.message : e);
    tomTat("order-dup-scan: LỖI ngoài phép đo — chi tiết trong phần mã hoá");
    await thoat(1);
  });
}
