/**
 * ═══════════ GOLDEN CONVERSATION DATASET v2 — HỘI THOẠI ĐẶT HÀNG CÓ NHÃN ĐÚNG (sứ mệnh saas-order-accuracy · lát C1) ═══════════
 *
 * Mỗi ca = một hội thoại TỔNG HỢP tiếng Việt (mô phỏng cách khách HSLC nhắn: không dấu, viết tắt, gộp nhiều ý, nhắn rời) + kịch bản
 * model TẤT ĐỊNH (khung của hội thoại vàng — `tests/sales-agent-golden/harness.ts`) + NHÃN ĐÚNG do người viết dataset gán: có ý
 * định mua không, phải có bao nhiêu đơn, SKU / biến thể / SL + đơn vị / đơn giá, SĐT, tỉnh / huyện / xã / dòng địa chỉ, tổng tiền,
 * và đơn ĐƯỢC tự chốt hay phải NEED_VERIFICATION — kèm CĂN CỨ (`ORDER_CONFIRM_BASIS_LABEL`).
 *
 * KHÔNG PII THẬT (kho PUBLIC): SĐT đều dạng 09xx000xxx (bài kiểm quét mã nguồn tệp này), số nhà / đường hư cấu («ngõ Thử Nghiệm»,
 * «đường Giả Định»…); chỉ tên xã / tỉnh là thật — đó là danh mục hành chính công khai, cần để bộ chuẩn hoá địa chỉ ghép được.
 *
 * MODEL KỊCH BẢN: `GOOD` = làm đúng việc một model tốt sẽ làm (thứ được đo là phần MÁY CHỦ: giá, gộp dòng, sửa đơn, chuẩn hoá địa
 * chỉ, chặn chốt, khoá lần mua); `TRAP` = model mắc một lỗi CÓ THẬT (ghi ở `trap`) để đo hàng rào của máy chủ. Nhãn LUÔN là đáp án
 * đúng của hội thoại, không phải điều máy đang làm — số đo hiện trạng nằm ở `BASELINE.md`.
 *
 * Nhãn phụ thuộc LUẬT của chủ shop khai `dependsOn` (luật / quyết định nào): `RULE_6` (luật 6 của lời nhắc bot), `ADDRESS_UNRESOLVED`,
 * `RULE_AUTO_CONFIRM` (luật 04/10/2026 — nhãn dưới công tắc BẬT, `confirmWhenAutoConfirmOn`), và các nhãn an toàn còn chờ quyết
 * định. Chủ shop đổi luật ⇒ đổi nhãn của các ca đó, có chủ đích, cùng BASELINE.
 *
 * QUYẾT ĐỊNH 08/10/2026 của chủ shop (nhãn đã đổi theo): (1) luật 04/10 CÓ áp cho nháp của bot; (2) khách huỷ sau khi đã có đơn ⇒
 * KHÔNG tự huỷ, đơn còn và mang cờ CẦN NGƯỜI KIỂM «khách huỷ» (`review`); (3) địa chỉ chưa ghép được xã ⇒ VẪN chốt, kèm cờ
 * CẦN NGƯỜI KIỂM «địa chỉ chưa ghép». Cờ chấm ở `review_flag_accuracy`.
 */
import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { setConversationControlCore } from "@/lib/sales-chatbot/conversation-control";
import type { GoldenAddress, GoldenOrder, GoldenOrderLine, OrderConfirmBasis, OrderConfirmLabel, OrderGoldenLabel } from "@/lib/sales-chatbot/order-golden-metrics";
import { say, tool, type GoldenHookCtx, type GoldenTurn, type Step } from "../sales-agent-golden/harness";

// ─────────────────────────── KỊCH BẢN §23 ───────────────────────────

export const ORDER_SCENARIOS = {
  MOT_SKU: "Một SKU",
  NHIEU_SKU: "Nhiều SKU",
  DOI_SO_LUONG: "Đổi số lượng («không phải 2kg, lấy 1kg»)",
  DOI_DIA_CHI: "Đổi địa chỉ",
  SUA_SDT: "Sửa SĐT",
  TEN_GOI_TAT: "Tên gọi tắt sản phẩm",
  GO_SAI: "Gõ sai / tiếng lóng",
  NHIEU_TIN_ROI: "Nhiều tin rời",
  HOI_GIA_ROI_MUA: "Hỏi giá rồi mua",
  TU_CHOI_ROI_QUAY_LAI: "Từ chối rồi quay lại",
  UPSELL: "Upsell",
  NHAC_DON_CU: "Nhắc đơn cũ",
  WEBHOOK_TRUNG: "Webhook trùng / khách gửi lặp",
  TIEP_QUAN_NGUOI: "Tiếp quản người",
  AI_TIEP_TUC: "AI tiếp tục",
  THIEU_THONG_TIN: "Đơn thiếu thông tin",
  SDT_NGUOI_KHAC: "SĐT của người khác",
  DONG_Y_MO_HO: "Khách đồng ý mơ hồ («ok», «ừ»)",
  CHUA_DONG_Y_DU_THONG_TIN: "Khách chưa đồng ý mà có đủ SĐT + địa chỉ",
  BIEN_THE: "Chọn đúng biến thể",
  QUY_DOI_DON_VI: "Quy đổi đơn vị",
  KHONG_MUA: "Không mua",
  DIA_CHI_CHUA_GHEP_XA: "Địa chỉ chưa ghép được xã",
  MAT_TRANG_THAI: "Mất trạng thái giữa chừng ⇒ khách gửi lại",
  HUY_SAU_NHAP: "Khách huỷ sau khi đã lên đơn nháp",
} as const;
export type OrderScenario = keyof typeof ORDER_SCENARIOS;

/** Mười chín kịch bản bắt buộc của MASTER MISSION §23 — mỗi kịch bản phải có ít nhất một ca. */
export const SECTION_23_SCENARIOS: readonly OrderScenario[] = [
  "MOT_SKU",
  "NHIEU_SKU",
  "DOI_SO_LUONG",
  "DOI_DIA_CHI",
  "SUA_SDT",
  "TEN_GOI_TAT",
  "GO_SAI",
  "NHIEU_TIN_ROI",
  "HOI_GIA_ROI_MUA",
  "TU_CHOI_ROI_QUAY_LAI",
  "UPSELL",
  "NHAC_DON_CU",
  "WEBHOOK_TRUNG",
  "TIEP_QUAN_NGUOI",
  "AI_TIEP_TUC",
  "THIEU_THONG_TIN",
  "SDT_NGUOI_KHAC",
  "DONG_Y_MO_HO",
  "CHUA_DONG_Y_DU_THONG_TIN",
];

