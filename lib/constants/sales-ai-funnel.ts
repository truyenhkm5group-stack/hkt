/**
 * ═══════════ PHỄU BÁN HÀNG CỦA NHÂN SỰ AI — MỘT BẬC, MỘT CHỦ SỞ HỮU ═══════════
 *
 * `SALES_STAGES` khai THỨ TỰ các giai đoạn. Sổ này khai thứ khác hẳn, và là thứ quyết định
 * phòng Sales AI có tự vận hành được hay không: **một hội thoại đứng lại ở bậc nào thì AI ĐÃ
 * TỰ LÀM ĐƯỢC TỚI ĐÂU, còn bậc kế tiếp đang chờ AI, chờ người, hay chờ một bên thứ ba.**
 *
 * ─── VÌ SAO PHẢI KHAI, THAY VÌ ĐẾM ───
 *
 * Đo bản chạy thử 22/09/2026: 597 hội thoại rơi vào NEW_LEAD 204 · SIZE_SELECTION 183 ·
 * VARIANT_SELECTION 4 · HUMAN_TAKEOVER 205 · LOST 1. **Không hội thoại nào vượt quá bậc 5 trên
 * 12.** Một bảng chỉ in dãy số ấy nói "phễu rò" rồi dừng lại ở đó — không ai đọc lần thứ hai,
 * đúng như luật 45 đã nói về mọi bảng chỉ in con số.
 *
 * Con số chỉ thành việc phải làm khi mỗi bậc khai được BA điều: bậc này đòi dữ kiện gì · thiếu
 * nó thì AI mắc ở đâu · AI TỰ vượt được không, hay phải có người. Chỉ khi đó "183 hội thoại kẹt
 * ở chọn size" mới đọc ra thành *"chưa khai bảng số đo, và chừng nào chưa khai thì 183 hội thoại
 * này AI không thể tự đi tiếp — không phải AI kém"*.
 *
 * ─── AI TỰ VƯỢT ĐƯỢC BẬC NÀO ───
 *
 * `autonomy` là câu trả lời, và nó KHÔNG phải một ước mơ mà là một lời khai kiểm chứng được:
 *
 *   `AI_ALONE`      AI tự đi qua được, không cần ai. Đây là phần "không cần chủ shop can thiệp".
 *   `AI_NEEDS_DATA` AI đi qua được NGAY KHI có dữ liệu khai báo. Chưa khai thì nó DỪNG và nói
 *                   rõ — không đoán. Chặn ở đây là việc của CHỦ SHOP, một lần, không lặp lại.
 *   `HUMAN_ONLY`    Không đường nào cho máy, kể cả khi mọi thứ khác hoàn hảo.
 *
 * Gộp ba loại này lại là điều nguy hiểm nhất có thể làm với một phòng tự vận hành: nó biến một
 * việc khai báo làm một lần thành "AI chưa đủ giỏi", và biến một trần cứng của nhà cung cấp
 * thành một lời hứa sẽ sửa được ở bản sau.
 */
import type { DepartmentCode } from "@/lib/constants/departments";
import type { SalesStage } from "@/lib/constants/sales-agent";

export const FUNNEL_AUTONOMY = ["AI_ALONE", "AI_NEEDS_DATA", "HUMAN_ONLY"] as const;
export type FunnelAutonomy = (typeof FUNNEL_AUTONOMY)[number];

export const FUNNEL_AUTONOMY_LABEL: Record<FunnelAutonomy, string> = {
  AI_ALONE: "AI tự đi được",
  AI_NEEDS_DATA: "AI đi được khi có dữ liệu khai",
  HUMAN_ONLY: "Bắt buộc có người",
};

export type FunnelStep = {
  /** Bậc trong `SALES_STAGES`. Một bậc của phễu = một giai đoạn, không gộp. */
  stage: SalesStage;
  /** Thứ tự trên phễu, 1 là đầu. Dùng để tính "đi được bao xa", không phải để sắp xếp hiển thị. */
  order: number;
  label: string;
  /** Dữ kiện mà bậc này phải có thì hội thoại mới đi tiếp được. */
  requires: string;
  autonomy: FunnelAutonomy;
  /**
   * Thứ đang chặn khi `autonomy` khác `AI_ALONE`. Phải cụ thể tới mức SỬA ĐƯỢC — tên khoá cấu
   * hình, tên API, tên bảng. "Cần thêm dữ liệu" không phải một câu sửa được.
   */
  blockedBy: string;
  /** Phòng phải đi làm khi hội thoại chất đống ở đây. Trỏ PHÒNG BAN, không bao giờ trỏ một người (luật 22). */
  owner: DepartmentCode;
};

