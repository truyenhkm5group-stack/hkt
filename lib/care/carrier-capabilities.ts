import { CARRIER_ACTION_KEYS, CARRIER_ACTION_LABEL, carrierActionAllowed, type CarrierActionKey } from "@/lib/constants/care";
import type { CarrierCapabilityStatus, CarrierCapabilityView } from "@/lib/care/contracts";

/**
 * ═══════════ MA TRẬN NĂNG LỰC VIETTEL POST — KHÔNG GIẢ ĐỊNH API TỒN TẠI ═══════════
 *
 * Nguồn: tài liệu API đối tác Viettel Post v2 (`order/UpdateOrder` TYPE 1 duyệt · 2 duyệt chuyển
 * hoàn · 3 phát tiếp · 4 huỷ · 5 lấy lại/gửi lại · 11 xoá đơn huỷ; `order/edit` sửa người nhận /
 * SĐT / địa chỉ / thu hộ / ghi chú cho đơn CHƯA phát) và đo trên production 11/09/2026: tài khoản
 * API của ERP đọc được 0/565 vận đơn đang chạy (vận đơn Pancake tạo thuộc tài khoản khác).
 *
 * Kết luận cho từng hành động theo (API có tồn tại?) × (credential có quyền trên kiện?) × (chặng):
 *  · SUPPORTED          — API có, credential sở hữu kiện, chặng cho phép ⇒ gửi thẳng.
 *  · PERMISSION_MISSING — API có nhưng tài khoản không sở hữu kiện (WEBHOOK_ONLY) ⇒ làm tay + ghi vết.
 *  · UNKNOWN            — API có, chưa dò xong năng lực (UNKNOWN_CAPABILITY) ⇒ thử gửi, lỗi quyền
 *                         thì thành UNSUPPORTED cho lần đó.
 *  · WEB_ONLY           — Viettel Post KHÔNG có API cho việc này, chỉ làm trên web / gọi bưu cục.
 *  · UNSUPPORTED        — Viettel Post không hỗ trợ ở chặng này (vd sửa người nhận sau khi đã phát).
 *
 * Tạo vận đơn trực tiếp (Direct VTP shipment creation) vẫn PENDING — không nằm trong ma trận này.
 */

export type CarrierActionSpec = {
  key: CarrierActionKey;
  label: string;
  /** API đối tác có endpoint cho việc này không. */
  api: { endpoint: string; type?: number } | null;
  /** Bằng chứng: tài liệu / lần gọi thật. */
  evidence: string;
};

export const CARRIER_ACTION_SPECS: Record<CarrierActionKey, CarrierActionSpec> = {
  redeliver: { key: "redeliver", label: CARRIER_ACTION_LABEL.redeliver, api: { endpoint: "order/UpdateOrder", type: 3 }, evidence: "Tài liệu API v2 UpdateOrder TYPE=3 (phát tiếp). Chưa có lần gọi thật thành công trên production vì tài khoản không sở hữu kiện." },
  "approve-return": { key: "approve-return", label: CARRIER_ACTION_LABEL["approve-return"], api: { endpoint: "order/UpdateOrder", type: 2 }, evidence: "Tài liệu API v2 UpdateOrder TYPE=2 (duyệt chuyển hoàn)." },
  resend: { key: "resend", label: CARRIER_ACTION_LABEL.resend, api: { endpoint: "order/UpdateOrder", type: 5 }, evidence: "Tài liệu API v2 UpdateOrder TYPE=5 (lấy lại đơn đã huỷ / hoàn để gửi lại)." },
  approve: { key: "approve", label: CARRIER_ACTION_LABEL.approve, api: { endpoint: "order/UpdateOrder", type: 1 }, evidence: "Tài liệu API v2 UpdateOrder TYPE=1 (duyệt đơn chờ duyệt)." },
  cancel: { key: "cancel", label: CARRIER_ACTION_LABEL.cancel, api: { endpoint: "order/UpdateOrder", type: 4 }, evidence: "Tài liệu API v2 UpdateOrder TYPE=4 (huỷ đơn chưa phát)." },
  edit: { key: "edit", label: CARRIER_ACTION_LABEL.edit, api: { endpoint: "order/edit" }, evidence: "Tài liệu API v2 order/edit: sửa người nhận / SĐT / địa chỉ / thu hộ / ghi chú cho đơn CHƯA phát." },
};

