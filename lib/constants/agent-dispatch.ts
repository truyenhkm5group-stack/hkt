import { type TechRisk, type TechTaskStatus } from "@/lib/constants/tech";

/**
 * ═══════════ NẤC 3 · ERP GIAO VIỆC CHO AGENT — LUẬT THUẦN ═══════════
 *
 * Tới Nấc 2, agent chỉ chạy khi có người mở GitHub Actions bấm tay. Nấc 3 cho ERP bấm hộ. Đó là
 * lần đầu tiên một màn hình nghiệp vụ khởi động được một tiến trình ghi mã — nên mọi luật quyết
 * định "ai được giao, giao cái gì, giao bao nhiêu" nằm ở đây, dưới dạng HÀM THUẦN kiểm thử được
 * từng ca, thay vì nằm rải trong một server action.
 *
 * ─── BA CỔNG, ĐỘC LẬP NHAU ───
 *
 * 1. **Cổng cấu hình** — chưa có token ghi thì KHÔNG giao được, và phải nói rõ là "chưa bật",
 *    không phải "hỏng" (`ERP_GITHUB_TOKEN` hôm nay chỉ có quyền đọc).
 * 2. **Cổng việc** — mức rủi ro, trạng thái, và phê duyệt của NGƯỜI.
 * 3. **Cổng hạn mức** — mỗi lượt chạy tốn tiền API và phút Actions thật.
 *
 * Ba cổng tách rời vì ba câu trả lời khác nhau dẫn tới ba việc phải làm khác nhau. Gộp thành một
 * câu "không giao được" là đẩy người đọc đi sửa nhầm chỗ (cùng bài học AGENTS.md mục 55).
 */

/**
 * WORKFLOW DUY NHẤT ERP ĐƯỢC PHÉP KHỞI ĐỘNG.
 *
 * Danh sách ĐÓNG, và nó là lý do tồn tại của cả tệp này. Một hàm `dispatchWorkflow(file)` nhận tên
 * tệp tuỳ ý từ nơi gọi thì ERP khởi động được `deploy-vps.yml` — tức là một màn hình nghiệp vụ
 * deploy được production. Không bao giờ.
 */
export const DISPATCHABLE_WORKFLOWS: readonly string[] = ["agent-run.yml"];

/**
 * NHÁNH DUY NHẤT ĐƯỢC PHÉP CHẠY.
 *
 * `agent-run.yml` trên một nhánh tuỳ ý nghĩa là chạy PHIÊN BẢN WORKFLOW của nhánh đó — kể cả
 * nhánh do chính agent vừa đẩy lên. Đó là đường để một lượt chạy tự viết lại hàng rào của lượt
 * sau. `main` là bản đã qua review.
 */
export const DISPATCH_REF = "main";

/**
 * MÃ VIỆC — VÀ CHỈ MÃ VIỆC — ĐƯỢC PHÉP ĐI QUA Ô `inputs` CỦA `workflow_dispatch`.
 *
 * Kho này PUBLIC, và đầu vào dispatch hiện NGUYÊN VĂN trong giao diện Actions lẫn trong log. Một
 * mã dạng `TECH-12` không nói gì với người ngoài; một tiêu đề việc thì nói hết. Nội dung việc đi
 * qua cửa ĐỌC hẹp `GET /api/tech/agent-task`, xác thực bằng khoá — xem `lib/tech/agent-task-read.ts`.
 *
 * Nên hình dạng được kiểm ở ĐÂY, tại hàm thực thi, chứ không ở nơi gọi: nơi gọi có thể quên, có
 * thể được thêm một nhánh mới, có thể là một server action viết vội. Cùng lý lẽ với
 * `DISPATCHABLE_WORKFLOWS`.
 */
export const MA_VIEC_DISPATCH = /^[A-Z][A-Z0-9]{1,11}-[0-9]{1,9}$/;

export function laMaViecHopLe(value: string): boolean {
  return MA_VIEC_DISPATCH.test(value);
}

export const DISPATCH_QUOTA = {
  /**
   * Trần mỗi GIỜ, tính trên TOÀN HỆ THỐNG chứ không theo người.
   *
   * Lượt chạy agent tốn khoá AI thật (tài khoản đã một lần hết credit lúc 00:58 ngày 20/09/2026)
   * và phút GitHub Actions thật. Trần theo người sẽ cộng dồn: năm quản trị viên × 5 lượt = 25
   * lượt/giờ, và hoá đơn không quan tâm ai bấm.
   */
  perHour: 4,
  /** Trần mỗi NGÀY — chặn một vòng lặp chạy chậm mà đều, thứ mà trần giờ không thấy. */
  perDay: 20,
} as const;

