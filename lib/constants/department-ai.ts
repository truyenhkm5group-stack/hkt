import { DEPARTMENT_CODES, DEPARTMENT_LABEL, DEPARTMENT_ORDER, type DepartmentCode } from "@/lib/constants/departments";

/**
 * ═══════════ AI AGENT CỦA TỪNG PHÒNG — MỘT SỔ KHAI, VÀ NÓ KHÔNG ĐƯỢC KHAI KHỐNG ═══════════
 *
 * Chủ shop yêu cầu (23/09/2026): *"tất cả các phòng ban, các nghiệp vụ đều cần có AI agent để tự
 * động hoặc bán tự động quy trình vận hành, giảm thiểu can thiệp của con người"*.
 *
 * Tệp này KHÔNG dựng agent. Nó trả lời câu phải trả lời trước khi dựng: **mỗi phòng đang đứng ở đâu
 * trên đường tự động hoá, và thiếu đúng cái gì để đi tiếp.** Không có bảng này thì "phòng nào cũng
 * có AI" là một câu nói, và mọi báo cáo tiến độ sau đó đều là cảm giác.
 *
 * ─── VÌ SAO LÀ MỘT THANG BẬC, KHÔNG PHẢI MỘT Ô "ĐÃ CÓ AI / CHƯA CÓ AI" ───
 *
 * Phòng Marketing AI (`docs/marketing-ai-department.md`) đã trả bài học đó: nó ĐO được, CHẨN ĐOÁN
 * được, QUYẾT ĐỊNH được từ lâu, nhưng vẫn không "tự động" vì hai nấc cuối chưa nối. Một ô nhị phân
 * sẽ in "chưa có AI" cho một phòng đã làm được bốn phần năm việc, hoặc in "đã có AI" cho một phòng
 * chỉ có một bản đặc tả. Cả hai cách đều làm chủ shop đầu tư sai chỗ.
 *
 * Năm nấc, và **thứ tự không đảo được**:
 *
 *   ĐO        → máy đọc được khâu này bằng số chưa? (chưa đo được thì mọi nấc sau là bịa)
 *   CHẨN ĐOÁN → máy chỉ ra được NGUYÊN NHÂN và phòng chịu trách nhiệm chưa?
 *   ĐỀ NGHỊ   → có một HÀM THUẦN ra quyết định, có cổng từ chối khi thiếu bằng chứng, chưa?
 *   VÀO VIỆC  → đề nghị có thành một dòng việc CÓ HẠN và CÓ PHÒNG trong hàng đợi chưa?
 *   BÀN TAY   → ERP có ghi được ra hệ thống ngoài (Facebook · Viettel Post · Pancake) chưa?
 *
 * Nấc BÀN TAY mà không có nấc ĐỀ NGHỊ là một cỗ máy tiêu tiền không có lý lẽ; nấc VÀO VIỆC mà không
 * có nấc ĐO là một hàng đợi đầy việc không ai kiểm được là đúng hay sai.
 *
 * ─── BỐN LUẬT CỦA SỔ NÀY ───
 *
 * 1. **`evidence` phải là ĐƯỜNG DẪN TỆP CÓ THẬT.** `tests/department-map.test.ts` mở từng tệp; khai
 *    một tệp không tồn tại là ĐỎ. Đây là thứ duy nhất ngăn bảng này biến thành một bản kế hoạch tự
 *    khen — mọi ô xanh đều phải chỉ ra được dòng mã đang chạy.
 * 2. **Nấc chưa xong phải khai `missing` CỤ THỂ TỚI MỨC SỬA ĐƯỢC.** "Cần hoàn thiện thêm" là một câu
 *    không ai làm được gì với nó. "Chưa có `WorkSource` cho mẫu tới hạn đặt" thì có.
 * 3. **`NONE` CỐ Ý khác `NONE` CHƯA LÀM.** Kế toán và Kho không có nấc BÀN TAY vì `RISK_FLOOR` trong
 *    `lib/ai/tools/registry.ts` CẤM AI ghi vào tiền và tồn kho — đó là một quyết định an toàn, không
 *    phải một thiếu sót. Nấc ấy mang `closedByDesign: true` và `missing` nói rõ vì sao không nên mở.
 *    Từ 24/09/2026 `nextRung()` BỎ QUA nấc cố ý đóng: trước đó, phòng đã làm xong mọi nấc được phép
 *    vẫn hiện "việc phải làm tiếp: Bàn tay", tức là chỉ người đọc đi mở đúng cánh cửa sổ này dặn
 *    đóng.
 * 4. **`measuredAt` là ngày ĐỌC MÃ NGUỒN, không phải ngày viết kế hoạch.** Số liệu production nào
 *    được nhắc trong `what`/`missing` đều phải có ngày đo kèm, vì một tỷ lệ 0/565 của tháng trước
 *    không còn là bằng chứng của hôm nay.
 */

export const AI_RUNGS = ["MEASURE", "DIAGNOSE", "PROPOSE", "DISPATCH", "ACT"] as const;
export type AiRung = (typeof AI_RUNGS)[number];

export const AI_RUNG_LABEL: Record<AiRung, string> = {
  MEASURE: "Đo",
  DIAGNOSE: "Chẩn đoán",
  PROPOSE: "Đề nghị",
  DISPATCH: "Vào việc",
  ACT: "Bàn tay",
};