/**
 * Việc vận hành hay cần mà Viettel Post KHÔNG có API — chỉ làm trên web / tổng đài. Liệt kê để UI
 * không vẽ nút giả và để người vận hành biết đường đi.
 */
export const CARRIER_WEB_ONLY_ACTIONS: { key: string; label: string; how: string }[] = [
  { key: "change-delivery-time", label: "Đổi giờ / ngày phát", how: "Gọi bưu cục hoặc nhắn qua app Viettel Post; API UpdateOrder không có tham số hẹn giờ." },
  { key: "complaint", label: "Khiếu nại / tra soát kiện", how: "Mở khiếu nại trên viettelpost.vn hoặc tổng đài 1900 8095; không có API tạo khiếu nại." },
  { key: "partial-delivery", label: "Giao một phần / đổi tiền thu hộ sau khi đã phát", how: "Chỉ bưu cục xử lý; API order/edit chỉ áp dụng trước khi phát." },
  { key: "change-address-after-dispatch", label: "Đổi địa chỉ khi kiện đã đi phát", how: "Gọi bưu cục; API order/edit từ chối đơn đã đi phát." },
];

export function carrierCapabilityFor(input: { actionKey: CarrierActionKey; stage: string; trackingCapability: string; configured: boolean; tracking: string }): CarrierCapabilityView {
  const spec = CARRIER_ACTION_SPECS[input.actionKey];
  const allowedAtStage = carrierActionAllowed(input.actionKey, input.stage);
  const webUrl = `https://viettelpost.vn/thong-tin-don-hang?peopleTracking=sender&orderNumber=${encodeURIComponent(input.tracking)}&orderType=1`;
  let status: CarrierCapabilityStatus;
  let reason: string;
  if (!spec.api) {
    status = "WEB_ONLY";
    reason = "Viettel Post không có API cho việc này — làm trên web hoặc gọi bưu cục.";
  } else if (!allowedAtStage) {
    status = "UNSUPPORTED";
    reason = `Viettel Post không nhận “${spec.label}” khi kiện ở chặng ${input.stage}.`;
  } else if (!input.configured) {
    status = "PERMISSION_MISSING";
    reason = "ERP chưa cấu hình tài khoản API Viettel Post.";
  } else if (input.trackingCapability === "API_TRACKABLE") {
    status = "SUPPORTED";
    reason = `Gửi thẳng qua ${spec.api.endpoint}${spec.api.type ? ` (TYPE ${spec.api.type})` : ""}; chỉ coi là thành công khi sự kiện hành trình xác nhận.`;
  } else if (input.trackingCapability === "WEBHOOK_ONLY") {
    status = "PERMISSION_MISSING";
    reason = "Tài khoản API của ERP không sở hữu kiện này (vận đơn Pancake tạo) — làm tay trên web, ERP ghi vết.";
  } else {
    status = "UNKNOWN";
    reason = "Chưa dò xong năng lực tài khoản với kiện này — có thể thử gửi; lỗi quyền sẽ được ghi lại.";
  }
  return { actionKey: input.actionKey, status, allowedAtStage, reason, webUrl };
}

export function carrierCapabilitiesFor(input: { stage: string; trackingCapability: string; configured: boolean; tracking: string }): CarrierCapabilityView[] {
  return CARRIER_ACTION_KEYS.map((actionKey) => carrierCapabilityFor({ ...input, actionKey }));
}