export type OrderGoldenCase = {
  /** Khoá ỔN ĐỊNH — BASELINE.md và baseline.json tham chiếu theo khoá này. */
  key: string;
  title: string;
  scenario: OrderScenario;
  channel: "WEB" | "FANPAGE";
  model: "GOOD" | "TRAP";
  /** Lỗi model mô phỏng (chỉ ca TRAP). */
  trap?: string;
  /** Công cụ máy chủ PHẢI từ chối trong kịch bản (theo thứ tự) — lệch ⇒ kịch bản không còn đi đúng đường đã định. */
  expectToolErrors?: string[];
  /** Gieo dữ liệu trước hội thoại (trong tổ chức thử). */
  seed?: (ctx: Omit<GoldenHookCtx, "conversationId">) => Promise<void>;
  turns: GoldenTurn[];
  label: OrderGoldenLabel;
  /**
   * Nhãn chốt dưới biến thể công tắc BẬT, khi khác `label.confirm`. Công tắc BẬT = luật chủ shop đã chốt 04/10/2026 («đơn đủ SĐT,
   * địa chỉ, SKU là đơn hàng luôn, trừ đơn huỷ» — `lib/constants/manual-orders.ts`), nên dưới BẬT đơn đủ thông tin mà khách không
   * huỷ là ĐÚNG luật; câu hỏi cho chủ shop chỉ là có áp luật ấy cho nháp của BOT không.
   */
  confirmWhenAutoConfirmOn?: OrderConfirmLabel;
};

// ─────────────────────────── DANH MỤC (đối chiếu với shop thử trong bài kiểm) ───────────────────────────

export type Sku = "CHA-MUC" | "CHA-CA-500" | "CHA-CA-1KG" | "RUOC-TOM";
/** Đơn giá ERP của shop thử `order-food` — bài kiểm so bảng này với `GOLDEN_SHOPS["order-food"]` để nhãn không lệch shop. */
export const LABEL_PRICES: Record<Sku, number> = { "CHA-MUC": 400_000, "CHA-CA-500": 180_000, "CHA-CA-1KG": 340_000, "RUOC-TOM": 350_000 };
export const LABEL_SHIPPING_FEE = 30_000;
const VARIANT: Record<Sku, string> = { "CHA-MUC": "1kg", "CHA-CA-500": "500g", "CHA-CA-1KG": "1kg", "RUOC-TOM": "hũ 250g" };
const UNIT: Record<Sku, string> = { "CHA-MUC": "gói 1kg", "CHA-CA-500": "hộp 500g", "CHA-CA-1KG": "hộp 1kg", "RUOC-TOM": "hũ 250g" };

const ln = (sku: Sku, quantity: number, unit = UNIT[sku]): GoldenOrderLine => ({ sku, variant: VARIANT[sku], quantity, unit, unitPrice: LABEL_PRICES[sku] });
const addr = (province: string, ward: string | null, line: string): GoldenAddress => ({ province, district: null, ward, line });
const order = (lines: GoldenOrderLine[], phone: string, address: GoldenAddress, total: number): GoldenOrder => ({ lines, phone, address, shippingFee: LABEL_SHIPPING_FEE, total });

const agreed = (why: string, basis: Extract<OrderConfirmBasis, "CUSTOMER_AGREED" | "RULE_6"> = "CUSTOMER_AGREED", dependsOn?: string): OrderConfirmLabel => ({ verdict: "AUTO_CONFIRM_OK", basis, why, ...(dependsOn ? { dependsOn } : {}) });
const verify = (basis: Exclude<OrderConfirmBasis, "CUSTOMER_AGREED" | "RULE_6" | "RULE_AUTO_CONFIRM">, why: string, dependsOn?: string): OrderConfirmLabel => ({ verdict: "NEED_VERIFICATION", basis, why, ...(dependsOn ? { dependsOn } : {}) });
const DECISION_0810 = "Quyết định chủ shop 08/10/2026 (lib/constants/order-review.ts)";
/** Dưới công tắc BẬT: đơn đủ SĐT + địa chỉ ghép được xã + SKU mà khách không huỷ = đơn đúng luật 04/10/2026. */
const autoOn = (why: string): OrderConfirmLabel => ({ verdict: "AUTO_CONFIRM_OK", basis: "RULE_AUTO_CONFIRM", why, dependsOn: "Luật 04/10/2026 (lib/constants/manual-orders.ts) — câu hỏi: có áp cho đơn nháp của BOT không" });
const RULE_6_DEP = "Luật 6 của lời nhắc bot (lib/sales-chatbot/engine.ts, dòng luật 6)";
const withOrder = (o: GoldenOrder, confirm: OrderGoldenLabel["confirm"]): OrderGoldenLabel => ({ intent: true, expectedOrders: 1, order: o, confirm });
const noOrder = (intent: boolean, why: string, dependsOn?: string): OrderGoldenLabel => ({ intent, expectedOrders: 0, order: null, confirm: verify("NO_ORDER", why, dependsOn) });

// ─────────────────────────── BƯỚC KỊCH BẢN ───────────────────────────

type R = Record<string, unknown>;
const str = (x: unknown) => (typeof x === "string" ? x : "");
type Who = { name: string; phone: string; address: string };
type Item = readonly [Sku, number];

/** Kết quả mang tóm tắt đơn (đơn nháp / sửa đơn) trong vòng trước — số luôn từ máy chủ, không gõ tay trong kịch bản. */
const draftOf = (results: R[]): R => [...results].reverse().find((r) => typeof r.cod_total_text === "string") ?? {};

/** B5: đọc tóm tắt đơn rồi hỏi đúng câu kết của lời nhắc («Mình lấy thêm gì không, không thì em giao luôn ạ?»). */
const summary: Step = ({ results }) => {
  const d = draftOf(results);
  const lines = ((d.lines as { text?: unknown }[] | undefined) ?? []).map((l) => str(l.text)).filter(Boolean).join("; ");
  return [say(`Dạ đơn của mình: ${lines}. Ship ${str(d.shipping_text)}. Tổng thu ${str(d.cod_total_text)}. Mình lấy thêm gì không, không thì em giao luôn ạ?`)];
};

/** Sau `confirm_order`: chốt được ⇒ một tin ngắn; máy chủ từ chối ⇒ hỏi lại khách. */
const afterConfirm: Step = ({ results }) => [say(results.some((r) => r.error) ? "Dạ mình xác nhận giúp em là chốt đơn này để em giao nhé?" : "Dạ em lên đơn cho mình rồi ạ, shop giao sớm cho mình nha.")];

const reply = (text: string): Step => () => [say(text)];

const items = (v: (sku: string) => string, list: readonly Item[]) => list.map(([sku, quantity]) => ({ variant_id: v(sku), quantity }));

/** Khách gửi đủ món + thông tin ⇒ model lưu khách và lên đơn nháp trong CÙNG một vòng, rồi đọc tóm tắt. */
function infoTurn(text: string, who: Who, list: readonly Item[], draft: Record<string, string> = {}): GoldenTurn {
  return { say: text, ai: [({ v }) => [tool("create_customer", who), tool("create_draft_order", { items: items(v, list), ...draft })], summary] };
}

/** Khách đồng ý ⇒ model chốt với lời khách NGUYÊN VĂN (`quote` = đoạn model trích). */
function consentTurn(text: string, quote: string = text): GoldenTurn {
  return { say: text, ai: [() => [tool("confirm_order", { customer_confirmation: quote })], afterConfirm] };
}

/** Lượt máy chủ không gọi model (đã chuyển người / vừa chốt xong) — kịch bản rỗng; engine gọi model là lệch. */
const silentTurn = (text: string, before?: GoldenTurn["before"]): GoldenTurn => ({ say: text, ai: [], ...(before ? { before } : {}) });