export const AI_RUNG_QUESTION: Record<AiRung, string> = {
  MEASURE: "Máy đọc được khâu này bằng số chưa?",
  DIAGNOSE: "Máy chỉ ra được nguyên nhân và phòng chịu trách nhiệm chưa?",
  PROPOSE: "Có hàm thuần ra đề nghị, kèm cổng từ chối khi thiếu bằng chứng, chưa?",
  DISPATCH: "Đề nghị có thành dòng việc có hạn, có phòng, trong hàng đợi chưa?",
  ACT: "ERP ghi được ra hệ thống ngoài chưa, và ai bấm?",
};

export const AI_STATUSES = ["BUILT", "PARTIAL", "SPEC_ONLY", "NONE"] as const;
export type AiStatus = (typeof AI_STATUSES)[number];

export const AI_STATUS_LABEL: Record<AiStatus, string> = {
  BUILT: "Đang chạy",
  PARTIAL: "Một phần",
  SPEC_ONLY: "Có đặc tả",
  NONE: "Chưa có",
};

/** Nhãn NGẮN cho ô bảng — bảng năm nấc phải vừa một màn hình, văn xuôi dài đi vào `title`. */
export const AI_STATUS_SHORT: Record<AiStatus, string> = {
  BUILT: "Chạy",
  PARTIAL: "Một phần",
  SPEC_ONLY: "Đặc tả",
  NONE: "Chưa có",
};

export const AI_STATUS_TONE: Record<AiStatus, string> = {
  BUILT: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  PARTIAL: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  SPEC_ONLY: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  NONE: "bg-muted text-muted-foreground",
};

/**
 * Mức tự chủ — CỦA CẢ PHÒNG, không phải của một nấc.
 *
 * `AUTO` là mức duy nhất cần chủ shop bấm một lần để mở, vì nó là mức mà máy ghi ra ngoài KHÔNG CHỜ
 * người. Hôm nay KHÔNG phòng nào ở mức đó, và sổ này không được tự đặt phòng nào vào đó.
 */
export const AI_AUTONOMIES = ["READ_ONLY", "COPILOT", "AUTO"] as const;
export type AiAutonomy = (typeof AI_AUTONOMIES)[number];

export const AI_AUTONOMY_LABEL: Record<AiAutonomy, string> = {
  READ_ONLY: "Chỉ đọc",
  COPILOT: "Đề nghị — người bấm",
  AUTO: "Tự ghi",
};

export type RungState = {
  status: AiStatus;
  /** Một câu: máy đang làm được gì ở nấc này, nói bằng việc thật. */
  what: string;
  /** Tệp đang chạy chứng minh câu trên. Bài kiểm mở từng tệp. */
  evidence: string[];
  /** Bắt buộc khi `status !== "BUILT"`: thiếu đúng cái gì, cụ thể tới mức sửa được. */
  missing?: string;
  /**
   * `true` = nấc này CỐ Ý đóng (chỉ đi với `status: "NONE"`), và `missing` nói vì sao không nên mở.
   * `nextRung()` bỏ qua nó. Không dùng để giấu một nấc chưa làm — bài kiểm đòi câu lý do.
   */
  closedByDesign?: true;
};

export type AgentZone = DepartmentCode | "SYSTEM";

export type AgentSpec = {
  zone: AgentZone;
  /** Tên gọi trong ERP. `null` = phòng chưa có agent nào mang tên. */
  name: string | null;
  /** Màn hình vào agent. `null` = chưa có lối vào, và đó là một việc phải làm. */
  home: string | null;
  autonomy: AiAutonomy;
  /** Vì sao ở mức tự chủ đó. `AUTO` thì phải trỏ được tới quyết định của chủ shop. */
  autonomyWhy: string;
  /** Đặc tả trong `docs/`. `null` = chưa có đặc tả nào cho phòng này. */
  spec: string | null;
  /** Ngày đọc mã nguồn để khai bảng dưới đây. */
  measuredAt: string;
  rungs: Record<AiRung, RungState>;
};

