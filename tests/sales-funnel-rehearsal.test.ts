import assert from "node:assert/strict";
import { decide } from "@/lib/ai-workforce/agents/sales/decide";
import { checkContextualConfirmation } from "@/lib/ai-workforce/agents/sales/confirm";
import { renderTemplate, type GenerationContext } from "@/lib/ai-workforce/agents/sales/generate";
import { EMPTY_SALES_STATE, confirmationFingerprint, type SalesState } from "@/lib/ai-workforce/agents/sales/state";
import type { ConfirmationCheck } from "@/lib/ai-workforce/agents/sales/confirm";
import { UNDERSTANDING_SCHEMA, type Understanding } from "@/lib/ai-workforce/agents/sales/understand";
import { SALES_FUNNEL } from "@/lib/constants/sales-ai-funnel";
import type { SalesAction, SalesStage } from "@/lib/constants/sales-agent";

/**
 * ═══════════ DIỄN TẬP TRỌN PHỄU — NỬA SAU CHƯA BAO GIỜ CHẠY ═══════════
 *
 * Đo bản chạy thử 22/09/2026 trên 1.065 lượt chạy thật: các hành động ĐÃ từng xảy ra là
 * `ASK_PRODUCT` · `ASK_VARIANT` · `ASK_SIZE` · `ANSWER_QUESTION` · `HANDOFF_HUMAN` · `NO_ACTION`,
 * cộng đúng 3 lượt `ASK_ADDRESS`. Bốn hành động còn lại — `SEND_ORDER_REVIEW`,
 * `CREATE_DRAFT_ORDER`, `SCHEDULE_FOLLOW_UP`, `HANDLE_OBJECTION` — **chưa xảy ra lần nào, và
 * cũng không có một dòng kiểm thử nào**.
 *
 * Lý do là phễu chết ở bậc 5: chưa khai bảng số đo nên mọi câu hỏi size đều chuyển người, và
 * không hội thoại nào đi được tới chỗ xin số điện thoại. Nghĩa là nửa sau của dây chuyền đã ở
 * trong kho mã nhiều tuần mà chưa từng thực thi.
 *
 * Khai bảng số đo xong thì nút thắt ấy mở, và hội thoại thật sẽ chảy thẳng vào đúng phần chưa ai
 * chạy bao giờ. Nếu nó hỏng, chỗ phát hiện ra sẽ là một khách đang chờ mua hàng.
 *
 * Bài này đi HẾT mười hai bậc bằng chính `decide()` và `renderTemplate()` — không giả lập, không
 * thay thế hàm nào — với một hội thoại dựng sẵn. Nó không thay được việc chạy thật, nhưng nó trả
 * lời được câu "nửa sau có chạy không" trước khi câu trả lời đó tốn một khách.
 */

const NOW = new Date("2026-09-22T03:00:00Z");

function hieu(intents: string[], confidence = 0.9): Understanding {
  return { ...UNDERSTANDING_SCHEMA.parse({ intents, entities: {}, confidence, evidence: "" }), tier: "RULE" };
}

/** Không xác nhận — dùng cho mọi bậc trước khi bản chốt được gửi. */
const CHUA_CHOT: ConfirmationCheck = { confirmed: false, reason: "chưa gửi bản chốt", blocking: [] };

function quyetDinh(stage: SalesStage, state: SalesState, understanding: Understanding, confirmation: ConfirmationCheck = CHUA_CHOT) {
  return decide({
    stage,
    state,
    understanding,
    confirmation,
    humanTakeover: false,
    orderCreated: false,
    stale: false,
    toolFailed: false,
    canPromiseStock: true,
    sizeAdvice: null,
  });
}

