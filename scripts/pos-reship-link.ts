/**
 * ═══════════ OPS `pos-reship-link` — GẮN MÃ VẬN ĐƠN VTP TẠO LẠI VÀO ĐƠN PANCAKE POS (P0 «VTP → ERP → POSCake → Pancake», 22/10/2026) ═══════════
 *
 * Gốc: shop tạo LẠI vận đơn trên web Viettel Post cho chính đơn Pancake (vận đơn mới mang `order_reference` = mã vận đơn GỐC). Đơn POS vẫn
 * mang mã gốc (hoặc không mã) ⇒ bot nhà / nhân viên đọc POS thấy mã cũ. Script ghi khối `partner` của đơn POS = mã vận đơn MỚI qua
 * `PUT /shops/{SHOP_ID}/orders/{ORDER_ID}` (spec OpenAPI chính thức: «chỉ field được gửi mới được ghi; field không gửi giữ nguyên»).
 *
 * MỘT LUẬT GHÉP, Ở ERP — POS CHỈ ĐI THEO. Script KHÔNG tự ghép vận đơn mới với vận đơn gốc: ứng viên là đơn có LẦN GỬI CHÍNH
 * (`PRIMARY_ATTEMPT` — cùng luật với `vanDonDaiDien` của bot) mang vết `raw.reship` (dấu mà luật gắn lần gửi kế ghi ở CẢ BA đường:
 * webhook, nhập tệp, vá dòng cũ — chỉ đường vá dòng cũ có thêm audit `SHIPMENT_RESHIP_RELINK`). Bản đầu tự ghép bằng
 * `order_reference` đã đếm 698 «cặp» trong khi thật chỉ 330: 368 dòng còn lại là CHẶNG HOÀN `…P…` (đo 22/10/2026) — ghi chúng
 * vào POS là gắn mã chiều hoàn vào đơn. Hai luật ghép là đúng thứ không được có.
 *
 * Luật (quyết định Tech Lead + chủ shop duyệt pilot 22/10/2026):
 *  · MẶC ĐỊNH CHẠY THỬ: đếm cặp từ CSDL, đọc tối đa `--limit` (mặc định 20) đơn trên POS để in kế hoạch — không ghi gì;
 *  · `--apply` BẮT BUỘC kèm `--limit=N`; chỉ ghi `partner.order_number_vtp` — KHÔNG BAO GIỜ đổi `status`, KHÔNG đụng `extend_code`
 *    (`extend_code` là mã DO PANCAKE CẤP, khác mã Viettel Post — lib/constants/viettelpost.ts; chạy thử 23/10/2026: 20/20 đơn mang
 *    `order_number_vtp` = mã GỐC còn `extend_code` = PKE1094… / PKE9008… — ghi đè nó là đổi định danh của Pancake, không phải gắn mã);
 *    (đổi trạng thái có thể làm Pancake trừ tồn / sinh doanh thu lần nữa — chưa xác minh thì không làm);
 *  · chỉ ghi khi `order_number_vtp` trên POS TRỐNG hoặc ĐÚNG mã gốc — mã lạ (ĐVVC khác, nhân viên đã sửa) ⇒ không đè, đếm riêng;
 *  · đúng mã mới rồi ⇒ không PUT (idempotent); đọc lại NGAY sau PUT, so mọi field khác trước / sau; ghi nhật ký ERP (audit);
 *  · mỗi đơn đúng MỘT lần gửi chính (`PRIMARY_ATTEMPT`), cùng CSDL nhà; không in tên / SĐT.
 *  · audit lưu NGUYÊN khối `partner` trước và sau PUT; `--rollback --order=<id>` PUT lại đúng `order_number_vtp` cũ theo dòng audit gần
 *    nhất — CHỈ khi POS đang mang đúng mã mới script đã ghi (mã khác ⇒ không đụng), mã cũ trống ⇒ không gửi null.
 *  · `--peek --order=<id>` (CHỈ ĐỌC, 23/10/2026 — sau pilot ba khoá customer / items / warehouse_info đổi mà không biết vì sao): in VÂN
 *    TAY từng khoá con (băm; chỉ in giá trị số / boolean, customer chỉ băm) để so hai lần đọc cách nhau, và so dòng hàng / tổng tiền POS
 *    (qua CHÍNH `mapOrder` của đường đồng bộ) với `order_items` / `orders` của ERP.
 * arg: `[--apply] [--limit=1..1000] [--pilot] [--order=<mã đơn POS>]` · `--rollback --order=<mã đơn POS>` · `--peek --order=<mã đơn POS>`. `--pilot` = lần gửi chính
 * ĐÃ GIAO + vận đơn gốc ĐÃ HUỶ.
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { mapOrder } from "@/lib/integrations/pancake/mapper";
import { getDb, schema, type Db } from "@/db";
import { PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import { env } from "@/lib/env";
import { asRecord, fetchJson, sleep } from "@/lib/integrations/http";
import { maskPancakeKey } from "@/lib/constants/pancake-pos-org";
import { assertHomeCredentials } from "@/lib/platform/credentials";
import { audit } from "@/lib/audit";
import { rowsOf } from "@/lib/sql-rows";

const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("pos-reship-link.ts"));
// Chạy thử ⇒ phiên CSDL chỉ đọc từ lần mở đầu tiên. `--apply` cần ghi nhật ký (audit) nên không ép.
if (CHAY_THANG && !process.argv.includes("--apply") && !process.argv.includes("--rollback")) process.env.ERP_READ_ONLY = "1";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s.slice(0, 300)}`);
const THROTTLE_MS = 400;

// ─────────────────────────── HÀM THUẦN ───────────────────────────

export type ReshipArgs = { apply: boolean; limit: number; pilot: boolean; order: string | null; rollback: boolean; peek: boolean } | { error: string };

/** Đối số. `--apply` không kèm `--limit` ⇒ lỗi (không bao giờ ghi hàng loạt vì quên một cờ). HÀM THUẦN. */
export function parseReshipArgs(argv: readonly string[]): ReshipArgs {
  const val = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? null;
  const apply = argv.includes("--apply");
  const rawLimit = val("limit");
  if (apply && rawLimit === null) return { error: "--apply bắt buộc kèm --limit=N (pilot: --limit=1)" };
  const limit = rawLimit === null ? 20 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return { error: "--limit phải là số nguyên 1..1000" };
  const order = val("order");
  if (order !== null && !/^[0-9A-Za-z_-]{1,40}$/.test(order)) return { error: "--order là mã đơn POS (chữ số / chữ, ≤ 40 ký tự)" };
  const rollback = argv.includes("--rollback");
  if (rollback && (apply || argv.includes("--pilot"))) return { error: "--rollback không đi cùng --apply / --pilot" };
  if (rollback && order === null) return { error: "--rollback bắt buộc kèm --order=<mã đơn POS> (gỡ từng đơn một)" };
  const peek = argv.includes("--peek");
  if (peek && (apply || rollback || argv.includes("--pilot"))) return { error: "--peek là CHỈ ĐỌC — không đi cùng --apply / --rollback / --pilot" };
  if (peek && order === null) return { error: "--peek bắt buộc kèm --order=<mã đơn POS>" };
  return { apply, limit, pilot: argv.includes("--pilot"), order, rollback, peek };
}