export const AGENTS: Record<AgentZone, AgentSpec> = {
  // ─────────────────────────────── KINH DOANH & CSKH ───────────────────────────────
  SALES: {
    zone: "SALES",
    name: "Trợ lý CSKH",
    home: "/cs",
    autonomy: "COPILOT",
    autonomyWhy: "Hai tool ghi (`resolve_case`, `reopen_case`) mang `policy: \"confirm\"` — mô hình đề nghị, người bấm mới ghi. Gửi tin cho khách cũ cũng do người bấm chạy chiến dịch.",
    spec: null,
    measuredAt: "2026-09-23",
    rungs: {
      MEASURE: {
        status: "BUILT",
        what: "Đếm case theo loại, theo người cầm, theo hạn; phễu hội thoại → đơn.",
        evidence: ["lib/queries/cs.ts", "lib/cs/conversation-funnel.ts", "lib/cs/workqueue.ts"],
      },
      DIAGNOSE: {
        status: "BUILT",
        what: "Máy tự sinh case từ thẻ đơn, ghi chú và thẻ hội thoại Pancake; nhận ra case im lặng quá lâu và case trùng.",
        evidence: ["lib/cs/detect.ts", "lib/cs/semantic-case.ts", "lib/cs/stale.ts"],
      },
      PROPOSE: {
        status: "BUILT",
        what: "Mỗi case có BƯỚC TIẾP THEO suy từ trạng thái, không phải một câu chung chung.",
        evidence: ["lib/constants/cs-next-action.ts", "lib/cs/failed-delivery.ts"],
      },
      DISPATCH: {
        status: "BUILT",
        what: "Nguồn `CS_CASE` chiếu thẳng vào hàng đợi `/work` kèm hạn xử lý và phòng chịu trách nhiệm.",
        evidence: ["lib/constants/work-sources.ts", "lib/queries/work-adapters.ts"],
      },
      ACT: {
        status: "PARTIAL",
        what: "Gửi được tin nhắn ra Pancake (chiến dịch chăm sóc / bán chéo, idempotent theo khách + chiến dịch) và đóng / mở lại case qua tool có xác nhận.",
        evidence: ["lib/outreach/send.ts", "lib/ai/tools/erp.ts"],
        missing:
          "Chưa TRẢ LỜI được trong hội thoại đang mở: đường gửi hiện tại đi theo CHIẾN DỊCH có phân khúc, không theo một tin khách vừa nhắn. Muốn agent trả lời trực tiếp thì cần (a) một tool ghi mới bọc `sendMessage` ở mức MỘT hội thoại, (b) hàng rào nội dung — hôm nay chưa có luật nào chặn mô hình hứa giá, hứa ngày giao.",
      },
    },
  },

  // ─────────────────────────────── MARKETING ───────────────────────────────
  MARKETING: {
    zone: "MARKETING",
    name: "Marketing AI",
    home: "/ads",
    autonomy: "COPILOT",
    autonomyWhy: "Chủ shop chốt 22/09/2026: mở nấc BÀN TAY ở mức COPILOT — agent đề nghị, người bấm xác nhận thì ERP mới gọi Facebook. Nấc `AUTO` chưa mở.",
    spec: "docs/marketing-ai-department.md",
    measuredAt: "2026-09-24",
    rungs: {
      MEASURE: {
        status: "BUILT",
        what: "Chi tiêu, đơn, doanh thu giao thành công và ROAS theo NGÀY × chiến dịch, hai đường quy kết tách nhau (đơn theo fanpage, tiền theo chiến dịch).",
        evidence: ["lib/queries/marketing-daily.ts", "lib/constants/marketing-daily.ts"],
      },
      DIAGNOSE: {
        status: "BUILT",
        what: "Tìm nguyên nhân có bằng chứng, kèm `why` và phòng sở hữu; phát hiện đột biến chi tiêu.",
        evidence: ["lib/marketing/diagnose.ts", "lib/constants/ads-anomaly.ts"],
      },
      PROPOSE: {
        status: "BUILT",
        what: "`decideAction()` là hàm thuần có bảng chân lý, từ chối kết luận khi mẫu chưa đủ; sổ quyết định ghi lại đã đề nghị gì và có bền không.",
        evidence: ["lib/constants/ads-decision.ts", "lib/marketing/decision-ledger.ts", "lib/constants/marketing-decision-ledger.ts"],
      },
      DISPATCH: {
        status: "BUILT",
        what: "Nguồn `ADS_DECISION` đưa từng khuyến nghị đã chín thành một dòng việc của phòng Marketing trong `/work`.",
        evidence: ["lib/constants/work-sources.ts", "lib/queries/work-adapters.ts"],
      },
      ACT: {
        status: "PARTIAL",
        what: "Đường ghi ngân sách / bật tắt chiến dịch đã dựng, qua bảy hàng rào và hai bước bấm, có trần thay đổi và phanh. Công tắc máy chủ `ADS_WRITE_ENABLED=true`, nấc `COPILOT` bật từ 22/09/2026; ERP tự hỏi Facebook token có `ads_management` không (tab Cấu hình vòng mẫu, `/ads`, `check-integrations`).",
        evidence: ["lib/marketing/ads-write-gate.ts", "lib/constants/ads-write.ts", "lib/constants/fb-token-scopes.ts"],
        missing:
          "CHƯA CÓ MỘT LƯỢT GHI THẬT NÀO: đo production 24/09/2026, sổ `ads_budget_changes` và `creative_fb_actions` đều TRỐNG — kể cả lượt bị từ chối. Chủ shop báo token đã có quyền; nấc này chỉ lên 'đang chạy' khi sổ có một lượt ghi THÀNH CÔNG (bấm 'Xác nhận' ở ô Bàn tay trên một dòng đã chín), không lên vì một lời kể.",
      },
    },
  },

  // ─────────────────────────────── GIAO VẬN ───────────────────────────────
  LOGISTICS: {
    zone: "LOGISTICS",
    name: "Care vận đơn",
    home: "/shipments",
    autonomy: "COPILOT",
    autonomyWhy: "Máy tự MỞ ca và tự xếp thứ tự, nhưng mọi lệnh gửi sang Viettel Post đều do người bấm; tool `request_carrier_action` mang `policy: \"confirm\"`.",
    spec: "docs/care-engine-contract.md",
    measuredAt: "2026-09-24",
    rungs: {
      MEASURE: {
        status: "BUILT",
        what: "Hai đồng hồ tách nhau: độ tươi (bao lâu ERP không nghe tin) và tuổi chặng (kiện đứng ở chặng này bao lâu); mốc bàn giao lấy bằng chứng sớm nhất.",
        evidence: ["lib/constants/shipment-timeline.ts", "lib/queries/logistics-freshness.ts", "lib/constants/carrier-handoff.ts"],
      },
      DIAGNOSE: {
        status: "BUILT",
        what: "Sáu lý do đối chiếu, xếp theo lý do MẠNH NHẤT; ca chăm sóc tự mở theo sự kiện ĐVVC và có chốt chống dựng lại vô cớ.",
        evidence: ["lib/constants/vtp-reconcile-queue.ts", "lib/care/reopen-guard.ts", "lib/care/service.ts"],
      },
      PROPOSE: {
        status: "BUILT",
        what: "Mỗi trạng thái ĐVVC có gợi ý kết cục và hành động tương ứng; 505 (đề nghị hoàn) tách khỏi 515/502 (đã duyệt hoàn) vì một cái còn phát tiếp được.",
        evidence: ["lib/constants/care-outcome.ts", "lib/constants/care-return-approval.ts", "lib/care/redelivery-eligibility.ts"],
      },
      DISPATCH: {
        status: "BUILT",
        what: "Nguồn `SHIPMENT_CARE` vào `/work` với hạn riêng; hàng đợi đối soát `/shipments?view=reconcile` hỏi câu khác nên đứng riêng.",
        evidence: ["lib/constants/work-sources.ts", "lib/constants/vtp-reconcile-queue.ts"],
      },
      ACT: {
        status: "PARTIAL",
        what: "`requestCarrierAction` gọi thật `order/UpdateOrder` của Viettel Post (phát tiếp · duyệt hoàn · gửi lại · huỷ · sửa người nhận), idempotent theo kiện + hành động + ngày.",
        evidence: ["lib/care/service.ts", "lib/care/carrier-capabilities.ts"],
        missing:
          "Viettel Post KHÔNG cấp API cho tài khoản shop — chỉ có webhook (chủ shop xác nhận 24/09/2026). Đo cùng ngày: tra cứu vận đơn trả HTTP 403, 2.815/2.873 vận đơn là `WEBHOOK_ONLY`; trước đó 11/09 là 565/565 `PERMISSION_MISSING`. Nên mọi lệnh phát tiếp · duyệt hoàn · sửa người nhận rơi về `MANUAL_REQUIRED`: làm tay trên viettelpost.vn, ERP ghi vết. Không tự động hoá đường web (AGENTS.md mục 5). Việc còn làm được ở phía ERP là SOẠN SẴN nội dung yêu cầu cho người làm tay, không phải gọi API.",
      },
    },
  },

  // ─────────────────────────────── KHO ───────────────────────────────
  WAREHOUSE: {
    zone: "WAREHOUSE",
    name: null,
    home: "/inventory/packing",
    autonomy: "READ_ONLY",
    autonomyWhy: "`RISK_FLOOR.inventory = \"forbidden\"`: AI không có một tool ghi nào vào tồn kho. Hàng vào tồn CHỈ bằng phiếu kho của người đếm thật.",
    spec: null,
    measuredAt: "2026-09-24",
    rungs: {
      MEASURE: {
        status: "BUILT",
        what: "Tồn thực tế và khả dụng bán dựng từ phiếu kho trừ đã xuất qua ĐVVC; mẫu chưa có phiếu nhập thì hiện 'chưa biết', không hiện 0.",
        evidence: ["lib/queries/stock.ts", "lib/constants/inventory.ts"],
      },
      DIAGNOSE: {
        status: "BUILT",
        what: "Cảnh báo sắp hết / đã hết theo tốc độ bán 30 ngày; đơn đã chốt còn nằm trong kho được tách theo năm lý do tắc, trong đó tồn thực tế được PHÂN cho đơn lên trước để tách đơn đóng gói được ngay khỏi đơn đang chờ hàng.",
        evidence: ["lib/constants/alerts.ts", "lib/constants/fulfillment-bottleneck.ts", "lib/constants/stock-shortage.ts"],
      },
      PROPOSE: {
        status: "PARTIAL",
        what: "Xếp thứ tự kiện hoàn cần mở đếm trước; nhận ra hàng chậm bán để đề nghị xả; mẫu ERP báo thiếu mà sổ kho âm hoặc Pancake báo còn đủ thì đề nghị KIỂM ĐẾM trước khi ai đặt sản xuất; và GOM ĐƠN ĐỦ HÀNG theo mẫu mã (từ 24/09/2026): một phiếu lấy hàng tổng cho cả kho, các lượt đơn giống hệt nhau để đóng liền tay, đơn lẻ theo thứ tự ai lên trước.",
        evidence: ["lib/returns/receive-queue.ts", "lib/constants/slow-moving.ts", "lib/constants/stock-shortage.ts", "lib/constants/packing-waves.ts", "lib/queries/packing-waves.ts"],
        missing: "Chưa có đề nghị VỊ TRÍ xếp hàng trong kho (mẫu bán chạy để gần bàn đóng gói): ERP không có bảng vị trí kệ. Và chưa ĐO được gom đơn tiết kiệm bao nhiêu công — không có mốc thời gian đóng gói từng đơn (Pancake chỉ ghi lúc đổi trạng thái).",
      },
      DISPATCH: {
        status: "BUILT",
        what: "Ba nguồn việc của kho vào `/work`: kiểm đếm hàng hoàn, nút thắt trước khi rời kho (ba trong bốn lý do), cảnh báo tồn kho.",
        evidence: ["lib/constants/work-sources.ts", "lib/constants/work-ownership.ts"],
      },
      ACT: {
        status: "NONE",
        what: "Không có, và CỐ Ý không có.",
        evidence: [],
        closedByDesign: true,
        missing:
          "KHÔNG NÊN MỞ. Một phiếu kho do máy ghi là một con số tồn không ai đếm — và tồn kho sai thì sai theo cả giá vốn, lợi nhuận và kế hoạch đặt hàng. Nấc này đứng ở `NONE` vĩnh viễn là trạng thái ĐÚNG; việc còn lại của kho là làm phần ĐO và ĐỀ NGHỊ tốt hơn, không phải giao bàn tay cho máy.",
      },
    },
  },

  // ─────────────────────────────── SẢN XUẤT ───────────────────────────────
  PRODUCTION: {
    zone: "PRODUCTION",
    name: null,
    home: "/inventory/shortage",
    autonomy: "READ_ONLY",
    autonomyWhy: "Chưa có tool ghi nào. Lệnh đặt hàng sản xuất do người tạo trên `/inventory/planning/orders/new`; bảng thiếu hàng chỉ ĐỀ XUẤT và dẫn link tới đó.",
    spec: "docs/inventory-forecast-contract.md",
    measuredAt: "2026-09-24",
    rungs: {
      MEASURE: {
        status: "BUILT",
        what: "Nhu cầu theo mẫu mã dựng từ đơn đã chốt, tốc độ bán và tồn khả dụng; vốn đang nằm ở mẫu nào đọc được theo giá vốn sống.",
        evidence: ["lib/queries/planning.ts", "lib/queries/inventory-decision.ts", "lib/constants/planning.ts"],
      },
      DIAGNOSE: {
        status: "PARTIAL",
        what: "Nhận ra mẫu sắp hết trong khi vẫn đang bán tốt, và mẫu đã bỏ vốn mà không bán được. Thời gian giao của xưởng suy được bằng cách ghép lô đặt với phiếu nhập kho — phép ghép CỐ Ý chặt, cùng một mẫu có hai lô thì nó khai NHẬP NHẰNG chứ không bốc một cái.",
        evidence: ["lib/constants/inventory-decision.ts", "lib/constants/slow-moving.ts", "lib/queries/purchasing.ts"],
        missing:
          "Từ 23/09/2026 `production_orders` ĐÃ CÓ mốc nhận thật (`received_at`, do KHO bấm lúc đếm xong, kèm khoá tài khoản). Nhưng chưa đo được ngay: lệnh cũ CỐ Ý không backfill (mục 35) nên mẫu bắt đầu từ 0 và cần vài tuần; và `production_orders.supplier` vẫn là Ô CHỮ TỰ DO, nên độ tin quy về TỪNG xưởng còn là phép nối yếu (mục 39) cho tới khi có danh mục nhà cung cấp.",
      },
      PROPOSE: {
        status: "BUILT",
        what: "`getReplenishmentPlan()` ra số lượng nên đặt cho từng mẫu, theo giả định khai ở trang Giả định chứ không phải hằng số trong mã.",
        evidence: ["lib/queries/planning.ts", "lib/constants/purchasing.ts"],
      },
      /*
        SỬA LỜI KHAI 24/09/2026 — hai nấc dưới đây từng khai `NONE` trong khi mã đã chạy.

        Mẫu tới hạn đặt ĐÃ sinh việc: `lib/alerts/rules.ts` dựng cảnh báo `STOCKOUT_RISK` ("hết trước
        khi SX xong") và `STOCK_LOW` thẳng từ `getReplenishmentPlan()`, và nguồn `INVENTORY_EXCEPTION`
        chiếu chúng vào `/work`. Bản khai cũ đề nghị thêm một nguồn `PRODUCTION_ORDER_DUE` — làm thế là
        HAI nguồn ở CÙNG độ mịn (một mẫu mã), và mọi tổng hợp tiền của hàng đợi sẽ cộng hai lần (AGENTS.md
        mục 19). Chỗ thiếu thật chỉ là việc mặc định rơi về phòng Kho.
      */
      DISPATCH: {
        status: "BUILT",
        what: "Mẫu đã hết, hoặc sẽ hết trước khi lô mới kịp sản xuất xong, thành việc `INVENTORY_EXCEPTION` trong `/work` (hạn 48–72 giờ), dựng thẳng từ `getReplenishmentPlan()` kèm số đề xuất đặt — và việc ấy VỀ PHÒNG SẢN XUẤT: chủ shop đã ghi đè `work.ownership` cho cả hai khoá `INVENTORY_EXCEPTION:STOCKOUT_RISK` / `:LOW_STOCK_RISK` (đo production 24/09/2026; phòng có 1 thành viên). Đơn đã chốt thiếu hàng tự ĐI TÌM NGƯỜI: bảng mẫu thiếu (mã · màu · size · thiếu · đơn chờ · chờ lâu nhất · đã đặt xưởng · đề xuất đặt · việc cần làm) gửi Lark nhóm Kho/Sản xuất khi phát sinh hoặc nặng thêm và mỗi sáng; đơn chờ hàng vào hàng đợi fulfillment cho CSKH báo khách.",
        evidence: ["lib/alerts/rules.ts", "lib/constants/work-sources.ts", "lib/constants/work-ownership.ts", "lib/alerts/stock-shortage-digest.ts", "lib/constants/stock-shortage.ts"],
      },
      ACT: {
        status: "BUILT",
        what: "Xưởng không có API, nên bàn tay của phòng này là SOẠN SẴN: bảng chốt đặt hàng điền sẵn số lượng ERP đề xuất cho từng màu × size, in / lưu PDF và sao chép văn bản dán Zalo. Người gửi rồi bấm 'Đã gửi xưởng'; kho bấm 'Đã nhận hàng về' để lại mốc thật.",
        evidence: ["lib/queries/production.ts", "app/(dashboard)/inventory/planning/orders/[id]/order-actions.tsx"],
      },
    },
  },

  // ─────────────────────────────── KẾ TOÁN ───────────────────────────────
  FINANCE: {
    zone: "FINANCE",
    name: null,
    home: "/finance-ops",
    autonomy: "READ_ONLY",
    autonomyWhy: "`RISK_FLOOR.finance = \"forbidden\"`: AI không có tool ghi nào vào tiền. Quy tắc tự động phân loại dòng tiền là LUẬT DO NGƯỜI KHAI, và nó không bao giờ ghi đè dòng người đã phân loại tay.",
    spec: "docs/finance-truth-contract.md",
    measuredAt: "2026-09-24",
    rungs: {
      MEASURE: {
        status: "BUILT",
        what: "Một đường duy nhất cho chi phí vận hành (`getOperatingCost`), dòng tiền theo kỳ, COD đã giao mà tiền chưa về.",
        evidence: ["lib/queries/cost-engine.ts", "lib/queries/cashflow.ts", "lib/constants/cost-authority.ts"],
      },
      DIAGNOSE: {
        status: "BUILT",
        what: "Trung tâm đối chiếu chạy các luật lệch giữa đơn, vận đơn và tiền; hàng đợi tác vụ tài chính xếp việc tồn theo hạn.",
        evidence: ["lib/constants/reconciliation.ts", "lib/queries/finance-ops.ts", "lib/constants/finance-ops.ts"],
      },
      PROPOSE: {
        status: "BUILT",
        what: "Ghép dòng tiền với chứng từ theo khoá tự nhiên, gợi ý nhóm kế toán theo quy tắc, và XẾP dòng chưa phân loại theo tiền đang treo × số ngày treo (cùng điểm thì khoản lớn trước) — một công thức cho cả `/finance-ops` và `/work`. Đề nghị chứ không tự ghi.",
        evidence: ["lib/queries/bank-match.ts", "lib/constants/bank.ts", "lib/finance/linkage.ts", "lib/constants/finance-ops.ts"],
      },
      DISPATCH: {
        status: "BUILT",
        what: "Hai nguồn `BANK_EXCEPTION` và `COD_EXCEPTION` vào `/work` với phòng Kế toán và hạn riêng.",
        evidence: ["lib/constants/work-sources.ts", "lib/constants/work-ownership.ts"],
      },
      ACT: {
        status: "NONE",
        what: "Không có, và CỐ Ý không có.",
        evidence: [],
        closedByDesign: true,
        missing:
          "KHÔNG NÊN MỞ cho AI. Một dòng tiền do máy phân loại sai sẽ đi thẳng vào lợi nhuận và vào lương — và không ai phát hiện, vì con số vẫn cân. Thứ ĐƯỢC phép tự động ở đây là quy tắc do người khai, chạy trên dòng CHƯA ai phân loại; phần đó đã có và không cần mô hình.",
      },
    },
  },

  // ─────────────────────────────── BAN ĐIỀU HÀNH ───────────────────────────────
  MANAGEMENT: {
    zone: "MANAGEMENT",
    name: "Trợ lý ERP (Copilot)",
    home: "/",
    autonomy: "COPILOT",
    autonomyWhy: "Copilot đọc ERP qua sổ tool; mọi tool ghi mang `policy: \"confirm\"` và ba nhóm rủi ro (tiền · tồn kho · ĐVVC) bị `forbidden` ngay ở sàn.",
    spec: "docs/ai-copilot-architecture.md",
    measuredAt: "2026-09-24",
    rungs: {
      MEASURE: {
        status: "BUILT",
        what: "Bản tin chủ shop: tiền, đơn, tỷ lệ giao, việc đang tắc — đọc lại chính các KPI chính thức, không tự tính.",
        evidence: ["lib/queries/business-brief.ts", "lib/queries/control-tower.ts"],
      },
      DIAGNOSE: {
        status: "BUILT",
        what: "Bốn loại chỗ trống dữ liệu (chưa biết thật · sửa được · quá cũ · cần người quyết) kèm nguồn thật và phòng chịu trách nhiệm.",
        evidence: ["lib/constants/data-quality-issues.ts", "lib/queries/data-quality-issues.ts"],
      },
      PROPOSE: {
        status: "BUILT",
        what: "ERP tự xếp BA VIỆC ĐÁNG LÀM NHẤT liên phòng (mỗi phòng một đầu việc; mức gấp trước, rồi tiền đang treo) trên màn hình Hôm nay, và Copilot đọc đúng hàm đó qua tool `get_morning_priorities`. Hình dạng khuyến nghị bị kiểu dữ liệu bắt buộc nêu chỉ số, bằng chứng, khoảng thời gian.",
        evidence: ["lib/work/morning-picks.ts", "lib/ai/tools/erp.ts", "lib/ai/copilot.ts", "lib/constants/recommendation.ts"],
      },
      DISPATCH: {
        status: "BUILT",
        what: "Mọi cảnh báo thành dòng việc, suy phòng ban theo loại việc; leo thang SLA tính lúc đọc nên không đẻ thêm việc.",
        evidence: ["lib/constants/work-sources.ts", "lib/work/escalation.ts"],
      },
      ACT: {
        status: "NONE",
        what: "Không có đường ghi nào ở mức điều hành.",
        evidence: [],
        closedByDesign: true,
        missing: "Cố ý: ban điều hành không có 'hành động' riêng để tự động — việc của họ là quyết, và quyết định phải là của người. Ba việc đáng làm nhất chỉ là ĐỀ NGHỊ; giao việc vẫn là một cú bấm của người (`reassignWork`).",
      },
    },
  },

  // ─────────────────────────────── NHÂN SỰ ───────────────────────────────
  HR: {
    zone: "HR",
    name: null,
    home: null,
    autonomy: "READ_ONLY",
    autonomyWhy: "Máy phân việc mặc định CHẠY THỬ và tắt ở mọi phòng; `apply: true` là một cú bấm của người.",
    spec: "docs/work-management-os.md",
    measuredAt: "2026-09-24",
    rungs: {
      MEASURE: {
        status: "PARTIAL",
        what: "Thẻ điểm theo phòng và theo người, chỉ tính việc THUỘC PHÒNG của người đó, kèm độ phủ và bốn mức tin cậy.",
        evidence: ["lib/queries/work-performance.ts", "lib/metrics/scorecard.ts", "lib/constants/department-performance.ts"],
        missing: "Chỉ đo được VIỆC TRONG ERP. Chấm công, tuyển dụng, đào tạo, nghỉ việc: ERP CHƯA CÓ BẢNG NÀO — nên chúng đã khai `UNAVAILABLE` kèm lý do thay vì dựng một con số gần đúng từ việc giao tay.",
      },
      DIAGNOSE: {
        status: "BUILT",
        what: "Leo thang khi vỡ hạn; xem trước tác động khi một người rời phòng; và chẩn đoán VÌ SAO một phòng quá hạn bằng trần tải cạnh số quá hạn: hết chỗ (thiếu người) · còn chỗ mà chưa ai nhận · dồn ở một người · chậm đều. Không bao giờ kết luận 'người này chậm' (mục 39).",
        evidence: ["lib/work/escalation.ts", "lib/org/impact.ts", "lib/work/overdue-diagnosis.ts"],
      },
      PROPOSE: {
        status: "BUILT",
        what: "Máy dựng kế hoạch phân việc: hàm thuần, chạy hai lần ra cùng kết quả, không nhồi quá trần, việc không giao được thì nằm lại kèm lý do và lối ra.",
        evidence: ["lib/work/distribution.ts", "lib/constants/workforce.ts"],
      },
      DISPATCH: {
        status: "PARTIAL",
        what: "Kế hoạch ghi được vào hàng đợi khi người bấm `apply`.",
        evidence: ["lib/work/distribution.ts", "lib/actions/work-quick.ts"],
        missing: "Phân việc tự động mặc định TẮT ở mọi phòng, và đó là mặc định đúng cho tới khi chủ shop tin số liệu tải của từng người. Bật từng phòng ở Công việc → Cấu hình; không có gì phải lập trình thêm.",
      },
      ACT: {
        status: "NONE",
        what: "Không có hệ thống nhân sự nào nối vào.",
        evidence: [],
        missing: "Không có chấm công, không có bảng tuyển dụng, không có nơi lưu hồ sơ đào tạo. Nấc này chỉ mở được sau khi nấc ĐO của phòng có dữ liệu thật — dựng bàn tay trước là tự động hoá một quy trình chưa ai đo được.",
      },
    },
  },

  // ─────────────────────────────── HỆ THỐNG (PHÒNG TECH AI) ───────────────────────────────
  /*
    KHÔNG PHẢI MỘT PHÒNG BAN TRONG SỔ NHÂN SỰ, NHƯNG PHẢI CÓ MẶT Ở ĐÂY.

    Phòng Tech AI là phòng AI đầu tiên và là phòng DUY NHẤT đủ cả năm nấc. Nó đứng trong bảng này
    làm CỘT MỐC SO SÁNH: mọi phòng khác đọc được mình còn thiếu nấc nào so với một phòng đã chạy
    thật, thay vì so với một hình dung. Việc kỹ thuật vẫn thuộc Ban điều hành trong hàng đợi công
    việc (`TECH_TASK` → `MANAGEMENT`) — bảng này nói về AGENT, không nói về ai nhận việc.
  */
  SYSTEM: {
    zone: "SYSTEM",
    name: "Phòng Tech AI",
    home: "/tech",
    autonomy: "COPILOT",
    autonomyWhy: "Agent viết mã và mở PR thật, nhưng không tự gộp: cổng kiểm thử + người duyệt đứng giữa. Deploy là một lượt bấm.",
    spec: "docs/tech-ai-room-status.md",
    measuredAt: "2026-09-23",
    rungs: {
      MEASURE: {
        status: "BUILT",
        what: "Sổ lượt chạy agent: chi phí token, thời gian, kết quả, cổng kiểm thử nào đỏ.",
        evidence: ["lib/tech/service.ts", "lib/constants/agent-run-ledger.ts", "lib/constants/agent-run-cost.ts"],
      },
      DIAGNOSE: {
        status: "BUILT",
        what: "AI CTO đọc kho mã và sự cố rồi nêu rủi ro kỹ thuật kèm bằng chứng.",
        evidence: ["lib/agents/cto.ts", "lib/constants/cto-proposal.ts", "lib/constants/tech-risk.ts"],
      },
      PROPOSE: {
        status: "BUILT",
        what: "Đề xuất của AI CTO thành việc kỹ thuật có phạm vi ghi hẹp, có ngân sách đọc, có cổng kiểm thử khai trước.",
        evidence: ["lib/constants/cto-proposal.ts", "lib/constants/agent-scopes.ts", "lib/constants/agent-test-guard.ts"],
      },
      DISPATCH: {
        status: "BUILT",
        what: "Nguồn `TECH_TASK` vào hàng đợi; lời giao việc tới được agent thật và có vết nếu rơi.",
        evidence: ["lib/constants/work-sources.ts", "lib/constants/agent-dispatch.ts"],
      },
      ACT: {
        status: "BUILT",
        what: "Agent chạy trong hộp cát, sửa mã, mở PR trên GitHub, và lượt deploy để lại vết.",
        evidence: ["lib/agents/runner.ts", "lib/agents/workspace.ts", "lib/constants/agent-sandbox.ts"],
      },
    },
  },
};

