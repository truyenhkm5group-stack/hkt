import { CARRIER_ACTION_CONFIRM_STAGES, CARRIER_ACTION_LABEL, type CarrierActionKey } from "@/lib/constants/care";
import { VTP_ORDER_ACTIONS } from "@/lib/constants/viettelpost";
import { formatVND } from "@/lib/format";

/**
 * ═══════════ LỆNH ĐVVC LÀM TAY — WEBHOOK LÀ NGƯỜI XÁC MINH ═══════════
 *
 * Viettel Post KHÔNG cấp API cho tài khoản shop (chủ shop xác nhận 24/09/2026), nên mọi lệnh phát
 * tiếp · duyệt hoàn · huỷ · sửa người nhận đều là `MANUAL_REQUIRED`: người làm trên viettelpost.vn.
 * Trước bản này vòng ấy KHÔNG BAO GIỜ khép: `settleCarrierRequests` chỉ nhìn lệnh gửi qua API, nên
 * một lệnh làm tay đứng mãi ở "Phải làm tay" / "Đã làm tay" dù webhook đã báo bưu tá đi phát lại.
 *
 * Giờ webhook — nguồn tin DUY NHẤT còn lại (mục 51) — là người xác minh: sự kiện mang chặng khớp
 * lệnh, xảy ra SAU lúc lập lệnh, đóng dấu `confirmed_at`. Hai điều CỐ Ý không làm:
 *
 *  · KHÔNG đổi `status`. `MANUAL_DONE` là LỜI KHAI của một người ("tôi đã làm"), `confirmed_at` là
 *    CHỨNG TỪ ĐVVC ("kiện đã sang chặng lệnh xin"). Hai chiều đứng riêng (mục 47) — ghi đè cái này
 *    bằng cái kia là mất khả năng hỏi "ai làm, và ĐVVC có làm theo không".
 *  · KHÔNG kết luận người đã gây ra kết quả. ĐVVC tự phục hồi được (mục 56): kiện có thể tự đi phát
 *    lại mà không ai bấm gì trên web. Nên nhãn nói "ĐVVC đã sang chặng lệnh xin", không nói "làm tay
 *    thành công".
 *
 * Hàm THUẦN, dùng được ở client.
 */

/**
 * Bao lâu không thấy webhook khớp thì coi là QUÁ HẠN và bảo người đi kiểm lại trên viettelpost.vn.
 * ĐỀ XUẤT KHỞI ĐIỂM — chủ shop chưa chốt. Căn cứ: bưu tá thường đi phát lại trong ngày làm việc kế
 * tiếp, và độ trễ webhook đo được là 36–41 giây (mục 51), nên 24 giờ im lặng là tín hiệu thật chứ
 * không phải đường truyền chậm.
 */
export const MANUAL_CONFIRM_WAIT_HOURS = 24;

export type ManualVerdict =
  /** Webhook đã báo chặng khớp lệnh — kiện không còn cần ai làm gì cho lệnh này. */
  | { state: "CARRIER_CONFIRMED"; at: Date }
  /** Chưa thấy webhook khớp, còn trong hạn chờ. `hours` = đã chờ bao lâu. */
  | { state: "WAITING"; hours: number }
  /** Quá hạn chờ mà webhook vẫn chưa báo — người phải mở viettelpost.vn kiểm lại. */
  | { state: "OVERDUE"; hours: number }
  /** Lệnh không sinh ra chặng nào để đối chiếu (sửa người nhận / COD) — webhook KHÔNG xác minh được. */
  | { state: "NOT_VERIFIABLE" };

type RequestLike = {
  actionKey: CarrierActionKey;
  status: string;
  /** Lúc lập lệnh. */
  at: Date | string;
  /** Lúc người bấm "Đã làm tay" (chỉ có ở `MANUAL_DONE`). */
  doneAt?: Date | string | null;
  confirmedAt?: Date | string | null;
};

const asDate = (v: Date | string | null | undefined): Date | null => {
  if (v === null || v === undefined || v === "") return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
};

export const MANUAL_STATUSES = ["MANUAL_REQUIRED", "MANUAL_DONE"] as const;

/**
 * Phán quyết xác minh của MỘT lệnh làm tay. Lệnh không phải làm tay ⇒ `null` (đường API có vòng
 * đời riêng: ACKNOWLEDGED → SUCCESS).
 *
 * Đồng hồ chờ tính từ lúc người bấm "Đã làm tay" nếu có — trước đó, chưa ai làm thì chưa có gì để
 * webhook xác nhận, và "quá hạn" nghĩa là CHƯA AI LÀM chứ không phải ĐVVC chậm.
 */
