/**
 * ═══════════ OPS `pos-reship-link` — GẮN MÃ VẬN ĐƠN VTP TẠO LẠI VÀO ĐƠN PANCAKE POS (P0 «VTP → ERP → POSCake → Pancake», 22/10/2026) ═══════════
 *
 * Gốc: shop tạo LẠI vận đơn trên web Viettel Post cho chính đơn Pancake (vận đơn mới mang `order_reference` = mã vận đơn GỐC). Đơn POS vẫn
 * mang mã gốc (hoặc không mã) ⇒ bot nhà / nhân viên đọc POS thấy mã cũ. Script ghi khối `partner` của đơn POS = mã vận đơn MỚI qua
 * `PUT /shops/{SHOP_ID}/orders/{ORDER_ID}` (spec OpenAPI chính thức: «chỉ field được gửi mới được ghi; field không gửi giữ nguyên»).
 *
 * Luật (quyết định Tech Lead + chủ shop duyệt pilot 22/10/2026):
 *  · MẶC ĐỊNH CHẠY THỬ: đếm cặp từ CSDL, đọc tối đa `--limit` (mặc định 20) đơn trên POS để in kế hoạch — không ghi gì;
 *  · `--apply` BẮT BUỘC kèm `--limit=N`; chỉ ghi `partner.extend_code` + `partner.order_number_vtp` — KHÔNG BAO GIỜ đổi `status`
 *    (đổi trạng thái có thể làm Pancake trừ tồn / sinh doanh thu lần nữa — chưa xác minh thì không làm);
 *  · chỉ ghi khi mã hiện có trên POS TRỐNG hoặc ĐÚNG mã gốc — mã lạ (ĐVVC khác, nhân viên đã sửa) ⇒ không đè, đếm riêng;
 *  · đúng mã mới rồi ⇒ không PUT (idempotent); đọc lại NGAY sau PUT, so mọi field khác trước / sau; ghi nhật ký ERP (audit);
 *  · cặp phải MỘT-MỘT (một vận đơn mới ↔ một vận đơn gốc ↔ một đơn), cùng CSDL nhà; không in tên / SĐT.
 * arg: `[--apply] [--limit=1..1000] [--pilot] [--order=<mã đơn POS>]`. `--pilot` = vận đơn mới ĐÃ GIAO + vận đơn gốc ĐÃ HUỶ.
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { env } from "@/lib/env";
import { asRecord, fetchJson, sleep } from "@/lib/integrations/http";
import { maskPancakeKey } from "@/lib/constants/pancake-pos-org";
import { assertHomeCredentials } from "@/lib/platform/credentials";
import { audit } from "@/lib/audit";
import { rowsOf } from "@/lib/sql-rows";

const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("pos-reship-link.ts"));
// Chạy thử ⇒ phiên CSDL chỉ đọc từ lần mở đầu tiên. `--apply` cần ghi nhật ký (audit) nên không ép.
if (CHAY_THANG && !process.argv.includes("--apply")) process.env.ERP_READ_ONLY = "1";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s.slice(0, 300)}`);
const THROTTLE_MS = 400;

// ─────────────────────────── HÀM THUẦN ───────────────────────────

export type ReshipArgs = { apply: boolean; limit: number; pilot: boolean; order: string | null } | { error: string };

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
  return { apply, limit, pilot: argv.includes("--pilot"), order };
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
 * Việc với một đơn: cả hai mã đã = mã mới ⇒ ALREADY; mỗi mã đang TRỐNG hoặc = mã GỐC ⇒ LINK; có mã nào khác cả hai ⇒ FOREIGN_CODE (không đè —
 * có thể là ĐVVC khác hoặc nhân viên đã sửa tay). HÀM THUẦN.
 */
