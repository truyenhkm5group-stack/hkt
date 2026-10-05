import { adminProvinces, adminWardsOf, findProvince, foldVnText } from "@/lib/address/vn-address";
import type { CarrierKey } from "@/lib/carriers/types";
import { formatDateTime } from "@/lib/format";
import { autoAttemptDue, ROUTE_HOLD_META, SHIPPING_ROUTING_LIMITS, type AutoAttemptState, type RouteHoldCode, type SelfArea, type ShippingRoute, type ShippingRoutingConfig } from "@/lib/constants/shipping-routing";

/**
 * ═══════════ QUYẾT TUYẾN GIAO CHO MỘT ĐƠN — HÀM THUẦN (POS tự chủ P7 · lib/constants/shipping-routing.ts) ═══════════
 *
 * Không đọc CSDL, không gọi mạng: cùng một đơn + cùng cấu hình + cùng tập hãng đang bật ⇒ cùng một tuyến, mọi lúc. Trang
 * «Danh sách tự giao» và job `shipping-route` gọi CÙNG hàm này — màn hình nói «đi hãng» thì máy tạo vận đơn đúng hãng ấy.
 *
 * Thứ tự căn cứ (dừng ở điều đầu tiên đúng):
 *  1. Đơn không tạo trong ERP / chưa «Đã xác nhận» ⇒ GIỮ (không phải việc của tuyến giao).
 *  2. Đã có lần gửi còn hiệu lực ở hãng ⇒ ĐÃ ĐI.
 *  3. Thiếu tỉnh / xã đã ghép ⇒ GIỮ — không đọc lại dòng địa chỉ ở đây: ô tỉnh + xã chỉ có giá trị khi lõi ghi đơn đã đối chiếu
 *     được với danh mục hoặc người đã chọn (`manualOrderGaps`), đọc lại là đoán.
 *  4. Thuộc khu tự giao ⇒ TỰ GIAO (khu tự giao thắng hãng: shop đã khai mình tự chở tới đó).
 *  5. Còn lại đi hãng mặc định — chưa chọn / chưa bật / thiếu cân ⇒ GIỮ; máy hỏng đủ lần ⇒ GIỮ kèm câu lỗi của hãng.
 */

export type RouteOrderInput = {
  isErp: boolean;
  stage: string;
  province: string;
  ward: string;
  hasLiveShipment: boolean;
  /** Cân của cả đơn (cân mẫu mã × số lượng); `null` = có dòng chưa khai cân. */
  weightGrams: number | null;
  /** Mốc đơn vào «Đã xác nhận» (`orders.last_update_status_at`). */
  confirmedAt: Date | null;
  updatedAt: Date;
  auto: AutoAttemptState | null;
};

/** Khoá so khớp tỉnh: tên tỉnh chuẩn (nhận cả tên cũ / viết tắt) ⇒ chữ đã gập; không nhận ra ⇒ chữ gập của chính nó. */
function provinceKey(name: string): string {
  const p = findProvince(name);
  return foldVnText(p?.name ?? name);
}

/** Tên chuẩn của tỉnh trong danh mục địa giới mới — `null` nếu không nhận ra (cấu hình không lưu tên lạ). */
export function canonicalProvince(name: string): string | null {
  return findProvince(name)?.name ?? null;
}

/** Tên xã chuẩn của MỘT tỉnh — chỉ nhận khi khớp đúng một xã (bỏ dấu); không đoán. */
export function canonicalWard(provinceName: string, ward: string): string | null {
  const p = findProvince(provinceName);
  if (!p) return null;
  const want = foldVnText(ward);
  const hits = adminWardsOf(p.code).filter((w) => foldVnText(w.name) === want);
  return hits.length === 1 ? hits[0]!.name : null;
}

/** Danh mục cho ô chọn của trang cấu hình: 34 tỉnh, mỗi tỉnh kèm tên các xã / phường. */
export function routingCatalog(): { province: string; wards: string[] }[] {
  return adminProvinces().map((p) => ({ province: p.name, wards: adminWardsOf(p.code).map((w) => w.name) }));
}

/** Đơn có thuộc khu tự giao nào không — trả tên khu khớp (xã, hoặc tỉnh khi khu là cả tỉnh). HÀM THUẦN. */
export function matchSelfArea(areas: readonly SelfArea[], province: string, ward: string): string | null {
  const pk = provinceKey(province);
  const wk = foldVnText(ward);
  for (const a of areas) {
    if (provinceKey(a.province) !== pk) continue;
    if (!a.wards.length) return a.province;
    const hit = a.wards.find((w) => foldVnText(w) === wk);
    if (hit) return hit;
  }
  return null;
}

function hold(code: RouteHoldCode, reason?: string): ShippingRoute {
  return { kind: "HOLD", code, reason: reason ?? ROUTE_HOLD_META[code].label };
}

export function decideShippingRoute(o: RouteOrderInput, cfg: ShippingRoutingConfig, readyCarriers: ReadonlySet<CarrierKey>, now: Date): ShippingRoute {
  if (!o.isErp) return hold("NOT_ERP");
  if (o.stage !== "CONFIRMED") return hold("NOT_CONFIRMED");
  if (o.hasLiveShipment) return { kind: "SHIPPED" };
  if (!o.province.trim()) return hold("NO_PROVINCE");
  if (!o.ward.trim()) return hold("NO_WARD");
  const area = matchSelfArea(cfg.selfAreas, o.province, o.ward);
  if (area) return { kind: "SELF", area };
  const carrier = cfg.defaultCarrier;
  if (!carrier) return hold("NO_CARRIER", cfg.selfAreas.length ? `Ngoài khu tự giao (${o.ward}, ${o.province}) và chưa chọn hãng mặc định` : "Chưa cấu hình tuyến giao: chưa khai khu tự giao, chưa chọn hãng mặc định");
  if (!readyCarriers.has(carrier)) return hold("CARRIER_OFF");
  if (o.weightGrams === null || !(o.weightGrams > 0)) return hold("NO_WEIGHT");
  const weightGrams = o.weightGrams;
  if (!cfg.autoCreate || !cfg.autoSince) return { kind: "CARRIER", carrier, weightGrams, auto: { ok: false, why: "Tự tạo vận đơn đang tắt — tạo tay ở trang đơn hoặc hàng loạt ở danh sách đơn" } };
  if (!o.confirmedAt || o.confirmedAt.getTime() < Date.parse(cfg.autoSince)) return { kind: "CARRIER", carrier, weightGrams, auto: { ok: false, why: "Đơn xác nhận TRƯỚC lúc bật tự tạo vận đơn — máy không kéo đơn cũ sang hãng; tạo tay hoặc hàng loạt" } };
  const due = autoAttemptDue(o.auto, o.updatedAt, now);
  if (due === "GAVE_UP") return hold("AUTO_FAILED", `Máy đã thử ${SHIPPING_ROUTING_LIMITS.autoMaxAttempts} lần không tạo được vận đơn: ${o.auto?.lastMessage ?? "không rõ lỗi"}`);
  if (due === "WAIT") return { kind: "CARRIER", carrier, weightGrams, auto: { ok: false, why: `Lần thử lúc ${formatDateTime(o.auto?.lastAt ?? null)} hỏng (${o.auto?.lastMessage ?? "không rõ lỗi"}) — máy thử lại sau ${SHIPPING_ROUTING_LIMITS.autoRetryAfterMs / 60_000} phút, hoặc sửa đơn để thử ngay` } };
  return { kind: "CARRIER", carrier, weightGrams, auto: { ok: true } };
}
