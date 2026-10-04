/**
 * ═══════════ BỘ HỘI THOẠI VÀNG — KỊCH BẢN (M1) ═══════════
 *
 * Mỗi hội thoại phủ MỘT hành vi bán hàng mà một thay đổi engine / công cụ / lời nhắc có thể làm vỡ im lặng. Lời khách lấy
 * theo cách khách HSLC thật nhắn (không dấu, viết tắt, gộp nhiều ý một câu); model giả chỉ làm đúng việc một model tốt sẽ làm,
 * để thứ được kiểm là phần MÁY CHỦ: giá đọc từ ERP, tồn, chặn chốt khi khách chưa đồng ý, chuyển người, lọc chữ nội bộ.
 *
 * Bổ sung hội thoại thật của HSLC (đã che SĐT / tên / địa chỉ) là việc sau: cần một thao tác ops chỉ-đọc xuất hội thoại — chưa
 * có, vì `db-query` không đọc CSDL tổ chức (MIGRATION_PLAN.md · M1).
 */
import { say, tool, type GoldenCase, type Step } from "./harness";

/** Bước trả lời bằng chữ dựng từ kết quả công cụ (số luôn lấy từ máy chủ, không gõ tay trong kịch bản). */
const reply =
  (f: (r: Record<string, unknown>) => string): Step =>
  ({ results }) => [say(f(results[0] ?? {}))];

const priceOf = (r: Record<string, unknown>) => String(((r.results as { price_text?: string }[] | undefined) ?? [])[0]?.price_text ?? "?");

