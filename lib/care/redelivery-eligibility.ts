/**
 * ═══════════ "PHÁT TIẾP" ĐƯỢC HAY KHÔNG — MỘT HÀM, BA NƠI GỌI ═══════════
 *
 * ─── VẤN ĐỀ ───
 *
 * Trước bản này, câu hỏi đó được trả lời ở BA chỗ, bằng BA luật khác nhau:
 *
 *   `app/(dashboard)/shipments/[id]/vtp-actions.tsx`  — danh sách chặng ghi cứng trong JSX;
 *   `lib/constants/care.ts::carrierActionAllowed`     — danh sách chặng thứ hai;
 *   `lib/actions/shipments-vtp.ts::vtpOrderAction`    — KHÔNG kiểm tra gì cả, gọi thẳng.
 *
 * Đường thứ ba là đường nút trên trang chi tiết vận đơn đang dùng. Nó không kiểm tra chặng, không
 * kiểm tra tài khoản API có sở hữu kiện hay không, và không ghi một dòng nào vào
 * `carrier_action_requests`. Đo production 13/09/2026: bảng đó có **0 dòng** — không một lời từ
 * chối nào của Viettel Post từng được lưu để đọc lại. Đó là lý do câu hỏi "vì sao 400" không trả
 * lời được bằng dữ liệu.
 *
 * ─── HAI ĐIỀU KIỆN, KHÔNG PHẢI MỘT ───
 *
 *  1. **KIỆN ĐANG Ở ĐÚNG CHỖ** — chỉ phát tiếp được khi gói hàng đã ở trong tay ĐVVC và chưa kết
 *     thúc. Xét bằng TRẠNG THÁI CON (`carrierSubstate`), không phải `stage`: `stage` gộp "chờ phát
 *     lại" với "tồn - khách nghỉ" thành `DELIVERY_FAILED`, và gộp "chờ xử lý" của kiện đã đi nửa
 *     đường với kiện còn trong kho thành `PENDING`.
 *  2. **TÀI KHOẢN API CÓ SỞ HỮU KIỆN** — vận đơn do Pancake tạo thuộc một tài khoản Viettel Post
 *     khác. Gửi lệnh lên cho kiện không thuộc mình thì ĐVVC từ chối, và trước đây lời từ chối đó
 *     hiện ra thành "HTTP 400".
 *
 * Điều kiện 2 KHÔNG chặn người dùng — nó đổi ĐƯỜNG ĐI: thành "phải làm tay trên web, ERP ghi vết",
 * chứ không phải một lệnh chắc chắn hỏng.
 */
import { carrierSubstate, type CarrierSubstate } from "@/lib/constants/carrier-substate";
import { CARRIER_ACTION_LABEL, carrierActionAllowed, type CarrierActionKey } from "@/lib/constants/care";
import type { ShipmentStage } from "@/db/schema";

export type EligibilityFacts = {
  stage: ShipmentStage | string | null;
  vtpStatus: number | null;
  vtpStatusName: string | null;
  /** `shipments.vtp_order_number` ?? `tracking_code`. Không có ⇒ không gửi được gì. */
  orderNumber: string | null;
  /** `shipments.tracking_capability`: API_TRACKABLE · WEBHOOK_ONLY · UNKNOWN_CAPABILITY. */
  trackingCapability: string;
  /** ERP đã cấu hình tài khoản API Viettel Post chưa. */
  configured: boolean;
};

export type EligibilityCode =
  | "OK"
  | "NO_TRACKING_NUMBER"
  | "WRONG_SUBSTATE"
  | "ALREADY_FINISHED"
  | "NOT_CONFIGURED"
  | "MANUAL_ONLY";

export type Eligibility = {
  /** Có được phép bấm nút không. `MANUAL_ONLY` vẫn `ok`: nó đi đường làm tay, có ghi vết. */
  ok: boolean;
  /** Có gửi lệnh lên API được không. `false` ở `MANUAL_ONLY` — và đó là lý do KHÔNG gọi API. */
  callsApi: boolean;
  code: EligibilityCode;
  /** Câu hiện trên tooltip khi nút bị khoá, hoặc trên hộp xác nhận khi phải làm tay. */
  reason: string;
  substate: CarrierSubstate;
};

/** Trạng thái con cho phép "phát tiếp": ĐVVC đang cầm hàng, chiều đi, chưa kết thúc. */
const PHAT_TIEP_DUOC: CarrierSubstate[] = ["PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY", "WAITING_REDELIVERY", "WAITING_PROCESSING", "DELIVERY_EXCEPTION"];

/** Trạng thái con cho phép "duyệt hoàn". */
const DUYET_HOAN_DUOC: CarrierSubstate[] = ["WAITING_REDELIVERY", "DELIVERY_EXCEPTION", "RETURNING", "OUT_FOR_DELIVERY", "IN_TRANSIT", "PICKED_UP"];

