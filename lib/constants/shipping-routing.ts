/**
 * ═══════════ TUYẾN GIAO TỰ ĐỘNG — ĐƠN ĐÃ XÁC NHẬN ĐI TIẾP SANG GIAO HÀNG (POS tự chủ P7) — THUẦN, CLIENT-SAFE ═══════════
 *
 * Chủ shop (SaaS «chotdontudong», MỌI tổ chức khách — 06/10/2026): đơn «Đã xác nhận» mà địa chỉ đã ghép được tỉnh + xã thì
 * TỰ ĐỘNG đi tiếp sang giao hàng theo HAI đường cùng tồn tại:
 *  1. TỰ GIAO — đơn thuộc khu vực shop tự giao (khai theo tỉnh và / hoặc xã, tên chuẩn địa giới mới) vào «Danh sách tự giao»
 *     cho người giao của shop; «Đã giao» đi qua phiếu giao có ký nhận (`confirmManualDeliveryCore`), «Giao không thành công»
 *     qua đường có sẵn (ORDER_OUTCOME.md mục 11).
 *  2. HÃNG — phần còn lại đi hãng mặc định (chỉ hãng tổ chức đã bật kết nối); công tắc «Tự tạo vận đơn» bật thì job
 *     `shipping-route` gọi ĐÚNG lõi tạo vận đơn (`lib/carriers/engine.ts`) — giữ chỗ chống trùng, `CHECK_UNIQUE`, không tự gửi
 *     lại lượt không rõ kết quả: mọi luật của lõi giữ nguyên.
 *
 * KHÔNG BAO GIỜ ĐOÁN: thiếu tỉnh / xã, chưa chọn hãng, hãng chưa bật, mẫu mã chưa khai cân nặng ⇒ GIỮ LẠI (`HOLD`) kèm lý do và
 * lối sửa. Cấu hình THEO TỔ CHỨC ở `settings['shipping.routing']`, mặc định TẮT tự tạo vận đơn. Bật công tắc KHÔNG kéo các đơn
 * đã xác nhận từ trước sang hãng (`autoSince`): bật nhầm một lần không được gọi bưu tá tới lấy cả kho hàng cũ.
 *
 * Tuyến KHÔNG lưu vào CSDL — đọc lúc xem (`lib/shipping/route.ts`). Không đổi ORDER_OUTCOME, không đổi luật tồn kho: tuyến chỉ
 * quyết đơn ĐI ĐƯỜNG NÀO, kết quả giao vẫn theo chứng từ (phiếu giao / mã cuối của hãng).
 */
import { CARRIER_KEYS, type CarrierKey } from "@/lib/carriers/types";

export const SHIPPING_ROUTING_SETTING_KEY = "shipping.routing";

/** Một khu tự giao: một tỉnh (tên chuẩn) + các xã / phường của nó; `wards` rỗng = CẢ TỈNH. */
export type SelfArea = { province: string; wards: string[] };

export type ShippingRoutingConfig = {
  selfAreas: SelfArea[];
  /** Hãng cho đơn ngoài khu tự giao; `null` = chưa chọn ⇒ đơn ngoài khu tự giao bị GIỮ LẠI. */
  defaultCarrier: CarrierKey | null;
  /** Công tắc «Tự tạo vận đơn» — mặc định TẮT. */
  autoCreate: boolean;
  /** Mã dịch vụ cố định của hãng mặc định; `null` = dịch vụ RẺ NHẤT trong bảng cước hãng trả cho TỪNG đơn. */
  serviceCode: string | null;
  /** Mốc bật công tắc (ISO) — chỉ đơn XÁC NHẬN từ mốc này mới được máy tự tạo vận đơn. */
  autoSince: string | null;
};

export const DEFAULT_SHIPPING_ROUTING: ShippingRoutingConfig = { selfAreas: [], defaultCarrier: null, autoCreate: false, serviceCode: null, autoSince: null };