export type PosPartner = { extend_code: string | null; order_number_vtp: string | null };
export type LinkPlan = "ALREADY" | "LINK" | "FOREIGN_CODE";

const clean = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().toUpperCase() : null);

/** Khối partner hiện có của một đơn POS (chỉ hai mã). HÀM THUẦN. */
export function partnerOf(order: Record<string, unknown>): PosPartner {
  const p = asRecord(order.partner);
  return { extend_code: clean(p.extend_code), order_number_vtp: clean(p.order_number_vtp) };
}

/**
 * Việc với một đơn — CHỈ xét `order_number_vtp` (mã Viettel Post; bot nhà đọc ô này trước `extend_code`): đã = mã mới ⇒ ALREADY; TRỐNG
 * hoặc = mã GỐC ⇒ LINK; mã khác cả hai ⇒ FOREIGN_CODE (không đè — ĐVVC khác hoặc nhân viên đã sửa tay). `extend_code` không tham gia:
 * đó là mã do Pancake cấp. Không đọc được mã gốc (`null`) ⇒ chỉ ô TRỐNG mới gắn. HÀM THUẦN.
 */
export function linkPlan(current: PosPartner, oldCode: string | null, newCode: string): LinkPlan {
  const o = clean(oldCode);
  const n = newCode.toUpperCase();
  const c = clean(current.order_number_vtp);
  if (c === n) return "ALREADY";
  return c === null || (o !== null && c === o) ? "LINK" : "FOREIGN_CODE";
}