const KET_THUC: CarrierSubstate[] = ["DELIVERED", "RETURNED", "CANCELLED"];

function xetChung(f: EligibilityFacts, choPhep: CarrierSubstate[], nhan: string): Eligibility {
  const { substate } = carrierSubstate({ code: f.vtpStatus, text: f.vtpStatusName, stage: (f.stage ?? null) as ShipmentStage | null });

  if (!f.orderNumber) return { ok: false, callsApi: false, code: "NO_TRACKING_NUMBER", reason: "Vận đơn chưa có mã Viettel Post — chưa gửi được lệnh nào.", substate };
  if (KET_THUC.includes(substate)) return { ok: false, callsApi: false, code: "ALREADY_FINISHED", reason: `Kiện đã kết thúc (${substate === "DELIVERED" ? "đã giao" : substate === "RETURNED" ? "đã hoàn" : "đã huỷ"}) — “${nhan}” không còn nghĩa.`, substate };
  if (!choPhep.includes(substate)) return { ok: false, callsApi: false, code: "WRONG_SUBSTATE", reason: `Viettel Post không nhận “${nhan}” khi kiện đang ở trạng thái “${substate}”.`, substate };
  if (!f.configured) return { ok: false, callsApi: false, code: "NOT_CONFIGURED", reason: "ERP chưa cấu hình tài khoản API Viettel Post — vào trang Kết nối dữ liệu để khai.", substate };
  if (f.trackingCapability !== "API_TRACKABLE")
    return {
      ok: true,
      callsApi: false,
      code: "MANUAL_ONLY",
      reason: "Tài khoản API của ERP không sở hữu vận đơn này (vận đơn do Pancake tạo thuộc tài khoản Viettel Post khác). Lệnh gửi lên sẽ bị từ chối — làm tay trên viettelpost.vn rồi bấm “Đã làm tay” để ERP ghi vết.",
      substate,
    };
  return { ok: true, callsApi: true, code: "OK", reason: `Gửi thẳng lên Viettel Post; chỉ coi là thành công khi sự kiện hành trình xác nhận.`, substate };
}

/** "Kiện này phát tiếp được không?" — dùng ở trang chi tiết, ở thao tác hàng loạt, và ở máy chủ. */
export function canRequestRedelivery(f: EligibilityFacts): Eligibility {
  return xetChung(f, PHAT_TIEP_DUOC, CARRIER_ACTION_LABEL.redeliver);
}

export function canApproveReturn(f: EligibilityFacts): Eligibility {
  return xetChung(f, DUYET_HOAN_DUOC, CARRIER_ACTION_LABEL["approve-return"]);
}

/**
 * Cửa chung cho mọi hành động ĐVVC, để máy chủ không có đường nào đi vòng qua kiểm tra.
 *
 * Hai hành động trong phạm vi bản này ("phát tiếp", "duyệt hoàn") xét bằng TRẠNG THÁI CON. Bốn
 * hành động còn lại giữ NGUYÊN luật chặng cũ (`carrierActionAllowed`): chúng không nằm trong đề
 * bài, và đổi luật của chúng ở đây là mở rộng phạm vi bằng một thay đổi không ai yêu cầu, không ai
 * đo, không ai kiểm — đúng kiểu thay đổi làm vỡ thứ đang chạy đúng.
 */
export function canRequestCarrierAction(key: CarrierActionKey, f: EligibilityFacts): Eligibility {
  if (key === "redeliver") return canRequestRedelivery(f);
  if (key === "approve-return") return canApproveReturn(f);
  const { substate } = carrierSubstate({ code: f.vtpStatus, text: f.vtpStatusName, stage: (f.stage ?? null) as ShipmentStage | null });
  if (!f.orderNumber) return { ok: false, callsApi: false, code: "NO_TRACKING_NUMBER", reason: "Vận đơn chưa có mã Viettel Post.", substate };
  if (!carrierActionAllowed(key, String(f.stage ?? ""))) return { ok: false, callsApi: false, code: "WRONG_SUBSTATE", reason: `Viettel Post không nhận “${CARRIER_ACTION_LABEL[key]}” khi kiện ở chặng ${f.stage}.`, substate };
  if (!f.configured) return { ok: false, callsApi: false, code: "NOT_CONFIGURED", reason: "ERP chưa cấu hình tài khoản API Viettel Post.", substate };
  if (f.trackingCapability !== "API_TRACKABLE") return { ok: true, callsApi: false, code: "MANUAL_ONLY", reason: "Tài khoản API của ERP không sở hữu vận đơn này — làm tay trên viettelpost.vn, ERP ghi vết.", substate };
  return { ok: true, callsApi: true, code: "OK", reason: "", substate };
}
