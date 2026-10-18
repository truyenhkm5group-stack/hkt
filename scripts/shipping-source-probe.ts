/*
  ops `shipping-source-probe` — VẬN ĐƠN CỦA MỘT TỔ CHỨC ĐANG ĐƯỢC TẠO Ở ĐÂU: ERP · PANCAKE POS · VIETTEL POST (CHỈ ĐỌC).

  Vì sao có (chủ shop 18/10/2026, luồng vận đơn HSLC): «Kiểm tra read-only nguồn tạo vận đơn hiện tại từ ERP, Pancake/PosCake và
  ViettelPost. Giữ đúng luồng tạo vận đơn của từng nguồn, đồng bộ trạng thái qua webhook/API, chống tạo trùng và bảo toàn COD. Không
  tự chuyển hệ thống sang receive-only khi chưa xác minh.» `shipment-origin-audit` (#897) đã đo: 30 ngày, tổ chức `hslc-hmt-shop` có
  0 vận đơn mang mã trong ERP từ BẤT KỲ nguồn nào, 577/577 đơn tạo trong ERP, 0 đơn đồng bộ từ Pancake. Vận đơn được tạo NGOÀI ERP —
  nhưng ở đâu (POS? trang / app Viettel Post?) và ERP có đẩy đơn sang POS không thì chưa ai đo.

  CĂN CỨ CÓ THẬT (đã đọc mã nguồn — không đoán):
   · Kết nối của tổ chức: `connectionStatusRows(db)` (lib/connectors/service.ts:143 — chỉ cột trạng thái, KHÔNG bí mật / cấu hình).
     Vai trò với vận đơn theo sổ connector (lib/connectors/registry.ts): `pancake-pos-org` (:181 — POS là NGUỒN đơn; bật ⇒ ERP thôi
     tạo tay) · `viettelpost-carrier` / `ghn-carrier` / `ghtk-carrier` (:271/:302/:336 — ERP TẠO vận đơn) · `viettelpost-org` (:242 —
     CHỈ webhook, «Viettel Post KHÔNG cấp API tra cứu cho shop», không có dòng kết nối) · `pancake-fanpage` (:818 — chat).
   · ERP → POS: đường đẩy đơn DUY NHẤT là `lib/landing/pos.ts::pushLandingToPos` (đơn LANDING, client môi trường của tổ chức NHÀ, lưu
     `landing_orders.pancake_order_id`). Đơn `erp-…` (bot / nhân viên) KHÔNG có đường đẩy sang POS, và `orders` không có cột mã đơn
     POS — liên kết duy nhất là `orders.raw.order_link` mà CHỈ đơn đồng bộ TỪ Pancake mang (lib/constants/pancake.ts:163–190).
   · Phía POS, CHỈ ĐỌC, HAI KÊNH:
     (a) API POS bằng khoá của tổ chức — CHỈ khi `pancake-pos-org` đang bật. Khoá chỉ mở được qua `openActiveConnection` trong NGỮ
         CẢNH tổ chức, mà `getDb()` của ngữ cảnh MIGRATE ⇒ gắn handle chẩn đoán CHỈ ĐỌC vào chỗ `getDb()` tìm trước
         (`bindReadOnlyOrgHandle` của scripts/inbox-perf-probe.ts — cùng cách ops `pancake-thread-diff`), rồi `openOrgPancakeClient` +
         `iterateOrders` (GET, có trần trang). Cả kỳ ⇒ MEASURED.
     (b) recent_orders: token page của `pancake-fanpage` (`pageTokensForOffboard`, service.ts:957 — cùng cách ops
         `customer-360-probe`) ⇒ GET tin của hội thoại ⇒ `recent_orders` = các ĐƠN POS mà Pancake gắn với khách của hội thoại đó ⇒
         `mapOrder` (lib/integrations/pancake/mapper.ts:422 — đối tác, mã vận đơn, COD khai báo, khâu). MẪU có trần (mặc định 40 hội
         thoại), một trang / hội thoại ⇒ thấy thì MEASURED trên mẫu, không thấy thì chỉ HINT.
   · Viettel Post: không có API đọc cho shop — chỉ webhook (`webhook_events.source = 'VIETTELPOST'`, sự kiện `VTP_*` ở
     `shipment_events`) + tệp nhập (`vtp_import_batches`) + bảng kê COD (`cod_statement_lines`, `vtp_statement_files`). 0 gói tin
     KHÔNG phân biệt được «chưa dán URL webhook vào tài khoản Viettel Post» với «không có vận đơn» — script nói đúng như vậy.

  MỨC TIN CẬY (mỗi kết luận một nhãn): MEASURED (đếm thẳng từ dữ liệu / API) · HINT (mẫu, hoặc ghép SĐT + ngày + tiền — KHÔNG dùng để
  kết luận một đơn là trùng) · UNKNOWN (không nguồn nào trả lời được). Ghép POS ↔ ERP: LINK (liên kết đã lưu) > HINT_STRONG (cùng khách
  + ±3 ngày + cùng số tiền) > HINT_WEAK (cùng khách + ±3 ngày) — hai nhóm HINT in RIÊNG, mục 45.

  TIỀN: COD trên POS là COD KHAI BÁO với hãng (`money_to_collect`) — KHÔNG phải tiền thực thu (ORDER_OUTCOME §8). In tổng theo nhóm.

  [ops:tom-tat] CHỈ số đếm / tiền tổng / tên nhóm. Mã đơn ngắn, mã đơn POS, mã vận đơn CHỈ ở phần MÃ HOÁ. Không in tên, SĐT, địa chỉ, chữ
  tin ở bất kỳ đâu. CHỈ ĐỌC do Postgres ép (`ERP_READ_ONLY=1` trước lần mở kết nối đầu tiên + hỏi lại phiên); Pancake CHỈ GET. Không
  đổi cấu hình, không đăng ký webhook, không ghi Pancake / Viettel Post / CSDL.

  arg: `<mã tổ chức> [<mã tổ chức 2> <mã tổ chức 3>] [--days=1..30] [--sample=0..100]` (mặc định 14 ngày, mẫu 40; `--sample=0` = không
  gọi Pancake).
*/
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("shipping-source-probe.ts"));
if (CHAY_THANG) process.env.ERP_READ_ONLY = "1";