export const GOLDEN_CASES: readonly GoldenCase[] = [
  {
    key: "bao-gia",
    title: "Khách hỏi giá ⇒ bot tìm sản phẩm, báo đúng giá ERP",
    shop: "food",
    channel: "WEB",
    turns: [{ say: "cha muc bao nhieu 1kg vay shop", ai: [() => [tool("search_products", { query: "chả mực" })], reply((r) => `Dạ chả mực giã tay ${priceOf(r)} một gói 1kg ạ.`)] }],
  },
  {
    key: "len-don-chot",
    title: "Trọn vòng: báo giá → giỏ → thông tin khách → đơn nháp → khách đồng ý → chốt (ghi thật, giữ hàng)",
    shop: "food",
    channel: "WEB",
    turns: [
      { say: "Chả mực bao nhiêu?", ai: [() => [tool("search_products", { query: "chả mực" })], reply((r) => `Chả mực giã tay ${priceOf(r)} một gói 1kg ạ.`)] },
      {
        say: "cho chi 2 goi, them 1 ruoc tom",
        ai: [
          ({ v }) => [tool("check_inventory", { items: [{ variant_id: v("CHA-MUC"), quantity: 2 }, { variant_id: v("RUOC-TOM"), quantity: 1 }] })],
          ({ v }) => [tool("calculate_cart", { items: [{ variant_id: v("CHA-MUC"), quantity: 2 }, { variant_id: v("RUOC-TOM"), quantity: 1 }] })],
          reply((r) => `Tạm tính ${String(r.subtotal_text)}, ${String(r.shipping_text)}. Chị cho em tên, SĐT, địa chỉ nhé.`),
        ],
      },
      {
        say: "Nguyễn Thị Lan 0912345678, 12 Hàng Bạc Hoàn Kiếm Hà Nội",
        ai: [
          () => [tool("create_customer", { name: "Nguyễn Thị Lan", phone: "0912345678", address: "12 Hàng Bạc, Hoàn Kiếm, Hà Nội" })],
          ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CHA-MUC"), quantity: 2 }, { variant_id: v("RUOC-TOM"), quantity: 1 }], delivery_note: "Giao giờ hành chính" })],
          reply((r) => `Tóm tắt đơn: tổng thu ${String(r.cod_total_text)}. Chị xác nhận chốt đơn không ạ?`),
        ],
      },
      { say: "ok chốt đơn", ai: [() => [tool("confirm_order", { customer_confirmation: "ok chốt đơn" })], reply((r) => `Đã chốt đơn ${String(r.order_code)}, tổng thu ${String(r.cod_total_text)}.`)] },
    ],
  },
  {
    key: "chot-khi-chua-dong-y",
    title: "Model tự chốt khi câu cuối của khách KHÔNG phải lời đồng ý ⇒ máy chủ từ chối, đơn vẫn nháp",
    shop: "food",
    channel: "WEB",
    turns: [
      {
        say: "lay 1 goi ruoc tom, Trần Văn Bình 0987654321, 5 Lê Lợi Huế",
        ai: [
          () => [tool("create_customer", { name: "Trần Văn Bình", phone: "0987654321", address: "5 Lê Lợi, Huế" })],
          ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("RUOC-TOM"), quantity: 1 }] })],
          reply((r) => `Đơn tạm tính ${String(r.cod_total_text)}, anh xác nhận giúp em nhé.`),
        ],
      },
      { say: "de toi hoi vo da", ai: [() => [tool("confirm_order", { customer_confirmation: "đồng ý" })], reply((r) => (r.error ? `Lỗi: ${String(r.error)}` : "Dạ."))] },
    ],
  },
  {
    key: "het-hang",
    title: "Khách đặt quá tồn ⇒ kiểm tồn trả thiếu hàng, bot không hứa",
    shop: "food",
    channel: "WEB",
    turns: [{ say: "muc kho cau con 5 goi ko", ai: [({ v }) => [tool("check_inventory", { items: [{ variant_id: v("MUC-KHO"), quantity: 5 }] })], reply(() => "Dạ mực khô câu bên em chỉ còn ít, em báo lại số chính xác cho anh nhé.")] }],
  },
  {
    key: "khach-si-chuyen-nguoi",
    title: "Khách hỏi giá sỉ số lượng lớn ⇒ chuyển người; lượt sau bot im, nhân viên tiếp nhận",
    shop: "food",
    channel: "WEB",
    turns: [
      { say: "quan an minh can lay si 50kg cha muc moi tuan, gia si sao", ai: [() => [tool("handoff_to_human", { reason: "Khách sỉ 50kg/tuần hỏi giá sỉ" })], reply(() => "Dạ em chuyển anh sang nhân viên phụ trách khách sỉ ạ.")] },
      { say: "alo shop oi", ai: [] },
    ],
  },
  {
    key: "khach-tu-choi",
    title: "Khách từ chối mua ⇒ ghi lý do, giai đoạn hội thoại đổi",
    shop: "food",
    channel: "WEB",
    turns: [{ say: "thoi dat qua minh ko mua dau", ai: [() => [tool("mark_declined", { reason: "Chê đắt" })], reply(() => "Dạ em cảm ơn chị đã quan tâm, khi cần chị nhắn em nhé.")] }],
  },
  {
    key: "mau-ma-khong-ton-tai",
    title: "Model truyền mã mẫu không có ⇒ công cụ báo lỗi, không ra giá bịa",
    shop: "food",
    channel: "WEB",
    turns: [{ say: "tinh tien 3 goi cha ca", ai: [() => [tool("calculate_cart", { items: [{ variant_id: "khong-co-ma-nay", quantity: 3 }] })], reply((r) => (r.error ? "Dạ em kiểm lại sản phẩm này rồi báo chị ngay ạ." : `Tổng ${String(r.subtotal_text)}`))] }],
  },
  {
    key: "ro-ri-chu-noi-bo",
    title: "Model lỡ nhắc tên trường nội bộ ⇒ bộ lọc chặn, khách không thấy",
    shop: "food",
    channel: "WEB",
    turns: [{ say: "chot luon cho chi", ai: [() => [say("Em cần customer_confirmation và variant_id để chốt ạ.")]] }],
  },
  {
    key: "khung-thu-khong-ghi",
    title: "Khung THỬ của chủ shop: đọc thật, ghi MÔ PHỎNG — không tạo khách, không tạo đơn",
    shop: "food",
    channel: "TEST",
    turns: [
      {
        say: "lay 1 cha muc, Lê Thị Hoa 0901112223, 3 Trần Phú Đà Nẵng",
        ai: [
          () => [tool("create_customer", { name: "Lê Thị Hoa", phone: "0901112223", address: "3 Trần Phú, Đà Nẵng" })],
          ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CHA-MUC"), quantity: 1 }] })],
          reply((r) => `Tóm tắt (thử): tổng thu ${String(r.cod_total_text)}. Chị xác nhận nhé?`),
        ],
      },
      { say: "ok chot", ai: [() => [tool("confirm_order", { customer_confirmation: "ok chot" })], reply((r) => `Đã chốt ${String(r.order_code ?? "")} (thử).`)] },
    ],
  },
  {
    key: "thoi-trang-goi-nganh",
    title: "Shop thời trang: lời nhắc dùng gói thời trang (không chữ hải sản), báo giá size",
    shop: "fashion",
    channel: "WEB",
    turns: [{ say: "dam linen size M gia bao nhieu a", ai: [() => [tool("search_products", { query: "đầm linen" })], reply((r) => `Dạ đầm suông linen size M ${priceOf(r)} ạ.`)] }],
  },
];