export function manualRequestVerdict(r: RequestLike, now: Date = new Date()): ManualVerdict | null {
  if (!(MANUAL_STATUSES as readonly string[]).includes(r.status)) return null;
  const confirmed = asDate(r.confirmedAt);
  if (confirmed) return { state: "CARRIER_CONFIRMED", at: confirmed };
  if (!(CARRIER_ACTION_CONFIRM_STAGES[r.actionKey] ?? []).length) return { state: "NOT_VERIFIABLE" };
  const from = (r.status === "MANUAL_DONE" ? asDate(r.doneAt) : null) ?? asDate(r.at);
  if (!from) return { state: "WAITING", hours: 0 };
  const hours = Math.max(0, (now.getTime() - from.getTime()) / 3_600_000);
  return hours >= MANUAL_CONFIRM_WAIT_HOURS ? { state: "OVERDUE", hours } : { state: "WAITING", hours };
}

/** Một câu cho người đọc — đủ để biết phải làm gì tiếp. */
export function manualVerdictText(v: ManualVerdict, status: string): string {
  const h = (x: number) => (x < 1 ? "dưới 1 giờ" : `${Math.floor(x)} giờ`);
  switch (v.state) {
    case "CARRIER_CONFIRMED":
      return status === "MANUAL_REQUIRED" ? "Webhook: ĐVVC đã sang chặng lệnh xin — không còn phải làm tay" : "Webhook: ĐVVC đã sang chặng lệnh xin";
    case "WAITING":
      return status === "MANUAL_REQUIRED" ? `Chưa ai làm · ${h(v.hours)}` : `Chờ webhook xác nhận · ${h(v.hours)}`;
    case "OVERDUE":
      return status === "MANUAL_REQUIRED"
        ? `Quá ${MANUAL_CONFIRM_WAIT_HOURS} giờ chưa ai làm, ĐVVC cũng chưa đổi chặng`
        : `Quá ${MANUAL_CONFIRM_WAIT_HOURS} giờ chưa thấy webhook — mở viettelpost.vn kiểm lại`;
    case "NOT_VERIFIABLE":
      return "Webhook không xác minh được lệnh sửa — kiểm trên viettelpost.vn";
  }
}

export const MANUAL_VERDICT_TONE: Record<ManualVerdict["state"], string> = {
  CARRIER_CONFIRMED: "text-emerald-700 dark:text-emerald-400",
  WAITING: "text-muted-foreground",
  OVERDUE: "text-rose-600 dark:text-rose-400",
  NOT_VERIFIABLE: "text-amber-700 dark:text-amber-400",
};

type EditPayload = { receiverName?: unknown; receiverPhone?: unknown; receiverAddress?: unknown; moneyCollection?: unknown; note?: unknown };

/**
 * NỘI DUNG SOẠN SẴN cho người làm tay trên viettelpost.vn: mã vận đơn, đúng tên thao tác trên web,
 * và mọi thông tin mới cần gõ. ERP KHÔNG tự động hoá đường web (AGENTS.md mục 5) — việc của nó là để
 * người làm tay không phải gõ lại, và không gõ sai.
 */
export function manualInstructionText(r: { actionKey: CarrierActionKey; orderNumber: string; note?: string | null; payload?: unknown }): string {
  const action = VTP_ORDER_ACTIONS.find((a) => a.key === r.actionKey);
  const lines = [`Mã vận đơn: ${r.orderNumber}`, `Việc cần làm: ${CARRIER_ACTION_LABEL[r.actionKey]}${action ? ` — ${action.hint}` : ""}`];
  if (r.actionKey === "edit") {
    const p = (r.payload && typeof r.payload === "object" ? r.payload : {}) as EditPayload;
    const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    if (s(p.receiverName)) lines.push(`Người nhận mới: ${s(p.receiverName)}`);
    if (s(p.receiverPhone)) lines.push(`SĐT mới: ${s(p.receiverPhone)}`);
    if (s(p.receiverAddress)) lines.push(`Địa chỉ mới: ${s(p.receiverAddress)}`);
    if (typeof p.moneyCollection === "number" && Number.isFinite(p.moneyCollection)) lines.push(`Tiền thu hộ (COD): ${formatVND(Math.round(p.moneyCollection))}`);
    if (s(p.note)) lines.push(`Ghi chú: ${s(p.note)}`);
  } else if (r.note?.trim()) {
    lines.push(`Ghi chú cho bưu cục: ${r.note.trim()}`);
  }
  return lines.join("\n");
}
