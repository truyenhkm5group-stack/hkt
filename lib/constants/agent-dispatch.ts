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

/**
 * Mức rủi ro mở cho MỌI agent, không cần khai gì thêm.
 *
 * `R2` KHÔNG nằm ở đây, và không bao giờ nằm ở đây: nó chỉ đi qua CỬA HẸP bên dưới, và cửa ấy
 * không bao giờ tự mở cho một vai nào.
 */
export const DISPATCHABLE_RISKS: readonly TechRisk[] = ["R0", "R1"];

/**
 * ═══════════ CỬA HẸP CHO R2 — VÀ VÌ SAO NÓ PHẢI TỒN TẠI ═══════════
 *
 * ─── ĐÃ ĐO 22/09/2026: HAI CỔNG CỦA CHỦ SHOP CHƯA BAO GIỜ CHẠY ĐƯỢC ───
 *
 * Cả hai đường ghi việc (`createTechTask` và đường đè mức rủi ro) đều đặt
 * `approvalRequired = (risk === "R2")` — một BẤT BIẾN, không phải trùng hợp. Mà `canDispatchTask`
 * loại `R2` ở phép kiểm ĐẦU TIÊN. Hệ quả: nhánh `APPROVAL` phía sau KHÔNG BAO GIỜ tới được trên
 * dữ liệu thật. Chủ shop bấm "Phê duyệt" bao nhiêu lần cũng không mở được việc cho agent, và màn
 * hình vẫn hiện một nút trông như có tác dụng.
 *
 * Cổng thứ hai cũng vậy: `tech_agents.allowed_risks` khai riêng cho TỪNG agent và chủ shop sửa
 * được ở `/tech/agents`, nhưng `runner.ts` chỉ đọc nó SAU khi dispatch đã đi qua — nên với R2 nó
 * cũng không bao giờ được hỏi tới.
 *
 * Một cổng không bao giờ tới được thì không phải một cổng chặt; nó là một cổng KHÔNG TỒN TẠI,
 * cộng thêm một nút nói dối người bấm.
 *
 * ─── VÌ SAO MỞ CỬA NÀY KHÔNG LÀM YẾU HÀNG RÀO ───
 *
 * Đo cùng ngày: 9/9 việc AI CTO đề xuất (TECH-4…TECH-12) đều là R2, phần lớn chỉ vì luật
 * `CARRIER_TRUTH` khai `modules: ["SHIPMENTS"]` — tức MỌI việc thuộc module ấy đều R2, kể cả
 * "Đo baseline phía trình duyệt" vốn không ghi một dòng mã nào. Cả chín nằm im vĩnh viễn.
 *
 * Nhưng hàng rào THẬT không nằm ở mức rủi ro, nó nằm ở PHẠM VI GHI: `NEVER_WRITE` (kiểm TRƯỚC sổ
 * vai) chặn `lib/actions/` · `lib/auth/` · `db/` · `drizzle/` · `.github/` · `scripts/` ·
 * `lib/agents/` · `lib/tech/` · `app/api/`, còn `WRITE_GLOBS_BY_ROLE` cho vai rộng nhất đúng
 * `docs/` + `tests/`. Nghĩa là KHÔNG vai nào — kể cả vai chưa tồn tại — chạm nổi một dòng của
 * `lib/queries/return-rate.ts` hay `lib/constants/returns.ts`. Đúng những thứ mà mười ba luật R2
 * sinh ra để bảo vệ đều đã nằm ngoài tầm với theo CẤU TRÚC.
 *
 * Nên lệnh cấm R2 đang khoá thêm một cánh cửa đã hàn chết, và cái giá là cả phòng đứng im.
 *
 * ─── BA ĐIỀU KIỆN, PHẢI ĐỦ CẢ BA, KHÔNG CÁI NÀO TỰ BẬT ───
 *
 *  1. **Vai được khai riêng mức `R2`** trong `tech_agents.allowed_risks`. Mười hai mẫu vai trong
 *     `TECH_AGENT_TEMPLATES` khai `R0` hoặc `R0/R1` — KHÔNG mẫu nào có `R2`. Nên sau bản này,
 *     không agent nào đang chạy nhận thêm được một việc nào: phải có một người vào `/tech/agents`
 *     và cấp cho MỘT vai cụ thể.
 *  2. **Phạm vi ghi của vai chỉ SINH RA CHỮ** (`PHAM_VI_CHI_SINH_CHU`). Xem docblock của nó.
 *  3. **Chủ shop đã ký duyệt** chính việc đó — nhánh `APPROVAL`, nay lần đầu tới được.
 *
 * Kết quả ròng: cổng tại lúc giao việc NHIỀU HƠN trước chứ không ít hơn. Trước bản này, một việc
 * R1 đi thẳng qua mà KHÔNG ai hỏi vai ấy được phép mức nào hay ghi được vào đâu — hai câu hỏi đó
 * mãi tới `runner.ts` mới được hỏi, sau khi đã tốn một lượt dispatch và phút Actions thật.
 */