/**
 * MƯỜI HAI BẬC. Thứ tự khớp `SALES_STAGES`; các giai đoạn KHÔNG nằm trên đường đi thẳng
 * (`OBJECTION` · `FOLLOW_UP` · `HUMAN_TAKEOVER` · `LOST`) cố ý đứng ngoài — chúng là NHÁNH RẼ,
 * và đếm chúng như một bậc tiến bộ sẽ làm một hội thoại bị khách từ chối trông như đã đi xa hơn
 * một hội thoại đang chờ chọn size.
 */
export const SALES_FUNNEL: FunnelStep[] = [
  {
    stage: "NEW_LEAD",
    order: 1,
    label: "Khách nhắn tới",
    requires: "Một tin của khách đã nạp được vào ERP",
    autonomy: "AI_ALONE",
    blockedBy: "",
    owner: "SALES",
  },
  {
    stage: "PRODUCT_IDENTIFIED",
    order: 2,
    label: "Biết khách hỏi mẫu nào",
    requires: "Product Resolver kết luận được một sản phẩm (ảnh chụp ngữ cảnh · bản đồ quảng cáo · mã hàng · câu quảng cáo)",
    autonomy: "AI_ALONE",
    blockedBy: "",
    owner: "SALES",
  },
  {
    stage: "QUALIFIED",
    order: 3,
    label: "Khách thật sự muốn mua",
    requires: "Một ý định mua đọc được từ câu khách nhắn",
    autonomy: "AI_ALONE",
    blockedBy: "",
    owner: "SALES",
  },
  {
    stage: "VARIANT_SELECTION",
    order: 4,
    label: "Chốt màu",
    requires: "Danh sách màu của sản phẩm, và câu trả lời của khách",
    autonomy: "AI_ALONE",
    blockedBy: "",
    owner: "SALES",
  },
  {
    stage: "SIZE_SELECTION",
    order: 5,
    label: "Chốt size",
    requires: "Khách tự chọn một size, HOẶC bảng số đo để quy từ chiều cao / cân nặng",
    autonomy: "AI_NEEDS_DATA",
    blockedBy:
      "Khoá ai.sizeRules trong settings chưa khai, nên size.recommend trả SIZE_DATA_MISSING và dây chuyền chuyển người. Khách đưa số đo mà không có bảng tra thì AI KHÔNG đoán — đoán một size trên cơ thể người thật là thứ không được phép đoán.",
    owner: "MANAGEMENT",
  },
  {
    stage: "PURCHASE_INTENT",
    order: 6,
    label: "Khách đồng ý mua",
    requires: "Một câu đồng ý có ngữ cảnh, gắn với đúng mẫu mã đang bàn",
    autonomy: "AI_ALONE",
    blockedBy: "",
    owner: "SALES",
  },
  {
    stage: "CONTACT_COLLECTION",
    order: 7,
    label: "Xin số điện thoại",
    requires: "Số điện thoại chuẩn hoá được về 0 cộng 9 chữ số",
    autonomy: "AI_ALONE",
    blockedBy: "",
    owner: "SALES",
  },
  {
    stage: "ADDRESS_COLLECTION",
    order: 8,
    label: "Xin địa chỉ",
    requires: "Địa chỉ đủ để addressIssue() thấy được tên tỉnh/thành",
    autonomy: "AI_ALONE",
    blockedBy: "",
    owner: "SALES",
  },
  {
    stage: "ORDER_REVIEW",
    order: 9,
    label: "Đọc lại đơn cho khách",
    requires: "Mẫu mã, số lượng, giá do MÁY CHỦ tính và phí ship — ba con số cộng được với nhau",
    autonomy: "AI_ALONE",
    blockedBy: "",
    owner: "SALES",
  },
  {
    stage: "AWAITING_CONFIRMATION",
    order: 10,
    label: "Chờ khách xác nhận",
    requires: "Bản chốt còn hiệu lực — vân tay đơn chưa đổi, chưa quá 24 giờ",
    autonomy: "AI_ALONE",
    blockedBy: "",
    owner: "SALES",
  },
  {
    stage: "CONFIRMED",
    order: 11,
    label: "Khách đã chốt",
    requires: "Xác nhận có ngữ cảnh: sáu điều kiện, vân tay đơn khớp, còn hạn",
    autonomy: "AI_ALONE",
    blockedBy: "",
    owner: "SALES",
  },
  {
    stage: "ORDER_CREATED",
    order: 12,
    label: "Đơn nháp đã lên POS",
    requires: "PancakeClient.createOrder() với status 0 (Mới), và công tắc AI_ALLOW_ORDER_CREATE bật",
    autonomy: "AI_NEEDS_DATA",
    blockedBy:
      "AI_ALLOW_ORDER_CREATE đang ghim false ở docker-compose. Bật được — nhưng chỉ nên bật sau khi bậc 5 thông và có người chấm tay đủ mẫu.",
    owner: "MANAGEMENT",
  },
];