import "dotenv/config";
import { and, desc, eq, gte, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { getDbForInspection, schema, type Db } from "@/db";
import { connectionStatusRows, pageTokensForOffboard, type ConnectionStatusRow } from "@/lib/connectors/service";
import { PANCAKE_PAGES_API, scrubSecrets } from "@/lib/connectors/testers";
import { manualOrderShortCode, MANUAL_ORDER_ID_PREFIX } from "@/lib/constants/manual-orders";
import { DEFAULT_SHIPPING_ROUTING, parseShippingRoutingConfig, SHIPPING_ROUTING_SETTING_KEY } from "@/lib/constants/shipping-routing";
import { asArray, asRecord, fetchJson, IntegrationError, sleep } from "@/lib/integrations/http";
import { openOrgPancakeClient } from "@/lib/integrations/pancake/org";
import { legBaseCode } from "@/lib/integrations/viettelpost/statement";
import { mapOrder, type MappedOrder } from "@/lib/integrations/pancake/mapper";
import { withOrganization } from "@/lib/platform/context";
import { findOrganization } from "@/lib/platform/organizations";
import { FANPAGE_CONNECTOR } from "@/lib/sales-chatbot/fanpage";
import { normalizeVnPhone } from "@/lib/sales-chatbot/returning";
import { mergeSettingJson } from "@/lib/settings";
import { rowsOf } from "@/lib/sql-rows";
import { bindReadOnlyOrgHandle } from "./inbox-perf-probe";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s.slice(0, 300)}`);
/** Loại lỗi (TypeError · IntegrationError…) — không câu lỗi, câu lỗi có thể mang URL. */
const tenLoi = (e: unknown) => (e instanceof Error ? e.constructor.name || "Error" : "lỗi");

export const PROBE_DEFAULT_DAYS = 14;
export const PROBE_MAX_DAYS = 30;
export const PROBE_DEFAULT_SAMPLE = 40;
export const PROBE_MAX_SAMPLE = 100;
export const PROBE_MAX_ORGS = 3;
/** Mẫu hội thoại đọc được tối thiểu để «không thấy đơn POS nào» đáng là một GỢI Ý; dưới mức ⇒ UNKNOWN. */
export const PROBE_MIN_SAMPLE = 10;
/** Cửa sổ ghép POS ↔ ERP theo ngày tạo. */
export const MATCH_DAYS = 3;
const MAX_ERP_ORDERS = 5_000;
const MAX_ORPHAN_ROWS = 20_000;
const DETAIL_MAX_LINES = 400;
const CALL_GAP_MS = 300;
const VN_OFFSET_MS = 7 * 3_600_000;
const USAGE = `<mã tổ chức> [<mã 2> <mã 3>] [--days=1..${PROBE_MAX_DAYS}] [--sample=0..${PROBE_MAX_SAMPLE}]`;

// ─────────────────────────── PHẦN THUẦN ───────────────────────────

export type ProbeArgs = { codes: string[]; days: number; sample: number };

export function parseProbeArgs(argv: readonly string[]): ProbeArgs | { error: string } {
  const codes = [...new Set(argv.filter((a) => !a.startsWith("--")).map((a) => a.trim()))];
  if (!codes.length) return { error: "thiếu mã tổ chức" };
  if (codes.length > PROBE_MAX_ORGS) return { error: `tối đa ${PROBE_MAX_ORGS} tổ chức một lượt` };
  if (codes.some((c) => !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(c))) return { error: "sai mã tổ chức" };
  const unknownFlags = argv.filter((a) => a.startsWith("--") && !/^--(days|sample)=/.test(a));
  if (unknownFlags.length) return { error: `tham số không nhận: ${unknownFlags.length} mục` };
  const val = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const rawDays = val("days");
  const days = rawDays === undefined ? PROBE_DEFAULT_DAYS : Number(rawDays);
  if (!Number.isInteger(days) || days < 1 || days > PROBE_MAX_DAYS) return { error: `--days phải là số nguyên 1..${PROBE_MAX_DAYS}` };
  const rawSample = val("sample");
  const sample = rawSample === undefined ? PROBE_DEFAULT_SAMPLE : Number(rawSample);
  if (!Number.isInteger(sample) || sample < 0 || sample > PROBE_MAX_SAMPLE) return { error: `--sample phải là số nguyên 0..${PROBE_MAX_SAMPLE}` };
  return { codes, days, sample };
}

/** Vai trò của một connector với VẬN ĐƠN (theo sổ lib/connectors/registry.ts). Connector ngoài danh sách không chở vận đơn. */
export const SHIPPING_CONNECTOR_ROLE: Record<string, "POS_SHOP" | "ERP_CARRIER_CREATE" | "CARRIER_WEBHOOK" | "CHAT_FANPAGE"> = {
  "pancake-pos-org": "POS_SHOP",
  "viettelpost-carrier": "ERP_CARRIER_CREATE",
  "ghn-carrier": "ERP_CARRIER_CREATE",
  "ghtk-carrier": "ERP_CARRIER_CREATE",
  "viettelpost-org": "CARRIER_WEBHOOK",
  "pancake-fanpage": "CHAT_FANPAGE",
};

/** Kết nối ĐANG BẬT = cùng định nghĩa với `connectionIsActive` (service.ts:236): ACTIVE + lần kiểm tra gần nhất đạt. HÀM THUẦN. */
export const connectionActive = (r: Pick<ConnectionStatusRow, "status" | "lastTestOk">) => r.status === "ACTIVE" && r.lastTestOk === true;

export const POS_CARRIER_BUCKETS = ["VTP", "GHN", "GHTK", "OTHER", "NO_TRACKING", "NO_SHIPMENT"] as const;
export type PosCarrierBucket = (typeof POS_CARRIER_BUCKETS)[number];

/**
 * Hãng của một đơn POS từ phần vận đơn `mapOrder` dựng ra. HÀM THUẦN.
 *  NO_SHIPMENT = POS không có phần đối tác (chưa gửi hãng) · NO_TRACKING = có phần đối tác / khâu đã gửi mà KHÔNG mã vận đơn (tự giao
 *  hoặc chưa đẩy được — POS không nói cái nào, nên không chia) · còn lại theo tên đối tác.
 */
export function posCarrierBucket(shipment: { carrier: string; trackingCode: string | null } | null): PosCarrierBucket {
  if (!shipment) return "NO_SHIPMENT";
  if (!(shipment.trackingCode ?? "").trim()) return "NO_TRACKING";
  const c = shipment.carrier.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/gi, "d").toLowerCase();
  if (c.includes("viettel") || c === "vtp") return "VTP";
  if (c.includes("ghn") || c.includes("giao hang nhanh")) return "GHN";
  if (c.includes("ghtk") || c.includes("tiet kiem")) return "GHTK";
  return "OTHER";
}

/** `order_id` (mã nội bộ web POS) trong một `order_link` đúng hình dạng — cùng luật `pancakePosOrderUrlFromLink`. HÀM THUẦN. */
export function posLinkOrderId(orderLink: unknown): string | null {
  if (typeof orderLink !== "string" || !orderLink.trim()) return null;
  try {
    const u = new URL(orderLink.trim());
    if (!["pos.pages.fm", "pos.pancake.vn"].includes(u.hostname) || !/^\/shop\/\d+\/order\/?$/.test(u.pathname)) return null;
    const id = u.searchParams.get("order_id");
    return id && /^\d+$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** Đơn POS rút gọn — chỉ đủ để phân nhóm và ghép, SĐT đã chuẩn hoá (không in ra đâu). */
export type PosOrderLite = {
  posId: string;
  linkOrderId: string | null;
  insertedAt: Date;
  stage: string;
  phone: string | null;
  conversationId: string | null;
  moneyToCollect: number;
  totalAfterDiscount: number;
  bucket: PosCarrierBucket;
  trackingCode: string | null;
  codDeclared: number;
};

export function toPosLite(m: MappedOrder): PosOrderLite {
  return {
    posId: m.id,
    linkOrderId: posLinkOrderId(asRecord(m.raw).order_link),
    insertedAt: m.insertedAt,
    stage: m.stage,
    phone: normalizeVnPhone(m.shipPhone || m.billPhone),
    conversationId: m.conversationId,
    moneyToCollect: m.moneyToCollect,
    totalAfterDiscount: m.totalPriceAfterDiscount,
    bucket: posCarrierBucket(m.shipment),
    trackingCode: (m.shipment?.trackingCode ?? "").trim() || null,
    codDeclared: m.shipment?.codAmount ?? 0,
  };
}

/** Đơn ERP rút gọn cho phép ghép. */
export type ErpOrderLite = {
  id: string;
  insertedAt: Date;
  phones: string[];
  thread: string | null;
  moneyToCollect: number;
  totalAfterDiscount: number;
  linkOrderId: string | null;
  /** Có lượt tạo vận đơn của ERP (`shipments.raw.carrierCreate`) ở bất kỳ trạng thái nào. */
  hasErpShipment: boolean;
};

export const MATCH_CLASSES = ["LINK", "HINT_STRONG", "HINT_WEAK", "NONE"] as const;
export type MatchClass = (typeof MATCH_CLASSES)[number];

/**
 * Ghép MỘT đơn POS với đơn ERP. HÀM THUẦN, không đoán ngoài ba bậc:
 *  LINK — đơn ERP mang `order_link` trỏ đúng đơn POS này (liên kết đã lưu);
 *  HINT_STRONG — cùng khách (SĐT chuẩn hoá trùng, hoặc cùng mã hội thoại) + tạo cách nhau ≤ MATCH_DAYS ngày + cùng số tiền (thu hộ
 *    hoặc tiền hàng sau giảm, > 0);
 *  HINT_WEAK — cùng khách + ≤ MATCH_DAYS ngày, tiền khác.
 * Nhiều ứng viên cùng bậc ⇒ lấy đơn gần ngày nhất (ổn định theo mã khi bằng nhau).
 */
export function matchPosToErp(pos: PosOrderLite, erps: readonly ErpOrderLite[]): { cls: MatchClass; erpId: string | null } {
  if (pos.linkOrderId) {
    const linked = erps.find((e) => e.linkOrderId === pos.linkOrderId);
    if (linked) return { cls: "LINK", erpId: linked.id };
  }
  const windowMs = MATCH_DAYS * 86_400_000;
  const near = erps
    .filter((e) => (pos.phone && e.phones.includes(pos.phone)) || (pos.conversationId && e.thread === pos.conversationId))
    .filter((e) => Math.abs(e.insertedAt.getTime() - pos.insertedAt.getTime()) <= windowMs)
    .sort((a, b) => Math.abs(a.insertedAt.getTime() - pos.insertedAt.getTime()) - Math.abs(b.insertedAt.getTime() - pos.insertedAt.getTime()) || a.id.localeCompare(b.id));
  const sameMoney = (e: ErpOrderLite) => (pos.moneyToCollect > 0 && pos.moneyToCollect === e.moneyToCollect) || (pos.totalAfterDiscount > 0 && pos.totalAfterDiscount === e.totalAfterDiscount);
  const strong = near.find(sameMoney);
  if (strong) return { cls: "HINT_STRONG", erpId: strong.id };
  if (near[0]) return { cls: "HINT_WEAK", erpId: near[0].id };
  return { cls: "NONE", erpId: null };
}

export type PosAggregate = {
  total: number;
  byStage: Map<string, number>;
  byBucket: Map<PosCarrierBucket, { n: number; cod: number }>;
  withTracking: number;
  match: Map<MatchClass, number>;
  /** Đơn POS CÓ mã vận đơn, theo bậc ghép. */
  matchWithTracking: Map<MatchClass, number>;
  /** Đơn ERP (khác nhau) mà một đơn POS có mã vận đơn ghép tới ở bậc LINK / HINT_STRONG. */
  erpAlsoShippedOnPos: number;
  /** …trong đó đơn ERP CŨNG có lượt tạo vận đơn của ERP ⇒ rủi ro hai vận đơn cho một đơn. */
  doubleShipmentRisk: number;
};

/** Gom đơn POS (đã khử trùng theo mã) + kết quả ghép. HÀM THUẦN. */
export function aggregatePos(rows: readonly { pos: PosOrderLite; match: { cls: MatchClass; erpId: string | null } }[], erpById: ReadonlyMap<string, ErpOrderLite>): PosAggregate {
  const byStage = new Map<string, number>();
  const byBucket = new Map<PosCarrierBucket, { n: number; cod: number }>();
  const match = new Map<MatchClass, number>();
  const matchWithTracking = new Map<MatchClass, number>();
  const shippedErp = new Set<string>();
  const risky = new Set<string>();
  let withTracking = 0;
  for (const { pos, match: m } of rows) {
    byStage.set(pos.stage, (byStage.get(pos.stage) ?? 0) + 1);
    const b = byBucket.get(pos.bucket) ?? { n: 0, cod: 0 };
    byBucket.set(pos.bucket, { n: b.n + 1, cod: b.cod + Math.max(0, Math.round(pos.codDeclared)) });
    match.set(m.cls, (match.get(m.cls) ?? 0) + 1);
    if (!pos.trackingCode) continue;
    withTracking += 1;
    matchWithTracking.set(m.cls, (matchWithTracking.get(m.cls) ?? 0) + 1);
    if (m.erpId && (m.cls === "LINK" || m.cls === "HINT_STRONG")) {
      shippedErp.add(m.erpId);
      if (erpById.get(m.erpId)?.hasErpShipment) risky.add(m.erpId);
    }
  }
  return { total: rows.length, byStage, byBucket, withTracking, match, matchWithTracking, erpAlsoShippedOnPos: shippedErp.size, doubleShipmentRisk: risky.size };
}

export type Strength = "MEASURED" | "HINT" | "UNKNOWN";
export type Conclusion = { path: "ERP_CARRIER" | "ERP_POS_LINK" | "POS_SHIPMENTS" | "VTP_WEBHOOK" | "OUTSIDE_ERP"; verdict: string; strength: Strength; why: string };

/** Kênh đọc POS. `api` = API Pancake POS bằng khoá của tổ chức (cả kỳ, có trần trang) · `sample` = recent_orders của MẪU hội thoại. */
export type PosChannelFacts = { status: "READ" | "NOT_CONNECTED" | "FAILED" | "SKIPPED"; posOrders: number; withTracking: number; strongOrLink: number; doubleShipmentRisk: number; truncated: boolean };

export type ProbeFacts = {
  posOrgPresent: boolean;
  posOrgActive: boolean;
  carrierCreateActive: string[];
  fanpageActive: boolean;
  /** Vận đơn có mã ERP biết trong kỳ, theo dấu nguồn. */
  /**
   * `carrierOnlyNoOrder` = vận đơn không gắn đơn, không dấu ERP / Pancake, KHÔNG phải chiều về và KHÔNG mang mã tham chiếu ERP (chắc
   * chắn tạo ngoài ERP) · `legUnsure` = mang DÁNG mã chiều về (`legBaseCode`) mà ERP không có vận đơn gốc — không chắc ⇒ chỉ HINT ·
   * `returnLegs` = chiều về của một vận đơn ERP đã biết (AGENTS §3 luật 7 — dòng riêng, order_id NULL theo quy ước) ⇒ LOẠI.
   */
  shipments: { withCode: number; erpCreated: number; pancakeSynced: number; carrierOnlyNoOrder: number; legUnsure: number; returnLegs: number };
  erpOrdersWithPosLink: number;
  landingPushedToPos: number;
  vtp: { packetsWindow: number; packetsAll: number; carrierEventsWindow: number; importBatches: number; statementLines: number };
  posApi: PosChannelFacts;
  pos: { sampleAsked: number; sampleRead: number; posOrders: number; withTracking: number; strongOrLink: number; doubleShipmentRisk: number };
};

export const ORPHAN_CLASSES = ["OUTSIDE", "RETURN_LEG", "LEG_UNSURE", "ERP_ECHO"] as const;
export type OrphanClass = (typeof ORPHAN_CLASSES)[number];

/**
 * Một vận đơn KHÔNG gắn đơn, không dấu tạo ERP / Pancake: có thật là tạo NGOÀI ERP không? HÀM THUẦN.
 *  ERP_ECHO — hãng gửi lại mã tham chiếu dạng ERP (`ERP<8 hex>-<n>`, chỉ ERP sinh) ⇒ ERP tạo, dòng đơn đã mất ⇒ LOẠI;
 *  RETURN_LEG — chiều về (AGENTS §3 luật 7: mã gốc + `[số]P[số]`, dòng RIÊNG, order_id NULL theo quy ước): `legBaseCode` của mã, hoặc
 *    `order_reference` khác mã, trỏ tới một vận đơn ERP ĐÃ BIẾT ⇒ LOẠI (không bao giờ đếm là «tạo ngoài ERP»);
 *  LEG_UNSURE — mang DÁNG mã chiều về (`legBaseCode` khác rỗng — CHÍNH regex của bộ đọc tệp VTP, không viết luật thứ hai) mà ERP không có
 *    vận đơn gốc ⇒ không chắc ⇒ chỉ HINT;
 *  OUTSIDE — còn lại.
 */
export function classifyOrphanShipment(row: { code: string; orderReference: string | null; carrierReference: string | null }, knownCodes: ReadonlySet<string>): OrphanClass {
  if (/^ERP[0-9A-F]{8}-\d+$/i.test((row.carrierReference ?? "").trim())) return "ERP_ECHO";
  const code = row.code.trim().toUpperCase();
  const base = legBaseCode(code);
  const ref = (row.orderReference ?? "").trim().toUpperCase();
  if ((base && knownCodes.has(base)) || (ref && ref !== code && knownCodes.has(ref))) return "RETURN_LEG";
  if (base) return "LEG_UNSURE";
  return "OUTSIDE";
}

/** Tổ chức nhà dùng credential MÔI TRƯỜNG (Pancake / Viettel Post), không dùng `org_connections` — phép đo này sẽ kết luận sai. */
export const HOME_ORG_REFUSAL = "tổ chức NHÀ dùng credential môi trường (Pancake POS / Viettel Post), không qua org_connections — phép đo này chỉ dành cho tổ chức khách; với nhà dùng ops shipment-origin-audit";

/**
 * Kết luận từng ĐƯỜNG tạo vận đơn kèm mức tin cậy. HÀM THUẦN. Không đường nào được «coi như có» khi thiếu căn cứ, và vắng mặt trong
 * MẪU không bao giờ là MEASURED. API POS đọc được (cả kỳ) thắng mẫu recent_orders.
 */
export function concludeShippingSource(f: ProbeFacts): Conclusion[] {
  const out: Conclusion[] = [];
  if (f.shipments.erpCreated > 0) out.push({ path: "ERP_CARRIER", verdict: "ĐANG DÙNG", strength: "MEASURED", why: `${f.shipments.erpCreated} vận đơn trong kỳ mang dấu tạo của ERP (carrierCreate)` });
  else if (!f.carrierCreateActive.length) out.push({ path: "ERP_CARRIER", verdict: "KHÔNG DÙNG", strength: "MEASURED", why: "không kết nối hãng nào (viettelpost/ghn/ghtk-carrier) đang bật và 0 vận đơn mang dấu tạo của ERP" });
  else out.push({ path: "ERP_CARRIER", verdict: "CÓ KẾT NỐI, KỲ NÀY KHÔNG TẠO", strength: "MEASURED", why: `kết nối bật: ${f.carrierCreateActive.join(", ")} · 0 vận đơn mang dấu tạo của ERP trong kỳ` });

  if (!f.posOrgActive) out.push({ path: "ERP_POS_LINK", verdict: "ERP KHÔNG NỐI POS", strength: "MEASURED", why: `kết nối pancake-pos-org ${f.posOrgPresent ? "có nhưng chưa bật" : "không có"} ⇒ ERP không kéo đơn / vận đơn POS; đơn ERP mang liên kết POS ${f.erpOrdersWithPosLink}; đơn ERP không có đường đẩy sang POS (chỉ đơn landing của nhà — đã đẩy ${f.landingPushedToPos})` });
  else if (f.shipments.pancakeSynced > 0) out.push({ path: "ERP_POS_LINK", verdict: "ERP KÉO VẬN ĐƠN TỪ POS", strength: "MEASURED", why: `${f.shipments.pancakeSynced} vận đơn trong kỳ mang dấu đồng bộ Pancake` });
  else out.push({ path: "ERP_POS_LINK", verdict: "NỐI POS NHƯNG KỲ NÀY KHÔNG CÓ VẬN ĐƠN ĐỒNG BỘ", strength: "MEASURED", why: "pancake-pos-org đang bật · 0 vận đơn mang dấu Pancake trong kỳ" });

  const api = f.posApi;
  const p = f.pos;
  const cap = api.truncated ? " (CẮT ở trần trang — số là tối thiểu)" : "";
  if (api.status === "READ" && api.withTracking > 0) out.push({ path: "POS_SHIPMENTS", verdict: "POS CÓ TẠO VẬN ĐƠN", strength: "MEASURED", why: `API POS cả kỳ: ${api.posOrders} đơn, ${api.withTracking} có mã vận đơn${cap} (ghép đơn ERP: LINK/HINT_STRONG ${api.strongOrLink} — gợi ý)` });
  else if (api.status === "READ") out.push({ path: "POS_SHIPMENTS", verdict: api.posOrders > 0 ? "CÓ ĐƠN POS, CHƯA THẤY MÃ VẬN ĐƠN" : "POS KHÔNG CÓ ĐƠN TRONG KỲ", strength: "MEASURED", why: `API POS cả kỳ: ${api.posOrders} đơn, 0 có mã vận đơn${cap}` });
  else if (p.sampleRead === 0) out.push({ path: "POS_SHIPMENTS", verdict: "CHƯA ĐO ĐƯỢC", strength: "UNKNOWN", why: `${api.status === "FAILED" ? "API POS lỗi; " : api.status === "NOT_CONNECTED" ? "không có khoá POS đang bật; " : ""}${p.sampleAsked ? `đọc được 0/${p.sampleAsked} hội thoại mẫu qua Pancake` : f.fanpageActive ? "không gọi Pancake (mẫu 0 / không hội thoại có mã page + mã hội thoại)" : "không có kết nối pancake-fanpage đang bật để đọc recent_orders"}` });
  else if (p.withTracking > 0) out.push({ path: "POS_SHIPMENTS", verdict: "POS CÓ TẠO VẬN ĐƠN", strength: "MEASURED", why: `trong ${p.sampleRead} hội thoại mẫu (CHỈ hội thoại đã có đơn ERP): ${p.posOrders} đơn POS trong kỳ, ${p.withTracking} có mã vận đơn (ghép đơn ERP: LINK/HINT_STRONG ${p.strongOrLink} — gợi ý)` });
  else if (p.posOrders > 0) out.push({ path: "POS_SHIPMENTS", verdict: "CÓ ĐƠN POS, CHƯA THẤY MÃ VẬN ĐƠN", strength: "MEASURED", why: `trong ${p.sampleRead} hội thoại mẫu (CHỈ hội thoại đã có đơn ERP): ${p.posOrders} đơn POS trong kỳ, 0 có mã vận đơn` });
  else out.push({ path: "POS_SHIPMENTS", verdict: "MẪU KHÔNG THẤY ĐƠN POS", strength: p.sampleRead >= PROBE_MIN_SAMPLE ? "HINT" : "UNKNOWN", why: `${p.sampleRead} hội thoại mẫu đọc được (CHỈ hội thoại đã có đơn ERP — đơn POS của hội thoại không có đơn ERP thì mẫu không thấy), 0 đơn POS trong kỳ (vắng trong mẫu không chứng minh POS không dùng${p.sampleRead < PROBE_MIN_SAMPLE ? `; mẫu < ${PROBE_MIN_SAMPLE}` : ""})` });

  const v = f.vtp;
  if (v.packetsAll > 0 || v.carrierEventsWindow > 0 || v.importBatches > 0 || v.statementLines > 0)
    out.push({ path: "VTP_WEBHOOK", verdict: v.packetsWindow > 0 || v.carrierEventsWindow > 0 ? "VIETTEL POST ĐANG BÁO VỀ" : "CÓ CHỨNG TỪ VIETTEL POST NHƯNG KỲ NÀY IM LẶNG", strength: "MEASURED", why: `gói webhook kỳ này ${v.packetsWindow} / mọi lúc ${v.packetsAll} · sự kiện hãng kỳ này ${v.carrierEventsWindow} · lượt nhập tệp ${v.importBatches} · dòng bảng kê ${v.statementLines}` });
  else out.push({ path: "VTP_WEBHOOK", verdict: "VIETTEL POST CHƯA TỪNG BÁO VỀ TỔ CHỨC NÀY", strength: "UNKNOWN", why: "0 gói webhook, 0 sự kiện hãng, 0 tệp nhập, 0 bảng kê. Viettel Post không cấp API đọc cho shop — ERP chỉ thấy khi URL webhook của tổ chức được dán vào tài khoản Viettel Post; không phân biệt được «chưa dán URL» với «không có vận đơn»" });

  if (f.shipments.carrierOnlyNoOrder > 0) out.push({ path: "OUTSIDE_ERP", verdict: "CÓ VẬN ĐƠN TẠO NGOÀI ERP", strength: "MEASURED", why: `${f.shipments.carrierOnlyNoOrder} vận đơn trong kỳ chỉ có chứng từ hãng, không gắn đơn ERP, không phải chiều về, không mang mã tham chiếu ERP — POS hay trang hãng thì ERP không tách được (đã loại ${f.shipments.returnLegs} chiều về của vận đơn đã biết; ${f.shipments.legUnsure} dáng chiều về không rõ gốc để riêng)` });
  else if (api.status === "READ" && api.withTracking > 0 && f.shipments.pancakeSynced === 0) out.push({ path: "OUTSIDE_ERP", verdict: "VẬN ĐƠN TẠO TRÊN POS, ERP KHÔNG THẤY", strength: "MEASURED", why: `API POS: ${api.withTracking} đơn có mã vận đơn trong kỳ, 0 vận đơn mang dấu Pancake về ERP` });
  else if (p.withTracking > 0 && f.shipments.pancakeSynced === 0) out.push({ path: "OUTSIDE_ERP", verdict: "VẬN ĐƠN TẠO TRÊN POS, ERP KHÔNG THẤY", strength: "MEASURED", why: `${p.withTracking} đơn POS có mã vận đơn trong mẫu (hội thoại đã có đơn ERP), 0 vận đơn mang dấu Pancake về ERP` });
  else if (f.shipments.legUnsure > 0) out.push({ path: "OUTSIDE_ERP", verdict: "CÓ THỂ CÓ VẬN ĐƠN TẠO NGOÀI ERP", strength: "HINT", why: `${f.shipments.legUnsure} vận đơn không gắn đơn mang DÁNG mã chiều về mà ERP không có vận đơn gốc — có thể là chiều về của vận đơn tạo ngoài ERP, có thể không; không kết luận (đã loại ${f.shipments.returnLegs} chiều về của vận đơn đã biết)` });
  else out.push({ path: "OUTSIDE_ERP", verdict: "KHÔNG XÁC ĐỊNH ĐƯỢC", strength: "UNKNOWN", why: "ERP không có dấu vết vận đơn nào ngoài ERP; trang / app Viettel Post không để lại gì trong ERP khi webhook chưa nối" });
  return out;
}

/** Một câu tổng kết từ các kết luận. HÀM THUẦN. */
export function overallSentence(cs: readonly Conclusion[]): string {
  const measuredUse = cs.filter((c) => c.strength === "MEASURED" && /ĐANG DÙNG|KÉO VẬN ĐƠN|POS CÓ TẠO|ĐANG BÁO VỀ|TẠO NGOÀI ERP|TẠO TRÊN POS/.test(c.verdict)).map((c) => c.path);
  if (measuredUse.length) return `Đường tạo / báo vận đơn ĐO ĐƯỢC: ${[...new Set(measuredUse)].join(" + ")}. Các đường còn lại xem từng dòng (mức tin cậy kèm theo).`;
  return "CHƯA XÁC ĐỊNH được đường tạo vận đơn từ dữ liệu ERP: ERP không tạo, không nối POS, Viettel Post chưa báo về — vận đơn được tạo ở nơi ERP không nhìn thấy. Giữ nguyên quy trình; KHÔNG chuyển receive-only cho tới khi có chứng cứ.";
}

/** Chia một câu tóm tắt thành các mảnh ≤ `max` ký tự, cắt ở khoảng trắng; mảnh sau mang «↳ ». HÀM THUẦN. */
export function splitSummary(s: string, max = 290): string[] {
  if (s.length <= max) return [s];
  const out: string[] = [];
  let rest = s;
  while (rest.length > max) {
    const cut = rest.lastIndexOf(" ", max);
    const at = cut > max / 2 ? cut : max;
    out.push(rest.slice(0, at));
    rest = `↳ ${rest.slice(at).trimStart()}`;
  }
  out.push(rest);
  return out;
}

const bump = <K>(m: Map<K, number>, k: K, n = 1) => m.set(k, (m.get(k) ?? 0) + n);
export const vnDay = (d: Date) => new Date(d.getTime() + VN_OFFSET_MS).toISOString().slice(0, 10);
const day = (d: unknown) => {
  if (!d) return "—";
  const t = d instanceof Date ? d : new Date(String(d));
  return Number.isNaN(t.getTime()) ? "—" : vnDay(t);
};
const vnd = (n: number) => `${Math.round(n).toLocaleString("vi-VN")} ₫`;

// ─────────────────────────── ĐỌC PANCAKE (CHỈ GET) ───────────────────────────

export type RecentOrdersResult = { ok: true; recentOrders: unknown[] | null } | { ok: false; reason: string };
export type RecentOrdersFetcher = (pageId: string, threadId: string, token: string) => Promise<RecentOrdersResult>;

/** GET tin MỘT hội thoại (một trang) qua Pancake Pages — chỉ lấy `recent_orders`. 429 / 5xx lùi dần trong `fetchJson`. */
export const fetchRecentOrdersFromPancake: RecentOrdersFetcher = async (pageId, threadId, token) => {
  const url = `${PANCAKE_PAGES_API}/v1/pages/${encodeURIComponent(pageId)}/conversations/${encodeURIComponent(threadId)}/messages?page_access_token=${encodeURIComponent(token)}`;
  try {
    const { body } = await fetchJson(url, { serviceName: "Pancake Pages", timeoutMs: 15_000, retries: 3 });
    const rec = asRecord(body);
    if (rec.success === false) return { ok: false, reason: "success=false" };
    return { ok: true, recentOrders: Array.isArray(rec.recent_orders) ? asArray(rec.recent_orders) : null };
  } catch (e) {
    // Câu lỗi có thể mang URL (token trong query) — che trước khi đi đâu.
    return { ok: false, reason: `${tenLoi(e)}: ${scrubSecrets(e instanceof Error ? e.message : String(e), [token]).slice(0, 120)}` };
  }
};

/** Trần trang khi đọc API POS (100 đơn / trang) — vượt thì in «CẮT», số là tối thiểu. */
export const POS_API_MAX_PAGES = 10;
export type PosApiResult = { ok: true; orders: unknown[]; truncated: boolean; totalEntries: number } | { ok: false; reason: string; notConnected?: boolean };
export type PosApiReader = (org: { code: string; isHome: boolean }, from: Date, now: Date) => Promise<PosApiResult>;

/**
 * Đơn POS tạo trong kỳ qua API Pancake POS bằng KHOÁ CỦA CHÍNH TỔ CHỨC (`pancake-pos-org`) — CHỈ GET (`iterateOrders` → `listOrders`;
 * 429 / 5xx lùi dần trong `fetchJson`, điều tiết nhịp trong client). Khoá chỉ mở được qua `openActiveConnection` trong NGỮ CẢNH tổ
 * chức, mà `getDb()` của ngữ cảnh sẽ MIGRATE — nên gắn handle CHẨN ĐOÁN (máy chủ ép chỉ đọc) vào chỗ `getDb()` tìm trước
 * (`bindReadOnlyOrgHandle`, cùng cách ops `pancake-thread-diff`). Câu lỗi chỉ in LOẠI + mã HTTP (client đã che khoá).
 */
export const readPosOrdersViaApi: PosApiReader = async (org, from, now) => {
  try {
    await bindReadOnlyOrgHandle(org);
    return await withOrganization(org.code, async (): Promise<PosApiResult> => {
      const opened = await openOrgPancakeClient();
      if (!("ok" in opened)) return { ok: false, reason: opened.skipped, notConnected: true };
      const orders: unknown[] = [];
      let pages = 0;
      let totalEntries = 0;
      let truncated = false;
      for await (const page of opened.client.iterateOrders({ updateStatus: "inserted_at", start: from, end: now, pageSize: 100 })) {
        pages += 1;
        totalEntries = Math.max(totalEntries, page.totalEntries);
        orders.push(...page.orders);
        if (pages >= POS_API_MAX_PAGES) {
          truncated = page.page < page.totalPages || orders.length < totalEntries;
          break;
        }
      }
      return { ok: true, orders, truncated, totalEntries };
    });
  } catch (e) {
    return { ok: false, reason: `${tenLoi(e)}${e instanceof IntegrationError ? ` HTTP ${e.status}` : ""}` };
  }
};

// ─────────────────────────── ĐỌC CSDL ───────────────────────────

export type ProbeOptions = { orgCode: string; isHome: boolean; days: number; sample: number; now: Date };
export type ProbeDeps = { fetchRecentOrders?: RecentOrdersFetcher; tokens?: Map<string, string>; gapMs?: number; readPosOrders?: PosApiReader };
export type ProbeReport = { facts: ProbeFacts; conclusions: Conclusion[]; pos: PosAggregate; posApi: PosAggregate | null; detail: string[]; summary: string[] };

const num = (v: unknown) => Number(v ?? 0) || 0;

/** Đọc + phân nhóm + in MỘT tổ chức. Trả bản số để bài kiểm đối chiếu. */
export async function probeShippingSource(db: Db, opts: ProbeOptions, deps: ProbeDeps = {}): Promise<ProbeReport> {
  // Nhà: kết nối nằm ở biến môi trường ⇒ «ERP không nối POS / không tạo vận đơn» sẽ là MEASURED SAI. Từ chối, không đo.
  if (opts.isHome) throw new Error(`shipping-source-probe: ${HOME_ORG_REFUSAL}`);
  const { orgCode, days, sample, now } = opts;
  const from = new Date(now.getTime() - days * 86_400_000);
  const summary: string[] = [];
  // Kênh tóm tắt cắt ở 300 ký tự — câu dài được CHIA thành nhiều dòng «↳» thay vì mất đuôi (đuôi thường là câu căn cứ).
  const say = (s: string) => {
    summary.push(s);
    for (const part of splitSummary(s)) tomTat(part);
  };
  const detail: string[] = [];

  // 1 · Kết nối — chỉ tên + trạng thái (đường đọc của service, không chạm bảng bí mật).
  const conns = await connectionStatusRows(db);
  const own = conns.filter((c) => c.orgCode === orgCode);
  const activeKeys = own.filter(connectionActive).map((c) => c.connectorKey);
  const p = schema.orgChannelPages;
  const pages = await db.select({ connectorKey: p.connectorKey, status: p.status, n: sql<number>`count(*)::int`, lastEvent: sql<Date | null>`max(${p.lastEventAt})` }).from(p).where(eq(p.orgCode, orgCode)).groupBy(p.connectorKey, p.status);
  const posOrg = own.find((c) => c.connectorKey === "pancake-pos-org");
  const carrierCreateActive = activeKeys.filter((k) => SHIPPING_CONNECTOR_ROLE[k] === "ERP_CARRIER_CREATE");
  const fanpageActive = activeKeys.includes(FANPAGE_CONNECTOR);
  say(`${orgCode} kết nối: ${own.length} (đang bật ${activeKeys.length}) · ${own.map((c) => `${c.connectorKey}=${c.status}${c.lastTestOk === true ? "✓" : c.lastTestOk === false ? "✗" : "?"}${SHIPPING_CONNECTOR_ROLE[c.connectorKey] ? `[${SHIPPING_CONNECTOR_ROLE[c.connectorKey]}]` : ""}`).join(" · ") || "—"}${conns.length !== own.length ? ` · dòng mang mã tổ chức khác ${conns.length - own.length} (bỏ qua)` : ""}`);
  say(`${orgCode} kết nối chở vận đơn: POS (pancake-pos-org) ${posOrg ? `${posOrg.status}${posOrg.lastTestOk ? " kiểm đạt" : ""} · kiểm lần cuối ${day(posOrg.lastTestAt)}` : "KHÔNG CÓ"} · ERP tạo vận đơn ${carrierCreateActive.join(", ") || "KHÔNG kết nối hãng nào bật"} · webhook Viettel Post: không có dòng kết nối (URL do máy chủ cấp — đo bằng gói tin bên dưới) · page chat ${pages.map((r) => `${r.connectorKey}/${r.status} ${r.n} (sự kiện cuối ${day(r.lastEvent)})`).join(" · ") || "0"}`);

  // 2 · Đồng bộ đã chạy (tên job, không chi tiết).
  const sr = schema.syncRuns;
  const runs = await db
    .select({ source: sr.source, job: sr.job, n: sql<number>`count(*)::int`, ok: sql<number>`count(*) filter (where ${sr.status} = 'SUCCESS')::int`, imported: sql<number>`coalesce(sum(${sr.imported}), 0)::int`, last: sql<Date | null>`max(${sr.startedAt})` })
    .from(sr)
    .where(and(gte(sr.startedAt, new Date(now.getTime() - 30 * 86_400_000)), sql`(${sr.source} ~* '(pancake|vtp|viettel|ghn|ghtk|carrier|ship)' or ${sr.job} ~* '(pancake|vtp|viettel|ghn|ghtk|carrier|ship)')`))
    .groupBy(sr.source, sr.job)
    .orderBy(desc(sql`max(${sr.startedAt})`))
    .limit(12);
  say(`${orgCode} lượt đồng bộ liên quan vận đơn / Pancake 30 ngày: ${runs.map((r) => `${r.source}/${r.job} ${r.n} lượt (đạt ${r.ok}, nhận ${r.imported}, cuối ${day(r.last)})`).join(" · ") || "0"}`);

  // 3 · Vận đơn ERP biết trong kỳ — theo dấu nguồn.
  const s = schema.shipments;
  const [sh] = await db
    .select({
      total: sql<number>`count(*)::int`,
      withCode: sql<number>`count(*) filter (where coalesce(${s.trackingCode}, ${s.vtpOrderNumber}, '') <> '')::int`,
      erpCreated: sql<number>`count(*) filter (where coalesce(${s.trackingCode}, ${s.vtpOrderNumber}, '') <> '' and ${s.raw} ? 'carrierCreate')::int`,
      erpAttempts: sql<number>`count(*) filter (where ${s.raw} ? 'carrierCreate')::int`,
      pancake: sql<number>`count(*) filter (where (${s.raw} ? 'pancake') or ${s.lastPancakeSyncAt} is not null)::int`,
      vtpRaw: sql<number>`count(*) filter (where ${s.raw} ? 'vtp')::int`,
      noOrder: sql<number>`count(*) filter (where ${s.orderId} is null and coalesce(${s.trackingCode}, ${s.vtpOrderNumber}, '') <> '')::int`,
      erpOrder: sql<number>`count(*) filter (where ${s.orderId} like ${`${MANUAL_ORDER_ID_PREFIX}%`})::int`,
      cod: sql<number>`coalesce(sum(${s.codAmount}) filter (where coalesce(${s.trackingCode}, ${s.vtpOrderNumber}, '') <> ''), 0)::bigint`,
    })
    .from(s)
    .where(gte(s.createdAt, from));
  // Vận đơn không gắn đơn, không dấu ERP / Pancake ⇒ phân loại bằng classifyOrphanShipment (loại chiều về + mã tham chiếu ERP).
  const orphanRows = await db
    .select({ code: sql<string>`coalesce(nullif(${s.trackingCode}, ''), ${s.vtpOrderNumber})`, orderReference: s.orderReference, carrierReference: sql<string | null>`coalesce(${s.raw}->'vtp'->>'ORDER_REFERENCE', ${s.raw}->'vtp'->>'order_reference')` })
    .from(s)
    .where(and(gte(s.createdAt, from), isNull(s.orderId), sql`coalesce(${s.trackingCode}, ${s.vtpOrderNumber}, '') <> ''`, sql`not (${s.raw} ? 'pancake')`, sql`not (${s.raw} ? 'carrierCreate')`))
    .limit(MAX_ORPHAN_ROWS + 1);
  const orphanTruncated = orphanRows.length > MAX_ORPHAN_ROWS;
  const orphans = orphanRows.slice(0, MAX_ORPHAN_ROWS);
  const candidates = [...new Set(orphans.flatMap((r) => [legBaseCode(String(r.code ?? "")), (r.orderReference ?? "").trim().toUpperCase()]).filter(Boolean))];
  const knownCodes = new Set<string>();
  for (let i = 0; i < candidates.length; i += 500) {
    const part = candidates.slice(i, i + 500);
    const hit = await db.select({ t: s.trackingCode, v: s.vtpOrderNumber }).from(s).where(or(inArray(s.trackingCode, part), inArray(s.vtpOrderNumber, part)));
    for (const h of hit) for (const c of [h.t, h.v]) if (c) knownCodes.add(c.trim().toUpperCase());
  }
  const orphanCls = new Map<OrphanClass, number>();
  for (const r of orphans) {
    const cls = classifyOrphanShipment({ code: String(r.code ?? ""), orderReference: r.orderReference, carrierReference: r.carrierReference }, knownCodes);
    bump(orphanCls, cls);
    if (cls !== "OUTSIDE") detail.push(`  vận đơn không đơn ${String(r.code ?? "")} · ${cls}`);
  }
  const se = schema.shipmentEvents;
  const evs = await db.select({ source: se.source, n: sql<number>`count(*)::int` }).from(se).where(gte(se.occurredAt, from)).groupBy(se.source);
  const carrierEventsWindow = evs.filter((e) => /^(VTP_|GHN_|GHTK_)/.test(e.source)).reduce((a, e) => a + num(e.n), 0);
  say(`${orgCode} vận đơn ERP biết ${days} ngày: dòng ${num(sh?.total)} · có mã ${num(sh?.withCode)} (COD khai báo ${vnd(num(sh?.cod))}) · dấu tạo ERP có mã ${num(sh?.erpCreated)} (mọi lượt tạo ERP ${num(sh?.erpAttempts)}) · dấu Pancake ${num(sh?.pancake)} · bản DATA Viettel Post ${num(sh?.vtpRaw)} · gắn đơn ERP ${num(sh?.erpOrder)} · KHÔNG gắn đơn ${num(sh?.noOrder)} (không dấu ERP/Pancake: ngoài ERP ${orphanCls.get("OUTSIDE") ?? 0} · chiều về của vận đơn đã biết ${orphanCls.get("RETURN_LEG") ?? 0} · dáng chiều về không rõ gốc ${orphanCls.get("LEG_UNSURE") ?? 0} · hãng gửi lại mã ERP ${orphanCls.get("ERP_ECHO") ?? 0}${orphanTruncated ? ` · CẮT ở ${MAX_ORPHAN_ROWS}` : ""}) · sự kiện hành trình theo nguồn: ${evs.map((e) => `${e.source} ${e.n}`).join(" · ") || "0"}`);

  // 4 · Viettel Post / hãng — chỉ webhook + tệp + bảng kê (không API đọc).
  const w = schema.webhookEvents;
  const hooks = await db
    .select({ source: w.source, all: sql<number>`count(*)::int`, win: sql<number>`count(*) filter (where ${w.receivedAt} >= ${from})::int`, first: sql<Date | null>`min(${w.receivedAt})`, last: sql<Date | null>`max(${w.receivedAt})`, failed: sql<number>`count(*) filter (where ${w.status} = 'FAILED')::int` })
    .from(w)
    .groupBy(w.source);
  const vtpHook = hooks.find((h) => h.source === "VIETTELPOST");
  const ib = schema.vtpImportBatches;
  const [imp] = await db.select({ n: sql<number>`count(*)::int`, apply: sql<number>`count(*) filter (where ${ib.mode} = 'APPLY')::int`, last: sql<Date | null>`max(${ib.createdAt})` }).from(ib);
  const cl = schema.codStatementLines;
  const [stm] = await db.select({ n: sql<number>`count(*)::int`, matched: sql<number>`count(*) filter (where ${cl.shipmentId} is not null)::int`, last: sql<Date | null>`max(${cl.createdAt})` }).from(cl);
  const sf = schema.vtpStatementFiles;
  const [files] = await db.select({ n: sql<number>`count(*)::int`, last: sql<Date | null>`max(${sf.receivedAt})` }).from(sf);
  say(`${orgCode} chứng từ hãng (Viettel Post KHÔNG cấp API đọc — chỉ webhook / tệp / bảng kê): gói webhook theo nguồn ${hooks.map((h) => `${h.source} ${h.win}/${h.all} (đầu ${day(h.first)}, cuối ${day(h.last)}, lỗi ${h.failed})`).join(" · ") || "0"} (kỳ này/mọi lúc) · lượt nhập tệp Viettel Post ${num(imp?.n)} (ghi ${num(imp?.apply)}, cuối ${day(imp?.last)}) · dòng bảng kê COD ${num(stm?.n)} (ghép vận đơn ${num(stm?.matched)}, cuối ${day(stm?.last)}) · tệp bảng kê ${num(files?.n)}`);

  // 5 · Đơn ERP trong kỳ + đường ERP → POS.
  const o = schema.orders;
  // Tên bảng tường minh: truy vấn mẫu bên dưới nối thêm sales_chat_conversations (cũng có cột id) — cột trần sẽ mơ hồ.
  const isErp = sql`"orders"."id" like ${`${MANUAL_ORDER_ID_PREFIX}%`}`;
  const [od] = await db
    .select({
      n: sql<number>`count(*)::int`,
      erp: sql<number>`count(*) filter (where ${isErp})::int`,
      posLink: sql<number>`count(*) filter (where ${isErp} and coalesce(${o.raw}->>'order_link', '') <> '')::int`,
      withShip: sql<number>`count(*) filter (where ${isErp} and exists (select 1 from shipments sx where sx.order_id = "orders"."id" and coalesce(sx.tracking_code, sx.vtp_order_number, '') <> ''))::int`,
      withErpCreate: sql<number>`count(*) filter (where ${isErp} and exists (select 1 from shipments sx where sx.order_id = "orders"."id" and sx.raw ? 'carrierCreate'))::int`,
      cod: sql<number>`coalesce(sum(${o.moneyToCollect}) filter (where ${isErp} and ${o.stage}::text not in ('CANCELLED','DELETED')), 0)::bigint`,
    })
    .from(o)
    .where(and(gte(o.insertedAt, from), ne(o.stage, "DELETED")));
  const stages = await db.select({ stage: sql<string>`${o.stage}::text`, n: sql<number>`count(*)::int` }).from(o).where(and(gte(o.insertedAt, from), isErp)).groupBy(o.stage);
  const lo = schema.landingOrders;
  const [land] = await db.select({ n: sql<number>`count(*) filter (where ${lo.pancakeOrderId} is not null)::int` }).from(lo);
  const [cfgRow] = await db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, SHIPPING_ROUTING_SETTING_KEY)).limit(1);
  const cfg = cfgRow ? parseShippingRoutingConfig(mergeSettingJson<unknown>(String(cfgRow.value), null)) : DEFAULT_SHIPPING_ROUTING;
  say(`${orgCode} đơn ${days} ngày: ${num(od?.n)} (tạo trong ERP ${num(od?.erp)} · đồng bộ ${num(od?.n) - num(od?.erp)}) · đơn ERP theo khâu ${stages.map((r) => `${r.stage} ${r.n}`).join(" · ") || "—"} · thu hộ đơn ERP chưa huỷ ${vnd(num(od?.cod))} · có vận đơn mang mã ${num(od?.withShip)} · có lượt tạo ERP ${num(od?.withErpCreate)}`);
  say(`${orgCode} ERP → POS: đơn ERP mang liên kết POS (raw.order_link) ${num(od?.posLink)} · mã đơn ERP không có cột mã POS và không có đường đẩy sang POS (chỉ đơn landing của nhà — đơn landing đã đẩy ${num(land?.n)}) · tuyến giao ERP: tự tạo vận đơn ${cfg.autoCreate ? "BẬT" : "TẮT"} · hãng mặc định ${cfg.defaultCarrier ?? "chưa chọn"} · khu tự giao ${cfg.selfAreas.length}`);

  // 6 · POS qua recent_orders của hội thoại — MẪU có trần.
  const cv = schema.salesChatConversations;
  const pageExpr = sql<string | null>`coalesce(${cv.pageId}, ${o.pageId})`;
  const threadExpr = sql<string | null>`coalesce(${cv.threadId}, ${o.conversationId})`;
  const erpRows = await db
    .select({ id: o.id, insertedAt: o.insertedAt, ship: o.shipPhone, bill: o.billPhone, pageId: pageExpr, thread: threadExpr, money: o.moneyToCollect, total: o.totalPriceAfterDiscount, link: sql<string | null>`${o.raw}->>'order_link'`, erpShip: sql<boolean>`exists (select 1 from shipments sx where sx.order_id = "orders"."id" and sx.raw ? 'carrierCreate')` })
    .from(o)
    .leftJoin(cv, eq(cv.id, o.salesConversationId))
    .where(and(isErp, ne(o.stage, "DELETED"), gte(o.insertedAt, new Date(from.getTime() - MATCH_DAYS * 86_400_000))))
    .orderBy(desc(o.insertedAt))
    .limit(MAX_ERP_ORDERS);
  const erps: ErpOrderLite[] = erpRows.map((r) => ({
    id: r.id,
    insertedAt: r.insertedAt instanceof Date ? r.insertedAt : new Date(String(r.insertedAt)),
    phones: [...new Set([r.ship, r.bill].map((x) => normalizeVnPhone(String(x ?? ""))).filter((x): x is string => Boolean(x)))],
    thread: r.thread,
    moneyToCollect: num(r.money),
    totalAfterDiscount: num(r.total),
    linkOrderId: posLinkOrderId(r.link),
    hasErpShipment: Boolean(r.erpShip),
  }));
  const erpById = new Map(erps.map((e) => [e.id, e]));
  const convs: { pageId: string; thread: string }[] = [];
  const seenConv = new Set<string>();
  for (const r of erpRows) {
    if (convs.length >= sample) break;
    const ins = r.insertedAt instanceof Date ? r.insertedAt : new Date(String(r.insertedAt));
    if (ins < from || !r.pageId || !r.thread) continue;
    const k = `${r.pageId}:${r.thread}`;
    if (seenConv.has(k)) continue;
    seenConv.add(k);
    convs.push({ pageId: r.pageId, thread: r.thread });
  }
  const tally = { asked: 0, read: 0, noToken: 0, failed: 0, noKey: 0, emptyList: 0, rawOrders: 0, unmapped: 0 };
  const failReasons = new Map<string, number>();
  const posById = new Map<string, PosOrderLite>();
  if (sample > 0 && convs.length) {
    const tokens = deps.tokens ?? (await pageTokensForOffboard(db, orgCode, FANPAGE_CONNECTOR)).tokens;
    const fetcher = deps.fetchRecentOrders ?? fetchRecentOrdersFromPancake;
    const gap = deps.gapMs ?? CALL_GAP_MS;
    for (const c of convs) {
      const token = tokens.get(c.pageId);
      if (!token) {
        tally.noToken += 1;
        continue;
      }
      if (tally.asked > 0 && gap > 0) await sleep(gap);
      tally.asked += 1;
      const res = await fetcher(c.pageId, c.thread, token);
      if (!res.ok) {
        tally.failed += 1;
        bump(failReasons, res.reason.split(":")[0] ?? "lỗi");
        detail.push(`  hội thoại …${c.thread.slice(-6)} · KHÔNG ĐỌC ĐƯỢC · ${res.reason}`);
        continue;
      }
      tally.read += 1;
      if (res.recentOrders === null) {
        tally.noKey += 1;
        continue;
      }
      if (!res.recentOrders.length) tally.emptyList += 1;
      for (const raw of res.recentOrders) {
        tally.rawOrders += 1;
        const m = mapOrder(raw);
        if (!m) {
          tally.unmapped += 1;
          continue;
        }
        if (!posById.has(m.id)) posById.set(m.id, toPosLite(m));
      }
    }
  }
  // Một đường phân nhóm + ghép cho cả hai kênh (API cả kỳ · mẫu recent_orders) — không hai luật.
  const analyse = (lites: readonly PosOrderLite[], tag: string): PosAggregate => {
    const inWindow = lites.filter((x) => x.insertedAt >= from).sort((a, b) => a.insertedAt.getTime() - b.insertedAt.getTime() || a.posId.localeCompare(b.posId));
    const matched = inWindow.map((pos) => ({ pos, match: matchPosToErp(pos, erps) }));
    for (const { pos, match } of matched) {
      const e = match.erpId ? erpById.get(match.erpId) : undefined;
      const risk = Boolean(pos.trackingCode && e?.hasErpShipment && (match.cls === "LINK" || match.cls === "HINT_STRONG"));
      detail.push(`  ${tag} POS ${pos.posId} · tạo ${vnDay(pos.insertedAt)} · ${pos.stage} · ${pos.bucket} · ${pos.trackingCode ?? "—"} · COD khai báo ${vnd(pos.codDeclared)} · ${match.cls}${match.erpId ? ` ↔ #${manualOrderShortCode(match.erpId)}` : ""}${risk ? " · RỦI RO HAI VẬN ĐƠN" : ""}`);
    }
    return aggregatePos(matched, erpById);
  };
  const sayAgg = (label: string, agg: PosAggregate) => {
    if (!agg.total) return;
    say(`${orgCode} ${label} theo hãng (số · COD khai báo, không phải tiền thực thu): ${POS_CARRIER_BUCKETS.filter((b) => agg.byBucket.get(b)).map((b) => `${b} ${agg.byBucket.get(b)!.n} · ${vnd(agg.byBucket.get(b)!.cod)}`).join(" | ")} · theo khâu POS: ${[...agg.byStage.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, n]) => `${k} ${n}`).join(" · ")}`);
    say(`${orgCode} ${label} ghép ↔ ERP (LINK = liên kết đã lưu; HINT_* chỉ là GỢI Ý, không kết luận): ${MATCH_CLASSES.map((c) => `${c} ${agg.match.get(c) ?? 0}`).join(" · ")} · trong đó có mã vận đơn: ${MATCH_CLASSES.map((c) => `${c} ${agg.matchWithTracking.get(c) ?? 0}`).join(" · ")}`);
    say(`${orgCode} ${label} rủi ro trùng (GỢI Ý): đơn ERP có đơn POS mang mã vận đơn ghép LINK/HINT_STRONG ${agg.erpAlsoShippedOnPos} · trong đó ERP CŨNG có lượt tạo vận đơn ${agg.doubleShipmentRisk}`);
  };
  const strongOrLink = (agg: PosAggregate) => (agg.matchWithTracking.get("LINK") ?? 0) + (agg.matchWithTracking.get("HINT_STRONG") ?? 0);

  const agg = analyse([...posById.values()], "MẪU");
  const sampleLine = sample === 0 ? "không gọi (--sample=0)" : !convs.length ? "0 hội thoại có mã page + mã hội thoại trong kỳ" : `hỏi ${tally.asked}/${convs.length} hội thoại (thiếu token page ${tally.noToken}) · đọc được ${tally.read} · lỗi ${tally.failed}${failReasons.size ? ` (${[...failReasons.entries()].map(([k, n]) => `${k} ${n}`).join(" · ")})` : ""} · không khoá recent_orders ${tally.noKey} · danh sách rỗng ${tally.emptyList}`;
  say(`${orgCode} POS qua recent_orders (Pancake, CHỈ GET, mẫu ≤ ${sample}): ${sampleLine} · đơn POS thấy ${tally.rawOrders} (đọc được ${posById.size}, không đọc được ${tally.unmapped}) · trong kỳ ${agg.total} · có mã vận đơn ${agg.withTracking}`);
  sayAgg("MẪU đơn POS trong kỳ", agg);

  // 7 · POS qua API bằng khoá CỦA TỔ CHỨC — chỉ khi kết nối pancake-pos-org đang bật (không thì không có khoá để đọc).
  const posOrgActive = Boolean(posOrg && connectionActive(posOrg));
  let posApi: PosChannelFacts = { status: posOrgActive ? "SKIPPED" : "NOT_CONNECTED", posOrders: 0, withTracking: 0, strongOrLink: 0, doubleShipmentRisk: 0, truncated: false };
  let apiAgg: PosAggregate | null = null;
  if (posOrgActive) {
    const res = await (deps.readPosOrders ?? readPosOrdersViaApi)({ code: orgCode, isHome: opts.isHome }, from, now);
    if (!res.ok) {
      posApi = { ...posApi, status: res.notConnected ? "NOT_CONNECTED" : "FAILED" };
      say(`${orgCode} POS qua API (khoá của tổ chức, CHỈ GET): ${res.notConnected ? "không mở được kết nối" : "LỖI"} — ${res.reason}`);
    } else {
      const lites = new Map<string, PosOrderLite>();
      let unmapped = 0;
      for (const raw of res.orders) {
        const m = mapOrder(raw);
        if (!m) unmapped += 1;
        else if (!lites.has(m.id)) lites.set(m.id, toPosLite(m));
      }
      apiAgg = analyse([...lites.values()], "API");
      posApi = { status: "READ", posOrders: apiAgg.total, withTracking: apiAgg.withTracking, strongOrLink: strongOrLink(apiAgg), doubleShipmentRisk: apiAgg.doubleShipmentRisk, truncated: res.truncated };
      say(`${orgCode} POS qua API (khoá của tổ chức, CHỈ GET, ≤ ${POS_API_MAX_PAGES} trang × 100): Pancake báo ${res.totalEntries} đơn · đọc ${res.orders.length}${res.truncated ? " (CẮT ở trần trang)" : ""} · không đọc được ${unmapped} · trong kỳ ${apiAgg.total} · có mã vận đơn ${apiAgg.withTracking}`);
      sayAgg("API đơn POS trong kỳ", apiAgg);
    }
  } else say(`${orgCode} POS qua API: không gọi — ${posOrg ? "kết nối pancake-pos-org chưa bật" : "tổ chức không có kết nối pancake-pos-org"} (ERP không có khoá POS của tổ chức này)`);

  const facts: ProbeFacts = {
    posOrgPresent: Boolean(posOrg),
    posOrgActive,
    carrierCreateActive,
    fanpageActive,
    shipments: { withCode: num(sh?.withCode), erpCreated: num(sh?.erpCreated), pancakeSynced: num(sh?.pancake), carrierOnlyNoOrder: orphanCls.get("OUTSIDE") ?? 0, legUnsure: orphanCls.get("LEG_UNSURE") ?? 0, returnLegs: orphanCls.get("RETURN_LEG") ?? 0 },
    erpOrdersWithPosLink: num(od?.posLink),
    landingPushedToPos: num(land?.n),
    vtp: { packetsWindow: num(vtpHook?.win), packetsAll: num(vtpHook?.all), carrierEventsWindow, importBatches: num(imp?.n), statementLines: num(stm?.n) },
    posApi,
    pos: { sampleAsked: tally.asked, sampleRead: tally.read, posOrders: agg.total, withTracking: agg.withTracking, strongOrLink: strongOrLink(agg), doubleShipmentRisk: agg.doubleShipmentRisk },
  };
  const conclusions = concludeShippingSource(facts);
  for (const c of conclusions) say(`${orgCode} KẾT LUẬN ${c.path}: ${c.verdict} [${c.strength}] — ${c.why}`);
  say(`${orgCode} TỔNG: ${overallSentence(conclusions)}`);

  console.log(`Chi tiết ${orgCode} (MÃ HOÁ) · kỳ ${days} ngày tới ${now.toISOString()}:`);
  for (const line of detail.slice(0, DETAIL_MAX_LINES)) console.log(line);
  if (detail.length > DETAIL_MAX_LINES) console.log(`  … còn ${detail.length - DETAIL_MAX_LINES} dòng không in`);
  return { facts, conclusions, pos: agg, posApi: apiAgg, detail, summary };
}

async function main() {
  const args = parseProbeArgs(process.argv.slice(2));
  if ("error" in args) {
    tomTat(`shipping-source-probe: DỪNG · cách dùng sai — ${args.error} (arg: ${USAGE})`);
    process.stdout.write("", () => process.exit(1));
    return;
  }
  let exit = 0;
  for (const code of args.codes) {
    const org = await findOrganization(code);
    if (!org) {
      tomTat(`shipping-source-probe: không có tổ chức «${code}» — bỏ qua`);
      exit = 1;
      continue;
    }
    if (org.isHome) {
      tomTat(`shipping-source-probe: bỏ qua «${org.code}» — ${HOME_ORG_REFUSAL}`);
      exit = 1;
      continue;
    }
    const db: Db = await getDbForInspection({ code: org.code, isHome: org.isHome });
    const [ro] = rowsOf<Record<string, unknown>>(await db.execute(sql`show default_transaction_read_only`));
    if (String(ro?.default_transaction_read_only ?? "") !== "on") {
      tomTat(`shipping-source-probe: DỪNG ở «${org.code}» · phiên CSDL KHÔNG ở chế độ chỉ đọc — không đọc gì`);
      process.stdout.write("", () => process.exit(70));
      return;
    }
    tomTat(`shipping-source-probe ${org.code}: ${args.days} ngày · mẫu ${args.sample} · lúc ${new Date().toISOString().slice(0, 16)}Z`);
    try {
      await probeShippingSource(db, { orgCode: org.code, isHome: org.isHome, days: args.days, sample: args.sample, now: new Date() });
    } catch (e) {
      // Câu lỗi đầy đủ chỉ đi vào phần MÃ HOÁ (ops chạy cả lượt trong ma_hoa_ket_qua); kênh tóm tắt công khai chỉ nhận LOẠI lỗi ngay dưới.
      console.error(`shipping-source-probe ${org.code} lỗi:`, e instanceof Error ? e.message : e);
      tomTat(`shipping-source-probe ${org.code}: LỖI ngoài phép đo (${tenLoi(e)}) — chi tiết trong phần mã hoá`);
      exit = 1;
    }
  }
  process.stdout.write("", () => process.exit(exit));
}

// Chỉ chạy khi được gọi THẲNG từ dòng lệnh — `import` từ bài kiểm không được kéo theo `process.exit`.
if (CHAY_THANG) {
  main().catch((e) => {
    // Như trên: câu lỗi chỉ vào phần MÃ HOÁ, tóm tắt công khai không mang nó.
    console.error("shipping-source-probe lỗi:", e instanceof Error ? e.message : e);
    tomTat("shipping-source-probe: LỖI ngoài phép đo — chi tiết trong phần mã hoá");
    process.stdout.write("", () => process.exit(1));
  });
}