/**
 * PHẠM VI GHI CHỈ SINH RA CHỮ — danh sách ĐÓNG.
 *
 * `docs/` là chữ cho NGƯỜI đọc: sai thì người đọc thấy sai, và không một con số nào trên màn hình
 * đổi theo.
 *
 * `tests/` KHÔNG nằm đây, dù vai QA ghi được nó. Một bài kiểm không phải chữ — nó là một KHẲNG
 * ĐỊNH CHẶN DEPLOY, và một khẳng định sai trong vùng tiền thì ghim luôn cái sai ấy thành luật
 * (AGENTS.md mục 0: *"Không được sửa giá trị kỳ vọng của chúng để CI xanh"*). Với một việc R2,
 * agent được phép viết ra LỜI, không được phép viết ra thứ PHÁN QUYẾT.
 */
export const PHAM_VI_CHI_SINH_CHU: readonly string[] = ["docs/"];

/**
 * Phạm vi ghi này có chỉ sinh ra chữ không — HÀM THUẦN.
 *
 * Rỗng ⇒ `false`. Một danh sách rỗng nghĩa là CHƯA BIẾT vai ấy ghi được gì, và "chưa biết" phải
 * rơi về phía HẸP HƠN (cùng luật với mục 31), không phải về phía "chẳng ghi được gì nên an toàn".
 */
export function chiSinhRaChu(globs: readonly string[] | null | undefined): boolean {
  if (!globs || globs.length === 0) return false;
  return globs.every((g) => PHAM_VI_CHI_SINH_CHU.includes(g));
}

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
  /**
   * Mức rủi ro khai riêng cho AGENT ĐƯỢC GÁN (`tech_agents.allowed_risks`). `null` = chưa gán ai.
   *
   * `runner.ts` đã hỏi câu này từ trước, nhưng hỏi SAU khi dispatch đã đi — tức sau khi đã tốn một
   * lượt và phút Actions thật. Hỏi lại ở đây không nới thêm gì, nó chỉ trả lời sớm hơn.
   */
  agentAllowedRisks: readonly string[] | null;
  /** Phạm vi ghi của VAI agent được gán (`writeGlobsForRole`). `null` = chưa gán ai. */
  agentWriteGlobs: readonly string[] | null;
};

export type DispatchVerdict =
  | { ok: true }
  | { ok: false; code: "RISK" | "STATUS" | "APPROVAL" | "NO_AGENT" | "AGENT_RISK" | "SCOPE"; reason: string };

/**
 * Việc này giao cho agent được không — HÀM THUẦN, không đọc CSDL.
 *
 * Trả về LÝ DO cụ thể chứ không phải một `false`: người bấm nút cần biết phải làm gì tiếp, và sáu
 * việc phải làm ấy khác hẳn nhau (hạ rủi ro · xin duyệt · phân loại việc · gán agent · cấp mức cho
 * vai · đổi vai khác). Gộp thành một câu "không giao được" là đẩy người đọc đi sửa nhầm chỗ
 * (AGENTS.md mục 55).
 */