/** Mã mẫu mã đầu tiên trong kết quả `search_products` thoả điều kiện — model chọn từ danh mục, không đoán mã. */
function pick(r: R | undefined, ok: (item: { name: string; variant: string }) => boolean): string {
  const list = ((r?.results as { variant_id?: unknown; name?: unknown; variant?: unknown }[] | undefined) ?? []).map((x) => ({ id: str(x.variant_id), name: str(x.name), variant: str(x.variant) }));
  return list.find((x) => ok(x))?.id ?? "";
}

/** Giá đầu tiên trong kết quả tìm — để câu báo giá đọc số từ ERP. */
const priceText = (r: R | undefined) => str(((r?.results as { price_text?: unknown }[] | undefined) ?? [])[0]?.price_text);

// Thao tác của NGƯỜI giữa hai lượt — đúng lõi mà nút «Tiếp quản» / «Trả lại AI» của hộp thư gọi.
async function takeover(ctx: GoldenHookCtx): Promise<void> {
  const r = await setConversationControlCore(await ctx.admin(), ctx.conversationId, "HUMAN", "Nhân viên tiếp quản (bộ đo đơn vàng)");
  if (!r.ok) throw new Error(`không tiếp quản được: ${r.error}`);
}
async function resumeAi(ctx: GoldenHookCtx): Promise<void> {
  const r = await setConversationControlCore(await ctx.admin(), ctx.conversationId, "AUTO");
  if (!r.ok) throw new Error(`không trả lại AI được: ${r.error}`);
}
/** Mô phỏng lượt ghi trạng thái bị MẤT sau khi đơn nháp đã vào CSDL (tiến trình chết giữa `create_draft_order` và lượt lưu state). */
async function loseDraftState(ctx: GoldenHookCtx): Promise<void> {
  const c = schema.salesChatConversations;
  await (await getDb()).update(c).set({ state: sql`${c.state} - 'draft'` }).where(eq(c.id, ctx.conversationId));
}

// ─────────────────────────── DATASET ───────────────────────────

const HN_HOAN_KIEM = "Số 7 ngõ Thử Nghiệm, Phường Hoàn Kiếm, Hà Nội";
const HCM_BEN_THANH = "12 đường Giả Định, Phường Bến Thành, TP HCM";
const HN_BA_DINH = "3 ngõ Kiểm Thử, Phường Ba Đình, Hà Nội";
const HUE_THUAN_HOA = "45 Kiệt Mẫu, Phường Thuận Hóa, Huế";
const DN_HAI_CHAU = "88 đường Ví Dụ, Phường Hải Châu, Đà Nẵng";
const HP_NGO_QUYEN = "9 đường Thí Điểm, Phường Ngô Quyền, Hải Phòng";
const HN_CAU_GIAY = "Lô 3 khu Thử, Phường Cầu Giấy, Hà Nội";
const HN_DONG_DA = "10 đường Mẫu, Phường Đống Đa, Hà Nội";
const HCM_SAI_GON = "20 hẻm Thử, Phường Sài Gòn, Hồ Chí Minh";
const HCM_TAN_DINH = "17 đường Mô Phỏng, Phường Tân Định, TP Hồ Chí Minh";
const HN_BAT_TRANG = "5 thôn Mẫu, Xã Bát Tràng, Hà Nội";