export const AGENT_ZONES: AgentZone[] = [...DEPARTMENT_ORDER, "SYSTEM"];

export function agentLabel(zone: AgentZone): string {
  return zone === "SYSTEM" ? "Hệ thống" : DEPARTMENT_LABEL[zone];
}

/** Bao nhiêu nấc đang chạy / một phần / cố ý đóng, trên tổng năm nấc. Dùng để xếp bảng, KHÔNG để chấm điểm ai. */
export function agentCoverage(spec: AgentSpec): { built: number; partial: number; closed: number; total: number } {
  const list = AI_RUNGS.map((r) => spec.rungs[r]);
  return {
    built: list.filter((s) => s.status === "BUILT").length,
    partial: list.filter((s) => s.status === "PARTIAL").length,
    closed: list.filter((s) => s.closedByDesign === true).length,
    total: AI_RUNGS.length,
  };
}

/**
 * Nấc đáng làm tiếp: nấc THẤP NHẤT chưa xong, BỎ QUA nấc cố ý đóng.
 *
 * Thứ tự thang bậc không đảo được, nên đi vá nấc BÀN TAY khi nấc ĐỀ NGHỊ còn dở là dựng một cỗ máy
 * không có lý lẽ. Trả `null` khi mọi nấc được phép mở đều đã chạy.
 */
