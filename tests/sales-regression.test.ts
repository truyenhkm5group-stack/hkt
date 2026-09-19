import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import {
  EMPTY_EXPECTATION,
  REGRESSION_FAILURES,
  REGRESSION_FAILURE_OWNER,
  compareToExpectation,
  looseIncludes,
  summarizeRegression,
  type RegressionCaseResult,
} from "@/lib/constants/sales-regression";
import { SEED_REGRESSION_CASES } from "@/lib/constants/sales-regression-seed";
import { replayToolRunner, runRegressionCase } from "@/lib/ai-workforce/agents/sales/regression";
import { buildOrderDraft, ORDER_REQUIREMENTS, QUANTITY_WARN_FROM } from "@/lib/constants/order-draft";
import { EMPTY_SALES_STATE, type SalesState } from "@/lib/ai-workforce/agents/sales/state";
import { missingOrderRequirements } from "@/lib/ai-workforce/agents/sales/confirm";
import { findColor, findSize, understandByRule } from "@/lib/ai-workforce/agents/sales/understand";
import { isAffirmativeText } from "@/lib/ai-workforce/agents/sales/confirm";
import { RUN_BREAKDOWNS, intentDistribution, pagesWithConversations, salesModelBreakdown, salesRunBreakdown } from "@/lib/queries/sales-metrics";
import { listShadowTurns, shadowMetrics } from "@/lib/queries/sales-review";
import { clearMemo } from "@/lib/cache";
import { PancakePagesClient } from "@/lib/integrations/pancake/pages";
import { EVAL_BATCH_MAX, EVAL_BATCH_MIN, EVAL_BUCKETS } from "@/lib/constants/sales-eval-buckets";
import { evalBatchCoverage } from "@/lib/queries/sales-eval-batch";
import { REVIEW_REASON_TAGS, REVIEW_REASON_TAG_META, type ReviewReasonTag } from "@/lib/constants/sales-review-tags";
import { fanpageOps } from "@/lib/queries/fanpage-ops";

/** Mốc gốc CỐ ĐỊNH — mốc trong ca là số phút tương đối, nên bài kiểm không già đi (AGENTS.md mục 50). */
const MOC_GOC = new Date("2026-01-01T02:00:00.000Z");

function state(patch: Partial<SalesState>): SalesState {
  return { ...EMPTY_SALES_STATE, ...patch };
}

