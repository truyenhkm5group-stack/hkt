/*
  ops `shipment-origin-audit` — VẬN ĐƠN CỦA MỘT TỔ CHỨC DO AI TẠO: ERP · POS/Pancake · NGOÀI ERP (CHỈ ĐỌC).

  Vì sao có (chủ shop 18/10/2026, HSLC): «Chưa mặc định tất cả vận đơn đều tạo từ ERP. Hãy đối chiếu read-only dữ liệu ERP,
  Pancake/PosCake, ViettelPost và webhook để xác định vận đơn nào được tạo ngoài ERP. Không tự thay đổi quy trình vận chuyển khi
  chưa xác minh.» Ca thật: đơn 42f28794 «Đã xác nhận» mà thiếu xã ⇒ tuyến giao của ERP GIỮ (NO_WARD) — vậy vận đơn của HSLC thật ra
  đi qua ERP hay đi đường khác?

  CĂN CỨ CÓ THẬT TRONG CSDL (đã đọc mã nguồn — không đoán):
   · ERP tạo: `shipments.raw.carrierCreate` (REQUESTED → CREATED / UNKNOWN; `by` = tài khoản, `null` = máy) — chỉ lõi
     `lib/carriers/engine.ts::createWithSession` ghi (giữ chỗ ~dòng 287–302, ghi mã ~338–344, nhận dòng mồ côi ~352–361); webhook
     VTP / Pancake ghi đè `raw` bằng phép TRẢI nên dấu này không mất (`viettelpost/sync.ts` `raw: { ...existingRaw, vtp }`,
     `pancake/sync.ts` `{ ...existing.raw, pancake }`). Nhật ký `audit_logs.action = 'SHIPMENT_CARRIER_CREATE'` (entity ORDER,
     `detail.after.shipmentId` + `trackingCode`, ~dòng 364) — người bấm và job `shipping-route` (userEmail `job:shipping-route`).
     Mã tham chiếu ERP gửi sang hãng: `vtpReferenceFor` = `ERP<8 ký tự đầu mã đơn>-<lần gửi>` (`lib/constants/carrier-vtp.ts:85`).
   · Pancake / POS: `shipments.raw.pancake` + `last_pancake_sync_at` + `partner_id` + sự kiện nguồn `PANCAKE` — chỉ
     `lib/integrations/pancake/sync.ts` (~dòng 374–470) ghi, và CHỈ cho đơn đồng bộ từ Pancake (không bao giờ cho đơn `erp-`).
   · Hãng: webhook VTP tạo dòng vận đơn khi chưa có (`applyVtpTracking(…, { allowCreate: true })`, `viettelpost/sync.ts:147–170`)
     và giữ bản DATA mới nhất ở `raw.vtp` (có `ORDER_REFERENCE` hãng gửi lại); sự kiện `VTP_WEBHOOK/VTP_POLL/VTP_IMPORT/
     VTP_STATEMENT*`; bảng kê / tệp danh sách vận đơn (`statement-db.ts`). GHN / GHTK KHÔNG tạo dòng: gói tin không khớp vận đơn ERP
     chỉ nằm ở `webhook_events` (`ghn/webhook.ts:82`, `ghtk/webhook.ts:114` — «đơn tạo ngoài ERP, chỉ lưu gói»).
   · KHÔNG nguồn nào ghi «người nào tạo trên trang hãng / trên POS»: ERP không phân biệt được POS với trang viettelpost.vn khi
     đơn không đồng bộ từ Pancake — cả hai rơi vào nhóm CHỈ CÓ CHỨNG TỪ HÃNG. Script nói đúng như vậy, không chia đôi bằng đoán.

  PHÂN LOẠI (danh sách ĐÓNG — `classifyShipmentOrigin`, hàm THUẦN):
   CONFLICT > ERP_CREATED > (lượt tạo ERP chưa xác nhận ⇒ UNKNOWN) > POS_OR_PANCAKE > CARRIER_ONLY_NO_ORDER / CARRIER_ONLY > UNKNOWN.
   CARRIER_ONLY_NO_ORDER (chứng từ hãng, KHÔNG gắn đơn ERP nào) là bằng chứng mạnh nhất của vận đơn tạo ngoài ERP với tổ chức mà
   mọi đơn đều tạo trong ERP (HSLC: 577/577 đơn, 0 đơn đồng bộ — đo 18/10/2026).

  BÁO THÊM: đơn ERP «Đã xác nhận» có vận đơn còn hiệu lực mà tuyến giao ERP ĐANG GIỮ (hỏi bằng CHÍNH `decideShippingRoute`, giả định
  chưa có vận đơn; bước «hãng đã bật» KHÔNG xét vì không đọc trạng thái kết nối) · vận đơn của đơn thiếu xã / tỉnh · GỢI Ý theo SĐT
  (vận đơn không gắn đơn ↔ đơn ERP — chỉ là đầu mối cho người kiểm, KHÔNG dùng để phân loại, mục 45).

  [ops:tom-tat] CHỈ là số đếm (theo nhóm · hãng · ngày). Mã vận đơn, mã đơn ngắn, căn cứ từng dòng CHỈ ở phần MÃ HOÁ. Không in tên,
  SĐT, địa chỉ ở bất kỳ đâu. CHỈ ĐỌC do Postgres ép (`ERP_READ_ONLY=1` trước lần mở kết nối đầu tiên + hỏi lại phiên). Chỉ dùng hàm
  THUẦN của lib (không qua getDb()) nên không cần gắn handle tổ chức.

  arg: `<mã tổ chức> [--days=1..90 | --since=<ISO UTC>]` (mặc định 30 ngày; mốc = lúc ERP biết vận đơn lần đầu, `shipments.created_at`).
*/
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("shipment-origin-audit.ts"));
if (CHAY_THANG) process.env.ERP_READ_ONLY = "1";