/** Thân PUT: CHỈ `partner.order_number_vtp`. Không status, không `extend_code`, không field nào khác. HÀM THUẦN. */
export function linkBody(newCode: string): { partner: { order_number_vtp: string } } {
  return { partner: { order_number_vtp: newCode } };
}

/** Khối của đơn POS được lấy vân tay (đúng ba khoá đổi sau pilot 23/10/2026 + khối partner). */
const PEEK_BLOCKS = ["customer", "items", "warehouse_info", "partner"] as const;

export type Fingerprint = { path: string; h: string; v: string | null };

/**
 * Vân tay từng khoá con của các khối trong PEEK_BLOCKS: `path` (vd `items[0].variation_info.retail_price`) · `h` = băm 12 ký tự của giá trị ·
 * `v` = giá trị CHỈ khi là số / boolean và KHÔNG thuộc `customer` (khối khách chỉ băm — không in tên / SĐT / địa chỉ dưới bất kỳ dạng nào).
 * Sâu tối đa hai tầng (items[i].x.y). So hai lần đọc theo `path` + `h` là biết khoá NÀO đổi mà không lộ giá trị. HÀM THUẦN.
 */
export function fingerprintOrder(order: Record<string, unknown>): Fingerprint[] {
  const out: Fingerprint[] = [];
  const h = (x: unknown) => createHash("sha256").update(JSON.stringify(x ?? null)).digest("hex").slice(0, 12);
  const put = (path: string, x: unknown, showable: boolean) => out.push({ path, h: h(x), v: showable && (typeof x === "number" || typeof x === "boolean") ? String(x) : null });
  const walk = (prefix: string, x: unknown, depth: number, showable: boolean) => {
    if (depth > 0 && Array.isArray(x)) return x.forEach((e, i) => walk(`${prefix}[${i}]`, e, depth - 1, showable));
    if (depth > 0 && x && typeof x === "object") return Object.entries(x as Record<string, unknown>).forEach(([k, e]) => walk(`${prefix}.${k}`, e, depth - 1, showable));
    put(prefix, x, showable);
  };
  for (const b of PEEK_BLOCKS) walk(b, order[b], b === "items" ? 3 : 2, b !== "customer");
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export type LineSummary = { variantId: string | null; quantity: number; unitPrice: number; lineTotal: number };
export type MoneyCheck = { linesMatch: boolean; totalsMatch: boolean; diffs: string[] };

/** Dòng hàng + tổng tiền POS (qua `mapOrder`) so với ERP. Lệch SL / đơn giá / mẫu mã / tổng ⇒ liệt kê TÊN chỗ lệch. HÀM THUẦN. */
export function compareMoney(pos: { lines: LineSummary[]; totalPrice: number; cod: number }, erp: { lines: LineSummary[]; totalPrice: number | null; cod: number | null }): MoneyCheck {
  const key = (l: LineSummary) => `${l.variantId ?? "?"}|${l.quantity}|${l.unitPrice}|${l.lineTotal}`;
  const a = pos.lines.map(key).sort();
  const b = erp.lines.map(key).sort();
  const diffs: string[] = [];
  if (a.length !== b.length) diffs.push(`số dòng ${a.length}≠${b.length}`);
  a.forEach((k, i) => {
    if (k !== b[i]) diffs.push(`dòng ${i + 1}`);
  });
  if (erp.totalPrice !== pos.totalPrice) diffs.push("total_price");
  if (erp.cod !== pos.cod) diffs.push("cod");
  return { linesMatch: !diffs.some((d) => d.startsWith("dòng") || d.startsWith("số dòng")), totalsMatch: !diffs.includes("total_price") && !diffs.includes("cod"), diffs };
}

/** `--peek --order=<id>`: CHỈ ĐỌC — vân tay khoá con + so tiền / dòng hàng POS ↔ ERP. Không PUT, không audit. */
async function runPeek(orderId: string): Promise<boolean> {
  const order = await pos("GET", orderId);
  const fp = fingerprintOrder(order);
  for (const f of fp) console.log(`peek ${orderId} ${f.path} ${f.h}${f.v !== null ? ` ${f.v}` : ""}`);
  const m = mapOrder(order);
  const db = await getDb();
  const erpLines = rowsOf<{ variant_id: string | null; quantity: number | string; unit_price: number | string; line_total: number | string }>(
    await db.execute(sql`select variant_id, quantity, unit_price, line_total from order_items where order_id = ${orderId}`),
  ).map((r) => ({ variantId: r.variant_id, quantity: Number(r.quantity), unitPrice: Number(r.unit_price), lineTotal: Number(r.line_total) }));
  const [o] = rowsOf<{ total_price: number | string | null; cod: number | string | null }>(await db.execute(sql`select total_price, cod from orders where id = ${orderId}`));
  const chk = m
    ? compareMoney(
        { lines: m.items.map((i) => ({ variantId: i.variantId, quantity: i.quantity, unitPrice: i.unitPrice, lineTotal: i.lineTotal })), totalPrice: m.totalPrice, cod: m.cod },
        { lines: erpLines, totalPrice: o?.total_price == null ? null : Number(o.total_price), cod: o?.cod == null ? null : Number(o.cod) },
      )
    : { linesMatch: false, totalsMatch: false, diffs: ["mapOrder không đọc được đơn"] };
  console.log(`peek ${orderId} so-ERP dòng ${chk.linesMatch ? "khớp" : "LỆCH"} · tổng ${chk.totalsMatch ? "khớp" : "LỆCH"}${chk.diffs.length ? ` · ${chk.diffs.join(", ")}` : ""}`);
  tomTat(`pos-reship-link XEM (chỉ đọc) · ${fp.length} khoá con · dòng hàng POS↔ERP ${chk.linesMatch ? "khớp" : "LỆCH"} · tổng tiền ${chk.totalsMatch ? "khớp" : "LỆCH"}`);
  return true;
}

/** Thân PUT của rollback: CHỈ `partner.order_number_vtp` = mã cũ ghi trong audit. HÀM THUẦN. */
export function rollbackBody(oldCode: string): { partner: { order_number_vtp: string } } {
  return { partner: { order_number_vtp: oldCode } };
}

export type RollbackPlan = "ROLLBACK" | "ALREADY" | "NO_RECORD" | "NO_OLD_CODE" | "FOREIGN_CODE";

/**
 * Gỡ một lượt gắn theo dòng audit gần nhất: POS đang = mã MỚI script đã ghi ⇒ ROLLBACK; đã = mã cũ ⇒ ALREADY; không có dòng audit ⇒
 * NO_RECORD; mã cũ trống ⇒ NO_OLD_CODE (không gửi null — chưa xác minh Pancake xử lý null ở ô này ra sao); mã khác cả hai ⇒ FOREIGN_CODE
 * (có người / lượt khác đã sửa sau script — không đè). HÀM THUẦN.
 */
export function rollbackPlan(current: PosPartner, rec: { oldCode: string | null; newCode: string } | null): RollbackPlan {
  if (!rec) return "NO_RECORD";
  const o = clean(rec.oldCode);
  const n = clean(rec.newCode);
  const c = clean(current.order_number_vtp);
  if (o === null) return "NO_OLD_CODE";
  if (c === o) return "ALREADY";
  return c === n ? "ROLLBACK" : "FOREIGN_CODE";
}

/**
 * Field được phép đổi sau PUT (mã VTP + dấu vết sửa của Pancake). Mọi field KHÁC đổi ⇒ báo — kể cả `partner.extend_code`: spec nói field
 * không gửi giữ nguyên, nhưng với khối lồng `partner` thì chưa xác minh, và pilot 1 đơn phải lộ ra nếu PUT xoá mất nó.
 */
const EXPECTED_CHANGE = new Set(["partner.order_number_vtp", "partner.updated_at", "updated_at", "last_editor", "last_editor_id", "histories", "status_history", "viewing"]);

/** Khoá (dạng a.b) có giá trị khác nhau giữa hai ảnh chụp đơn, trừ các field được phép đổi. Chỉ TÊN khoá — không in giá trị. HÀM THUẦN. */
export function unexpectedChanges(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const out: string[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    if (k === "partner") {
      const b = asRecord(before.partner);
      const a = asRecord(after.partner);
      for (const pk of new Set([...Object.keys(b), ...Object.keys(a)])) {
        const key = `partner.${pk}`;
        if (!EXPECTED_CHANGE.has(key) && JSON.stringify(b[pk] ?? null) !== JSON.stringify(a[pk] ?? null)) out.push(key);
      }
      continue;
    }
    if (EXPECTED_CHANGE.has(k)) continue;
    if (JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null)) out.push(k);
  }
  return out.sort();
}