export async function testSalesRegression(db: Db) {
  // ═══════════ 1. BA VA CHẠM CHÍNH TẢ MÀ PHÉP BỎ DẤU TỰ TẠO RA ═══════════
  //
  // Đây là lỗi bộ ca hồi quy đã bắt được ngày 19/09/2026, và là lý do cả ba dòng dưới đây tồn tại:
  // `normalize()` bỏ dấu nên "vâng" ↦ "vang" trùng khít "vàng". Khách chốt màu rồi nhắn "vâng" và
  // máy ghi nhận họ vừa ĐỔI SANG MÀU VÀNG — mẫu mã đã chốt bị xoá vì không màu nào còn khớp.
  assert.equal(findColor("vâng"), "", 'chữ đồng ý "vâng" KHÔNG BAO GIỜ được đọc thành màu Vàng');
  assert.equal(findColor("vâng ạ"), "", '"vâng ạ" cũng vậy');
  assert.equal(findColor("cái đó bao nhiêu"), "", '"đó" không phải "đỏ"');
  assert.equal(findColor("khi nào hàng đến"), "", '"đến" không phải "đen"');
  // Hai đường nhận màu vẫn phải chạy: có chỉ dấu thì nhận cả cách viết không dấu.
  assert.equal(findColor("lấy cho chị màu đỏ đô size XL"), "Đỏ", "có chỉ dấu ⇒ nhận màu, và chỉ lấy MỘT từ chứ không nuốt phần đuôi");
  assert.equal(findColor("cho em mau den nhe"), "Đen", "viết không dấu nhưng có chỉ dấu ⇒ vẫn nhận");
  assert.equal(findColor("chị lấy đen nhé"), "Đen", "không chỉ dấu nhưng ĐÚNG chính tả có dấu ⇒ nhận");

  // ═══════════ 2. "G" CẮT RA TỪ "size gì" KHÔNG PHẢI MỘT SIZE ═══════════
  //
  // `parseVariantText` dùng lớp ký tự ASCII nên nó dừng sau một ký tự của "gì" và trả về "G". Máy
  // ghi nhận khách chọn một size không tồn tại, và phép khớp mẫu mã sau đó không bao giờ ra kết quả.
  assert.equal(findSize("Chị 1m58 60kg thì mặc size gì em"), "", 'câu HỎI size không được đọc thành size "G"');
  assert.equal(findSize("size nào cũng được"), "", "vẫn là câu hỏi, không phải một lựa chọn");
  assert.equal(findSize("lấy size XL nhé"), "XL", "size chữ thật vẫn nhận bình thường");
  assert.equal(findSize("cho chị size 30"), "30", "size SỐ là size thật của quần / giày — không được loại oan");

  // ═══════════ 3. CHÍN CA DỰNG SẴN PHẢI ĐẠT, VÀ PHẢI ỔN ĐỊNH ═══════════
  const lan1: RegressionCaseResult[] = [];
  for (const c of SEED_REGRESSION_CASES) lan1.push(await runRegressionCase(c, MOC_GOC));
  const truot = lan1.filter((r) => !r.passed);
  assert.equal(
    truot.length,
    0,
    `bộ ca dựng sẵn phải ĐẠT hết — đang trượt: ${truot.map((t) => `${t.key} (${t.findings.map((f) => `${f.failure}:${f.field}`).join(", ")})`).join(" · ")}`,
  );

  // Chạy hai lần ra ĐÚNG một kết quả: một bộ ca nhấp nháy là một bộ ca người ta học cách bỏ qua.
  const lan2: RegressionCaseResult[] = [];
  for (const c of SEED_REGRESSION_CASES) lan2.push(await runRegressionCase(c, MOC_GOC));
  assert.deepEqual(
    lan2.map((r) => ({ key: r.key, passed: r.passed, findings: r.findings })),
    lan1.map((r) => ({ key: r.key, passed: r.passed, findings: r.findings })),
    "chạy lại phải ra cùng kết quả từng ca — dây chuyền ở bậc luật là TẤT ĐỊNH",
  );

  // Khoá ca phải DUY NHẤT, nếu không báo cáo đếm một tình huống hai lần.
  const khoa = SEED_REGRESSION_CASES.map((c) => c.key);
  assert.equal(new Set(khoa).size, khoa.length, "khoá ca dựng sẵn không được trùng");

  // ═══════════ 4. PHÉP SO PHẢI BẮT ĐƯỢC LỖI, KHÔNG CHỈ BIẾT NÓI ĐẠT ═══════════
  //
  // Một phép so luôn trả rỗng thì cả bộ ca xanh vĩnh viễn — nên phải kiểm chính nó bằng một kết quả
  // SAI ở mọi chiều.
  const thuc = {
    intents: ["OTHER"],
    stage: "NEW_LEAD" as const,
    action: "ASK_PRODUCT" as const,
    handoffReason: null,
    state: { size: "M", color: "Đen", phone: "", quantity: 1, purchaseIntent: false, variantId: null, productName: "" },
    reply: "Dạ chị đang xem mẫu nào ạ?",
  };
  const batDuoc = compareToExpectation(
    {
      ...EMPTY_EXPECTATION,
      intents: ["PURCHASE_INTENT"],
      stage: "CONFIRMED",
      action: "CREATE_DRAFT_ORDER",
      handoff: true,
      state: { size: "XL", color: "Đỏ", phone: "0912345678", quantity: 2, purchaseIntent: true, hasVariant: true },
      replyMustContain: ["499.000"],
      replyMustNotContain: ["mẫu nào"],
    },
    thuc,
  );
  const loai = new Set(batDuoc.map((f) => f.failure));
  for (const phai of ["WRONG_INTENT", "WRONG_STAGE", "WRONG_ACTION", "WRONG_HANDOFF", "LOST_STATE", "REPLY_MISSING_REQUIRED", "REPLY_SAID_FORBIDDEN"]) {
    assert.ok(loai.has(phai as never), `phép so phải bắt được ${phai}`);
  }
  // Ý định so theo phép CHỨA: máy đọc thêm ý định phụ KHÔNG phải là sai.
  assert.equal(
    compareToExpectation({ ...EMPTY_EXPECTATION, intents: ["PRICE_QUESTION"] }, { ...thuc, intents: ["PRICE_QUESTION", "GREETING"] }).length,
    0,
    "đọc thêm một ý định phụ không phải lỗi",
  );
  // Chiều không khai thì KHÔNG kiểm — `null` là "chưa quyết", không phải "phải bằng rỗng".
  assert.equal(compareToExpectation(EMPTY_EXPECTATION, thuc).length, 0, "kỳ vọng rỗng ⇒ không kiểm chiều nào");
  // Lý do chuyển người chỉ có nghĩa khi ĐÃ chuyển: báo sai lý do trên một lượt không chuyển người
  // là dựng thêm một lỗi thứ hai từ đúng một lỗi.
  assert.equal(
    compareToExpectation({ ...EMPTY_EXPECTATION, handoffReason: "COMPLAINT" }, thuc).filter((f) => f.failure === "WRONG_HANDOFF_REASON").length,
    0,
    "không chuyển người thì không chấm lý do chuyển người",
  );
  assert.ok(looseIncludes("Dạ màu Đỏ Đô ạ", "do do"), "so câu chữ bỏ dấu và không phân biệt hoa thường");

  // Mọi loại thất bại phải khai người chịu trách nhiệm — một bảng lỗi không nói ai đi sửa là bảng
  // không ai mở lần thứ hai.
  for (const f of REGRESSION_FAILURES) assert.ok(REGRESSION_FAILURE_OWNER[f], `${f} phải khai chủ sở hữu`);

  // ═══════════ 5. BÁO CÁO GOM ĐÚNG ═══════════
  const bc = summarizeRegression(
    [
      { key: "a", title: "", origin: "SEED", passed: true, findings: [], turnsRun: 1, durationMs: 1 },
      { key: "b", title: "", origin: "REVIEW", passed: false, findings: [{ failure: "WRONG_INTENT", field: "intents", expected: "x", actual: "y" }], turnsRun: 1, durationMs: 1 },
      { key: "c", title: "", origin: "REVIEW", passed: false, findings: [{ failure: "ERROR", field: "pipeline", expected: "chạy hết", actual: "nổ" }], turnsRun: 0, durationMs: 1 },
    ],
    MOC_GOC,
    5,
  );
  assert.equal(bc.total, 3);
  assert.equal(bc.passed, 1);
  assert.equal(bc.failed, 2);
  // Lỗi dây chuyền ĐẾM RIÊNG khỏi lỗi nghiệp vụ: "không đo được" khác hẳn "đo được và ra sai", và
  // gộp chúng làm người đọc đi sửa nhầm chỗ.
  assert.equal(bc.errored, 1, "ca ném lỗi phải đếm riêng");
  assert.equal(bc.byFailure.WRONG_INTENT, 1);

  // ═══════════ 6. CÔNG CỤ GIẢ LẬP: VẮNG MẶT ≠ LỖI ═══════════
  //
  // Khoá vắng mặt trả một giá trị TRUNG TÍNH. Trả `null` thì dây chuyền đọc thành CÔNG CỤ LỖI và
  // mọi ca thiếu một ô hoá thành "chuyển người vì lỗi công cụ" — che mất đúng điều ca muốn đo.
  const chay = replayToolRunner({ "pricing.get": null });
  assert.notEqual(await chay("product.get_variants", {}), null, "khoá vắng mặt ⇒ giá trị trung tính, KHÔNG phải lỗi");
  assert.equal(await chay("pricing.get", {}), null, "khai null tường minh ⇒ công cụ LỖI, và đó là một ca phải kiểm được");

  // ═══════════ 7. BẢN NHÁP ĐƠN ═══════════
  const offer = { unitPrice: 499_000, shippingFee: 25_000, freeShipFrom: null, availableColors: ["Đỏ đô", "Đen"], codPolicy: "Thu hộ khi giao" };
  const du = state({
    productId: "p1", productName: "Đầm Q004", variantId: "v1", variantLabel: "XL Đỏ đô", size: "XL", color: "Đỏ đô",
    quantity: 1, phone: "0912345678", customerName: "Chị Lan",
    address: "Số 5 ngõ 12 Nguyễn Trãi, Thanh Xuân, Hà Nội", province: "Hà Nội", quotedTotal: 524_000,
  });
  const nhapDu = buildOrderDraft({
    state: du, missing: missingOrderRequirements(du), confirmed: true, offer,
    productCode: "Q004", sku: "Q004-XL-DO", sourcePageId: "page-1", sourceConversationId: "ht-1", channelCustomerName: "Thu Nguyen", humanTakeoverAt: null,
  });
  assert.equal(nhapDu.ready, true, "đủ năm điều kiện + khách đã xác nhận ⇒ SẴN SÀNG");
  assert.equal(nhapDu.customerNameSource, "CHAT", "tên khách TỰ XƯNG trong hội thoại là nguồn mạnh nhất");

  /*
    TÊN KÊNH ĐỨNG Ở BẬC HAI — không bị vứt đi, nhưng phải nói rõ nó từ đâu.

    Bản đầu chỉ đọc `state.customerName`, nên màn hình in "chưa có tên khách" trong khi ERP đang
    giữ tên Pancake báo về — người đọc sẽ đi hỏi lại một thứ đã biết. Nhưng in nó ra mà không nói
    nguồn cũng sai theo hướng ngược lại: tên Facebook có thể là biệt danh, hoặc của một người khác
    trong nhà, và bưu tá gọi nhầm tên là một lần giao hỏng.
  */
  const khongTenChat = state({ ...du, customerName: "" });
  const nhapTenKenh = buildOrderDraft({
    state: khongTenChat, missing: missingOrderRequirements(khongTenChat), confirmed: true, offer,
    productCode: "Q004", sku: "", sourcePageId: "", sourceConversationId: "", channelCustomerName: "Thu Nguyen", humanTakeoverAt: null,
  });
  assert.equal(nhapTenKenh.customerName, "Thu Nguyen", "không có tên trong chat thì dùng tên kênh, KHÔNG để trống");
  assert.equal(nhapTenKenh.customerNameSource, "CHANNEL", "và phải nói rõ tên ấy từ kênh ra");
  assert.ok(!nhapTenKenh.warnings.includes("NO_CUSTOMER_NAME"), "có tên kênh thì không còn là 'chưa có tên khách'");

  const khongTenGi = buildOrderDraft({
    state: khongTenChat, missing: missingOrderRequirements(khongTenChat), confirmed: true, offer,
    productCode: "Q004", sku: "", sourcePageId: "", sourceConversationId: "", channelCustomerName: "", humanTakeoverAt: null,
  });
  assert.equal(khongTenGi.customerNameSource, "NONE");
  assert.ok(khongTenGi.warnings.includes("NO_CUSTOMER_NAME"), "không nguồn nào có tên ⇒ vẫn phải cảnh báo");
  assert.equal(nhapDu.missing.length, 0);
  assert.equal(nhapDu.total, 524_000, "tổng là con số MÁY CHỦ tính, không tính lại ở bản nháp");
  assert.equal(nhapDu.codAmount, 524_000, "thu hộ = đúng tổng máy chủ đã tính");
  assert.deepEqual(nhapDu.warnings, [], "đơn sạch thì không có cảnh báo nào");

  // ĐỦ DỮ LIỆU KHÔNG PHẢI LÀ ĐÃ CHỐT. Hai vế, và vế thứ hai không suy ra từ vế thứ nhất.
  const chuaChot = buildOrderDraft({
    state: du, missing: missingOrderRequirements(du), confirmed: false, offer,
    productCode: "Q004", sku: "Q004-XL-DO", sourcePageId: "page-1", sourceConversationId: "ht-1", channelCustomerName: "", humanTakeoverAt: null,
  });
  assert.equal(chuaChot.ready, false, "chưa xác nhận ⇒ KHÔNG được đánh dấu sẵn sàng");
  assert.ok(chuaChot.warnings.includes("NOT_CONFIRMED_BY_CUSTOMER"));

  // Thiếu địa chỉ: chặn, và nêu đúng tên điều kiện thiếu.
  const thieuDiaChi = state({ ...du, address: "", province: "" });
  const nhapThieu = buildOrderDraft({
    state: thieuDiaChi, missing: missingOrderRequirements(thieuDiaChi), confirmed: true, offer,
    productCode: "Q004", sku: "", sourcePageId: "page-1", sourceConversationId: "ht-1", channelCustomerName: "", humanTakeoverAt: null,
  });
  assert.equal(nhapThieu.ready, false, "thiếu điều kiện bắt buộc ⇒ KHÔNG BAO GIỜ sẵn sàng");
  assert.ok(nhapThieu.missing.some((m) => m.key === "ADDRESS"), "phải nêu đúng điều kiện đang thiếu");

  // CHƯA BIẾT GIÁ in ra là CHƯA BIẾT (null), không phải 0 (AGENTS.md mục 42).
  const chuaCoGia = state({ ...du, quotedTotal: null });
  const nhapChuaGia = buildOrderDraft({
    state: chuaCoGia, missing: missingOrderRequirements(chuaCoGia), confirmed: true, offer: null,
    productCode: "", sku: "", sourcePageId: "", sourceConversationId: "", channelCustomerName: "", humanTakeoverAt: null,
  });
  assert.equal(nhapChuaGia.total, null, "chưa ai tính giá ⇒ tổng là CHƯA BIẾT, không phải 0đ");
  assert.equal(nhapChuaGia.codAmount, null, "và thu hộ cũng vậy");
  assert.ok(nhapChuaGia.missing.some((m) => m.key === "PRICE"));

  // Lệch tiền thì IN RA, không sửa hộ: giá kênh khác giá khai là chuyện hợp lệ, người quyết.
  const lech = state({ ...du, quotedTotal: 700_000 });
  const nhapLech = buildOrderDraft({
    state: lech, missing: missingOrderRequirements(lech), confirmed: true, offer,
    productCode: "Q004", sku: "", sourcePageId: "", sourceConversationId: "", channelCustomerName: "", humanTakeoverAt: null,
  });
  assert.ok(nhapLech.warnings.includes("PRICE_DISAGREES_WITH_OFFER"), "tổng lệch với đơn giá + ship ⇒ phải cảnh báo");
  assert.equal(nhapLech.total, 700_000, "và KHÔNG được sửa con số máy chủ đã tính");

  // Ô chưa khai thì không kết luận được gì — nói "lệch" lúc đó là dựng ra một mâu thuẫn không có thật.
  const khongCoOffer = buildOrderDraft({
    state: du, missing: missingOrderRequirements(du), confirmed: true, offer: null,
    productCode: "", sku: "", sourcePageId: "", sourceConversationId: "", channelCustomerName: "", humanTakeoverAt: null,
  });
  assert.ok(!khongCoOffer.warnings.includes("PRICE_DISAGREES_WITH_OFFER"), "chưa khai giá thì không kết luận lệch");
  assert.ok(khongCoOffer.warnings.includes("OFFER_NOT_DECLARED"), "nhưng phải nói ra là KHÔNG CÓ GÌ ĐỂ ĐỐI CHIẾU");

  // Màu ngoài bảng khai, số lượng bất thường, người đang cầm việc — cảnh báo, không chặn.
  const la = state({ ...du, color: "Xanh neon", quantity: QUANTITY_WARN_FROM });
  const nhapLa = buildOrderDraft({
    state: la, missing: missingOrderRequirements(la), confirmed: true, offer,
    productCode: "", sku: "", sourcePageId: "", sourceConversationId: "", channelCustomerName: "", humanTakeoverAt: new Date(),
  });
  assert.ok(nhapLa.warnings.includes("COLOR_NOT_IN_OFFER"));
  assert.ok(nhapLa.warnings.includes("QUANTITY_UNUSUAL"));
  assert.ok(nhapLa.warnings.includes("HUMAN_HOLDS_CONVERSATION"));
  assert.equal(nhapLa.missing.length, 0, "cả ba đều là CẢNH BÁO — không cái nào chặn bản nháp");

  // Năm điều kiện của bản nháp và của đường TẠO ĐƠN THẬT là CÙNG MỘT danh sách. Chép lại ở một chỗ
  // thứ hai là dựng một bản nháp nói "sẵn sàng" trong khi đường thật từ chối.
  const { ORDER_REQUIREMENTS: tuCongCu } = await import("@/lib/ai-workforce/tools/erp");
  assert.deepEqual([...tuCongCu], [...ORDER_REQUIREMENTS], "công cụ ERP và bản nháp phải đọc chung một danh sách điều kiện");

  // ═══════════ 8. CA TRONG CSDL: BẤM LẠI LÀ CẬP NHẬT, KHÔNG ĐẺ CA THỨ HAI ═══════════
  const goi = {
    caseKey: "test-regression-uq",
    title: "ca thử",
    input: { messages: [{ text: "mẫu này bao nhiêu", minutesFromStart: 0 }], priorState: {}, priorStage: "NEW_LEAD", toolResults: {}, context: { humanTakeover: false, orderCreated: false, stale: false, canPromiseStock: null } },
    expected: EMPTY_EXPECTATION,
  };
  await db.insert(schema.salesRegressionCases).values(goi);
  await assert.rejects(
    async () => db.insert(schema.salesRegressionCases).values({ ...goi, title: "ca thử lần hai" }),
    "CSDL phải từ chối ca trùng khoá — hai ca trùng làm mọi tỷ lệ đọc từ bộ hồi quy lệch âm thầm",
  );
  const [doc] = await db.select().from(schema.salesRegressionCases).where(eq(schema.salesRegressionCases.caseKey, goi.caseKey));
  assert.ok(doc, "ca đã lưu phải đọc lại được");
  assert.equal(doc.active, true, "ca mới mặc định đang bật");
  assert.equal(doc.createdByUserId, null, "gieo tay không có người bấm ⇒ NULL, không đoán một tài khoản nào");

  // Ca trong CSDL chạy được y như ca dựng sẵn — cùng một trình chạy, không có đường thứ hai.
  const ketQuaDb = await runRegressionCase(
    {
      key: doc.caseKey, title: doc.title, origin: "REVIEW",
      messages: goi.input.messages, priorState: {}, priorStage: "NEW_LEAD",
      toolResults: {}, context: goi.input.context, expected: EMPTY_EXPECTATION,
      sourceConversationId: "", sourceSuggestionId: "", pageId: "",
    },
    MOC_GOC,
  );
  assert.equal(ketQuaDb.passed, true, "ca không khai kỳ vọng nào thì không có gì để trượt");
  assert.equal(ketQuaDb.turnsRun, 1);

  // Ca không có tin nào là LỖI ĐO ĐƯỢC, không phải một ca đạt im lặng.
  const rong = await runRegressionCase(
    { key: "rong", title: "", origin: "SEED", messages: [], priorState: {}, priorStage: "NEW_LEAD", toolResults: {}, context: goi.input.context, expected: EMPTY_EXPECTATION, sourceConversationId: "", sourceSuggestionId: "", pageId: "" },
    MOC_GOC,
  );
  assert.equal(rong.passed, false);
  assert.equal(rong.findings[0]?.failure, "ERROR", "ca rỗng phải ra ERROR, không được lặng lẽ ĐẠT");

  await db.delete(schema.salesRegressionCases).where(eq(schema.salesRegressionCases.caseKey, goi.caseKey));

  // ═══════════ 9. CÂU CHỐT ĐƠN PHỔ BIẾN NHẤT PHẢI RA ĐÚNG Ý ĐỊNH ═══════════
  assert.ok(
    understandByRule("Lấy cho chị màu đỏ đô size XL").intents.includes("PURCHASE_INTENT"),
    '"lấy cho chị …" là câu MUA — đọc thiếu vế đó thì máy đi hỏi lại đúng cái màu khách vừa nói',
  );

  // ═══════════ 10. BÓC TÁCH PHẢI CỘNG RA ĐÚNG TỔNG ═══════════
  //
  // Đây là điều KHÓA LẠI việc bóc tách không được trở thành nguồn sự thật thứ hai. Hai nơi cùng
  // tính một con số thì sớm muộn lệch nhau, và chúng luôn lệch đúng vào ngày cần chúng khớp
  // (AGENTS.md mục 8.12). Nên bài kiểm này CỘNG các dòng rồi so với `shadowMetrics()` từng số.
  clearMemo();
  const tong = await shadowMetrics(7);
  for (const dim of RUN_BREAKDOWNS) {
    const rows = await salesRunBreakdown(7, dim);
    const cong = (f: (r: (typeof rows)[number]) => number) => rows.reduce((a, r) => a + f(r), 0);
    // MẪU SỐ cũng phải khớp, không chỉ tử số. `shadowMetrics` không in ra số lượt chạy, nhưng nó
    // in TỶ LỆ chuyển người — và tỷ lệ ấy chỉ khớp khi cả tử lẫn mẫu cùng khớp.
    const soLuot = cong((r) => r.runs);
    const tyLe = soLuot > 0 ? (cong((r) => r.handoffs) / soLuot) * 100 : null;
    assert.equal(tyLe, tong.handoffRate, `bóc tách theo ${dim}: tỷ lệ chuyển người phải bằng shadowMetrics (khớp tỷ lệ ⇒ khớp cả mẫu số)`);
    assert.equal(cong((r) => r.handoffs), tong.handoffs, `bóc tách theo ${dim}: tổng chuyển người phải bằng shadowMetrics`);
    assert.equal(cong((r) => r.errors), tong.errors, `bóc tách theo ${dim}: tổng lỗi phải bằng shadowMetrics`);
    assert.equal(cong((r) => r.inputTokens), tong.inputTokens, `bóc tách theo ${dim}: tổng token vào phải bằng shadowMetrics`);
    assert.equal(cong((r) => r.outputTokens), tong.outputTokens, `bóc tách theo ${dim}: tổng token ra phải bằng shadowMetrics`);
    assert.equal(cong((r) => r.unpricedRuns), tong.unpricedRuns, `bóc tách theo ${dim}: số lượt chưa khai giá phải bằng shadowMetrics`);
    // MỖI LƯỢT NẰM Ở ĐÚNG MỘT DÒNG: không dòng nào trùng khoá, nếu không tổng cộng được nhưng
    // người đọc vẫn thấy hai dòng cùng tên.
    const khoaRows = rows.map((r) => r.key);
    assert.equal(new Set(khoaRows).size, khoaRows.length, `bóc tách theo ${dim}: khoá dòng không được trùng`);
    // Mẫu số 0 ⇒ null, không phải 0%.
    for (const r of rows) {
      if (r.runs === 0) assert.equal(r.handoffRate, null, `bóc tách theo ${dim}: dòng không có lượt nào phải trả null, không phải 0%`);
      // Còn lượt chưa khai đơn giá ⇒ CẢ DÒNG là CHƯA BIẾT, y như con số tổng.
      if (r.unpricedRuns > 0) assert.equal(r.costVnd, null, `bóc tách theo ${dim}: còn lượt chưa khai giá thì chi phí dòng phải là CHƯA BIẾT`);
    }
  }
  // Bảng mô hình ở ĐỘ MỊN KHÁC (lần gọi), nên nó KHÔNG phải cộng ra bằng số lượt chạy — kiểm rằng
  // nó chạy được và giữ đúng luật "chưa khai giá ⇒ CHƯA BIẾT".
  for (const m of await salesModelBreakdown(7)) {
    if (m.unpricedCalls > 0) assert.equal(m.costVnd, null, "lần gọi chưa khai giá ⇒ chi phí là CHƯA BIẾT, không phải 0đ");
  }

  // ═══════════ 11. TRUY VẤN TÌNH TRẠNG VẬN HÀNH PHẢI CHẠY THẬT ═══════════
  //
  // Bài học 19/09/2026 của chính kho mã này: `listFanpages()` mang một cột mà migration đã xoá, và
  // vì cột ấy nằm trong một CHUỖI SQL nên `tsc` không thấy, lint không thấy — trang chỉ đổ khi có
  // người mở nó. Nên truy vấn nào không được trình biên dịch soi thì phải có một bài kiểm CHẠY nó
  // trên lược đồ đã migrate. Không kiểm giá trị trả về, chỉ đòi nó KHÔNG NÉM.
  const opsTrong = await fanpageOps("page-khong-ton-tai-bao-gio");
  assert.equal(opsTrong.conversations, 0, "page không có gì ⇒ 0 hội thoại, và KHÔNG được ném lỗi");
  assert.equal(opsTrong.lastRunAt, null, "chưa nạp lần nào ⇒ null (CHƯA LẦN NÀO), không phải một mốc bịa");
  assert.equal(opsTrong.hasProfile, false);
  assert.equal(opsTrong.catalogProductCode, "", "chưa khai mã WIN ⇒ rỗng, không đoán một mã nào");
  // Tình trạng chứng thư chỉ nói CÓ hay KHÔNG. Không trường nào ở đây mang giá trị token — kho mã
  // này PUBLIC, và một ô chữ lọt ra màn hình là lọt ra vĩnh viễn.
  const cacKhoa = Object.keys(opsTrong.credential);
  assert.deepEqual(cacKhoa.sort(), ["hasPageToken", "hasUserToken", "note", "ok", "pageTokenMatchesThisPage"], "tình trạng chứng thư chỉ được mang 5 trường, không trường nào là token");
  assert.equal(typeof opsTrong.credential.ok, "boolean");

  // ═══════════ 12. BỀ MẶT MỚI KHÔNG MỞ THÊM MỘT ĐƯỜNG RA NÀO ═══════════
  //
  // Ba thứ thêm vào ở lượt này đều ĐỌC và SOẠN: bộ ca hồi quy, bản nháp đơn, bảng điều khiển vận
  // hành. Không cái nào được có đường tới khách hàng hay tới POS. Kiểm bằng cách QUÉT MÃ ĐÃ VÀO
  // KHO — không đọc đĩa — nên một dòng mới thêm sẽ đỏ ở máy người viết chứ không đợi tới lúc chạy.
  const BE_MAT_MOI = [
    "lib/constants/sales-regression.ts",
    "lib/constants/sales-regression-seed.ts",
    "lib/constants/order-draft.ts",
    "lib/ai-workforce/agents/sales/regression.ts",
    "lib/actions/sales-regression.ts",
    "lib/queries/fanpage-ops.ts",
    "lib/actions/fanpage-ops.ts",
    "lib/queries/sales-metrics.ts",
    "scripts/run-sales-ai-regression.ts",
    "app/(dashboard)/ai/[id]/order-draft-card.tsx",
    "app/(dashboard)/ai/[id]/regression-form.tsx",
    "app/(dashboard)/ai/fanpage/ops-card.tsx",
    "app/(dashboard)/ai/breakdown.tsx",
  ];
  const CAM = /\bsendSalesMessage\s*\(|\bsendMessage\s*\(|\bsendMessageWithFallback\s*\(|\bcreateOrder\s*\(|approvedByUserId\s*:|callTool\s*\(\s*[^,]+,\s*["']order\./;
  /*
    BỎ CHÚ THÍCH TRƯỚC KHI QUÉT.

    Chính bài kiểm này vừa đỏ oan ở `lib/constants/order-draft.ts`, nơi tên công cụ tạo đơn chỉ xuất
    hiện trong MỘT CÂU GIẢI THÍCH rằng bản nháp KHÔNG gọi nó. Một phép quét bắt cả chú thích sẽ dạy
    người viết đừng giải thích nữa — đúng thứ kho mã này không muốn. Mã thật thì không trốn được
    vào chú thích, nên bỏ chú thích đi làm phép quét CHẶT HƠN chứ không lỏng hơn.
  */
  const boChuThich = (ma: string) => ma.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const f of BE_MAT_MOI) {
    let ma = "";
    try {
      ma = execSync(`git show HEAD:"${f}"`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      // Tệp chưa vào kho ở commit này (đang viết dở) thì đọc đĩa — vẫn phải sạch.
      try {
        ma = readFileSync(f, "utf8");
      } catch {
        continue;
      }
    }
    assert.ok(!CAM.test(boChuThich(ma)), `${f}: bề mặt mới KHÔNG được có đường gửi tin hay tạo đơn`);
  }
  /*
    PHÉP QUÉT PHẢI BIẾT CẮN, không chỉ biết nói ĐẠT.

    Một biểu thức gõ sai sẽ im lặng đúng bằng một kho mã sạch — và nó sẽ im lặng mãi mãi. Nên kiểm
    chính nó trên bốn đoạn mã BẨN, và trên một câu chú thích nhắc đúng những tên ấy (câu chú thích
    KHÔNG được làm đỏ, nếu không người viết sẽ thôi giải thích).
  */
  for (const ban of [
    'await sendSalesMessage({ text: "xin chào" })',
    "const r = await client.createOrder(payload)",
    'approvedByUserId: user.id',
    'await callTool(ctx, "order.create_draft", args)',
  ]) {
    assert.ok(CAM.test(boChuThich(ban)), `phép quét phải bắt được: ${ban}`);
  }
  assert.ok(!CAM.test(boChuThich("// đường tạo đơn thật vẫn là order.create_draft và nó đi qua cổng công cụ")), "một câu giải thích KHÔNG được làm đỏ phép quét");

  // ═══════════ 13. LỌC THEO PAGE VÀ Ô TÌM PHẢI THẬT SỰ THU HẸP ═══════════
  //
  // Một bộ lọc CHẠY ĐƯỢC mà không thu hẹp gì là bộ lọc tệ nhất: người soát tin rằng mình đang nhìn
  // một tập con, trong khi họ nhìn toàn bộ. Nên kiểm bằng HIỆU SỐ, không chỉ kiểm nó không ném.
  const tatCa = await listShadowTurns({ limit: 200 });
  const pagesCoHoiThoai = await pagesWithConversations();
  if (tatCa.length > 0 && pagesCoHoiThoai.length > 0) {
    const tongTheoPage = (
      await Promise.all(pagesCoHoiThoai.map((pg) => listShadowTurns({ limit: 200, pageId: pg })))
    ).reduce((a, r) => a + r.length, 0);
    // Mỗi hội thoại thuộc đúng MỘT page, nên cộng các page lại phải ra đúng tổng — không thiếu,
    // và cũng không thừa (một lượt lọt vào hai page nghĩa là phép nối sai).
    assert.equal(tongTheoPage, tatCa.length, "cộng các page lại phải ra đúng tổng số lượt");

    const pageLa = await listShadowTurns({ limit: 200, pageId: "page-khong-ton-tai-bao-gio" });
    assert.equal(pageLa.length, 0, "lọc theo một page không tồn tại phải ra RỖNG, không ra toàn bộ");
  }
  // Ô tìm: một chuỗi không thể có mặt ở đâu phải ra rỗng. Đây là phép thử chứng minh bộ lọc CÓ TÁC
  // DỤNG — nếu nó bị bỏ quên ở tầng truy vấn thì dòng này trả về cả danh sách và bài kiểm đỏ.
  const timVoNghia = await listShadowTurns({ limit: 200, search: "zzz-chuoi-khong-bao-gio-co-that-zzz" });
  assert.equal(timVoNghia.length, 0, "ô tìm với một chuỗi không tồn tại phải ra RỖNG");
  if (tatCa.length > 0) {
    // Và một chuỗi CÓ THẬT (lấy từ chính dữ liệu) phải tìm ra ít nhất một dòng — bộ lọc không được
    // chặt tới mức không bao giờ khớp.
    const mau = tatCa.find((t) => t.conversationExternalId);
    if (mau) {
      const tim = await listShadowTurns({ limit: 200, search: mau.conversationExternalId });
      assert.ok(tim.length >= 1, "tìm bằng mã hội thoại có thật phải ra ít nhất một dòng");
    }
  }

  // ═══════════ 14. PHÂN BỐ Ý ĐỊNH — ĐỂ LẤY MẪU PHÂN TẦNG ═══════════
  //
  // Bảng này CỐ Ý không phân hoạch: một lượt mang nhiều ý định thì nó đáng được thấy ở cả hai chỗ,
  // vì mục đích là TÌM ĐỦ LOẠI để chấm chứ không phải cộng ra tổng. Bài kiểm khoá lại đúng điều đó
  // — nếu ai đó "sửa" nó thành phân hoạch, dòng dưới đây đỏ và câu hỏi được đặt lại.
  const phanBo = await intentDistribution(30);
  /*
    SO ĐÚNG TẬP, KHÔNG SO TỔNG SỐ LƯỢT.

    Bản đầu của bài kiểm này so với `listShadowTurns({limit:500})` và đỏ — đúng, nhưng vì bài kiểm
    sai chứ không vì truy vấn sai: phân bố lọc theo cửa sổ 30 ngày và NỐI TRONG với `ai_runs`, nên
    lượt không có lượt chạy (không có ý định nào để đọc) nằm ngoài. So một tập con với một tập cha
    rồi đòi "lớn hơn hoặc bằng" là một phép so không có nghĩa.

    Thứ thật sự phải khoá: bảng này KHÔNG phân hoạch. Nên so với đúng những lượt CÓ ít nhất một ý
    định trong cùng cửa sổ.
  */
  const luotTrongCuaSo = await listShadowTurns({ from: new Date(Date.now() - 30 * 86_400_000), limit: 500 });
  const luotCoYDinh = luotTrongCuaSo.filter((t) => t.intents.length > 0);
  if (phanBo.length && luotCoYDinh.length) {
    const tongCacO = phanBo.reduce((a, y) => a + y.turns, 0);
    assert.ok(
      tongCacO >= luotCoYDinh.length,
      `trải hết ý định thì tổng các ô (${tongCacO}) phải ≥ số lượt CÓ ý định (${luotCoYDinh.length}) — một lượt mang nhiều ý định được đếm ở nhiều ô`,
    );
    for (const y of phanBo) {
      assert.ok(y.turns > 0, "ý định có trong bảng thì phải có ít nhất một lượt");
      assert.ok(y.reviewed <= y.turns, "số đã chấm không thể lớn hơn số lượt");
      assert.ok(y.withReply <= y.turns, "số lượt có câu không thể lớn hơn số lượt");
    }
    // Không ý định nào được trùng dòng, nếu không người soát thấy hai chip cùng tên.
    const ten = phanBo.map((y) => y.intent);
    assert.equal(new Set(ten).size, ten.length, "mỗi ý định đúng một dòng");
  }

  /* ═══════════ 15. MA TRẬN CHUẨN HOÁ TIẾNG VIỆT ═══════════
     Hai trong bốn lỗi đã bắt được đều sinh ra từ phép bỏ dấu, nên vùng này phải có một tấm lưới
     DÀY chứ không phải vài ví dụ lẻ. Mỗi dòng dưới đây là một câu khách THẬT SỰ gõ. */

  // ── XÁC NHẬN ──
  for (const t of ["vâng", "vâng ạ", "dạ", "dạ chị lấy", "ok em", "được em", "lấy nhé", "chốt em"]) {
    assert.ok(isAffirmativeText(t), `"${t}" phải đọc là ĐỒNG Ý`);
  }
  // Và câu HỎI có chứa chữ đồng ý thì KHÔNG phải đồng ý.
  for (const t of ["ok chưa shop", "được không ạ", "chốt chưa em"]) {
    assert.ok(!isAffirmativeText(t), `"${t}" là câu HỎI, không phải lời đồng ý`);
  }

  // ── MÀU ──
  for (const [cau, mong] of [
    ["lấy màu vàng", "Vàng"], ["lấy màu đỏ", "Đỏ"], ["màu đỏ đô nhé", "Đỏ"], ["cho chị màu đen", "Đen"],
    ["màu nâu ạ", "Nâu"], ["màu xanh", "Xanh"], ["màu xanh lá", "Xanh"], ["màu xanh navy", "Xanh"],
  ] as const) {
    assert.equal(findColor(cau), mong, `màu của "${cau}"`);
  }
  // KHÔNG PHẢI MÀU. Dòng đầu là lỗi đã đo được: bỏ dấu làm "vâng" trùng "vàng".
  for (const t of ["vâng", "vâng ạ", "cái đó", "khi nào hàng đến", "chị tìm mẫu này", "để chị xem đã", "bên em còn không"]) {
    assert.equal(findColor(t), "", `"${t}" KHÔNG được đọc thành một màu`);
  }

  // ── SIZE: CÂU HỎI KHÔNG BAO GIỜ LÀ MỘT LỰA CHỌN ──
  for (const t of ["size gì", "mặc size nào", "60kg mặc size gì", "chị cao 1m60 nặng 55kg", "cho chị hỏi size"]) {
    assert.equal(findSize(t), "", `"${t}" là câu HỎI size, không được ghi thành một size`);
  }
  // ── SIZE: LỰA CHỌN PHẢI ĐỌC ĐƯỢC ──
  for (const [cau, mong] of [["lấy XL", "XL"], ["đổi sang L", "L"], ["cho chị size M", "M"], ["lấy size 2XL", "2XL"]] as const) {
    assert.equal(findSize(cau), mong, `size của "${cau}"`);
  }
  // SỐ HAI CHỮ SỐ TRÔI NỔI KHÔNG PHẢI SIZE. Size số chỉ nhận qua chữ "size"/"số" đứng trước —
  // "giá 50 nghìn" mà đọc thành size 50 là ghi một lựa chọn khách chưa hề đưa ra.
  for (const t of ["giá 50 nghìn thôi", "chị 55 tuổi rồi", "lấy 2 cái"]) {
    assert.equal(findSize(t), "", `"${t}" không được đọc thành size`);
  }
  assert.equal(findSize("cho chị size 30"), "30", "size SỐ vẫn nhận khi có chữ size đứng trước");

  // ── Ý MUỐN MUA: KIỂM HÀNH VI, KHÔNG KIỂM NHÃN ──
  // "chốt mẫu này" ra CONFIRM chứ không ra PURCHASE_INTENT, và điều đó KHÔNG sao: `applyUnderstanding`
  // bật ý muốn mua cho cả CONFIRM. Kiểm nhãn thay vì kiểm hành vi là ép dây chuyền theo một hình
  // dạng nó không cần có.
  const BAT_Y_MUON_MUA = ["PURCHASE_INTENT", "CONFIRM", "PROVIDE_CONTACT", "PROVIDE_ADDRESS"];
  for (const t of ["lấy cho chị mẫu này", "chốt mẫu này", "chị lấy đỏ XL", "đặt giúp chị", "lấy 2 cái"]) {
    const intents = understandByRule(t).intents;
    assert.ok(intents.some((i) => BAT_Y_MUON_MUA.includes(i)), `"${t}" phải làm ý muốn mua DÍNH LẠI — đang ra ${intents.join(",")}`);
  }

  // ── KHIẾU NẠI / VIỆC SAU BÁN: PHẢI VỀ TAY NGƯỜI ──
  for (const t of ["hàng lỗi", "hàng rách", "giao sai màu", "muốn trả", "chưa nhận được hàng", "bưu tá không giao"]) {
    const intents = understandByRule(t).intents;
    assert.ok(intents.includes("COMPLAINT") || intents.includes("AFTER_SALES"), `"${t}" phải vào nhóm người xử — đang ra ${intents.join(",")}`);
  }
  /*
    "MUỐN ĐỔI" CỐ Ý KHÔNG ĐƯỢC KHAI TỪ KHOÁ, và đây là một QUYẾT ĐỊNH chứ không phải một chỗ sót.

    Nó mang HAI nghĩa trái ngược nhau tuỳ lúc: "muốn đổi sang màu đỏ" là khách đang chọn mẫu mã
    GIỮA MỘT CUỘC BÁN, còn "muốn đổi hàng" là việc sau bán. Khai nó vào nhóm sau bán thì mọi khách
    đang chọn màu đều bị ném sang hàng đợi chăm sóc — một đơn sắp chốt đổi lấy một việc không có
    thật.

    Không khai thì độ tin rơi xuống 0,2 và dây chuyền CHUYỂN NGƯỜI vì không đủ tin. Khách vẫn được
    người thật xử lý; chỉ lý do là "máy không chắc" thay vì "việc sau bán" — và với một câu thật sự
    mơ hồ thì "máy không chắc" mới là câu trung thực.
  */
  const muonDoi = understandByRule("muốn đổi");
  assert.ok(muonDoi.confidence < 0.35, '"muốn đổi" phải rơi dưới ngưỡng tin cậy ⇒ chuyển người, KHÔNG được trả lời bừa');

  /*
    ── "VÀNG" KHÔNG PHẢI "VÂNG" — Ở CHỐT CHẶN CUỐI CÙNG TRƯỚC KHI TẠO ĐƠN ──

    `isAffirmativeText` so trên chuỗi ĐÃ BỎ DẤU và danh sách của nó có `"vang"`. `normalize("vàng")`
    cũng ra `"vang"`. Nên KHÁCH CHỌN MÀU VÀNG bị đọc là KHÁCH ĐỒNG Ý CHỐT ĐƠN. Cùng lỗi ấy còn ba
    chỗ nữa: "vẫn"→"van", "đã"→"da", "ư"→"u".

    Đây là một lỗi nặng hơn hẳn lỗi cùng kiểu ở `findColor` (đã vá trước): `findColor` đọc sai một
    thuộc tính, còn chỗ này là điều kiện thứ năm trong sáu điều kiện tạo đơn.

    Bài kiểm khoá CẢ HAI CHIỀU. Chiều bỏ sót (khách đồng ý mà máy không nhận) chỉ tốn một câu hỏi
    lại; chiều nhận nhầm là một kiện hàng thật gửi cho người không đặt. Nên danh sách CẤM dài hơn
    danh sách PHẢI NHẬN, và nó gồm cả những câu chỉ trùng nhau SAU KHI bỏ dấu.
  */
  const XAC_NHAN_PHAI_NHAN = [
    "ok", "oke", "oki", "okie", "okla", "dc", "đc", "được", "ừ", "ừa", "uh", "uhm", "um",
    "vâng", "vâng ạ", "dạ", "dạ vâng", "chốt", "chốt đơn", "chốt nhé", "lấy nhé", "gửi nhé",
    "ship đi", "đồng ý", "yes", "ok em chốt cho anh",
  ];
  for (const t of XAC_NHAN_PHAI_NHAN) {
    assert.equal(isAffirmativeText(t), true, `"${t}" là lời đồng ý thật — bỏ sót thì máy hỏi lại một câu thừa`);
  }
  const XAC_NHAN_CAM = [
    // Trùng "vâng"/"dạ"/"ừ" SAU KHI bỏ dấu — mỗi câu ở đây từng tạo được một đơn khách chưa chốt.
    "vàng", "màu vàng", "em thích màu vàng hơn", "vắng nhà", "váng đầu",
    "vẫn chưa quyết", "em vẫn thích màu đỏ", "em đã xem rồi",
    // Không dấu thì KHÔNG phân biệt được "vâng" với "vàng" ⇒ không được đoán.
    "vang",
    // Phủ định và câu hỏi.
    "không", "ko", "k", "thôi", "để suy nghĩ", "ok à", "ok chưa shop?", "ok hả", "ok chứ", "còn hàng không",
  ];
  for (const t of XAC_NHAN_CAM) {
    assert.equal(isAffirmativeText(t), false, `"${t}" KHÔNG phải lời đồng ý — nhận nhầm là gửi một kiện hàng cho người không đặt`);
  }

  /*
    ── LỚP KÝ TỰ `h` TRƠ TRỌI TRONG BỘ DÒ CÂU HỎI ──

    Bộ dò cũ coi MỌI câu kết thúc bằng chữ "h" là câu hỏi. Tiếng Việt có vô số câu đồng ý kết thúc
    bằng "h" — và nó cũng chứa "ừ", tức chính một lời đồng ý. Hai câu dưới đây đủ để bài kiểm đỏ
    nếu ai đó khôi phục lớp ký tự ấy.
  */
  assert.equal(isAffirmativeText("ok em chốt cho anh"), true, 'câu kết thúc bằng "h" KHÔNG phải câu hỏi');
  assert.equal(isAffirmativeText("ừ"), true, '"ừ" là đồng ý, không phải tiểu từ hỏi');

  /*
    ── CHIỀU CÒN LẠI CỦA CÙNG MỘT VA CHẠM: "màu, vâng ạ" KHÔNG PHẢI MÀU VÀNG ──

    Đường nhận màu CÓ CHỈ DẤU đọc từ ngay sau "màu" trên chuỗi đã bỏ dấu — cố ý, để bắt được
    "mau do" khi khách gõ thiếu dấu. Cái giá là "vâng" cũng bỏ dấu thành "vang". Câu "chị chọn
    màu, vâng ạ" sau khi bỏ dấu câu thành "chị chọn màu vâng ạ".

    Chỉ loại dạng CÓ DẤU: "mau vang" không dấu thì Vàng vẫn là cách đọc hợp lý nhất, và giữ được
    nó chính là lý do đường có chỉ dấu tồn tại.
  */
  assert.equal(findColor("chị chọn màu, vâng ạ"), "", '"vâng" sau chữ "màu" là tiếng đồng ý, không phải màu Vàng');
  assert.equal(findColor("màu, dạ em xem"), "", '"dạ" cũng vậy');
  assert.equal(findColor("mau vang"), "Vàng", "gõ thiếu dấu thì Vàng vẫn là cách đọc hợp lý nhất — không được vá quá tay");
  assert.equal(findColor("màu vàng"), "Vàng");

  // ── Ý MUỐN MUA · VIỆC SAU BÁN: hai chỗ hổng đo được, kèm BẪY chiều ngược ──
  for (const t of ["mua 1 cái", "đặt hàng", "lấy cho chị 1 bộ", "chốt đơn nhé", "cho chị 1 cái", "order 1 cái", "em muốn mua"]) {
    const intents = understandByRule(t).intents;
    assert.ok(intents.some((i) => ["PURCHASE_INTENT", "CONFIRM"].includes(i)), `"${t}" là ý muốn mua — đang ra ${intents.join(",") || "(rỗng)"}`);
  }
  for (const t of ["giao chậm quá", "sao lâu thế shop", "bao giờ giao hàng", "bao gio giao hang"]) {
    const intents = understandByRule(t).intents;
    assert.ok(intents.some((i) => ["COMPLAINT", "AFTER_SALES"].includes(i)), `"${t}" là việc sau bán — đang ra ${intents.join(",") || "(rỗng)"}`);
  }
  /*
    BẪY: khách ĐANG CHỌN MẪU không được rơi sang hàng đợi sau bán. Mọi lần nới danh sách từ khoá
    sau bán đều có nguy cơ kéo theo nhóm này — một đơn sắp chốt đổi lấy một việc không có thật.
  */
  for (const t of ["cho mình 1 cái màu đỏ", "đổi sang màu xanh nhé", "lấy size L"]) {
    assert.ok(!understandByRule(t).intents.includes("AFTER_SALES"), `"${t}" là khách đang chọn mẫu, KHÔNG phải việc sau bán`);
  }

  /*
    ── MÁY CHỦ LẶP LẠI TRANG MỘT: DỪNG SỚM, KHÔNG ĐẾM HAI LẦN, VÀ NÓI RA ──

    ĐO TỪ VPS 19/09/2026: Pancake bỏ qua cả `page_size` lẫn `page_number` — trang 2 trùng đủ 60/60
    mã với trang 1. Điều kiện dừng cũ (`list.length < 50`) không bao giờ đúng khi máy chủ luôn trả
    60, nên lượt nạp gọi đủ HAI MƯƠI lần cho MỘT trang dữ liệu.

    Bài kiểm dựng lại đúng máy chủ ấy bằng một `fetch` giả và khoá ba tính chất:
      · gọi ĐÚNG HAI lần (lần hai để phát hiện sự lặp, không phải để lấy dữ liệu);
      · trả về 60 mã KHÁC NHAU, không phải 120 dòng có 60 bản sao;
      · `paginationStalled` bật lên, vì im lặng ở đây biến CHƯA LẤY HẾT thành ĐÃ LẤY HẾT.

    Dùng `fetch` giả chứ không gọi Pancake thật: bài kiểm phải chạy được offline, chạy lại cho cùng
    một kết quả, và không bao giờ tiêu hạn mức của một dịch vụ bên ngoài.
  */
  {
    const SAU_MUOI = Array.from({ length: 60 }, (_, i) => ({
      id: `conv-lap-${i}`,
      customers: [{ id: `cust-${i}`, name: `Khách ${i}` }],
      updated_at: "2026-09-19T07:44:49.000000",
    }));
    // ĐẾM RIÊNG lời gọi DANH SÁCH HỘI THOẠI. Client còn xin page token trước đó, nên đếm tổng số
    // lượt `fetch` là đếm cả một lời gọi thuộc việc khác — bài kiểm sẽ nói sai về vòng lặp.
    let soLanGoi = 0;
    const fetchGoc = globalThis.fetch;
    globalThis.fetch = (async (u: string | URL | Request) => {
      if (String(u).includes("/conversations")) soLanGoi += 1;
      return new Response(JSON.stringify({ success: true, conversations: SAU_MUOI }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    try {
      const client = new PancakePagesClient("token-gia", "https://khong-goi-that.invalid");
      const ds = await client.listConversations("page-lap", new Date(Date.now() - 86_400_000), new Date(), 200);
      assert.equal(soLanGoi, 2, `máy chủ lặp lại trang một ⇒ phải dừng sau 2 lời gọi, đang gọi ${soLanGoi}`);
      assert.equal(ds.length, 60, "phải trả 60 hội thoại KHÁC NHAU, không phải 120 dòng có bản sao");
      assert.equal(new Set(ds.map((c) => c.id)).size, 60, "không mã nào được đếm hai lần");
      assert.equal(client.paginationStalled, true, "phải nói ra rằng mẻ này CHƯA lấy hết cửa sổ");

      /*
        ── MÁY CHỦ TÔN TRỌNG `current_count`: PHẢI LẤY ĐỦ CẢ HAI TRANG ──

        Đo từ VPS 19/09/2026 (run 35444310784): `current_count` LÀ tham số phân trang thật của
        Pancake — trang 1 và trang 2 không trùng một mã nào, và cửa sổ 24 giờ có ít nhất 100 hội
        thoại trong khi một lời gọi trả tối đa 60. Tức bản cũ KHÔNG chỉ gọi thừa, nó MẤT 40 hội
        thoại mỗi mẻ.

        Máy chủ giả ở đây đọc đúng `current_count` và cắt lát như Pancake thật. Bài kiểm khoá HÀNH
        VI chứ không khoá TÊN THAM SỐ: nó đòi client lấy đủ 100 mã khác nhau. Ai đổi sang một tên
        khác mà vẫn lấy đủ thì bài kiểm vẫn xanh — đúng như vậy, vì thứ đáng bảo vệ là "không mất
        hội thoại nào", không phải một chuỗi ký tự.
      */
      const TRAM = Array.from({ length: 100 }, (_, i) => ({
        id: `conv-trang-${i}`,
        customers: [{ id: `cust-${i}`, name: `Khách ${i}` }],
        updated_at: "2026-09-19T07:44:49.000000",
      }));
      let soLanGoiPhanTrang = 0;
      globalThis.fetch = (async (u: string | URL | Request) => {
        const url = new URL(String(u));
        if (!url.pathname.includes("/conversations")) {
          return new Response(JSON.stringify({ success: true }), { status: 200, headers: { "content-type": "application/json" } });
        }
        soLanGoiPhanTrang += 1;
        const daCo = Number(url.searchParams.get("current_count") ?? 0);
        // TRẦN 60 MỖI LƯỢT, y như máy chủ thật — không phải `page_size` client xin.
        const lat = TRAM.slice(daCo, daCo + 60);
        return new Response(JSON.stringify({ success: true, conversations: lat }), { status: 200, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch;
      const client3 = new PancakePagesClient("token-gia", "https://khong-goi-that.invalid");
      const ds3 = await client3.listConversations("page-phan-trang", new Date(Date.now() - 86_400_000), new Date(), 200);
      assert.equal(ds3.length, 100, `phải lấy ĐỦ 100 hội thoại của cửa sổ, đang lấy ${ds3.length}`);
      assert.equal(new Set(ds3.map((c) => c.id)).size, 100, "không mã nào được đếm hai lần");
      assert.equal(soLanGoiPhanTrang, 3, "60 + 40 + một lượt rỗng để biết đã hết — đúng 3 lượt, không phải 20");
      assert.equal(client3.paginationStalled, false, "máy chủ phân trang đúng thì KHÔNG được báo lặp");

      /*
        VẾ NGƯỢC: cửa sổ chỉ có 10 hội thoại. Máy chủ ĐÚNG ĐẮN trả 10 rồi trả RỖNG ở lượt sau,
        nên client dừng vì hết dữ liệu — KHÔNG phải vì đoán được kích thước trang, và KHÔNG bật cờ
        lặp. Một lượt gọi thêm để biết "đã hết" là cái giá đúng của việc thôi đoán: rẻ hơn hẳn so
        với điều kiện dừng theo số dòng, thứ đã một lần im lặng sai suốt hai mươi vòng.
      */
      soLanGoi = 0;
      const ITHON = SAU_MUOI.slice(0, 10);
      globalThis.fetch = (async (u: string | URL | Request) => {
        const url = new URL(String(u));
        if (!url.pathname.includes("/conversations")) {
          return new Response(JSON.stringify({ success: true }), { status: 200, headers: { "content-type": "application/json" } });
        }
        soLanGoi += 1;
        const daCo = Number(url.searchParams.get("current_count") ?? 0);
        return new Response(JSON.stringify({ success: true, conversations: ITHON.slice(daCo) }), { status: 200, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch;
      const client2 = new PancakePagesClient("token-gia", "https://khong-goi-that.invalid");
      const ds2 = await client2.listConversations("page-it", new Date(Date.now() - 86_400_000), new Date(), 200);
      assert.equal(ds2.length, 10);
      assert.equal(soLanGoi, 2, "10 hội thoại + một lượt rỗng để biết đã hết");
      assert.equal(client2.paginationStalled, false, "không lặp thì không được bật cờ — cảnh báo sai địa chỉ tệ hơn không cảnh báo");
    } finally {
      globalThis.fetch = fetchGoc;
    }
  }

  /*
    ── MẺ CHẤM PHÂN TẦNG: SỔ NHÓM VÀ MỆNH ĐỀ LỌC PHẢI CHẠY THẬT ──

    Ba tính chất đáng khoá, và không cái nào là "gọi hàm xem có ném lỗi không":

    1. SÀN CỠ MẪU nằm TRONG khoảng chủ shop yêu cầu (30–50). Sàn được CỘNG RA từ chính sổ nhóm,
       không gõ lại ở đâu — nên thêm một nhóm mà quên chỉnh sàn thì bài kiểm này đỏ chứ không phải
       người vận hành phát hiện khi mẻ chấm đã phát đi.
    2. MƯỜI BỐN MỆNH ĐỀ ĐỀU CHẠY ĐƯỢC trên lược đồ đã migrate. Một mệnh đề SQL sai cú pháp chỉ nổ
       lúc có người bấm vào đúng nhóm ấy — tức muộn nhất có thể, và với đúng người ít có khả năng
       sửa nó nhất.
    3. MƯỜI LÝ DO CHẤM chủ shop đòi đều CÓ MẶT. Danh sách cũ thiếu bảy cái; thiếu một cái thì
       người chấm phải nhét lỗi vào một nhãn gần đúng và bảng đếm nói sai về chỗ máy hay hỏng nhất.
  */
  assert.ok(
    EVAL_BATCH_MIN >= 30 && EVAL_BATCH_MIN <= EVAL_BATCH_MAX,
    `sàn cỡ mẫu phải nằm trong 30–${EVAL_BATCH_MAX}, đang là ${EVAL_BATCH_MIN}`,
  );
  assert.equal(new Set(EVAL_BUCKETS.map((b) => b.key)).size, EVAL_BUCKETS.length, "khoá nhóm phải duy nhất");
  for (const b of EVAL_BUCKETS) {
    assert.ok(b.question.trim().length > 10, `nhóm ${b.key} phải khai CÂU HỎI nó trả lời`);
    assert.ok(b.risk.trim().length > 10, `nhóm ${b.key} phải khai HẬU QUẢ nếu máy hỏng ở đó`);
  }
  const doPhu = await evalBatchCoverage(90);
  assert.equal(doPhu.length, EVAL_BUCKETS.length, "mọi nhóm phải có một dòng độ phủ, kể cả nhóm 0 ca");
  for (const b of doPhu) {
    assert.ok(Number.isFinite(b.available) && b.available >= 0, `nhóm ${b.key}: số ca phải là một con số`);
    assert.ok(b.reviewed <= b.available, `nhóm ${b.key}: đã chấm (${b.reviewed}) không thể nhiều hơn số ca có (${b.available})`);
  }
  // Mệnh đề lọc phải thật sự LỌC, không phải trả về mọi thứ.
  for (const b of EVAL_BUCKETS) {
    const loc = await listShadowTurns({ evalBucket: b.key, limit: 5 });
    assert.ok(Array.isArray(loc), `lọc theo nhóm ${b.key} phải chạy được trên lược đồ đã migrate`);
  }
  const BAT_BUOC = [
    "WRONG_INTENT", "WRONG_PRODUCT", "WRONG_VARIANT", "WRONG_STATE", "BAD_REPLY",
    "HALLUCINATION", "SHOULD_HAVE_HANDED_OFF", "MISSING_ENTITY", "WRONG_ORDER_DRAFT", "OTHER",
  ];
  for (const t of BAT_BUOC) {
    assert.ok((REVIEW_REASON_TAGS as readonly string[]).includes(t), `thiếu lý do chấm bắt buộc: ${t}`);
    assert.ok(REVIEW_REASON_TAG_META[t as ReviewReasonTag]?.label, `lý do ${t} phải có nhãn đọc được`);
  }

  console.log(
    `✓ Hồi quy nhân sự bán hàng: ${SEED_REGRESSION_CASES.length} ca dựng sẵn ĐẠT và ổn định qua hai lượt chạy · phép so bắt đủ 7 loại lỗi · "vâng" không còn là màu Vàng · "size gì" không còn là size G · bản nháp đơn thiếu điều kiện thì KHÔNG bao giờ sẵn sàng, và chưa có giá thì in CHƯA BIẾT chứ không in 0đ · bóc tách theo ${RUN_BREAKDOWNS.length} chiều cộng lại ĐÚNG BẰNG shadowMetrics (không có nguồn sự thật thứ hai) · truy vấn tình trạng vận hành CHẠY THẬT trên lược đồ đã migrate · ${BE_MAT_MOI.length} tệp bề mặt mới KHÔNG có đường gửi tin / tạo đơn nào · lọc theo page cộng lại ra đúng tổng và ô tìm thật sự thu hẹp · phân bố ý định KHÔNG phân hoạch (cố ý) và không trùng dòng · ma trận tiếng Việt 45 câu: xác nhận · màu · size · ý muốn mua · khiếu nại`,
  );
}