import "dotenv/config";
import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
import { getDbForInspection, schema, type Db } from "@/db";
import { findOrganization } from "@/lib/platform/organizations";
import { attemptHoldsOrder, carrierCreateOf, linesWeight, type CarrierCreateState } from "@/lib/constants/carrier-vtp";
import { CARRIER_KEYS } from "@/lib/carriers/types";
import { DEFAULT_SHIPPING_ROUTING, parseShippingRoutingConfig, ROUTE_HOLD_CODES, SHIPPING_ROUTING_SETTING_KEY, type AutoAttemptState, type ShippingRoutingConfig } from "@/lib/constants/shipping-routing";
import { isManualOrderId, manualOrderShortCode, MANUAL_ORDER_ID_PREFIX } from "@/lib/constants/manual-orders";
import { addressReviewOpenOf, decideShippingRoute, orderReviewOpenOf } from "@/lib/shipping/route";
import { normalizeVnPhone } from "@/lib/sales-chatbot/returning";
import { mergeSettingJson } from "@/lib/settings";
import { rowsOf } from "@/lib/sql-rows";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s.slice(0, 300)}`);

export const ORIGIN_DEFAULT_DAYS = 30;
export const ORIGIN_MAX_DAYS = 90;
/** Trần dòng một lượt đọc — vượt thì in rõ «+», không cắt im lặng. */
export const ORIGIN_MAX_ROWS = 20_000;
export const ORIGIN_MAX_HOLD_ORDERS = 2_000;
const DETAIL_MAX_LINES = 600;
const VN_OFFSET_MS = 7 * 3_600_000;
const USAGE = `<mã tổ chức> [--days=1..${ORIGIN_MAX_DAYS} | --since=<ISO UTC>]`;

// ─────────────────────────── PHẦN THUẦN ───────────────────────────

export type OriginArgs = { code: string; days: number; since?: Date };

export function parseOriginArgs(argv: readonly string[]): OriginArgs | { error: string } {
  const code = (argv.find((a) => !a.startsWith("--")) ?? "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(code)) return { error: "thiếu / sai mã tổ chức" };
  const val = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const unknownFlags = argv.filter((a) => a.startsWith("--") && !/^--(days|since)=/.test(a));
  if (unknownFlags.length) return { error: `tham số không nhận: ${unknownFlags.length} mục` };
  const rawDays = val("days");
  const days = rawDays === undefined ? ORIGIN_DEFAULT_DAYS : Number(rawDays);
  if (!Number.isInteger(days) || days < 1 || days > ORIGIN_MAX_DAYS) return { error: `--days phải là số nguyên 1..${ORIGIN_MAX_DAYS}` };
  const rawSince = val("since");
  if (rawSince === undefined) return { code, days };
  const since = new Date(rawSince);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?Z$/.test(rawSince) || Number.isNaN(since.getTime())) return { error: "--since phải là mốc UTC dạng 2026-10-14T08:10Z" };
  return { code, days, since };
}

export const ORIGIN_CLASSES = ["ERP_CREATED", "POS_OR_PANCAKE", "CARRIER_ONLY_NO_ORDER", "CARRIER_ONLY", "CONFLICT", "UNKNOWN"] as const;
export type OriginClass = (typeof ORIGIN_CLASSES)[number];

/** Căn cứ in được — danh sách ĐÓNG (mỗi dòng mang mọi căn cứ QUAN SÁT ĐƯỢC, không chỉ căn cứ quyết định). */
export const ORIGIN_KEYS = [
  "ERP_CREATE_CREATED",
  "ERP_CREATE_REQUESTED",
  "ERP_CREATE_UNKNOWN",
  "AUDIT_CARRIER_CREATE",
  "CARRIER_ECHOED_ERP_REF",
  "ERP_REQUEST_UNCONFIRMED",
  "PANCAKE_RAW",
  "PANCAKE_SYNCED_AT",
  "PANCAKE_PARTNER_ID",
  "PANCAKE_EVENT",
  "CARRIER_EVENT",
  "VTP_RAW",
  "VTP_SYNCED_AT",
  "COD_STATEMENT",
  "WEBHOOK_PACKET_ONLY",
  "NO_ORDER",
  "NO_SOURCE_MARKER",
  "CONFLICT_ERP_AND_PANCAKE",
  "CONFLICT_AUDIT_CODE_MISMATCH",
  "CONFLICT_ERP_ON_NON_ERP_ORDER",
  "CONFLICT_CARRIER_REF_OTHER_ORDER",
  "CONFLICT_CARRIER_REF_NE_ERP_REF",
] as const;
export type OriginKey = (typeof ORIGIN_KEYS)[number];

/** Nguồn sự kiện hành trình là CHỨNG TỪ HÃNG (đặt ở dòng sự kiện bởi webhook / hỏi lại / tệp / bảng kê). Ngoài danh sách ⇒ không tính. */
export const CARRIER_EVENT_SOURCES = ["VTP_WEBHOOK", "VTP_POLL", "VTP_IMPORT", "VTP_STATEMENT", "VTP_STATEMENT_MAIL", "GHN_WEBHOOK", "GHTK_WEBHOOK"] as const;

export type ShipmentEvidence = {
  /** ERP = mã đơn `erp-…` · SYNCED = đơn đồng bộ (Pancake) · NONE = dòng vận đơn không gắn đơn nào. */
  orderKind: "ERP" | "SYNCED" | "NONE";
  /** `manualOrderShortCode` của đơn ERP (8 ký tự in hoa) — `null` với đơn khác. */
  orderShort: string | null;
  code: string;
  erpCreate: { state: CarrierCreateState; reference: string } | null;
  /** Nhật ký SHIPMENT_CARRIER_CREATE khớp dòng này (theo shipmentId, hoặc cùng đơn + cùng mã). */
  erpAudit: { trackingCode: string | null } | null;
  /** Mã tham chiếu HÃNG gửi lại (raw.vtp ORDER_REFERENCE · gói webhook) — không phải cột ERP tự ghi. */
  carrierReference: string | null;
  pancake: { raw: boolean; syncedAt: boolean; partnerId: boolean; event: boolean };
  carrier: { events: boolean; rawVtp: boolean; vtpSyncedAt: boolean; statement: boolean; packetOnly: boolean };
};

export type OriginVerdict = { cls: OriginClass; keys: OriginKey[] };

const ERP_REF_RE = /^ERP([0-9A-F]{8})-\d+$/;

/** Hình dạng mã tham chiếu phía hãng — chỉ nhãn, không in mã. HÀM THUẦN. */
export function referenceShape(ref: string | null | undefined): "ERP" | "DIGITS" | "OTHER" | "NONE" {
  const r = (ref ?? "").trim();
  if (!r) return "NONE";
  if (ERP_REF_RE.test(r.toUpperCase())) return "ERP";
  return /^\d+$/.test(r) ? "DIGITS" : "OTHER";
}

/** Hãng theo danh sách ĐÓNG (cột `shipments.carrier` là chữ tự do từ Pancake). HÀM THUẦN. */
export function carrierBucket(carrier: string | null | undefined): string {
  const c = (carrier ?? "").normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/gi, "d").toLowerCase();
  if (!c.trim()) return "TRONG";
  if (c.includes("viettel") || c === "vtp") return "VTP";
  if (c.includes("ghn") || c.includes("giao hang nhanh")) return "GHN";
  if (c.includes("ghtk") || c.includes("tiet kiem")) return "GHTK";
  if (c.includes("j&t") || /\bjt\b/.test(c) || c.includes("j & t")) return "JT";
  if (c.includes("spx") || c.includes("shopee")) return "SPX";
  if (c.includes("ninja")) return "NINJAVAN";
  if (c.includes("best")) return "BEST";
  if (c.includes("ahamove")) return "AHAMOVE";
  if (c.includes("vnpost") || c.includes("buu dien")) return "VNPOST";
  return "KHAC";
}

/** Ngày giờ Việt Nam `YYYY-MM-DD` của một mốc. HÀM THUẦN. */
export const vnDay = (d: Date) => new Date(d.getTime() + VN_OFFSET_MS).toISOString().slice(0, 10);

/**
 * Nguồn gốc của MỘT vận đơn từ căn cứ đã lưu. HÀM THUẦN, không đoán: thiếu căn cứ ⇒ UNKNOWN (không bao giờ «coi như ERP»).
 *  1. Căn cứ cãi nhau ⇒ CONFLICT (ERP tạo VÀ Pancake ghi · mã trong nhật ký ≠ mã trên dòng · ERP tạo trên đơn không phải đơn ERP ·
 *     hãng gửi lại mã tham chiếu ERP của ĐƠN KHÁC · khác mã tham chiếu ERP đã lưu).
 *  2. ERP tạo xong (`carrierCreate = CREATED`), nhật ký SHIPMENT_CARRIER_CREATE, hoặc hãng gửi lại mã tham chiếu dạng ERP (chỉ ERP
 *     sinh dạng này) ⇒ ERP_CREATED.
 *  3. ERP có gửi yêu cầu (REQUESTED / UNKNOWN) nhưng không gì xác nhận mã NÀY đến từ yêu cầu ấy ⇒ UNKNOWN (ERP_REQUEST_UNCONFIRMED).
 *  4. Dấu Pancake ⇒ POS_OR_PANCAKE.
 *  5. Chỉ có chứng từ hãng ⇒ CARRIER_ONLY_NO_ORDER (không gắn đơn) / CARRIER_ONLY (gắn đơn mà không có dấu tạo nào).
 *  6. Còn lại ⇒ UNKNOWN (NO_SOURCE_MARKER).
 */
export function classifyShipmentOrigin(e: ShipmentEvidence): OriginVerdict {
  const keys: OriginKey[] = [];
  if (e.erpCreate) keys.push(e.erpCreate.state === "CREATED" ? "ERP_CREATE_CREATED" : e.erpCreate.state === "REQUESTED" ? "ERP_CREATE_REQUESTED" : "ERP_CREATE_UNKNOWN");
  if (e.erpAudit) keys.push("AUDIT_CARRIER_CREATE");
  const refShape = referenceShape(e.carrierReference);
  const refShort = refShape === "ERP" ? ERP_REF_RE.exec((e.carrierReference ?? "").trim().toUpperCase())?.[1] ?? null : null;
  if (refShort) keys.push("CARRIER_ECHOED_ERP_REF");
  if (e.pancake.raw) keys.push("PANCAKE_RAW");
  if (e.pancake.syncedAt) keys.push("PANCAKE_SYNCED_AT");
  if (e.pancake.partnerId) keys.push("PANCAKE_PARTNER_ID");
  if (e.pancake.event) keys.push("PANCAKE_EVENT");
  if (e.carrier.events) keys.push("CARRIER_EVENT");
  if (e.carrier.rawVtp) keys.push("VTP_RAW");
  if (e.carrier.vtpSyncedAt) keys.push("VTP_SYNCED_AT");
  if (e.carrier.statement) keys.push("COD_STATEMENT");
  if (e.carrier.packetOnly) keys.push("WEBHOOK_PACKET_ONLY");
  if (e.orderKind === "NONE") keys.push("NO_ORDER");

  const erpRecord = Boolean(e.erpCreate || e.erpAudit);
  const pancake = e.pancake.raw || e.pancake.syncedAt || e.pancake.partnerId || e.pancake.event;
  const carrier = e.carrier.events || e.carrier.rawVtp || e.carrier.vtpSyncedAt || e.carrier.statement || e.carrier.packetOnly;

  const conflicts: OriginKey[] = [];
  if ((erpRecord || refShort) && pancake) conflicts.push("CONFLICT_ERP_AND_PANCAKE");
  if (e.erpAudit?.trackingCode && e.code && e.erpAudit.trackingCode !== e.code) conflicts.push("CONFLICT_AUDIT_CODE_MISMATCH");
  if (erpRecord && e.orderKind !== "ERP") conflicts.push("CONFLICT_ERP_ON_NON_ERP_ORDER");
  if (refShort && ((e.orderKind === "ERP" && e.orderShort !== refShort) || e.orderKind === "SYNCED")) conflicts.push("CONFLICT_CARRIER_REF_OTHER_ORDER");
  if (refShort && e.erpCreate?.reference && e.erpCreate.reference.toUpperCase() !== (e.carrierReference ?? "").trim().toUpperCase()) conflicts.push("CONFLICT_CARRIER_REF_NE_ERP_REF");
  if (conflicts.length) return { cls: "CONFLICT", keys: [...keys, ...conflicts] };

  if (e.erpCreate?.state === "CREATED" || e.erpAudit || refShort) return { cls: "ERP_CREATED", keys };
  if (e.erpCreate) return { cls: "UNKNOWN", keys: [...keys, "ERP_REQUEST_UNCONFIRMED"] };
  if (pancake) return { cls: "POS_OR_PANCAKE", keys };
  if (carrier) return { cls: e.orderKind === "NONE" ? "CARRIER_ONLY_NO_ORDER" : "CARRIER_ONLY", keys };
  return { cls: "UNKNOWN", keys: [...keys, "NO_SOURCE_MARKER"] };
}

/** Đếm theo nhóm, in theo thứ tự ĐÓNG (nhóm 0 vẫn in). HÀM THUẦN. */
export function classCountsText(counts: ReadonlyMap<OriginClass, number>): string {
  return ORIGIN_CLASSES.map((c) => `${c} ${counts.get(c) ?? 0}`).join(" · ");
}

const bump = <K>(m: Map<K, number>, k: K, n = 1) => m.set(k, (m.get(k) ?? 0) + n);
const nested = <K>(m: Map<K, Map<OriginClass, number>>, k: K, c: OriginClass) => {
  if (!m.has(k)) m.set(k, new Map());
  bump(m.get(k)!, c);
};
const shortCls: Record<OriginClass, string> = { ERP_CREATED: "ERP", POS_OR_PANCAKE: "POS", CARRIER_ONLY_NO_ORDER: "HÃNG-KHÔNG-ĐƠN", CARRIER_ONLY: "HÃNG", CONFLICT: "CÃI", UNKNOWN: "?" };
const compact = (m: ReadonlyMap<OriginClass, number>) => ORIGIN_CLASSES.filter((c) => m.get(c)).map((c) => `${shortCls[c]} ${m.get(c)}`).join("/") || "0";

// ─────────────────────────── ĐỌC DỮ LIỆU ───────────────────────────

type ShipRow = {
  id: string;
  orderId: string | null;
  attemptNo: number | null;
  carrier: string;
  trackingCode: string | null;
  vtpOrderNumber: string | null;
  stage: string;
  partnerId: number | null;
  lastPancakeSyncAt: Date | null;
  lastVtpSyncAt: Date | null;
  codStatementRef: string | null;
  carrierCreate: unknown;
  carrierCancel: unknown;
  hasPancakeRaw: boolean;
  hasVtpRaw: boolean;
  vtpRef: string | null;
  createdAt: Date;
};

function shipSelect() {
  const s = schema.shipments;
  return {
    id: s.id,
    orderId: s.orderId,
    attemptNo: s.attemptNo,
    carrier: s.carrier,
    trackingCode: s.trackingCode,
    vtpOrderNumber: s.vtpOrderNumber,
    stage: sql<string>`${s.stage}::text`,
    partnerId: s.partnerId,
    lastPancakeSyncAt: s.lastPancakeSyncAt,
    lastVtpSyncAt: s.lastVtpSyncAt,
    codStatementRef: s.codStatementRef,
    // Chỉ lấy đúng các nhánh cần của `raw` — không kéo tên / SĐT / địa chỉ trong bản DATA của hãng ra khỏi CSDL.
    carrierCreate: sql<unknown>`${s.raw}->'carrierCreate'`,
    carrierCancel: sql<unknown>`${s.raw}->'carrierCancel'`,
    hasPancakeRaw: sql<boolean>`((${s.raw}->'pancake') is not null)`,
    hasVtpRaw: sql<boolean>`((${s.raw}->'vtp') is not null)`,
    vtpRef: sql<string | null>`coalesce(${s.raw}->'vtp'->>'ORDER_REFERENCE', ${s.raw}->'vtp'->>'order_reference')`,
    createdAt: s.createdAt,
  };
}

const codeOf = (r: { trackingCode: string | null; vtpOrderNumber: string | null }) => (r.trackingCode ?? "").trim() || (r.vtpOrderNumber ?? "").trim();
const chunks = <T>(xs: readonly T[], n = 500): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/** Căn cứ cho một tập dòng vận đơn: sự kiện theo nguồn + nhật ký tạo vận đơn của ERP. */
async function evidenceFor(db: Db, rows: readonly ShipRow[]): Promise<Map<string, ShipmentEvidence>> {
  const ids = rows.map((r) => r.id);
  const events = new Map<string, Set<string>>();
  for (const part of chunks(ids)) {
    const ev = await db
      .select({ sid: schema.shipmentEvents.shipmentId, source: schema.shipmentEvents.source })
      .from(schema.shipmentEvents)
      .where(inArray(schema.shipmentEvents.shipmentId, part))
      .groupBy(schema.shipmentEvents.shipmentId, schema.shipmentEvents.source);
    for (const e of ev) events.set(e.sid, (events.get(e.sid) ?? new Set()).add(e.source));
  }
  const orderIds = [...new Set(rows.map((r) => r.orderId).filter((x): x is string => Boolean(x)))];
  const audits: { orderId: string; sid: string | null; code: string | null }[] = [];
  for (const part of chunks(orderIds)) {
    const a = schema.auditLogs;
    audits.push(
      ...(await db
        .select({ orderId: a.entityId, sid: sql<string | null>`${a.detail}->'after'->>'shipmentId'`, code: sql<string | null>`${a.detail}->'after'->>'trackingCode'` })
        .from(a)
        .where(and(eq(a.action, "SHIPMENT_CARRIER_CREATE"), eq(a.entity, "ORDER"), inArray(a.entityId, part)))),
    );
  }
  const carrierSources = new Set<string>(CARRIER_EVENT_SOURCES);
  const out = new Map<string, ShipmentEvidence>();
  for (const r of rows) {
    const code = codeOf(r);
    const create = carrierCreateOf({ carrierCreate: r.carrierCreate });
    const audit = audits.find((x) => x.sid === r.id) ?? audits.find((x) => x.orderId === r.orderId && code !== "" && x.code === code) ?? null;
    const src = events.get(r.id) ?? new Set<string>();
    out.set(r.id, {
      orderKind: !r.orderId ? "NONE" : isManualOrderId(r.orderId) ? "ERP" : "SYNCED",
      orderShort: r.orderId && isManualOrderId(r.orderId) ? manualOrderShortCode(r.orderId) : null,
      code,
      erpCreate: create ? { state: create.state, reference: create.reference } : null,
      erpAudit: audit ? { trackingCode: audit.code } : null,
      carrierReference: r.vtpRef,
      pancake: { raw: r.hasPancakeRaw, syncedAt: Boolean(r.lastPancakeSyncAt), partnerId: r.partnerId !== null, event: src.has("PANCAKE") },
      carrier: { events: [...src].some((x) => carrierSources.has(x)), rawVtp: r.hasVtpRaw, vtpSyncedAt: Boolean(r.lastVtpSyncAt), statement: Boolean(r.codStatementRef), packetOnly: false },
    });
  }
  return out;
}

export type OriginReport = {
  total: number;
  truncated: boolean;
  classes: Map<OriginClass, number>;
  keys: Map<OriginKey, number>;
  byCarrier: Map<string, Map<OriginClass, number>>;
  byDay: Map<string, Map<OriginClass, number>>;
  packetOnly: number;
  pendingErpAttempts: Map<string, number>;
  held: { withLive: number; held: number; byCode: Map<string, number>; heldClasses: Map<OriginClass, number> };
  missingAddress: { ward: number; province: number; classes: Map<OriginClass, number> };
  phoneHint: { shipments: number; orders: number; ordersHeld: number; ordersWithErpShipment: number };
  detail: string[];
};

/** Đọc + phân loại + in. Trả bản số để bài kiểm đối chiếu. */
export async function auditShipmentOrigin(db: Db, from: Date, now: Date, span: string): Promise<OriginReport> {
  const s = schema.shipments;
  const raw = (await db.select(shipSelect()).from(s).where(gte(s.createdAt, from)).orderBy(asc(s.createdAt)).limit(ORIGIN_MAX_ROWS + 1)) as ShipRow[];
  const truncated = raw.length > ORIGIN_MAX_ROWS;
  const window = raw.slice(0, ORIGIN_MAX_ROWS);
  const withCode = window.filter((r) => codeOf(r));
  // Lượt tạo của ERP chưa có mã (giữ chỗ đang chờ hãng / không rõ kết quả) — không phải vận đơn, đếm riêng.
  const pendingErpAttempts = new Map<string, number>();
  for (const r of window) {
    if (codeOf(r)) continue;
    const c = carrierCreateOf({ carrierCreate: r.carrierCreate });
    bump(pendingErpAttempts, c ? c.state : "KHÔNG_DẤU_ERP");
  }

  // Đơn ERP «Đã xác nhận» (không theo kỳ) + vận đơn của chúng — cho phần «đã có vận đơn dù ERP đang giữ».
  const o = schema.orders;
  const confirmed = await db
    .select({ order: o, dispatch: schema.orderDispatch })
    .from(o)
    .leftJoin(schema.orderDispatch, eq(schema.orderDispatch.orderId, o.id))
    .where(and(eq(o.stage, "CONFIRMED"), sql`${o.id} like ${`${MANUAL_ORDER_ID_PREFIX}%`}`))
    .orderBy(asc(o.id))
    .limit(ORIGIN_MAX_HOLD_ORDERS + 1);
  const confirmedIds = confirmed.slice(0, ORIGIN_MAX_HOLD_ORDERS).map((r) => r.order.id);
  const holdShips: ShipRow[] = [];
  for (const part of chunks(confirmedIds)) holdShips.push(...((await db.select(shipSelect()).from(s).where(inArray(s.orderId, part))) as ShipRow[]));

  const allRows = new Map<string, ShipRow>();
  for (const r of [...withCode, ...holdShips]) allRows.set(r.id, r);
  const evidence = await evidenceFor(db, [...allRows.values()]);
  const verdicts = new Map<string, OriginVerdict>();
  for (const [id, e] of evidence) verdicts.set(id, classifyShipmentOrigin(e));

  // Gói webhook của hãng KHÔNG khớp dòng vận đơn nào (GHN / GHTK không tạo dòng; VTP chỉ khi áp lỗi) ⇒ hãng biết, ERP không có dòng.
  const w = schema.webhookEvents;
  const refExpr = sql<string | null>`coalesce(${w.payload}->'DATA'->>'ORDER_REFERENCE', ${w.payload}->'DATA'->>'order_reference', ${w.payload}->>'ClientOrderCode', ${w.payload}->>'partner_id')`;
  const packets = await db
    .select({ source: w.source, code: w.externalId, firstAt: sql<Date>`min(${w.receivedAt})`, ref: sql<string | null>`max(${refExpr})` })
    .from(w)
    .where(
      and(
        inArray(w.source, ["VIETTELPOST", "GHN", "GHTK"]),
        gte(w.receivedAt, from),
        sql`coalesce(${w.externalId}, '') <> ''`,
        // Bí danh tường minh: drizzle in cột trong sql`` không kèm tên bảng, câu con tương quan phải tự nêu bảng nào là bảng nào.
        sql`not exists (select 1 from shipments sx where sx.tracking_code = webhook_events.external_id or sx.vtp_order_number = webhook_events.external_id or (${refExpr} is not null and sx.order_reference = ${refExpr}))`,
      ),
    )
    .groupBy(w.source, w.externalId)
    .limit(ORIGIN_MAX_ROWS);

  const classes = new Map<OriginClass, number>();
  const keys = new Map<OriginKey, number>();
  const byCarrier = new Map<string, Map<OriginClass, number>>();
  const byDay = new Map<string, Map<OriginClass, number>>();
  const detail: string[] = [];
  const count = (v: OriginVerdict, carrier: string, day: string) => {
    bump(classes, v.cls);
    for (const k of v.keys) bump(keys, k);
    nested(byCarrier, carrier, v.cls);
    nested(byDay, day, v.cls);
  };
  const orderLabel = (orderId: string | null) => (!orderId ? "không đơn" : isManualOrderId(orderId) ? `#${manualOrderShortCode(orderId)}` : `đơn đồng bộ ${orderId}`);

  for (const r of withCode) {
    const v = verdicts.get(r.id)!;
    count(v, carrierBucket(r.carrier), vnDay(r.createdAt));
    detail.push(`  ${orderLabel(r.orderId)} · ${carrierBucket(r.carrier)} · ${codeOf(r)} · lần gửi ${r.attemptNo ?? "?"} · ${r.stage} · ERP biết ${vnDay(r.createdAt)} · ${v.cls} · căn cứ ${v.keys.join("+") || "—"}`);
  }
  let packetOnly = 0;
  for (const p of packets) {
    const v = classifyShipmentOrigin({
      orderKind: "NONE",
      orderShort: null,
      code: String(p.code ?? ""),
      erpCreate: null,
      erpAudit: null,
      carrierReference: p.ref,
      pancake: { raw: false, syncedAt: false, partnerId: false, event: false },
      carrier: { events: false, rawVtp: false, vtpSyncedAt: false, statement: false, packetOnly: true },
    });
    packetOnly += 1;
    const firstAt = p.firstAt instanceof Date ? p.firstAt : new Date(String(p.firstAt));
    const carrier = p.source === "VIETTELPOST" ? "VTP" : p.source;
    count(v, carrier, vnDay(firstAt));
    detail.push(`  không dòng vận đơn · ${carrier} · ${p.code} · gói webhook đầu ${vnDay(firstAt)} · tham chiếu ${referenceShape(p.ref)} · ${v.cls} · căn cứ ${v.keys.join("+")}`);
  }
  const total = withCode.length + packets.length;

  // ── Đơn ERP «Đã xác nhận» có vận đơn còn hiệu lực: tuyến giao ERP có đang GIỮ không (giả định chưa có vận đơn)?
  const [cfgRow] = await db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, SHIPPING_ROUTING_SETTING_KEY)).limit(1);
  const cfg: ShippingRoutingConfig = cfgRow ? parseShippingRoutingConfig(mergeSettingJson<unknown>(String(cfgRow.value), null)) : DEFAULT_SHIPPING_ROUTING;
  const items = confirmedIds.length ? await db.select({ orderId: schema.orderItems.orderId, name: schema.orderItems.productName, quantity: schema.orderItems.quantity, weight: schema.orderItems.weight }).from(schema.orderItems).where(inArray(schema.orderItems.orderId, confirmedIds)) : [];
  const shipsByOrder = new Map<string, ShipRow[]>();
  for (const r of holdShips) if (r.orderId) shipsByOrder.set(r.orderId, [...(shipsByOrder.get(r.orderId) ?? []), r]);
  const held = { withLive: 0, held: 0, byCode: new Map<string, number>(), heldClasses: new Map<OriginClass, number>() };
  const routeOf = new Map<string, string>();
  const allCarriers = new Set(CARRIER_KEYS);
  for (const { order, dispatch } of confirmed.slice(0, ORIGIN_MAX_HOLD_ORDERS)) {
    const its = items.filter((i) => i.orderId === order.id);
    const auto: AutoAttemptState | null = dispatch ? { attempts: dispatch.autoAttempts, lastAt: dispatch.autoLastAt, lastResult: dispatch.autoLastResult === "CREATED" || dispatch.autoLastResult === "FAILED" ? dispatch.autoLastResult : null, lastMessage: dispatch.autoLastMessage } : null;
    // CHÍNH decideShippingRoute (lib/shipping/route.ts), với hasLiveShipment = false: «nếu chưa có vận đơn, ERP có tự đi không?».
    // Mọi hãng coi như đã bật — bước CARRIER_OFF KHÔNG xét (script không đọc trạng thái kết nối).
    const route = decideShippingRoute(
      {
        isErp: true,
        stage: order.stage,
        province: order.shipProvince ?? "",
        ward: order.shipCommune ?? "",
        hasLiveShipment: false,
        weightGrams: linesWeight(its.map((i) => ({ name: i.name ?? "", quantity: i.quantity, unitPrice: 0, weightGrams: i.weight ?? 0 }))),
        confirmedAt: order.lastUpdateStatusAt ?? null,
        updatedAt: order.updatedAt,
        auto,
        addressReviewOpen: addressReviewOpenOf(order.raw),
        orderReviewOpen: orderReviewOpenOf(order.raw),
      },
      cfg,
      allCarriers,
      now,
    );
    routeOf.set(order.id, route.kind === "HOLD" ? route.code : route.kind);
    const live = (shipsByOrder.get(order.id) ?? []).filter((r) => attemptHoldsOrder({ stage: r.stage, raw: { carrierCreate: r.carrierCreate, carrierCancel: r.carrierCancel } }));
    if (!live.length) continue;
    held.withLive += 1;
    if (route.kind !== "HOLD") continue;
    held.held += 1;
    bump(held.byCode, route.code);
    for (const r of live) {
      const v = verdicts.get(r.id) ?? classifyShipmentOrigin(evidence.get(r.id)!);
      bump(held.heldClasses, v.cls);
      detail.push(`  GIỮ ${route.code} · #${manualOrderShortCode(order.id)} · ${carrierBucket(r.carrier)} · ${codeOf(r) || "(chưa mã)"} · ${r.stage} · ${v.cls} · căn cứ ${v.keys.join("+") || "—"}`);
    }
  }

  // ── Vận đơn (trong kỳ) của đơn thiếu xã / tỉnh.
  const linkedIds = [...new Set(withCode.map((r) => r.orderId).filter((x): x is string => Boolean(x)))];
  const addr = new Map<string, { province: string; ward: string }>();
  for (const part of chunks(linkedIds)) for (const r of await db.select({ id: o.id, province: o.shipProvince, ward: o.shipCommune }).from(o).where(inArray(o.id, part))) addr.set(r.id, { province: (r.province ?? "").trim(), ward: (r.ward ?? "").trim() });
  const missingAddress = { ward: 0, province: 0, classes: new Map<OriginClass, number>() };
  for (const r of withCode) {
    const a = r.orderId ? addr.get(r.orderId) : undefined;
    if (!a || (a.ward && a.province)) continue;
    if (!a.ward) missingAddress.ward += 1;
    if (!a.province) missingAddress.province += 1;
    bump(missingAddress.classes, verdicts.get(r.id)!.cls);
  }

  // ── GỢI Ý theo SĐT (KHÔNG phân loại — mục 45): vận đơn không gắn đơn trong kỳ ↔ đơn ERP có cùng SĐT người nhận. Không in SĐT.
  const orphanIds = withCode.filter((r) => !r.orderId).map((r) => r.id);
  const phoneHint = { shipments: 0, orders: 0, ordersHeld: 0, ordersWithErpShipment: 0 };
  if (orphanIds.length) {
    const orphanPhones: { id: string; phone: string }[] = [];
    for (const part of chunks(orphanIds)) orphanPhones.push(...(await db.select({ id: s.id, phone: s.receiverPhone }).from(s).where(inArray(s.id, part))));
    const erpOrders = await db
      .select({ id: o.id, ship: o.shipPhone, bill: o.billPhone })
      .from(o)
      .where(and(sql`${o.id} like ${`${MANUAL_ORDER_ID_PREFIX}%`}`, gte(o.insertedAt, new Date(from.getTime() - 30 * 86_400_000))))
      .limit(ORIGIN_MAX_ROWS);
    const byPhone = new Map<string, string[]>();
    for (const e of erpOrders) for (const p of new Set([e.ship, e.bill].map((x) => normalizeVnPhone(String(x ?? ""))).filter((x): x is string => Boolean(x)))) byPhone.set(p, [...(byPhone.get(p) ?? []), e.id]);
    const hitOrders = new Set<string>();
    for (const sp of orphanPhones) {
      const p = normalizeVnPhone(String(sp.phone ?? ""));
      const hits = p ? byPhone.get(p) ?? [] : [];
      if (!hits.length) continue;
      phoneHint.shipments += 1;
      for (const h of hits) hitOrders.add(h);
      const row = allRows.get(sp.id)!;
      detail.push(`  GỢI Ý SĐT · vận đơn ${codeOf(row)} (không đơn, ${verdicts.get(sp.id)!.cls}) ↔ đơn ERP ${hits.slice(0, 3).map((h) => `#${manualOrderShortCode(h)}${routeOf.has(h) ? ` [tuyến ${routeOf.get(h)}]` : ""}`).join(", ")}${hits.length > 3 ? ` +${hits.length - 3}` : ""}`);
    }
    phoneHint.orders = hitOrders.size;
    const erpShipOrders = new Set<string>();
    for (const part of chunks([...hitOrders])) {
      const rows = (await db.select(shipSelect()).from(s).where(inArray(s.orderId, part))) as ShipRow[];
      for (const r of rows) if (carrierCreateOf({ carrierCreate: r.carrierCreate }) && r.orderId) erpShipOrders.add(r.orderId);
    }
    phoneHint.ordersWithErpShipment = erpShipOrders.size;
    phoneHint.ordersHeld = [...hitOrders].filter((h) => (ROUTE_HOLD_CODES as readonly string[]).includes(routeOf.get(h) ?? "")).length;
  }

  // ── IN.
  console.log(`Kỳ ${span} tới ${now.toISOString()} · ${withCode.length} dòng vận đơn có mã + ${packets.length} mã chỉ có gói webhook${truncated ? ` · CẮT ở ${ORIGIN_MAX_ROWS} dòng` : ""}`);
  for (const line of detail.slice(0, DETAIL_MAX_LINES)) console.log(line);
  if (detail.length > DETAIL_MAX_LINES) console.log(`  … còn ${detail.length - DETAIL_MAX_LINES} dòng không in`);

  const plus = truncated ? "+" : "";
  tomTat(`shipment-origin-audit ${span}: ${total}${plus} vận đơn có mã · ${classCountsText(classes)} · trong đó chỉ có gói webhook (không dòng vận đơn) ${packetOnly}`);
  tomTat(`Theo hãng: ${[...byCarrier.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, m]) => `${k} ${compact(m)}`).join(" · ") || "—"}`);
  const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (let i = 0; i < days.length; i += 6) tomTat(`Theo ngày (giờ VN, lúc ERP biết vận đơn): ${days.slice(i, i + 6).map(([d, m]) => `${d} ${compact(m)}`).join(" · ")}`);
  tomTat(`Căn cứ: ${ORIGIN_KEYS.filter((k) => keys.get(k)).map((k) => `${k} ${keys.get(k)}`).join(" · ") || "—"}`);
  const shapes = new Map<string, number>();
  for (const r of withCode) bump(shapes, referenceShape(r.vtpRef));
  for (const p of packets) bump(shapes, referenceShape(p.ref));
  tomTat(`Mã tham chiếu phía hãng: dạng ERP ${shapes.get("ERP") ?? 0} · chỉ chữ số ${shapes.get("DIGITS") ?? 0} · khác ${shapes.get("OTHER") ?? 0} · không có ${shapes.get("NONE") ?? 0}`);
  const kinds = new Map<string, number>();
  for (const r of withCode) bump(kinds, !r.orderId ? "NONE" : isManualOrderId(r.orderId) ? "ERP" : "SYNCED");
  tomTat(`Dòng vận đơn theo đơn: đơn ERP ${kinds.get("ERP") ?? 0} · đơn đồng bộ ${kinds.get("SYNCED") ?? 0} · KHÔNG gắn đơn ${kinds.get("NONE") ?? 0} · lượt tạo của ERP chưa có mã: ${[...pendingErpAttempts.entries()].map(([k, n]) => `${k} ${n}`).join(" · ") || "0"}`);
  tomTat(`Cấu hình tuyến giao: tự tạo vận đơn ${cfg.autoCreate ? "BẬT" : "TẮT"} · hãng mặc định ${cfg.defaultCarrier ?? "chưa chọn"} · khu tự giao ${cfg.selfAreas.length}${cfgRow ? "" : " (chưa khai — mặc định)"}`);
  tomTat(`Đơn ERP «Đã xác nhận» (toàn bộ${confirmed.length > ORIGIN_MAX_HOLD_ORDERS ? `, cắt ${ORIGIN_MAX_HOLD_ORDERS}` : ""}) có vận đơn còn hiệu lực ${held.withLive} · ĐÃ CÓ VẬN ĐƠN DÙ ERP ĐANG GIỮ ${held.held}: ${[...held.byCode.entries()].map(([k, n]) => `${k} ${n}`).join(" · ") || "—"} · nguồn vận đơn của nhóm giữ: ${compact(held.heldClasses)} · (giữ đọc lúc chạy; CARRIER_OFF không xét)`);
  tomTat(`Vận đơn trong kỳ của đơn thiếu xã ${missingAddress.ward} · thiếu tỉnh ${missingAddress.province} · theo nguồn ${compact(missingAddress.classes)}`);
  tomTat(`GỢI Ý theo SĐT (không dùng để phân loại): vận đơn không gắn đơn trùng SĐT đơn ERP ${phoneHint.shipments} · đơn ERP liên quan ${phoneHint.orders} · trong đó ERP đang giữ ${phoneHint.ordersHeld} · đã có lượt tạo ERP ${phoneHint.ordersWithErpShipment}`);
  return { total, truncated, classes, keys, byCarrier, byDay, packetOnly, pendingErpAttempts, held, missingAddress, phoneHint, detail };
}