export const SHIPPING_ROUTING_LIMITS = {
  maxAreas: 40,
  maxWardsPerArea: 400,
  nameMax: 120,
  /** Một lượt job tạo tối đa chừng này vận đơn (tuần tự, mỗi đơn 2–3 lượt gọi hãng) — phần còn lại lượt sau làm tiếp. */
  autoPerRun: 20,
  /** Hỏng liên tiếp quá chừng này lần (đơn không sửa gì) ⇒ máy thôi thử, đơn hiện ở «Giữ lại» chờ người. */
  autoMaxAttempts: 3,
  /** Khoảng chờ giữa hai lần máy thử lại cùng một đơn (đơn không sửa gì). */
  autoRetryAfterMs: 30 * 60_000,
  /** Trần số đơn một lượt gán người giao. */
  assignMax: 200,
} as const;

const SERVICE_CODE = /^[A-Z0-9]{1,10}$/;

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

/** Đọc cấu hình đã lưu — dòng hỏng / thiếu ⇒ mặc định (TẮT). Không ném. HÀM THUẦN. */
export function parseShippingRoutingConfig(raw: unknown): ShippingRoutingConfig {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_SHIPPING_ROUTING };
  const r = raw as Record<string, unknown>;
  const areas: SelfArea[] = [];
  const seen = new Set<string>();
  for (const a of Array.isArray(r.selfAreas) ? r.selfAreas : []) {
    if (!a || typeof a !== "object") continue;
    const province = str((a as Record<string, unknown>).province, SHIPPING_ROUTING_LIMITS.nameMax);
    if (!province || seen.has(province)) continue;
    seen.add(province);
    const wardsRaw = (a as Record<string, unknown>).wards;
    const wards = [...new Set((Array.isArray(wardsRaw) ? wardsRaw : []).map((w) => str(w, SHIPPING_ROUTING_LIMITS.nameMax)).filter(Boolean))].slice(0, SHIPPING_ROUTING_LIMITS.maxWardsPerArea);
    areas.push({ province, wards });
    if (areas.length >= SHIPPING_ROUTING_LIMITS.maxAreas) break;
  }
  const carrier = typeof r.defaultCarrier === "string" && (CARRIER_KEYS as readonly string[]).includes(r.defaultCarrier) ? (r.defaultCarrier as CarrierKey) : null;
  const code = typeof r.serviceCode === "string" && SERVICE_CODE.test(r.serviceCode.trim()) ? r.serviceCode.trim() : null;
  const since = typeof r.autoSince === "string" && Number.isFinite(Date.parse(r.autoSince)) ? r.autoSince : null;
  // Công tắc chỉ nhận đúng `true` — chuỗi «true», số 1… là cách một công tắc bật nhầm.
  const autoCreate = r.autoCreate === true && carrier !== null && since !== null;
  return { selfAreas: areas, defaultCarrier: carrier, autoCreate, serviceCode: code, autoSince: since };
}

/** Mã dịch vụ hợp lệ (cùng mẫu với ô dịch vụ của lõi tạo vận đơn). */
export function isServiceCode(v: string): boolean {
  return SERVICE_CODE.test(v);
}

// ─────────────────────────── KẾT QUẢ TUYẾN ───────────────────────────

export const ROUTE_HOLD_CODES = ["NOT_ERP", "NOT_CONFIRMED", "NO_PROVINCE", "NO_WARD", "NO_CARRIER", "CARRIER_OFF", "NO_WEIGHT", "AUTO_FAILED"] as const;
export type RouteHoldCode = (typeof ROUTE_HOLD_CODES)[number];

/** Lối sửa của một lý do giữ lại — màn hình dựng link từ đây. */
export type RouteFix = "EDIT_ORDER" | "ROUTING" | "CONNECTIONS" | "PRODUCTS" | "ORDER";