// ─────────────────────────── PHẦN CSDL + POS ───────────────────────────

export type ReshipPair = { orderId: string; oldCode: string | null; newCode: string; newStage: string; oldStage: string | null; viaAudit: boolean };

/**
 * Ứng viên: đơn Pancake (không phải đơn `erp-`) mà LẦN GỬI CHÍNH (`PRIMARY_ATTEMPT`) là lần gửi kế do luật gắn của ERP tạo / gắn
 * (`raw.reship.of` = vận đơn gốc), chiều đi, mã VTP không phải chặng hoàn `…P…`. Script KHÔNG ghép gì — mã gốc chỉ đọc theo
 * `raw.reship.of`. CHỈ ĐỌC.
 */
export async function readPairs(db: Db): Promise<{ pairs: ReshipPair[] }> {
  const rows = rowsOf<{ order_id: string; old_code: string | null; new_code: string; new_stage: string; old_stage: string | null; via_audit: boolean }>(
    await db.execute(sql`select "orders"."id" as order_id, "shipments"."vtp_order_number" as new_code, "shipments"."stage"::text as new_stage,
        g.vtp_order_number as old_code, g.stage::text as old_stage,
        exists (select 1 from audit_logs a where a.action = 'SHIPMENT_RESHIP_RELINK' and a.entity_id = "shipments"."id") as via_audit
      from "shipments"
      join "orders" on "orders"."id" = "shipments"."order_id" and ${PRIMARY_ATTEMPT}
      left join shipments g on g.id = "shipments"."raw" -> 'reship' ->> 'of'
      where "shipments"."raw" -> 'reship' ->> 'of' is not null
        and "shipments"."vtp_order_number" is not null and "shipments"."vtp_order_number" !~ '[0-9]P[0-9]+$'
        and coalesce("shipments"."direction"::text, 'OUTBOUND') <> 'RETURN' and "orders"."id" not like 'erp-%'
      order by "shipments"."created_at" desc nulls last, "shipments"."id"`),
  );
  return { pairs: rows.map((r) => ({ orderId: String(r.order_id), oldCode: r.old_code, newCode: String(r.new_code), newStage: r.new_stage, oldStage: r.old_stage, viaAudit: Boolean(r.via_audit) })) };
}