async function main() {
  const args = parseOriginArgs(process.argv.slice(2));
  if ("error" in args) {
    tomTat(`shipment-origin-audit: DỪNG · cách dùng sai — ${args.error} (arg: ${USAGE})`);
    process.stdout.write("", () => process.exit(1));
    return;
  }
  const org = await findOrganization(args.code);
  if (!org) {
    tomTat(`shipment-origin-audit: DỪNG · không có tổ chức «${args.code}»`);
    process.stdout.write("", () => process.exit(1));
    return;
  }
  const db: Db = await getDbForInspection({ code: org.code, isHome: org.isHome });
  const [ro] = rowsOf<Record<string, unknown>>(await db.execute(sql`show default_transaction_read_only`));
  if (String(ro?.default_transaction_read_only ?? "") !== "on") {
    tomTat("shipment-origin-audit: DỪNG · phiên CSDL KHÔNG ở chế độ chỉ đọc — không đọc gì");
    process.stdout.write("", () => process.exit(70));
    return;
  }
  const now = new Date();
  const from = args.since ?? new Date(now.getTime() - args.days * 86_400_000);
  const span = args.since ? `từ ${args.since.toISOString()}` : `${args.days} ngày`;
  console.log(`Tổ chức ${org.code} · ${span}`);
  await auditShipmentOrigin(db, from, now, span);
  process.stdout.write("", () => process.exit(0));
}

// Chỉ chạy khi được gọi THẲNG từ dòng lệnh — `import` từ bài kiểm không được kéo theo `process.exit`.
if (CHAY_THANG) {
  main().catch((e) => {
    console.error("shipment-origin-audit lỗi:", e instanceof Error ? e.message : e);
    tomTat("shipment-origin-audit: LỖI ngoài phép đo — chi tiết trong phần mã hoá");
    process.stdout.write("", () => process.exit(1));
  });
}