export function linkPlan(current: PosPartner, oldCode: string, newCode: string): LinkPlan {
  const o = oldCode.toUpperCase();
  const n = newCode.toUpperCase();
  const codes = [clean(current.extend_code), clean(current.order_number_vtp)];
  if (codes.every((c) => c === n)) return "ALREADY";
  return codes.every((c) => c === null || c === o || c === n) ? "LINK" : "FOREIGN_CODE";
}

/** Thân PUT: CHỈ khối partner, hai mã. Không status, không field nào khác. HÀM THUẦN. */
export function linkBody(newCode: string): { partner: { extend_code: string; order_number_vtp: string } } {
  return { partner: { extend_code: newCode, order_number_vtp: newCode } };
}

/** Field được phép đổi sau PUT (chính hai mã + dấu vết sửa của Pancake). Mọi field KHÁC đổi ⇒ báo. */
const EXPECTED_CHANGE = new Set(["partner.extend_code", "partner.order_number_vtp", "partner.updated_at", "updated_at", "last_editor", "last_editor_id", "histories", "status_history", "viewing"]);

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

export type ReshipPair = { orderId: string; oldCode: string; newCode: string; newStage: string; oldStage: string };

/** Cặp vận đơn tạo lại ↔ vận đơn gốc (đã gắn đơn) — MỘT-MỘT, chiều đi, không phải chặng hoàn `…P…`. CHỈ ĐỌC. */
async function readPairs(): Promise<{ pairs: ReshipPair[]; notOneToOne: number }> {
  const db = await getDb();
  const rows = rowsOf<{ order_id: string; old_code: string; new_code: string; new_stage: string; old_stage: string; n_per_order: number | string; n_per_new: number | string }>(
    await db.execute(sql`select g.order_id, g.vtp_order_number as old_code, n.vtp_order_number as new_code, n.stage::text as new_stage, g.stage::text as old_stage,
        count(*) over (partition by g.order_id) as n_per_order, count(*) over (partition by n.id) as n_per_new
      from shipments n
      join shipments g on g.vtp_order_number = n.order_reference and g.order_id is not null and g.id <> n.id
      where n.order_reference is not null and n.order_id is null and coalesce(n.direction, 'OUTBOUND') <> 'RETURN' and n.order_reference !~ '[0-9]P[0-9]'
        and n.vtp_order_number is not null and g.order_id not like 'erp-%'
      order by n.created_at desc nulls last, n.id`),
  );
  const one = rows.filter((r) => Number(r.n_per_order) === 1 && Number(r.n_per_new) === 1);
  return { pairs: one.map((r) => ({ orderId: String(r.order_id), oldCode: String(r.old_code), newCode: String(r.new_code), newStage: r.new_stage, oldStage: r.old_stage })), notOneToOne: rows.length - one.length };
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

export async function runReshipLink(args: Exclude<ReshipArgs, { error: string }>, runId: string): Promise<boolean> {
  const { pairs: all, notOneToOne } = await readPairs();
  const delivered = all.filter((p) => p.newStage === "DELIVERED").length;
  const cancelledOld = all.filter((p) => p.oldStage === "CANCELLED").length;
  const pilotSet = all.filter((p) => p.newStage === "DELIVERED" && p.oldStage === "CANCELLED");
  tomTat(`pos-reship-link ${args.apply ? "GHI" : "CHẠY THỬ"} · cặp một-một ${all.length} (không một-một bị loại ${notOneToOne}) · vận đơn mới đã giao ${delivered} · gốc đã huỷ ${cancelledOld} · cả hai (nhóm pilot) ${pilotSet.length}`);
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
    console.log(`đơn ${p.orderId}: ${plan} · POS hiện ${cur.order_number_vtp ?? "—"}/${cur.extend_code ?? "—"} · gốc ${p.oldCode} (${p.oldStage}) → mới ${p.newCode} (${p.newStage})`);
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
    const ok = Boolean(now && now.extend_code === p.newCode.toUpperCase() && now.order_number_vtp === p.newCode.toUpperCase());
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
      before: cur,
      after: now ?? null,
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