let lastCall = 0;
/** Gọi POS của TỔ CHỨC NHÀ. Mọi câu lỗi đã che khoá (khoá nằm trong query của URL). */
async function pos(method: "GET" | "PUT", orderId: string, body?: unknown): Promise<Record<string, unknown>> {
  await assertHomeCredentials("pancake");
  const wait = THROTTLE_MS - (Date.now() - lastCall);
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  const key = env.pancake.apiKey ?? "";
  const url = new URL(`${env.pancake.baseUrl.replace(/\/$/, "")}/shops/${env.pancake.shopId}/orders/${encodeURIComponent(orderId)}`);
  url.searchParams.set("api_key", key);
  try {
    const { body: res } = await fetchJson(url, { serviceName: "Pancake", timeoutMs: 60_000, method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), retries: method === "GET" ? 2 : 0 });
    const r = asRecord(res);
    if (r.success === false) throw new Error(`POS từ chối: ${String(r.message ?? "").slice(0, 120)}`);
    return asRecord(r.data ?? r);
  } catch (e) {
    throw new Error(maskPancakeKey(e instanceof Error ? e.message : String(e), key).slice(0, 200));
  }
}

/** Dòng audit gắn mã gần nhất của một đơn (mã cũ / mã mới). Không có ⇒ `null`. CHỈ ĐỌC. */
export async function lastLinkRecord(db: Db, orderId: string): Promise<{ oldCode: string | null; newCode: string } | null> {
  const a = schema.auditLogs;
  const [row] = await db.select({ detail: a.detail }).from(a).where(and(eq(a.action, "pos.reship_link"), eq(a.entityId, orderId))).orderBy(desc(a.createdAt)).limit(1);
  const d = asRecord(row?.detail);
  return typeof d.newCode === "string" ? { oldCode: typeof d.oldCode === "string" ? d.oldCode : null, newCode: d.newCode } : null;
}

