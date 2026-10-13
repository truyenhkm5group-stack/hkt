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
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { addDays, todayVN } from "@/lib/format";
import { imageLine } from "@/lib/sales-chatbot/vision";
import { say, tool, type GoldenCase, type GoldenHookCtx, type Step } from "./harness";

/** Bước trả lời bằng chữ dựng từ kết quả công cụ (số luôn lấy từ máy chủ, không gõ tay trong kịch bản). */
const reply =
  (f: (r: Record<string, unknown>) => string): Step =>
  ({ results }) => [say(f(results[0] ?? {}))];

const priceOf = (r: Record<string, unknown>) => String(((r.results as { price_text?: string }[] | undefined) ?? [])[0]?.price_text ?? "?");

/**
 * KIẾN THỨC CỦA SHOP (sổ AIS-05) dùng cho hai hội thoại vàng bên dưới. Khuyến mãi ĐANG CHẠY không mang ngày (ảnh chụp không phụ
 * thuộc ngày chạy — AGENTS.md mục 50); hai khuyến mãi hết hạn / chưa tới ngày dựng TỪ ĐỒNG HỒ THẬT nên luôn ngoài lời nhắc.
 * Bảo hành CỐ Ý để trống: khách hỏi tới thì bot phải chuyển người, không tự đặt chính sách.
 */
export const GOLDEN_KNOWLEDGE = {
  faq: [{ q: "Shop có giao hoả tốc không?", a: "Nội thành Hà Nội giao trong 2 giờ qua ứng dụng giao hàng, phí theo ứng dụng." }],
  policies: {
    returns: "Đổi trong 3 ngày nếu hàng lỗi hoặc giao sai; khách quay video lúc mở hàng.",
    warranty: "",
    shipping: "Giao toàn quốc 2–4 ngày.",
    payment: "Thanh toán khi nhận hàng (COD) hoặc chuyển khoản.",
  },
  promotions: [
    { title: "Mua 2 tặng ruốc", content: "Mua từ 2 gói chả mực tặng 1 gói ruốc 100g.", from: null, to: null },
    { title: "Khuyến mãi đã hết", content: "Giảm 50% toàn shop.", from: addDays(todayVN(), -20), to: addDays(todayVN(), -10) },
    { title: "Khuyến mãi chưa tới", content: "Đồng giá 99K.", from: addDays(todayVN(), 10), to: null },
  ],
};

/**
 * KHÁCH CŨ CỦA CHÍNH HỘI THOẠI (Customer 360 — 11/10/2026, ca «Nga Ho Thien»): hội thoại mang mã page + mã hội thoại Pancake, và ERP
 * có MỘT đơn đồng bộ từ Pancake mang đúng mã hội thoại đó (đã gửi, có xã + tỉnh chuẩn hoá) — chưa có hồ sơ khách, chưa có SĐT trong
 * hội thoại. Dữ liệu GIẢ (kho PUBLIC). Mốc đơn = lúc gieo (đồng hồ thật — AGENTS.md mục 50: «gần nhất <ngày>» là ngày chạy).
 */