export function canDispatchTask(task: DispatchTask): DispatchVerdict {
  /*
    CHƯA GÁN AGENT ĐỨNG ĐẦU — không phải vì nó nặng nhất, mà vì MỌI câu hỏi phía sau đều là câu
    hỏi VỀ VAI ĐƯỢC GÁN: vai ấy được phép mức nào, vai ấy ghi được vào đâu. Chưa có vai thì chưa
    trả lời được, và trả lời bừa là chọn giữa "khoá nhầm một việc hợp lệ" và "mở nhầm một việc
    không hợp lệ" — cả hai đều sai, nên không đoán.
  */
  if (!task.agentKey) {
    return { ok: false, code: "NO_AGENT", reason: `Việc ${task.code} chưa gán agent nào — giao cho ai thì phải nói rõ.` };
  }

  if (!DISPATCHABLE_RISKS.includes(task.risk as TechRisk)) {
    /* Mức lạ (không phải R0/R1/R2) rơi về phía hẹp, không rơi về phía cho qua. */
    if (task.risk !== "R2") {
      return { ok: false, code: "RISK", reason: `Việc ${task.code} ở mức lạ \`${task.risk}\`; agent chỉ nhận ${DISPATCHABLE_RISKS.join(" · ")}, hoặc R2 qua cửa hẹp.` };
    }
    /*
      CỬA HẸP CHO R2 — điều kiện PHẠM VI GHI. Hai điều kiện còn lại (vai được cấp mức, chủ shop đã
      ký) nằm ở hai phép kiểm riêng bên dưới, để mỗi cái hỏng cho ra một câu trả lời khác nhau.
    */
    if (!chiSinhRaChu(task.agentWriteGlobs)) {
      return {
        ok: false,
        code: "SCOPE",
        reason: `Việc ${task.code} ở mức R2. R2 chỉ mở cho vai CHỈ GHI RA CHỮ (${PHAM_VI_CHI_SINH_CHU.join(" · ")}); vai \`${task.agentKey}\` ghi được ${task.agentWriteGlobs?.join(" · ") || "(chưa khai)"}. Một bài kiểm không phải chữ — nó là khẳng định chặn deploy.`,
      };
    }
  }

  /*
    MỨC KHAI RIÊNG CHO VAI — cổng của CHỦ SHOP, ở `/tech/agents`.

    Không mẫu vai nào trong `TECH_AGENT_TEMPLATES` khai `R2`. Nên nhánh này là thứ giữ cho cửa hẹp
    ở trên đóng cho tới khi có một NGƯỜI mở nó cho MỘT vai cụ thể.
  */
  if (!(task.agentAllowedRisks ?? []).includes(task.risk)) {
    const daKhai = task.agentAllowedRisks?.join(" · ") || "(chưa khai mức nào)";
    return { ok: false, code: "AGENT_RISK", reason: `Vai \`${task.agentKey}\` chỉ được phép ${daKhai}, không có ${task.risk}. Cấp mức cho vai ở /tech/agents, hoặc giao cho vai khác.` };
  }

  if (!DISPATCHABLE_STATUSES.includes(task.status as TechTaskStatus)) {
    return { ok: false, code: "STATUS", reason: `Việc ${task.code} đang ở ${task.status}; chỉ giao được khi ${DISPATCHABLE_STATUSES.join(" · ")}. Việc chưa phân loại thì chưa ai hiểu nó là gì.` };
  }
  /*
    PHÊ DUYỆT CỦA NGƯỜI LÀ CỔNG CỨNG.

    `approvalRequired` được máy xếp lúc tính rủi ro; nếu nó bật thì phải có `APPROVED`. `PENDING`
    và `REJECTED` đều là KHÔNG — và `NOT_REQUIRED` khi cờ đang bật là một mâu thuẫn, nên cũng
    KHÔNG: dữ liệu tự mâu thuẫn thì rơi về phía hẹp hơn, không rơi về phía cho qua.

    Nhánh này TRƯỚC BẢN NÀY KHÔNG BAO GIỜ TỚI ĐƯỢC trên dữ liệu thật (xem docblock cửa hẹp).
  */
  if (task.approvalRequired && task.approvalStatus !== "APPROVED") {
    return { ok: false, code: "APPROVAL", reason: `Việc ${task.code} cần người duyệt (đang ${task.approvalStatus || "chưa có"}).` };
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