/**
 * BẬC THỨ MƯỜI BA KHÔNG TỒN TẠI TRONG PHỄU, VÀ ĐÓ LÀ MỘT LỜI KHAI, KHÔNG PHẢI MỘT THIẾU SÓT.
 *
 * CHỐT đơn trên POS (đưa đơn nháp thành đơn đã xác nhận) **không có API**. Pancake POS có
 * `POST /orders` để tạo, có `GET` để đọc, và KHÔNG có endpoint update-order — nên `order.confirm`
 * của nhân sự AI chỉ ghi được trong ERP và trả `posUpdated: false`.
 *
 * Khai nó ở đây, tách hẳn khỏi `SALES_FUNNEL`, vì hai lý do:
 *   · một bậc `HUMAN_ONLY` nằm lẫn trong phễu sẽ bị đọc thành "chỗ AI còn yếu", rồi ai đó sẽ đi
 *     tối ưu một thứ không tối ưu được;
 *   · và tỷ lệ "tự động hoá" của phễu phải tính trên những bậc THẬT SỰ tự động hoá được, nếu
 *     không nó vĩnh viễn không bao giờ chạm 100% và con số ấy mất hết ý nghĩa.
 */
export const FUNNEL_BEYOND_REACH = {
  stage: "ORDER_CONFIRMED_ON_POS",
  label: "Chốt đơn trên POS",
  autonomy: "HUMAN_ONLY" as FunnelAutonomy,
  blockedBy:
    "Pancake POS không có endpoint update-order. Không phải giới hạn của ERP, và không có bản sau nào sửa được — trừ khi Pancake mở API.",
  owner: "SALES" as DepartmentCode,
} as const;

/** Bậc cuối mà AI có thể tự đi tới. Dẫn xuất, không gõ tay — thêm một bậc là con số này tự đúng. */
export const FUNNEL_LAST_STEP = SALES_FUNNEL[SALES_FUNNEL.length - 1].order;

/** Tra một bậc theo giai đoạn. Giai đoạn nhánh rẽ trả `null` — chúng không nằm trên phễu. */
export function funnelStep(stage: SalesStage): FunnelStep | null {
  return SALES_FUNNEL.find((s) => s.stage === stage) ?? null;
}

/**
 * Bậc xa nhất mà một hội thoại đã đi tới.
 *
 * NHÁNH RẼ KHÔNG PHẢI MỘT BẬC. `HUMAN_TAKEOVER` hay `LOST` không nói gì về việc hội thoại đã đi
 * được bao xa — một hội thoại bị người cầm ở bậc 2 và một hội thoại bị người cầm ở bậc 9 mang
 * cùng một giá trị `stage`, nên đọc `stage` của chúng như một bậc tiến bộ là trộn hai thứ khác
 * hẳn nhau. Trả `null` = CHƯA BIẾT đi được tới đâu, và người gọi phải đếm chúng riêng.
 */
export function reachedOrder(stage: SalesStage): number | null {
  return funnelStep(stage)?.order ?? null;
}