export const RETURNING_THREAD = { pageId: "pg-vang", threadId: "pg-vang_psid-vang", orderId: "vang-don-cu", phone: "0900000123", address: "Số 8 ngõ 2", ward: "Phường Cầu Giấy", province: "Thành phố Hà Nội" } as const;
export async function seedReturningThread({ conversationId }: Pick<GoldenHookCtx, "conversationId">, over: { orderId?: string; stage?: "SHIPPED" | "RETURNED"; address?: string; at?: Date; threadId?: string } = {}): Promise<void> {
  const db = await getDb();
  await db.update(schema.salesChatConversations).set({ pageId: RETURNING_THREAD.pageId, threadId: over.threadId ?? RETURNING_THREAD.threadId }).where(eq(schema.salesChatConversations.id, conversationId));
  await db.insert(schema.orders).values({
    id: over.orderId ?? RETURNING_THREAD.orderId,
    insertedAt: over.at ?? new Date(),
    stage: over.stage ?? "SHIPPED",
    pageId: RETURNING_THREAD.pageId,
    conversationId: over.threadId ?? RETURNING_THREAD.threadId,
    shipFullName: "Chị Vàng",
    shipPhone: RETURNING_THREAD.phone,
    shipAddress: over.address ?? RETURNING_THREAD.address,
    shipCommune: RETURNING_THREAD.ward,
    shipProvince: RETURNING_THREAD.province,
  });
}

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
    key: "hau-mai-da-nhan-hang",
    title: "Vòng đời tư vấn → chốt → hậu mãi (HOTFIX 12/10/2026, ca «Khanh Nhung»): khách nhắn sau khi chốt ⇒ AI VẪN trả lời (không chuyển người mặc định), «nhận hàng rồi» ⇒ cảm ơn + hỏi thăm, không chốt lại / không lên đơn mới; khiếu nại hoàn tiền ⇒ MÁY CHỦ chuyển người (không lượt AI)",
    shop: "food",
    channel: "WEB",
    turns: [
      {
        say: "lay 1 goi ruoc tom, Lê Thị Hoa 0977000111, 8 Trần Phú Đà Nẵng",
        ai: [
          () => [tool("create_customer", { name: "Lê Thị Hoa", phone: "0977000111", address: "8 Trần Phú, Đà Nẵng" })],
          ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("RUOC-TOM"), quantity: 1 }] })],
          reply((r) => `Đơn tạm tính ${String(r.cod_total_text)}, chị xác nhận giúp em nhé.`),
        ],
      },
      { say: "ok chốt đơn", ai: [() => [tool("confirm_order", { customer_confirmation: "ok chốt đơn" })], reply(() => "Dạ em lên đơn cho chị rồi ạ.")] },
      { say: "Tôi nhận hàng rồi nhưng chưa thử chất lượng", ai: [() => [say("Dạ em cảm ơn chị đã nhận hàng ạ. Chị dùng thử thấy thế nào nhắn em nhé!")]] },
      // Khiếu nại có đơn ⇒ MÁY CHỦ chuyển người trước lượt AI (review #821 F2) — model không được hỏi, không thể hứa hoàn tiền.
      { say: "goi ruoc bi moc roi, minh muon tra hang hoan tien", ai: [] },
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
    key: "fanpage-chuyen-nguoi-im-lang",
    title: "Fanpage: chuyển người thì bot IM — nhân viên trả lời trực tiếp trên page (chủ shop chốt 01/10/2026)",
    shop: "food",
    channel: "FANPAGE",
    turns: [{ say: "cho minh gap nhan vien", ai: [() => [tool("handoff_to_human", { reason: "Khách muốn gặp nhân viên" })]] }],
  },
  {
    key: "zalo-chuyen-nguoi-im-lang",
    title: "Zalo OA: chuyển người thì bot IM như fanpage — nhân viên trả lời trực tiếp trong OA",
    shop: "food",
    channel: "ZALO",
    turns: [{ say: "cho minh gap nhan vien", ai: [() => [tool("handoff_to_human", { reason: "Khách muốn gặp nhân viên" })]] }],
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
  // ═══ P0 10/10/2026 — AI KHÔNG ĐƯỢC KHẲNG ĐỊNH ĐIỀU CHƯA XÁC MINH (lib/sales-chatbot/claim-guard.ts) ═══
  {
    key: "anh-chuyen-khoan-chuyen-nguoi",
    title: "Khách gửi ảnh chuyển khoản ⇒ máy chủ chuyển người NGAY, không gọi model, không câu «đã nhận tiền»",
    shop: "food",
    channel: "WEB",
    turns: [{ say: imageLine(1, "Ảnh chụp màn hình chuyển khoản thành công số tiền 280,000 VND"), ai: [() => [say("Dạ em đã nhận được tiền rồi ạ, cảm ơn chị.")]] }],
  },
  {
    key: "fanpage-anh-chuyen-khoan-im-lang",
    title: "Fanpage: khách gửi ảnh chuyển khoản ⇒ chuyển người, bot IM (luật kênh), nhân viên đối soát",
    shop: "food",
    channel: "FANPAGE",
    turns: [{ say: imageLine(1, "Ảnh chụp chuyển khoản 280,000 VND, nội dung: thanh toan don"), ai: [() => [say("Dạ em đã nhận được tiền rồi ạ.")]] }],
  },
  {
    key: "ai-noi-da-nhan-tien-bi-chan",
    title: "Model tự nói «đã nhận được tiền» khi chưa có chứng từ thu ⇒ câu bị chặn, câu an toàn thay chỗ, chuyển người",
    shop: "food",
    channel: "WEB",
    turns: [{ say: "chi gui roi do em check giup chi nhe", ai: [() => [say("Dạ em đã nhận được tiền rồi ạ, chị còn cần em hỗ trợ thêm món gì cho lần tới không ạ?")]] }],
  },
  {
    key: "chua-co-don-khong-noi-chot",
    title: "Chưa có đơn ERP nào mà model nói «em chốt đơn … tổng …» ⇒ câu bị chặn, chuyển người",
    shop: "food",
    channel: "WEB",
    turns: [{ say: "2 hop cha muc, dua cho nha xe nhe em", ai: [() => [say("Dạ em chốt đơn 2 hộp chả mực, tổng 800.000 ₫ ạ.")]] }],
  },
  {
    key: "chot-cung-vong-voi-cong-cu",
    title: "«Em lên đơn rồi ạ» viết CÙNG vòng với confirm_order ⇒ giữ lại tới khi chốt thành công rồi mới gửi",
    shop: "food",
    channel: "WEB",
    turns: [
      {
        say: "lay 1 cha muc, Phạm Thị Thu 0900000111, 8 Lý Thường Kiệt Phường Cửa Nam Hà Nội",
        ai: [
          () => [tool("create_customer", { name: "Phạm Thị Thu", phone: "0900000111", address: "8 Lý Thường Kiệt, Phường Cửa Nam, Hà Nội" })],
          ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CHA-MUC"), quantity: 1 }] })],
          reply((r) => `Tóm tắt đơn: tổng thu ${String(r.cod_total_text)}. Mình lấy thêm gì không, không thì em giao luôn ạ?`),
        ],
      },
      { say: "ok giao di em", ai: [() => [say("Dạ em lên đơn cho mình rồi ạ."), tool("confirm_order", { customer_confirmation: "ok giao di em" })], () => [say("Shop giao sớm cho mình nha.")]] },
    ],
  },
  {
    key: "chot-cung-vong-cong-cu-tu-choi",
    title: "«Em chốt đơn rồi ạ» cùng vòng với confirm_order mà máy chủ TỪ CHỐI chốt ⇒ câu không gửi, chuyển người",
    shop: "food",
    channel: "WEB",
    turns: [
      {
        say: "lay 1 ruoc tom, Đỗ Văn Hải 0900000222, 3 Nguyễn Huệ Huế",
        ai: [
          () => [tool("create_customer", { name: "Đỗ Văn Hải", phone: "0900000222", address: "3 Nguyễn Huệ, Huế" })],
          ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("RUOC-TOM"), quantity: 1 }] })],
          reply((r) => `Đơn tạm tính ${String(r.cod_total_text)}, anh xác nhận giúp em nhé.`),
        ],
      },
      { say: "de toi hoi vo da", ai: [() => [say("Dạ em chốt đơn cho anh rồi ạ."), tool("confirm_order", { customer_confirmation: "đồng ý" })]] },
    ],
  },
  {
    key: "kien-thuc-chinh-sach-khuyen-mai",
    title: "Kiến thức của shop: hỏi đổi trả ⇒ trả lời theo chính sách shop khai; hỏi khuyến mãi ⇒ mô tả khuyến mãi đang chạy, số tiền vẫn từ calculate_cart",
    shop: "food",
    channel: "WEB",
    config: GOLDEN_KNOWLEDGE,
    turns: [
      { say: "shop co cho doi tra ko", ai: [() => [say("Dạ shop đổi trong 3 ngày nếu hàng lỗi hoặc giao sai, mình quay video lúc mở hàng giúp em ạ.")]] },
      {
        say: "dang co khuyen mai gi ko, lay 2 goi cha muc het bao nhieu",
        ai: [({ v }) => [tool("calculate_cart", { items: [{ variant_id: v("CHA-MUC"), quantity: 2 }] })], reply((r) => `Dạ shop đang có «Mua 2 tặng ruốc»: mua từ 2 gói chả mực tặng 1 gói ruốc 100g. 2 gói chả mực ${String(r.subtotal_text)} ạ.`)],
      },
    ],
  },
  {
    key: "kien-thuc-chua-khai-chuyen-nguoi",
    title: "Kiến thức của shop: hỏi chính sách shop CHƯA khai (bảo hành) ⇒ không tự đặt, chuyển người «Ngoài chính sách»",
    shop: "food",
    channel: "WEB",
    config: GOLDEN_KNOWLEDGE,
    turns: [{ say: "bao hanh the nao shop", ai: [() => [tool("handoff_to_human", { reason: "Ngoài chính sách — bảo hành" })], reply(() => "Dạ phần bảo hành em chưa có thông tin, em chuyển nhân viên báo mình ngay ạ.")] }],
  },
  {
    key: "khach-cu-van-dia-chi-cu",
    title: "Khách cũ «vẫn địa chỉ cũ» ⇒ máy chủ tra đơn cũ của CHÍNH hội thoại (mã hội thoại Pancake), lời nhắc đề xuất xác nhận thay vì xin lại; khách đồng ý ⇒ máy chủ tự điền địa chỉ",
    shop: "food",
    channel: "WEB",
    turns: [
      {
        before: (ctx) => seedReturningThread(ctx),
        say: "Cho chi 1 goi cha muc\nVẫn địa chỉ cũ nhé",
        ai: [() => [say("Dạ em gửi 1 gói chả mực về Số 8 ngõ 2, Phường Cầu Giấy, Thành phố Hà Nội, SĐT đuôi 0123 như đơn trước được không ạ?")]],
      },
      {
        say: "đúng rồi em",
        ai: [
          () => [tool("create_customer", { use_saved_address: true, customer_confirmation: "đúng rồi em" })],
          ({ v }) => [tool("create_draft_order", { items: [{ variant_id: v("CHA-MUC"), quantity: 1 }] })],
          reply((r) => `Tóm tắt đơn: tổng thu ${String(r.cod_total_text)}. Chị xác nhận chốt đơn không ạ?`),
        ],
      },
    ],
  },
];