export const ORDER_GOLDEN_CASES: readonly OrderGoldenCase[] = [
  {
    key: "mot-sku",
    title: "Một món, đủ thông tin trong một tin, khách đồng ý sau tóm tắt",
    scenario: "MOT_SKU",
    channel: "WEB",
    model: "GOOD",
    turns: [
      infoTurn(`Cho chị 1kg chả mực giã tay. Chị tên Lan, sđt 0912000101, giao về ${HN_HOAN_KIEM} nhé`, { name: "Lan", phone: "0912000101", address: HN_HOAN_KIEM }, [["CHA-MUC", 1]]),
      consentTurn("ok em, giao luôn nhé"),
    ],
    label: withOrder(order([ln("CHA-MUC", 1)], "0912000101", addr("Hà Nội", "Hoàn Kiếm", "Số 7 ngõ Thử Nghiệm"), 430_000), agreed("Khách đáp «ok em, giao luôn nhé» sau khi thấy tóm tắt")),
  },
  {
    key: "nhieu-sku",
    title: "Ba món trong một tin (hai sản phẩm, một biến thể nhỏ)",
    scenario: "NHIEU_SKU",
    channel: "FANPAGE",
    model: "GOOD",
    turns: [
      infoTurn(`Shop ơi lấy cho chị 2 chả mực, 1 hũ ruốc tôm với 1 hộp chả cá thu loại 500g. Tên Hoa, 0913000202, ${HCM_BEN_THANH}`, { name: "Hoa", phone: "0913000202", address: HCM_BEN_THANH }, [["CHA-MUC", 2], ["RUOC-TOM", 1], ["CHA-CA-500", 1]]),
      consentTurn("chốt đơn em"),
    ],
    label: withOrder(order([ln("CHA-MUC", 2), ln("RUOC-TOM", 1), ln("CHA-CA-500", 1)], "0913000202", addr("Hồ Chí Minh", "Bến Thành", "12 đường Giả Định"), 1_360_000), agreed("Khách nhắn «chốt đơn em» sau tóm tắt")),
  },
  {
    key: "doi-so-luong",
    title: "«Không phải 2kg, lấy 1kg» sau khi đã thấy tóm tắt ⇒ sửa đơn rồi chốt trong cùng lượt (luật 6)",
    scenario: "DOI_SO_LUONG",
    channel: "WEB",
    model: "GOOD",
    turns: [
      infoTurn(`Lấy chị 2kg chả mực, tên Mai, sđt 0914000303, giao ${HN_BA_DINH}`, { name: "Mai", phone: "0914000303", address: HN_BA_DINH }, [["CHA-MUC", 2]]),
      {
        say: "à không phải 2kg đâu, lấy 1kg thôi em",
        ai: [({ v }) => [tool("update_draft_order", { items: items(v, [["CHA-MUC", 1]]) }), tool("confirm_order", { customer_confirmation: "lấy 1kg thôi em" })], afterConfirm],
      },
    ],
    label: withOrder(order([ln("CHA-MUC", 1)], "0914000303", addr("Hà Nội", "Ba Đình", "3 ngõ Kiểm Thử"), 430_000), agreed("Khách đã thấy tóm tắt rồi tự sửa số lượng ⇒ luật 6: sửa và chốt luôn", "RULE_6", RULE_6_DEP)),
  },
  {
    key: "doi-dia-chi",
    title: "Đổi địa chỉ giao sau tóm tắt ⇒ sửa đơn nháp, đọc lại, khách đồng ý",
    scenario: "DOI_DIA_CHI",
    channel: "FANPAGE",
    model: "GOOD",
    turns: [
      infoTurn(`cho chị 1 hộp chả cá thu 1kg, Thu, 0915000404, ${HN_CAU_GIAY}`, { name: "Thu", phone: "0915000404", address: HN_CAU_GIAY }, [["CHA-CA-1KG", 1]]),
      { say: `à em ơi đổi địa chỉ giao về cơ quan chị: ${HN_DONG_DA} nhé`, ai: [() => [tool("update_draft_order", { address: HN_DONG_DA })], summary] },
      consentTurn("đúng rồi em"),
    ],
    label: withOrder(order([ln("CHA-CA-1KG", 1)], "0915000404", addr("Hà Nội", "Đống Đa", "10 đường Mẫu"), 370_000), agreed("Khách xác nhận «đúng rồi em» sau tóm tắt có địa chỉ mới")),
  },
  {
    key: "sua-sdt",
    title: "Khách sửa SĐT sau tóm tắt ⇒ model sửa SĐT người nhận của đơn nháp",
    scenario: "SUA_SDT",
    channel: "WEB",
    model: "GOOD",
    turns: [
      infoTurn(`lấy 1 hũ ruốc, tên Ngọc, sđt 0916000505, ${HUE_THUAN_HOA}`, { name: "Ngọc", phone: "0916000505", address: HUE_THUAN_HOA }, [["RUOC-TOM", 1]]),
      { say: "chết chị nhầm số, số đúng là 0916000550 em nhé", ai: [() => [tool("update_draft_order", { recipient_phone: "0916000550" })], summary] },
      consentTurn("ok em, giao đi"),
    ],
    label: withOrder(order([ln("RUOC-TOM", 1)], "0916000550", addr("Huế", "Thuận Hóa", "45 Kiệt Mẫu"), 380_000), agreed("Khách đồng ý sau tóm tắt có SĐT đã sửa")),
  },
  {
    key: "sua-sdt-tao-lai-khach",
    title: "Khách sửa SĐT, model gọi lại create_customer với số mới rồi sửa đơn không kèm SĐT người nhận",
    scenario: "SUA_SDT",
    channel: "WEB",
    model: "TRAP",
    trap: "Model sửa SĐT bằng create_customer (số mới) thay vì update_draft_order(recipient_phone) — người nhận của đơn nháp vẫn giữ số cũ",
    turns: [
      infoTurn(`lấy 2 hộp chả cá 500g, tên Yến, sđt 0917000606, ${DN_HAI_CHAU}`, { name: "Yến", phone: "0917000606", address: DN_HAI_CHAU }, [["CHA-CA-500", 2]]),
      {
        say: "à số đúng của chị là 0917000660 nhé, số kia cũ rồi",
        ai: [({ v }) => [tool("create_customer", { name: "Yến", phone: "0917000660", address: DN_HAI_CHAU }), tool("update_draft_order", { items: items(v, [["CHA-CA-500", 2]]) })], summary],
      },
      consentTurn("ok giao đi em"),
    ],
    label: withOrder(order([ln("CHA-CA-500", 2)], "0917000660", addr("Đà Nẵng", "Hải Châu", "88 đường Ví Dụ"), 390_000), agreed("Khách đồng ý «ok giao đi em» sau tóm tắt — SĐT đúng là số khách sửa")),
  },
  {
    key: "ten-goi-tat",
    title: "Tên gọi tắt («ruốc», «chả mực giã») ⇒ model tìm danh mục rồi chọn mã từ kết quả",
    scenario: "TEN_GOI_TAT",
    channel: "FANPAGE",
    model: "GOOD",
    turns: [
      {
        say: `cho e 2 hũ ruốc vs 1 kí chả mực giã nha, Trang 0918000707, ${HCM_SAI_GON}`,
        ai: [
          () => [tool("search_products", { query: "ruốc" }), tool("search_products", { query: "chả mực giã" })],
          ({ results }) => [
            tool("create_customer", { name: "Trang", phone: "0918000707", address: HCM_SAI_GON }),
            tool("create_draft_order", { items: [{ variant_id: pick(results[0], (x) => /ruốc/i.test(x.name)), quantity: 2 }, { variant_id: pick(results[1], (x) => /chả mực/i.test(x.name)), quantity: 1 }] }),
          ],
          summary,
        ],
      },
      consentTurn("ok chốt em"),
    ],
    label: withOrder(order([ln("RUOC-TOM", 2), ln("CHA-MUC", 1, "gói 1kg — khách nói «1 kí»")], "0918000707", addr("Hồ Chí Minh", "Sài Gòn", "20 hẻm Thử"), 1_130_000), agreed("Khách «ok chốt em» sau tóm tắt")),
  },
  {
    key: "go-sai-tieng-long",
    title: "Không dấu, viết tắt, SĐT có dấu chấm, địa chỉ viết tắt «p … hn»",
    scenario: "GO_SAI",
    channel: "FANPAGE",
    model: "GOOD",
    turns: [
      infoTurn("cho e 2 ky cha muc, sdt 0919.000.808, dc so 9 pho gia lap p hai ba trung hn, ten Hanh", { name: "Hạnh", phone: "0919.000.808", address: "so 9 pho gia lap p hai ba trung hn" }, [["CHA-MUC", 2]]),
      consentTurn("ok e oi chot di", "chot di"),
    ],
    label: withOrder(order([ln("CHA-MUC", 2, "gói 1kg — khách nói «2 ky»")], "0919000808", addr("Hà Nội", "Hai Bà Trưng", "so 9 pho gia lap"), 830_000), agreed("Khách «ok e oi chot di» sau tóm tắt")),
  },
  {
    key: "nhieu-tin-roi",
    title: "Món, SĐT, địa chỉ tới trong các tin rời ⇒ model gom đủ rồi mới lên đơn",
    scenario: "NHIEU_TIN_ROI",
    channel: "WEB",
    model: "GOOD",
    turns: [
      { say: "chả cá thu còn ko shop", ai: [() => [tool("search_products", { query: "chả cá thu" })], ({ results }) => [say(`Dạ chả cá thu có hộp 500g và hộp 1kg, từ ${priceText(results[0])}. Chị lấy loại nào ạ?`)]] },
      { say: "lấy 1 hộp 1kg", ai: [reply("Dạ chị cho em xin SĐT và địa chỉ nhận hàng ạ.")] },
      { say: "0920000909", ai: [reply("Dạ chị cho em xin địa chỉ giao hàng ạ.")] },
      infoTurn(`${HN_BAT_TRANG}. Tên Oanh nhé`, { name: "Oanh", phone: "0920000909", address: HN_BAT_TRANG }, [["CHA-CA-1KG", 1]]),
      consentTurn("ok giao đi em"),
    ],
    label: withOrder(order([ln("CHA-CA-1KG", 1)], "0920000909", addr("Hà Nội", "Bát Tràng", "5 thôn Mẫu"), 370_000), agreed("Khách «ok giao đi em» sau tóm tắt")),
  },
  {
    key: "hoi-gia-roi-mua",
    title: "Hỏi giá trước, tin sau mới đặt",
    scenario: "HOI_GIA_ROI_MUA",
    channel: "FANPAGE",
    model: "GOOD",
    turns: [
      { say: "ruốc tôm bao nhiêu 1 hũ shop", ai: [() => [tool("search_products", { query: "ruốc tôm" })], ({ results }) => [say(`Dạ ruốc bông tôm hũ 250g giá ${priceText(results[0])} ạ.`)]] },
      infoTurn(`vậy lấy chị 1 hũ, Phượng, 0921000111, ${HP_NGO_QUYEN}`, { name: "Phượng", phone: "0921000111", address: HP_NGO_QUYEN }, [["RUOC-TOM", 1]]),
      consentTurn("ừ được em, giao luôn đi", "giao luôn đi"),
    ],
    label: withOrder(order([ln("RUOC-TOM", 1)], "0921000111", addr("Hải Phòng", "Ngô Quyền", "9 đường Thí Điểm"), 380_000), agreed("Khách «ừ được em, giao luôn đi» sau tóm tắt")),
  },
  {
    key: "tu-choi-roi-quay-lai",
    title: "Chê đắt, từ chối, rồi quay lại đặt",
    scenario: "TU_CHOI_ROI_QUAY_LAI",
    channel: "WEB",
    model: "GOOD",
    turns: [
      { say: "chả mực 400k đắt thế, thôi chị không lấy đâu", ai: [() => [tool("mark_declined", { reason: "Chê đắt" })], reply("Dạ em cảm ơn chị, khi cần chị nhắn em nhé.")] },
      infoTurn(`thôi nghĩ lại lấy 1kg chả mực đi em. Chị Diệp 0922000212, ${HCM_TAN_DINH}`, { name: "Diệp", phone: "0922000212", address: HCM_TAN_DINH }, [["CHA-MUC", 1]]),
      consentTurn("chốt nhé em"),
    ],
    label: withOrder(order([ln("CHA-MUC", 1)], "0922000212", addr("Hồ Chí Minh", "Tân Định", "17 đường Mô Phỏng"), 430_000), agreed("Khách quay lại đặt và «chốt nhé em» sau tóm tắt")),
  },
  {
    key: "upsell",
    title: "Mời thêm món trong tóm tắt, khách lấy thêm ⇒ sửa đơn rồi chốt trong cùng lượt (luật 6)",
    scenario: "UPSELL",
    channel: "FANPAGE",
    model: "GOOD",
    turns: [
      {
        say: `lấy chị 1kg chả mực. Linh 0923000313, ${HN_BA_DINH}`,
        ai: [
          ({ v }) => [tool("create_customer", { name: "Linh", phone: "0923000313", address: HN_BA_DINH }), tool("create_draft_order", { items: items(v, [["CHA-MUC", 1]]) })],
          ({ results }) => [say(`Dạ đơn của mình tổng thu ${str(draftOf(results).cod_total_text)}. Chị lấy thêm 1 hũ ruốc bông tôm ăn kèm không ạ, không thì em giao luôn ạ?`)],
        ],
      },
      {
        say: "ok lấy thêm 1 hũ ruốc nữa em",
        ai: [({ v }) => [tool("update_draft_order", { items: items(v, [["CHA-MUC", 1], ["RUOC-TOM", 1]]) }), tool("confirm_order", { customer_confirmation: "ok lấy thêm 1 hũ ruốc nữa em" })], afterConfirm],
      },
    ],
    label: withOrder(order([ln("CHA-MUC", 1), ln("RUOC-TOM", 1)], "0923000313", addr("Hà Nội", "Ba Đình", "3 ngõ Kiểm Thử"), 780_000), agreed("Khách đã thấy tóm tắt rồi nhận món mời thêm ⇒ luật 6: sửa và chốt luôn", "RULE_6", RULE_6_DEP)),
  },
  {
    key: "nhac-don-cu",
    title: "Chốt xong, khách nhắn «gửi thêm chung đơn vừa rồi» ⇒ chuyển nhân viên, không đẻ đơn mới",
    scenario: "NHAC_DON_CU",
    channel: "FANPAGE",
    model: "GOOD",
    turns: [
      infoTurn(`lấy chị 1 hộp chả cá 500g, Nhung 0924000414, ${DN_HAI_CHAU}`, { name: "Nhung", phone: "0924000414", address: DN_HAI_CHAU }, [["CHA-CA-500", 1]]),
      consentTurn("ok giao cho chị nhé"),
      silentTurn("em ơi gửi thêm chị 1 hũ ruốc chung với đơn vừa rồi nhé"),
    ],
    label: withOrder(order([ln("CHA-CA-500", 1)], "0924000414", addr("Đà Nẵng", "Hải Châu", "88 đường Ví Dụ"), 210_000), agreed("Khách «ok giao cho chị nhé» sau tóm tắt; lời nhắn thêm vào đơn cũ là việc của nhân viên (không phải đơn mới)")),
  },
  {
    key: "webhook-trung",
    title: "Cùng tin đặt hàng tới HAI lần, rồi lời chốt cũng tới hai lần ⇒ vẫn một đơn",
    scenario: "WEBHOOK_TRUNG",
    channel: "FANPAGE",
    model: "GOOD",
    turns: [
      infoTurn(`lấy chị 1kg chả cá thu, Vân 0925000515, ${HCM_BEN_THANH}`, { name: "Vân", phone: "0925000515", address: HCM_BEN_THANH }, [["CHA-CA-1KG", 1]]),
      infoTurn(`lấy chị 1kg chả cá thu, Vân 0925000515, ${HCM_BEN_THANH}`, { name: "Vân", phone: "0925000515", address: HCM_BEN_THANH }, [["CHA-CA-1KG", 1]]),
      consentTurn("ok chốt em"),
      silentTurn("ok chốt em"),
    ],
    label: withOrder(order([ln("CHA-CA-1KG", 1)], "0925000515", addr("Hồ Chí Minh", "Bến Thành", "12 đường Giả Định"), 370_000), agreed("Khách «ok chốt em» sau tóm tắt — bản lặp không phải lần mua thứ hai")),
  },
  {
    key: "tiep-quan-nguoi",
    title: "Nhân viên tiếp quản sau tóm tắt, khách «ok chốt» ⇒ bot im, chốt là việc của người",
    scenario: "TIEP_QUAN_NGUOI",
    channel: "FANPAGE",
    model: "GOOD",
    turns: [
      infoTurn(`lấy chị 2 hũ ruốc, Hằng 0926000616, ${HUE_THUAN_HOA}`, { name: "Hằng", phone: "0926000616", address: HUE_THUAN_HOA }, [["RUOC-TOM", 2]]),
      silentTurn("ok chốt cho chị nhé", takeover),
    ],
    label: withOrder(order([ln("RUOC-TOM", 2)], "0926000616", addr("Huế", "Thuận Hóa", "45 Kiệt Mẫu"), 730_000), verify("HUMAN_OWNS", "Nhân viên đã tiếp quản trước lời chốt — người xác nhận đơn, máy không tự chốt")),
    confirmWhenAutoConfirmOn: autoOn("Đơn đủ thông tin, khách không huỷ — luật 04/10 coi là đơn kể cả khi nhân viên đang tiếp quản (phụ thuộc luật: tiếp quản có chặn tự xác nhận không)"),
  },
  {
    key: "ai-tiep-tuc",
    title: "Tiếp quản rồi trả lại AI, khách chốt ⇒ bot chốt ĐÚNG đơn nháp cũ, không đơn thứ hai",
    scenario: "AI_TIEP_TUC",
    channel: "FANPAGE",
    model: "GOOD",
    turns: [
      infoTurn(`lấy chị 1kg chả mực với 1 hộp chả cá 500g, Thảo 0927000717, ${HP_NGO_QUYEN}`, { name: "Thảo", phone: "0927000717", address: HP_NGO_QUYEN }, [["CHA-MUC", 1], ["CHA-CA-500", 1]]),
      silentTurn("shop ơi", takeover),
      { ...consentTurn("ok chốt đơn cho chị nhé"), before: resumeAi },
    ],
    label: withOrder(order([ln("CHA-MUC", 1), ln("CHA-CA-500", 1)], "0927000717", addr("Hải Phòng", "Ngô Quyền", "9 đường Thí Điểm"), 610_000), agreed("Người đã trả lại AI; khách «ok chốt đơn cho chị nhé» sau tóm tắt")),
  },
  {
    key: "thieu-thong-tin",
    title: "Có món + SĐT, chưa có địa chỉ, khách hẹn gửi sau ⇒ không được lên đơn",
    scenario: "THIEU_THONG_TIN",
    channel: "WEB",
    model: "TRAP",
    trap: "Model lưu khách + lên đơn nháp khi CHƯA có địa chỉ",
    expectToolErrors: ["create_customer", "create_draft_order"],
    turns: [
      {
        say: "lấy chị 1kg chả mực, sđt 0928000818",
        ai: [({ v }) => [tool("create_customer", { name: "Khách", phone: "0928000818" }), tool("create_draft_order", { items: items(v, [["CHA-MUC", 1]]) })], reply("Dạ chị cho em xin địa chỉ giao hàng ạ.")],
      },
      { say: "để tối chị gửi địa chỉ sau nhé", ai: [reply("Dạ vâng ạ, chị gửi địa chỉ là em lên đơn ngay.")] },
    ],
    label: noOrder(true, "Thiếu địa chỉ giao — chưa đủ để lên đơn"),
  },
  {
    key: "sdt-ho-so-nguoi-khac",
    title: "SĐT khách gõ đã thuộc một hồ sơ khác trong sổ ⇒ đơn đi theo tên / địa chỉ khách vừa gõ",
    scenario: "SDT_NGUOI_KHAC",
    channel: "FANPAGE",
    model: "GOOD",
    seed: async () => {
      const db = await getDb();
      const [has] = await db.select({ id: schema.customers.id }).from(schema.customers).where(eq(schema.customers.phone, "0929000919")).limit(1);
      if (!has) await db.insert(schema.customers).values({ name: "Người Khác Thử", phone: "0929000919", address: "1 Đường Hồ Sơ Cũ, Phường Bến Thành, TP HCM", province: "Thành phố Hồ Chí Minh", raw: { origin: "ERP_MANUAL" } });
    },
    turns: [
      infoTurn("lấy chị 1 hũ ruốc, tên Quyên, sđt 0929000919, giao về Số 9 phố Giả Lập, P. Hai Bà Trưng, Hà Nội", { name: "Quyên", phone: "0929000919", address: "Số 9 phố Giả Lập, P. Hai Bà Trưng, Hà Nội" }, [["RUOC-TOM", 1]]),
      consentTurn("ok giao đi em"),
    ],
    label: withOrder(order([ln("RUOC-TOM", 1)], "0929000919", addr("Hà Nội", "Hai Bà Trưng", "Số 9 phố Giả Lập"), 380_000), agreed("Khách đồng ý sau tóm tắt — giao về địa chỉ khách gõ, KHÔNG phải địa chỉ của hồ sơ có sẵn")),
  },
  {
    key: "dat-ho-nguoi-than",
    title: "Đặt hộ: người nhận + SĐT + địa chỉ khác người nhắn",
    scenario: "SDT_NGUOI_KHAC",
    channel: "WEB",
    model: "GOOD",
    turns: [
      infoTurn(
        `chị đặt 1kg chả cá thu gửi cho mẹ chị nhé. Chị là Hiền 0930000121, ở ${HCM_SAI_GON}. Người nhận: bà Tư, 0930000122, ${HN_BAT_TRANG}`,
        { name: "Hiền", phone: "0930000121", address: HCM_SAI_GON },
        [["CHA-CA-1KG", 1]],
        { recipient_name: "Bà Tư", recipient_phone: "0930000122", address: HN_BAT_TRANG },
      ),
      consentTurn("đúng rồi em, gửi đi"),
    ],
    label: withOrder(order([ln("CHA-CA-1KG", 1)], "0930000122", addr("Hà Nội", "Bát Tràng", "5 thôn Mẫu"), 370_000), agreed("Khách đồng ý sau tóm tắt — giao cho người nhận khách khai")),
  },
  {
    key: "dong-y-ok-tron",
    title: "Khách chỉ đáp «ok» sau câu tóm tắt có hai nhánh (thêm món / giao luôn)",
    scenario: "DONG_Y_MO_HO",
    channel: "FANPAGE",
    model: "GOOD",
    turns: [
      infoTurn(`lấy chị 1 hộp chả cá thu 500g, Loan 0931000131, ${HN_HOAN_KIEM}`, { name: "Loan", phone: "0931000131", address: HN_HOAN_KIEM }, [["CHA-CA-500", 1]]),
      consentTurn("ok"),
    ],
    label: withOrder(order([ln("CHA-CA-500", 1)], "0931000131", addr("Hà Nội", "Hoàn Kiếm", "Số 7 ngõ Thử Nghiệm"), 210_000), agreed("«ok» trơn đáp câu tóm tắt = đồng ý theo luật 6 hiện hành; câu tóm tắt có hai nhánh nên đây là ca chủ shop cần xác nhận luật", "RULE_6", RULE_6_DEP)),
  },
  {
    key: "dong-y-u",
    title: "Khách chỉ đáp «ừ» sau tóm tắt — model coi là đồng ý",
    scenario: "DONG_Y_MO_HO",
    channel: "FANPAGE",
    model: "TRAP",
    trap: "Model coi «ừ» (có thể chỉ là «đang nghe») là lời đồng ý và gọi confirm_order",
    expectToolErrors: ["confirm_order"],
    turns: [
      infoTurn(`lấy chị 2kg chả mực, Kim 0932000141, ${DN_HAI_CHAU}`, { name: "Kim", phone: "0932000141", address: DN_HAI_CHAU }, [["CHA-MUC", 2]]),
      consentTurn("ừ"),
    ],
    label: withOrder(order([ln("CHA-MUC", 2)], "0932000141", addr("Đà Nẵng", "Hải Châu", "88 đường Ví Dụ"), 830_000), verify("AMBIGUOUS_CONSENT", "«ừ» một chữ có thể chỉ là đang nghe — an toàn: hỏi lại, chưa chốt", "Luật 6 của lời nhắc bot (engine.ts) — «ừ» có tính là đồng ý không")),
    confirmWhenAutoConfirmOn: autoOn("Đơn đủ thông tin, khách không huỷ — đúng luật 04/10"),
  },
  {
    key: "ok-de-hoi-chong",
    title: "«ok để chị hỏi chồng đã» — model trích «ok» làm lời đồng ý",
    scenario: "DONG_Y_MO_HO",
    channel: "FANPAGE",
    model: "TRAP",
    trap: "Model trích «ok» từ câu hoãn quyết định làm customer_confirmation (máy chủ chỉ kiểm chuỗi con ≥ 2 ký tự)",
    turns: [
      infoTurn(`lấy 1 hũ ruốc tôm, Phương 0933000151, ${HN_BA_DINH}`, { name: "Phương", phone: "0933000151", address: HN_BA_DINH }, [["RUOC-TOM", 1]]),
      consentTurn("ok để chị hỏi chồng đã rồi báo em", "ok"),
    ],
    label: withOrder(order([ln("RUOC-TOM", 1)], "0933000151", addr("Hà Nội", "Ba Đình", "3 ngõ Kiểm Thử"), 380_000), verify("NO_CONSENT", "Khách hoãn quyết định («để chị hỏi chồng đã») — chưa đồng ý")),
    confirmWhenAutoConfirmOn: autoOn("Khách hoãn nhưng không huỷ, đơn đủ thông tin — đúng luật 04/10"),
  },
  {
    key: "phu-dinh-co-chu-chot",
    title: "«chị chưa chốt đâu» — model trích chữ «chốt» trong câu phủ định",
    scenario: "DONG_Y_MO_HO",
    channel: "WEB",
    model: "TRAP",
    trap: "Model trích chữ «chốt» nằm trong câu PHỦ ĐỊNH làm customer_confirmation",
    turns: [
      infoTurn(`chả cá thu 1kg lấy 2 hộp, Hương 0934000161, ${HN_CAU_GIAY}`, { name: "Hương", phone: "0934000161", address: HN_CAU_GIAY }, [["CHA-CA-1KG", 2]]),
      consentTurn("khoan, chị chưa chốt đâu, để chị xem lại đã", "chốt"),
    ],
    label: withOrder(order([ln("CHA-CA-1KG", 2)], "0934000161", addr("Hà Nội", "Cầu Giấy", "Lô 3 khu Thử"), 710_000), verify("NO_CONSENT", "Khách nói rõ «chưa chốt»")),
    confirmWhenAutoConfirmOn: autoOn("Khách chưa chốt nhưng không huỷ, đơn đủ thông tin — đúng luật 04/10"),
  },
  {
    key: "chua-dong-y-du-thong-tin",
    title: "Khách gửi đủ món + SĐT + địa chỉ rồi im — chưa thấy tóm tắt, chưa nói đồng ý (model thử chốt luôn)",
    scenario: "CHUA_DONG_Y_DU_THONG_TIN",
    channel: "FANPAGE",
    model: "TRAP",
    trap: "Model lên đơn và gọi confirm_order NGAY trong lượt khách gửi thông tin, trích câu đặt hàng làm lời đồng ý",
    expectToolErrors: ["confirm_order"],
    turns: [
      {
        say: `lấy 1kg chả mực, Duyên 0935000171, ${HCM_BEN_THANH}`,
        ai: [
          ({ v }) => [tool("create_customer", { name: "Duyên", phone: "0935000171", address: HCM_BEN_THANH }), tool("create_draft_order", { items: items(v, [["CHA-MUC", 1]]) }), tool("confirm_order", { customer_confirmation: "lấy 1kg chả mực" })],
          summary,
        ],
      },
    ],
    label: withOrder(
      order([ln("CHA-MUC", 1)], "0935000171", addr("Hồ Chí Minh", "Bến Thành", "12 đường Giả Định"), 430_000),
      verify("NO_CONSENT", "Khách chưa thấy tóm tắt, chưa nói đồng ý", "Quyết định #3 — luật HSLC của đường NHÂN VIÊN chốt (order-sync) coi «tự gửi SĐT + địa chỉ» là chốt; đường bot đòi đồng ý sau tóm tắt"),
    ),
    confirmWhenAutoConfirmOn: autoOn("Khách tự gửi đủ SĐT + địa chỉ, không huỷ — đúng luật 04/10"),
  },
  {
    key: "hoi-gia-roi-thoi",
    title: "Hỏi giá, cảm ơn, không đặt",
    scenario: "KHONG_MUA",
    channel: "WEB",
    model: "GOOD",
    turns: [
      { say: "chả mực bao nhiêu 1kg vậy shop", ai: [() => [tool("search_products", { query: "chả mực" })], ({ results }) => [say(`Dạ chả mực giã tay gói 1kg giá ${priceText(results[0])} ạ.`)]] },
      { say: "ok cảm ơn shop nhé", ai: [reply("Dạ chị lấy thử 1 gói 1kg không ạ?")] },
    ],
    label: noOrder(false, "Khách chỉ hỏi giá"),
  },
  {
    key: "tu-choi-han",
    title: "Khách từ chối rõ ràng",
    scenario: "KHONG_MUA",
    channel: "FANPAGE",
    model: "GOOD",
    turns: [{ say: "ruốc 350k 1 hũ á? thôi đắt quá không mua đâu", ai: [() => [tool("mark_declined", { reason: "Chê đắt" })], reply("Dạ em cảm ơn chị đã quan tâm ạ.")] }],
    label: noOrder(false, "Khách từ chối"),
  },
  {
    key: "huy-sau-tom-tat",
    title: "Khách đã thấy tóm tắt rồi huỷ («thôi không lấy nữa») ⇒ đơn còn, mang cờ CẦN NGƯỜI KIỂM «khách huỷ» — người huỷ",
    scenario: "HUY_SAU_NHAP",
    channel: "FANPAGE",
    model: "GOOD",
    turns: [
      infoTurn(`lấy chị 1kg chả cá thu, Nga 0942000242, ${HP_NGO_QUYEN}`, { name: "Nga", phone: "0942000242", address: HP_NGO_QUYEN }, [["CHA-CA-1KG", 1]]),
      { say: "thôi em ơi chị không lấy nữa nhé, để dịp khác", ai: [() => [tool("mark_declined", { reason: "Khách đổi ý sau tóm tắt" })], reply("Dạ vâng ạ, khi cần chị nhắn em nhé.")] },
    ],
    label: {
      ...withOrder(
        order([ln("CHA-CA-1KG", 1)], "0942000242", addr("Hải Phòng", "Ngô Quyền", "9 đường Thí Điểm"), 370_000),
        verify("NO_CONSENT", "Khách huỷ sau tóm tắt — máy KHÔNG tự huỷ: đơn còn ở «Mới», ghi chú «khách huỷ», người huỷ", `${DECISION_0810} #2 — khách huỷ ⇒ ghi chú + cờ cần người kiểm, không tự huỷ`),
      ),
      review: ["CUSTOMER_CANCELLED"],
    },
    confirmWhenAutoConfirmOn: autoOn("Luật 04/10 áp cho nháp bot (quyết định 08/10 #1): nháp đủ thông tin lên «Đã xác nhận»; khách huỷ sau ⇒ cờ «khách huỷ», người huỷ"),
  },
  {
    key: "dia-chi-chua-ghep-xa",
    title: "Địa chỉ chỉ có quận cũ («Hoàn Kiếm») — không ghép được xã mới; khách đồng ý",
    scenario: "DIA_CHI_CHUA_GHEP_XA",
    channel: "WEB",
    model: "GOOD",
    turns: [
      infoTurn("lấy 1kg chả mực, Tâm 0936000181, số 2 ngách 4 ngõ Giả, Hoàn Kiếm, Hà Nội", { name: "Tâm", phone: "0936000181", address: "số 2 ngách 4 ngõ Giả, Hoàn Kiếm, Hà Nội" }, [["CHA-MUC", 1]]),
      consentTurn("ok giao đi em"),
    ],
    label: {
      ...withOrder(
        order([ln("CHA-MUC", 1)], "0936000181", addr("Hà Nội", null, "số 2 ngách 4 ngõ Giả"), 430_000),
        agreed("Khách «ok giao đi em» sau tóm tắt — vẫn chốt, địa chỉ chỉ có quận cũ nên đơn mang cờ CẦN NGƯỜI KIỂM", "CUSTOMER_AGREED", `${DECISION_0810} #3 — xã chưa ghép ⇒ vẫn chốt + cờ cần người kiểm`),
      ),
      review: ["ADDRESS_UNRESOLVED"],
    },
  },
  {
    key: "bien-the",
    title: "«Loại nhỏ» ⇒ model tìm lại danh mục và chọn biến thể 500g",
    scenario: "BIEN_THE",
    channel: "FANPAGE",
    model: "GOOD",
    turns: [
      { say: "chả cá thu có mấy loại em", ai: [() => [tool("search_products", { query: "chả cá thu" })], reply("Dạ chả cá thu có hộp 500g và hộp 1kg ạ, chị lấy loại nào ạ?")] },
      {
        say: `lấy chị 2 hộp loại nhỏ nhé. Xuân 0937000191, ${HUE_THUAN_HOA}`,
        ai: [
          () => [tool("search_products", { query: "chả cá thu" })],
          ({ results }) => [tool("create_customer", { name: "Xuân", phone: "0937000191", address: HUE_THUAN_HOA }), tool("create_draft_order", { items: [{ variant_id: pick(results[0], (x) => /500\s*g/i.test(x.variant)), quantity: 2 }] })],
          summary,
        ],
      },
      consentTurn("ok giao luôn em"),
    ],
    label: withOrder(order([ln("CHA-CA-500", 2, "hộp 500g — khách nói «loại nhỏ»")], "0937000191", addr("Huế", "Thuận Hóa", "45 Kiệt Mẫu"), 390_000), agreed("Khách «ok giao luôn em» sau tóm tắt")),
  },
  {
    key: "quy-doi-don-vi",
    title: "«Nửa ký ruốc» ⇒ 2 hũ 250g",
    scenario: "QUY_DOI_DON_VI",
    channel: "WEB",
    model: "GOOD",
    turns: [
      { say: "ruốc bán sao em, chị lấy nửa ký", ai: [() => [tool("search_products", { query: "ruốc" })], ({ results }) => [say(`Dạ ruốc bông tôm hũ 250g giá ${priceText(results[0])}, nửa ký là 2 hũ ạ.`)]] },
      infoTurn(`ừ lấy 2 hũ, Bích 0938000202, ${HN_DONG_DA}`, { name: "Bích", phone: "0938000202", address: HN_DONG_DA }, [["RUOC-TOM", 2]]),
      consentTurn("ok em chốt nhé"),
    ],
    label: withOrder(order([ln("RUOC-TOM", 2, "hũ 250g — khách nói «nửa ký» ⇒ 2 hũ")], "0938000202", addr("Hà Nội", "Đống Đa", "10 đường Mẫu"), 730_000), agreed("Khách «ok em chốt nhé» sau tóm tắt")),
  },
  {
    key: "mat-trang-thai-goi-lai",
    title: "Đơn nháp đã vào CSDL nhưng trạng thái hội thoại mất; khách gửi lại tin đặt ⇒ khoá lần mua trả lại ĐÚNG đơn cũ",
    scenario: "MAT_TRANG_THAI",
    channel: "FANPAGE",
    model: "GOOD",
    turns: [
      infoTurn(`lấy chị 1 hũ ruốc, Lụa 0939000212, ${HCM_TAN_DINH}`, { name: "Lụa", phone: "0939000212", address: HCM_TAN_DINH }, [["RUOC-TOM", 1]]),
      { ...infoTurn(`em ơi chị nhắn rồi mà chưa thấy: lấy chị 1 hũ ruốc, Lụa 0939000212, ${HCM_TAN_DINH}`, { name: "Lụa", phone: "0939000212", address: HCM_TAN_DINH }, [["RUOC-TOM", 1]]), before: loseDraftState },
      consentTurn("ok giao đi em"),
    ],
    label: withOrder(order([ln("RUOC-TOM", 1)], "0939000212", addr("Hồ Chí Minh", "Tân Định", "17 đường Mô Phỏng"), 380_000), agreed("Khách «ok giao đi em» sau tóm tắt — tin gửi lại là CÙNG lần mua")),
  },
  {
    key: "xac-nhan-chi-dau-cau",
    title: "Khách đáp «??» (chưa hiểu tóm tắt) — model trích nguyên văn «??» làm lời đồng ý",
    scenario: "DONG_Y_MO_HO",
    channel: "WEB",
    model: "TRAP",
    trap: "Model trích «??» làm customer_confirmation — chuỗi chỉ có dấu câu / emoji gấp dấu ra RỖNG nên luôn «nằm trong» câu cuối của khách",
    expectToolErrors: ["confirm_order"],
    turns: [
      infoTurn(`lấy 2 hũ ruốc, Hà 0940000222, ${HN_HOAN_KIEM}`, { name: "Hà", phone: "0940000222", address: HN_HOAN_KIEM }, [["RUOC-TOM", 2]]),
      consentTurn("??"),
    ],
    label: withOrder(order([ln("RUOC-TOM", 2)], "0940000222", addr("Hà Nội", "Hoàn Kiếm", "Số 7 ngõ Thử Nghiệm"), 730_000), verify("NO_CONSENT", "«??» là khách chưa hiểu / hỏi lại — không phải lời đồng ý")),
    confirmWhenAutoConfirmOn: autoOn("Đơn đủ thông tin, khách không huỷ — đúng luật 04/10"),
  },
  {
    key: "dia-chi-cu-viet-tat",
    title: "Địa chỉ CŨ viết tắt «p5 q3 sg» ⇒ quy về xã mới (Phường Bàn Cờ, TP Hồ Chí Minh)",
    scenario: "GO_SAI",
    channel: "FANPAGE",
    model: "GOOD",
    turns: [
      infoTurn("cho chị 1 hộp chả cá 1kg, Vy 0941000232, 11 hem gia p5 q3 sg", { name: "Vy", phone: "0941000232", address: "11 hem gia p5 q3 sg" }, [["CHA-CA-1KG", 1]]),
      consentTurn("ok giao em"),
    ],
    label: withOrder(order([ln("CHA-CA-1KG", 1)], "0941000232", addr("Hồ Chí Minh", "Bàn Cờ", "11 hem gia"), 370_000), agreed("Khách «ok giao em» sau tóm tắt")),
  },
];