/** `--rollback --order=<id>`: PUT lại mã cũ theo audit, đọc lại, so field, ghi audit riêng. */
async function runRollback(orderId: string, runId: string): Promise<boolean> {
  const rec = await lastLinkRecord(await getDb(), orderId);
  const before = await pos("GET", orderId);
  const plan = rollbackPlan(partnerOf(before), rec);
  tomTat(`pos-reship-link GỠ · kế hoạch ${plan}`);
  console.log(`đơn ${orderId}: ${plan} · POS hiện ${partnerOf(before).order_number_vtp ?? "—"} · audit cũ ${rec?.oldCode ?? "—"} → mới ${rec?.newCode ?? "—"}`);
  if (plan !== "ROLLBACK" || !rec?.oldCode) return plan === "ALREADY";
  await pos("PUT", orderId, rollbackBody(rec.oldCode));
  const after = await pos("GET", orderId).catch(() => null);
  const ok = Boolean(after && partnerOf(after).order_number_vtp === clean(rec.oldCode));
  const other = after ? unexpectedChanges(before, after) : ["(không đọc lại được)"];
  console.log(`đơn ${orderId}: gỡ ${ok ? "ĐÚNG mã cũ" : "CHƯA đúng mã cũ"} · field khác đổi: ${other.length ? other.join(", ") : "không"}`);
  tomTat(`pos-reship-link GỠ · đọc lại ${ok ? "đúng" : "CHƯA đúng"} mã cũ · số field khác bị đổi ${other.length}`);
  await audit({
    userEmail: "script:pos-reship-link",
    action: "pos.reship_link.rollback",
    entity: "order",
    entityId: orderId,
    before: { partner: asRecord(before.partner) },
    after: after ? { partner: asRecord(after.partner) } : null,
    reason: "Gỡ lượt gắn mã vận đơn tạo lại — PUT lại order_number_vtp cũ theo dòng audit pos.reship_link gần nhất",
    correlationId: runId,
    detail: { oldCode: rec.oldCode, newCode: rec.newCode, readbackOk: ok, otherFieldsChanged: other },
  }).catch((e: unknown) => console.log(`đơn ${orderId}: ghi nhật ký lỗi — ${e instanceof Error ? e.message : e}`));
  return ok;
}