export function nextRung(spec: AgentSpec): AiRung | null {
  return AI_RUNGS.find((r) => spec.rungs[r].status !== "BUILT" && spec.rungs[r].closedByDesign !== true) ?? null;
}

/** Lá chắn khai báo: nấc khai "cố ý đóng" mà không ở `NONE` hoặc lại có bằng chứng đang chạy. Phải luôn rỗng. */
export const CLOSED_RUNGS_MISDECLARED: string[] = AGENT_ZONES.flatMap((z) =>
  AI_RUNGS.filter((r) => AGENTS[z].rungs[r].closedByDesign === true && (AGENTS[z].rungs[r].status !== "NONE" || AGENTS[z].rungs[r].evidence.length > 0)).map((r) => `${z}:${r}`),
);

/** Mọi đường dẫn bằng chứng — bài kiểm mở từng tệp, khai tệp không có thật là ĐỎ. */
export const AGENT_EVIDENCE_PATHS: string[] = [...new Set(AGENT_ZONES.flatMap((z) => AI_RUNGS.flatMap((r) => AGENTS[z].rungs[r].evidence)))];

/** Lá chắn khai báo: nấc chưa xong mà không nói thiếu gì. Phải luôn rỗng. */
export const RUNGS_WITHOUT_MISSING: string[] = AGENT_ZONES.flatMap((z) =>
  AI_RUNGS.filter((r) => AGENTS[z].rungs[r].status !== "BUILT" && !AGENTS[z].rungs[r].missing).map((r) => `${z}:${r}`),
);

/** Lá chắn khai báo: nấc khai đang chạy mà không có một tệp bằng chứng nào. Phải luôn rỗng. */
export const RUNGS_WITHOUT_EVIDENCE: string[] = AGENT_ZONES.flatMap((z) =>
  AI_RUNGS.filter((r) => AGENTS[z].rungs[r].status === "BUILT" && AGENTS[z].rungs[r].evidence.length === 0).map((r) => `${z}:${r}`),
);

/** Lá chắn khai báo: phòng nào trong sổ nhân sự chưa có dòng nào ở bảng AI. Phải luôn rỗng. */
export const DEPARTMENTS_WITHOUT_AGENT_ROW: DepartmentCode[] = DEPARTMENT_CODES.filter((d) => !AGENTS[d]);