/** Mức rủi ro agent được phép nhận. `R2` KHÔNG BAO GIỜ — giữ nguyên từ Phase 1. */
export const DISPATCHABLE_RISKS: readonly TechRisk[] = ["R0", "R1"];

/**
 * Trạng thái việc mà giao cho agent là HỢP LÝ.
 *
 * `NEW` KHÔNG nằm ở đây: một việc chưa ai phân loại thì chưa biết nó là gì, và giao cho máy một
 * việc chưa hiểu là cách nhanh nhất để có một PR không ai muốn đọc.
 */
export const DISPATCHABLE_STATUSES: readonly TechTaskStatus[] = ["TRIAGED", "SPEC_READY", "BUILDING"];

export type DispatchTask = {
  code: string;
  risk: string;
  status: string;
  approvalRequired: boolean;
  approvalStatus: string;
  agentKey: string | null;
};

export type DispatchVerdict = { ok: true } | { ok: false; code: "RISK" | "STATUS" | "APPROVAL" | "NO_AGENT"; reason: string };

/**
 * Việc này giao cho agent được không — HÀM THUẦN, không đọc CSDL.
 *
 * Trả về LÝ DO cụ thể chứ không phải một `false`: người bấm nút cần biết phải làm gì tiếp (hạ rủi
 * ro? xin duyệt? phân loại việc? gán agent?), và bốn việc ấy khác hẳn nhau.
 */
export function canDispatchTask(task: DispatchTask): DispatchVerdict {
  if (!DISPATCHABLE_RISKS.includes(task.risk as TechRisk)) {
    return { ok: false, code: "RISK", reason: `Việc ${task.code} ở mức ${task.risk}; agent chỉ nhận ${DISPATCHABLE_RISKS.join(" · ")}. R2 không bao giờ mở cho agent.` };
  }
  if (!DISPATCHABLE_STATUSES.includes(task.status as TechTaskStatus)) {
    return { ok: false, code: "STATUS", reason: `Việc ${task.code} đang ở ${task.status}; chỉ giao được khi ${DISPATCHABLE_STATUSES.join(" · ")}. Việc chưa phân loại thì chưa ai hiểu nó là gì.` };
  }
  /*
    PHÊ DUYỆT CỦA NGƯỜI LÀ CỔNG CỨNG.

    `approvalRequired` được máy xếp lúc tính rủi ro; nếu nó bật thì phải có `APPROVED`. `PENDING`
    và `REJECTED` đều là KHÔNG — và `NOT_REQUIRED` khi cờ đang bật là một mâu thuẫn, nên cũng
    KHÔNG: dữ liệu tự mâu thuẫn thì rơi về phía hẹp hơn, không rơi về phía cho qua.
  */
  if (task.approvalRequired && task.approvalStatus !== "APPROVED") {
    return { ok: false, code: "APPROVAL", reason: `Việc ${task.code} cần người duyệt (đang ${task.approvalStatus || "chưa có"}).` };
  }
  if (!task.agentKey) {
    return { ok: false, code: "NO_AGENT", reason: `Việc ${task.code} chưa gán agent nào — giao cho ai thì phải nói rõ.` };
  }
  return { ok: true };
}

export type QuotaVerdict = { ok: true; conLaiGio: number; conLaiNgay: number } | { ok: false; reason: string };

/**
 * Còn hạn mức không — HÀM THUẦN, nhận số đã đếm sẵn.
 *
 * Tách phép ĐẾM (đọc CSDL) khỏi phép QUYẾT (thuần) để mọi ca biên kiểm được mà không cần dựng dữ
 * liệu: đúng trần, hơn trần một, và cả hai trần cùng chạm.
 */
export function checkDispatchQuota(trongGio: number, trongNgay: number): QuotaVerdict {
  if (trongGio >= DISPATCH_QUOTA.perHour) {
    return { ok: false, reason: `Đã giao ${trongGio}/${DISPATCH_QUOTA.perHour} lượt trong một giờ. Mỗi lượt chạy tốn khoá AI và phút Actions thật — chờ hết giờ rồi giao tiếp.` };
  }
  if (trongNgay >= DISPATCH_QUOTA.perDay) {
    return { ok: false, reason: `Đã giao ${trongNgay}/${DISPATCH_QUOTA.perDay} lượt trong một ngày.` };
  }
  return { ok: true, conLaiGio: DISPATCH_QUOTA.perHour - trongGio, conLaiNgay: DISPATCH_QUOTA.perDay - trongNgay };
}

/** Khoá hành động trong `audit_logs` — cũng là thứ dùng để ĐẾM hạn mức, nên nó không được đổi. */
export const DISPATCH_AUDIT_ACTION = "TECH_AGENT_DISPATCHED";