export const ROUTE_HOLD_META: Record<RouteHoldCode, { label: string; fix: RouteFix; fixLabel: string }> = {
  NOT_ERP: { label: "Đơn đồng bộ từ nguồn khác", fix: "ORDER", fixLabel: "Nguồn của đơn đẩy sang hãng" },
  NOT_CONFIRMED: { label: "Đơn chưa «Đã xác nhận»", fix: "EDIT_ORDER", fixLabel: "Chốt đơn với khách" },
  NO_PROVINCE: { label: "Chưa ghép được tỉnh / thành", fix: "EDIT_ORDER", fixLabel: "Sửa đơn — chọn tỉnh và xã" },
  NO_WARD: { label: "Chưa ghép được xã / phường", fix: "EDIT_ORDER", fixLabel: "Sửa đơn — chọn xã / phường" },
  NO_CARRIER: { label: "Ngoài khu tự giao, chưa chọn hãng mặc định", fix: "ROUTING", fixLabel: "Cấu hình tuyến giao" },
  CARRIER_OFF: { label: "Hãng mặc định chưa bật kết nối", fix: "CONNECTIONS", fixLabel: "Cài đặt → Kết nối → Vận chuyển" },
  NO_WEIGHT: { label: "Mẫu mã chưa khai cân nặng", fix: "ORDER", fixLabel: "Tạo vận đơn tay ở trang đơn (nhập cân) hoặc khai cân mẫu mã" },
  AUTO_FAILED: { label: "Máy tự tạo vận đơn không được", fix: "ORDER", fixLabel: "Xem lỗi, sửa đơn rồi tạo tay ở trang đơn" },
};

export type ShippingRoute =
  /** Đơn đã có một lần gửi còn hiệu lực ở hãng — đã đi, không xếp tuyến nữa. */
  | { kind: "SHIPPED" }
  /** Thuộc khu tự giao — vào «Danh sách tự giao». `area` = tên khu khớp (xã hoặc tỉnh). */
  | { kind: "SELF"; area: string }
  /** Đi hãng. `auto` nói máy có tự tạo vận đơn cho đơn này ở lượt tới không, và vì sao không. */
  | { kind: "CARRIER"; carrier: CarrierKey; weightGrams: number; auto: { ok: true } | { ok: false; why: string } }
  | { kind: "HOLD"; code: RouteHoldCode; reason: string };

export const ROUTE_KIND_LABEL: Record<ShippingRoute["kind"], string> = { SHIPPED: "Đã có vận đơn", SELF: "Tự giao", CARRIER: "Đi hãng", HOLD: "Giữ lại" };

// ─────────────────────────── LƯỢT MÁY TỰ TẠO VẬN ĐƠN ───────────────────────────

export type AutoAttemptState = { attempts: number; lastAt: Date | null; lastResult: "CREATED" | "FAILED" | null; lastMessage: string | null };

/**
 * Máy có được thử tạo vận đơn cho đơn này ở lượt này không. HÀM THUẦN.
 *  · Chưa thử lần nào, hoặc người đã SỬA ĐƠN sau lần hỏng gần nhất ⇒ `FRESH` (thử ngay; bộ đếm tính lại).
 *  · Hỏng đủ `autoMaxAttempts` lần liên tiếp mà đơn không đổi ⇒ `GAVE_UP` (người quyết — đơn hiện ở «Giữ lại»).
 *  · Còn lại: chưa đủ `autoRetryAfterMs` kể từ lần hỏng ⇒ `WAIT`; đủ ⇒ `FRESH`.
 * Lần tạo thành công thì lõi đã giữ đơn (một lần gửi còn hiệu lực) — câu hỏi này không còn được hỏi.
 */
export function autoAttemptDue(a: AutoAttemptState | null, orderUpdatedAt: Date, now: Date): "FRESH" | "WAIT" | "GAVE_UP" {
  if (!a || a.lastResult !== "FAILED" || !a.lastAt) return "FRESH";
  if (orderUpdatedAt.getTime() > a.lastAt.getTime()) return "FRESH";
  if (a.attempts >= SHIPPING_ROUTING_LIMITS.autoMaxAttempts) return "GAVE_UP";
  return now.getTime() - a.lastAt.getTime() >= SHIPPING_ROUTING_LIMITS.autoRetryAfterMs ? "FRESH" : "WAIT";
}

/** Số lần hỏng liên tiếp SAU một lần hỏng mới — người đã sửa đơn sau lần hỏng trước thì đếm lại từ 1. HÀM THUẦN. */
export function nextFailedAttempts(a: AutoAttemptState | null, orderUpdatedAt: Date): number {
  if (!a || a.lastResult !== "FAILED" || !a.lastAt || orderUpdatedAt.getTime() > a.lastAt.getTime()) return 1;
  return a.attempts + 1;
}