export async function runReshipLink(args: Exclude<ReshipArgs, { error: string }>, runId: string): Promise<boolean> {
  if (args.rollback && args.order) return runRollback(args.order, runId);
  if (args.peek && args.order) return runPeek(args.order);
  const { pairs: all } = await readPairs(await getDb());
  const delivered = all.filter((p) => p.newStage === "DELIVERED").length;
  const cancelledOld = all.filter((p) => p.oldStage === "CANCELLED").length;
  const viaAudit = all.filter((p) => p.viaAudit).length;
  const pilotSet = all.filter((p) => p.newStage === "DELIVERED" && p.oldStage === "CANCELLED");
  tomTat(`pos-reship-link ${args.apply ? "GHI" : "CHẠY THỬ"} · đơn có lần gửi chính do ERP gắn ${all.length} (có audit vá dòng cũ ${viaAudit}) · lần gửi chính đã giao ${delivered} · gốc đã huỷ ${cancelledOld} · cả hai (nhóm pilot) ${pilotSet.length}`);
  let chon = args.pilot ? pilotSet : all;
  if (args.order) chon = chon.filter((p) => p.orderId === args.order);
  chon = chon.slice(0, args.limit);
  const dem = { ALREADY: 0, LINK: 0, FOREIGN_CODE: 0, READ_FAIL: 0, PUT_OK: 0, PUT_FAIL: 0, READBACK_OK: 0, READBACK_MISMATCH: 0, OTHER_FIELDS_CHANGED: 0 };
  for (const p of chon) {
    let before: Record<string, unknown>;
    try {
      before = await pos("GET", p.orderId);
    } catch (e) {
      dem.READ_FAIL += 1;
      console.log(`đơn ${p.orderId}: không đọc được trên POS — ${e instanceof Error ? e.message : e}`);
      continue;
    }
    const cur = partnerOf(before);
    const plan = linkPlan(cur, p.oldCode, p.newCode);
    dem[plan] += 1;
    console.log(`đơn ${p.orderId}: ${plan} · POS hiện ${cur.order_number_vtp ?? "—"}/${cur.extend_code ?? "—"} · gốc ${p.oldCode ?? "—"} (${p.oldStage ?? "—"}) → mới ${p.newCode} (${p.newStage})${p.viaAudit ? " · vá dòng cũ" : ""}`);
    if (!args.apply || plan !== "LINK") continue;
    try {
      await pos("PUT", p.orderId, linkBody(p.newCode));
      dem.PUT_OK += 1;
    } catch (e) {
      dem.PUT_FAIL += 1;
      console.log(`đơn ${p.orderId}: PUT lỗi — ${e instanceof Error ? e.message : e}`);
      continue;
    }
    // Đọc lại NGAY: đúng mã chưa, và field nào KHÁC đã đổi (chỉ tên khoá).
    const after = await pos("GET", p.orderId).catch(() => null);
    const now = after ? partnerOf(after) : null;
    const ok = Boolean(now && now.order_number_vtp === p.newCode.toUpperCase());
    if (ok) dem.READBACK_OK += 1;
    else dem.READBACK_MISMATCH += 1;
    const other = after ? unexpectedChanges(before, after) : ["(không đọc lại được)"];
    if (other.length) dem.OTHER_FIELDS_CHANGED += 1;
    console.log(`đơn ${p.orderId}: đọc lại ${ok ? "ĐÚNG mã mới" : "CHƯA đúng mã mới"} · field khác đổi: ${other.length ? other.join(", ") : "không"}`);
    await audit({
      userEmail: "script:pos-reship-link",
      action: "pos.reship_link",
      entity: "order",
      entityId: p.orderId,
      // NGUYÊN khối partner trước / sau (mã, trạng thái ĐVVC, phí…) — căn cứ để gỡ và để so khi có tranh cãi.
      before: { partner: asRecord(before.partner) },
      after: after ? { partner: asRecord(after.partner) } : null,
      reason: "Vận đơn tạo lại trên web Viettel Post cho chính đơn Pancake — gắn mã MỚI vào khối partner của đơn POS (chủ shop duyệt pilot 22/10/2026)",
      correlationId: runId,
      detail: { oldCode: p.oldCode, newCode: p.newCode, readbackOk: ok, otherFieldsChanged: other },
    }).catch((e: unknown) => console.log(`đơn ${p.orderId}: ghi nhật ký lỗi — ${e instanceof Error ? e.message : e}`));
  }
  tomTat(`pos-reship-link · đã xét ${chon.length}: đã đúng ${dem.ALREADY} · cần gắn ${dem.LINK} · mã lạ (không đè) ${dem.FOREIGN_CODE} · đọc POS lỗi ${dem.READ_FAIL}`);
  if (args.apply) tomTat(`pos-reship-link GHI · PUT thành công ${dem.PUT_OK} · lỗi ${dem.PUT_FAIL} · đọc lại đúng ${dem.READBACK_OK} · chưa đúng ${dem.READBACK_MISMATCH} · đơn có field KHÁC bị đổi ${dem.OTHER_FIELDS_CHANGED}`);
  return dem.PUT_FAIL === 0 && dem.READBACK_MISMATCH === 0;
}

if (CHAY_THANG) {
  const args = parseReshipArgs(process.argv.slice(2));
  const done = (code: number) => process.stdout.write("", () => process.exit(code));
  if ("error" in args) {
    tomTat(`pos-reship-link: ${args.error}`);
    done(2);
  } else {
    runReshipLink(args, `pos-reship-link:${new Date().toISOString()}`).then(
      (ok) => done(ok ? 0 : 1),
      (e: unknown) => {
        console.error("pos-reship-link lỗi:", e instanceof Error ? e.message : e);
        tomTat("pos-reship-link: LỖI — chi tiết trong phần mã hoá");
        done(1);
      },
    );
  }
}