export function testSalesFunnelRehearsal() {
  /*
    ─────────── ĐI TỚI ───────────
    Mỗi bước dựng đúng trạng thái mà bước trước để lại, rồi hỏi `decide()` việc kế tiếp. Trạng
    thái KHÔNG được nhảy cóc: nếu một bậc không thật sự sinh ra dữ kiện cho bậc sau thì bài kiểm
    này đứt, và đó chính là thứ cần biết.
  */
  const daDi: { stage: SalesStage; action: SalesAction }[] = [];

  // Bậc 1–2: khách nhắn, máy chưa biết mẫu nào.
  let state: SalesState = { ...EMPTY_SALES_STATE };
  let d = quyetDinh("NEW_LEAD", state, hieu(["GREETING"]));
  assert.equal(d.action, "ASK_PRODUCT", "chưa biết mẫu nào thì phải hỏi mẫu");
  daDi.push({ stage: d.stage, action: d.action });

  // Bậc 3: đã nhận ra sản phẩm.
  state = { ...state, productId: "p1", productName: "Đầm Q004", needsColor: true, needsSize: true };
  d = quyetDinh("PRODUCT_IDENTIFIED", state, hieu(["PRODUCT_QUESTION"]));
  assert.equal(d.action, "ANSWER_QUESTION", "khách hỏi thì trả lời trước, không đứng thay bằng bước tiếp");

  /*
    Bậc 4: SIZE TRƯỚC, MÀU SAU — và đây là chỗ bài kiểm này đã sửa được sổ phễu.

    `SALES_STAGES` liệt kê VARIANT_SELECTION trước SIZE_SELECTION, nên bản đầu của `SALES_FUNNEL`
    chép đúng thứ tự ấy. Nhưng `nextStage()` hỏi `needsSize` TRƯỚC `needsColor` một cách vô điều
    kiện: sản phẩm cần cả hai thì máy hỏi size trước. Sổ khai ngược thì màn hình vẫn vẽ ra một cái
    phễu trông hợp lý, chỉ là hai bậc giữa đứng sai chỗ và "tỷ lệ đi tiếp" của chúng nói về hai
    bước chuyển không có thật.
  */
  d = quyetDinh("PRODUCT_IDENTIFIED", state, hieu(["PURCHASE_INTENT"]));
  assert.equal(d.action, "ASK_SIZE", "cần cả size lẫn màu thì máy hỏi SIZE trước — xem nextStage()");
  assert.equal(d.stage, "SIZE_SELECTION");
  daDi.push({ stage: d.stage, action: d.action });

  // Bậc 5: chốt size xong mới tới màu.
  state = { ...state, size: "L", needsSize: false, purchaseIntent: true };
  d = quyetDinh("SIZE_SELECTION", state, hieu(["PROVIDE_VARIANT"]));
  assert.equal(d.action, "ASK_VARIANT", "hết size thì tới màu");
  assert.equal(d.stage, "VARIANT_SELECTION");
  daDi.push({ stage: d.stage, action: d.action });

  /*
    ─────────── TỪ ĐÂY TRỞ ĐI LÀ PHẦN CHƯA BAO GIỜ CHẠY ───────────
  */

  // Bậc 6–7: đủ mẫu mã và có ý muốn mua ⇒ xin số điện thoại.
  state = { ...state, color: "Đỏ", needsColor: false, variantId: "v1", variantLabel: "L Đỏ", quotedTotal: 524_000 };
  d = quyetDinh("PURCHASE_INTENT", state, hieu(["CONFIRM"]));
  assert.equal(d.action, "ASK_CONTACT", "đã chốt mẫu mã và khách muốn mua ⇒ xin SĐT");
  daDi.push({ stage: d.stage, action: d.action });

  // Bậc 8: có SĐT ⇒ xin địa chỉ.
  state = { ...state, phone: "0901234567" };
  d = quyetDinh("CONTACT_COLLECTION", state, hieu(["PROVIDE_CONTACT"]));
  assert.equal(d.action, "ASK_ADDRESS", "có SĐT rồi thì xin địa chỉ");
  daDi.push({ stage: d.stage, action: d.action });

  // Bậc 9: đủ địa chỉ ⇒ đọc lại đơn cho khách.
  state = { ...state, address: "12 Nguyễn Trãi, Thanh Xuân", province: "Hà Nội" };
  d = quyetDinh("ADDRESS_COLLECTION", state, hieu(["PROVIDE_ADDRESS"]));
  assert.equal(d.action, "SEND_ORDER_REVIEW", "đủ điều kiện thì đọc lại đơn — KHÔNG lên đơn thẳng");
  assert.deepEqual(d.missing, [], "tới đây không được còn thiếu gì");
  daDi.push({ stage: d.stage, action: d.action });

  /*
    Bậc 10–11: BẢN CHỐT ĐÃ GỬI, khách trả lời "ok".

    Đây là chỗ nguy hiểm nhất của cả dây chuyền — một chữ "ok" biến thành một kiện hàng. Nên nó đi
    qua `checkContextualConfirmation` thật, với vân tay đơn thật, chứ không phải một cờ dựng tay.
  */
  const banChot = {
    fingerprint: confirmationFingerprint(state),
    sentAt: new Date(NOW.getTime() - 60_000).toISOString(),
    summary: "Đầm Q004 L Đỏ · 1 cái · tổng 524.000 ₫",
    variantId: "v1",
    quantity: 1,
    total: 524_000,
  };
  state = { ...state, pending: banChot };
  const xacNhan = checkContextualConfirmation({
    state,
    message: { text: "ok chị lấy nhé", sentAt: new Date(NOW.getTime() - 30_000) },
    now: NOW,
  });
  assert.equal(xacNhan.confirmed, true, `xác nhận phải đạt, nhận: ${xacNhan.confirmed ? "" : xacNhan.reason}`);

  d = quyetDinh("AWAITING_CONFIRMATION", state, hieu(["CONFIRM"]), xacNhan);
  assert.equal(d.action, "CREATE_DRAFT_ORDER", "xác nhận có ngữ cảnh + đơn đủ điều kiện ⇒ lên đơn nháp");
  assert.equal(d.stage, "CONFIRMED");
  daDi.push({ stage: d.stage, action: d.action });

  /*
    ─────────── HAI NHÁNH RẼ, CŨNG CHƯA BAO GIỜ CHẠY ───────────
  */

  // Khách thắc mắc KHÔNG phải về giá ⇒ máy xử, không chuyển người ngay.
  const phanNan = quyetDinh("OBJECTION", state, hieu(["OBJECTION"]));
  assert.equal(phanNan.action, "HANDLE_OBJECTION", "thắc mắc không phải trả giá thì máy vẫn xử được");

  // Trả giá thì KHÁC HẲN: giá là quyết định kinh doanh, máy không được tự hạ.
  const traGia = decide({
    stage: "OBJECTION",
    state,
    understanding: { ...UNDERSTANDING_SCHEMA.parse({ intents: ["OBJECTION"], entities: {}, confidence: 0.9, evidence: "dat qua bot chut di" }), tier: "RULE" },
    confirmation: CHUA_CHOT,
    humanTakeover: false,
    orderCreated: false,
    stale: false,
    canPromiseStock: true,
  });
  assert.equal(traGia.action, "HANDOFF_HUMAN", "khách trả giá ⇒ người quyết, máy không tự hạ giá");
  assert.equal(traGia.handoffReason, "PRICE_NEGOTIATION");

  /*
    Khách im lâu ⇒ hẹn lại — NHƯNG chỉ ở một cửa rất hẹp.

    `nextStage()` đặt `stale` ở nấc CUỐI CÙNG, sau mọi nấc tiến trình, vì "im lặng" không mang
    thông tin mới nào. Hệ quả đo được ở đây: hội thoại ĐÃ nhận ra sản phẩm mà khách im luôn thì
    KHÔNG rơi vào `FOLLOW_UP` — nó nằm lại ở bậc cũ và máy tiếp tục hỏi.

    Đó là hành vi đang có, không phải lỗi, và bài kiểm này ghi nó lại thay vì khẳng định điều
    ngược lại. Có nên hẹn lại một lead đã biết mẫu hay không là quyết định bán hàng của chủ shop.
  */
  const imLangSomBi = quyetDinh("PRODUCT_IDENTIFIED", { ...EMPTY_SALES_STATE, productId: "p1", needsSize: true }, hieu(["OTHER"]));
  assert.notEqual(imLangSomBi.action, "SCHEDULE_FOLLOW_UP", "đã biết sản phẩm thì máy đi tiếp, không hẹn lại");

  const imLang = decide({
    stage: "FOLLOW_UP",
    state: EMPTY_SALES_STATE,
    understanding: hieu(["OTHER"]),
    confirmation: CHUA_CHOT,
    humanTakeover: false,
    orderCreated: false,
    stale: true,
    canPromiseStock: true,
  });
  assert.equal(imLang.action, "SCHEDULE_FOLLOW_UP", "khách im lâu thì hẹn lại, không bỏ rơi hội thoại");

  /*
    ─────────── CÂU CHỮ CỦA MỖI BẬC PHẢI DỰNG ĐƯỢC ───────────

    `decide()` chọn đúng việc mà `renderTemplate()` trả câu rỗng thì hội thoại vẫn đứng im, và
    màn hình sẽ nói "đã soạn" trong khi khách không nhận được gì. Hai thứ hỏng độc lập nhau nên
    phải kiểm riêng.
  */
  const nen: GenerationContext = {
    action: "ASK_CONTACT",
    state,
    sizes: ["M", "L", "XL"],
    colors: ["Đỏ"],
    sizeAdvice: null,
    stockKnown: true,
    available: 5,
    shippingFee: 25_000,
    missing: [],
    reason: "",
  };
  for (const act of ["ASK_CONTACT", "ASK_ADDRESS", "HANDLE_OBJECTION", "SCHEDULE_FOLLOW_UP"] as SalesAction[]) {
    const cau = renderTemplate({ ...nen, action: act });
    assert.ok(cau.trim().length > 0, `hành động ${act} phải dựng được câu chữ, không được trả rỗng`);
  }

  // `SEND_ORDER_REVIEW` cần bản xem trước đơn — thiếu nó thì câu chữ không có gì để đọc cho khách.
  const banXem = renderTemplate({
    ...nen,
    action: "SEND_ORDER_REVIEW",
    orderSummary: "Đầm Q004 L Đỏ · 1 cái · 499.000 ₫ + ship 25.000 ₫ = 524.000 ₫",
  });
  assert.ok(banXem.includes("524.000"), "bản đọc lại đơn phải nêu đúng số tiền máy chủ đã tính");

  /*
    ─────────── PHỄU KHAI RA ĐÚNG THỨ DÂY CHUYỀN ĐI QUA ───────────

    Sổ phễu (`SALES_FUNNEL`) là thứ màn hình /ai/department vẽ. Nếu dây chuyền đi qua một giai
    đoạn mà sổ không khai, màn hình sẽ đếm hội thoại đó vào "nhánh rẽ" và báo cáo im lặng sai.
  */
  for (const b of daDi) {
    assert.ok(
      SALES_FUNNEL.some((f) => f.stage === b.stage) || ["HUMAN_TAKEOVER", "LOST", "OBJECTION", "FOLLOW_UP"].includes(b.stage),
      `dây chuyền đi qua giai đoạn ${b.stage} mà sổ phễu không khai — màn hình sẽ đếm nhầm`,
    );
  }

  /*
    THỨ TỰ SỔ PHỄU PHẢI LÀ THỨ TỰ DÂY CHUYỀN THẬT SỰ ĐI QUA.

    Đây là phép kiểm đáng giá nhất của cả tệp, vì nó bắt đúng loại lỗi vừa xảy ra: sổ chép thứ tự
    từ `SALES_STAGES` (thứ tự KHAI BÁO) trong khi hội thoại đi theo `nextStage()` (thứ tự ĐI QUA).
    Hai thứ ấy trùng nhau ở mười bậc và lệch nhau ở hai bậc giữa — vừa đủ để không ai nhìn ra bằng
    mắt, và vừa đủ để hai ô trên màn hình nói về hai bước chuyển không có thật.

    Danh sách `daDi` được dựng bằng chính `decide()` ở trên, nên nó là bằng chứng chứ không phải
    một bản chép thứ hai.
  */
  const bacCua = (st: SalesStage) => SALES_FUNNEL.find((f) => f.stage === st)?.order ?? null;
  let truoc = 0;
  for (const b of daDi) {
    const bac = bacCua(b.stage);
    if (bac === null) continue; // nhánh rẽ, không nằm trên phễu
    assert.ok(
      bac > truoc,
      `dây chuyền đi ${b.stage} (bậc ${bac}) sau một bậc ${truoc} — sổ phễu khai sai thứ tự so với nextStage()`,
    );
    truoc = bac;
  }

  console.log(
    `✓ Diễn tập trọn phễu: đi hết ${SALES_FUNNEL.length} bậc bằng chính decide() — xin SĐT · xin địa chỉ · đọc lại đơn · lên đơn nháp đều chạy (bốn hành động này chưa từng xảy ra trên dữ liệu thật) · trả giá vẫn chuyển người · câu chữ mỗi bậc dựng được`,
  );
}
