import assert from "node:assert/strict";
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
import { RUN_BREAKDOWNS, salesModelBreakdown, salesRunBreakdown } from "@/lib/queries/sales-metrics";
import { shadowMetrics } from "@/lib/queries/sales-review";
import { clearMemo } from "@/lib/cache";
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
    productCode: "Q004", sku: "Q004-XL-DO", sourcePageId: "page-1", sourceConversationId: "ht-1", humanTakeoverAt: null,
  });
  assert.equal(nhapDu.ready, true, "đủ năm điều kiện + khách đã xác nhận ⇒ SẴN SÀNG");
  assert.equal(nhapDu.missing.length, 0);
  assert.equal(nhapDu.total, 524_000, "tổng là con số MÁY CHỦ tính, không tính lại ở bản nháp");
  assert.equal(nhapDu.codAmount, 524_000, "thu hộ = đúng tổng máy chủ đã tính");
  assert.deepEqual(nhapDu.warnings, [], "đơn sạch thì không có cảnh báo nào");

  // ĐỦ DỮ LIỆU KHÔNG PHẢI LÀ ĐÃ CHỐT. Hai vế, và vế thứ hai không suy ra từ vế thứ nhất.
  const chuaChot = buildOrderDraft({
    state: du, missing: missingOrderRequirements(du), confirmed: false, offer,
    productCode: "Q004", sku: "Q004-XL-DO", sourcePageId: "page-1", sourceConversationId: "ht-1", humanTakeoverAt: null,
  });
  assert.equal(chuaChot.ready, false, "chưa xác nhận ⇒ KHÔNG được đánh dấu sẵn sàng");
  assert.ok(chuaChot.warnings.includes("NOT_CONFIRMED_BY_CUSTOMER"));

  // Thiếu địa chỉ: chặn, và nêu đúng tên điều kiện thiếu.
  const thieuDiaChi = state({ ...du, address: "", province: "" });
  const nhapThieu = buildOrderDraft({
    state: thieuDiaChi, missing: missingOrderRequirements(thieuDiaChi), confirmed: true, offer,
    productCode: "Q004", sku: "", sourcePageId: "page-1", sourceConversationId: "ht-1", humanTakeoverAt: null,
  });
  assert.equal(nhapThieu.ready, false, "thiếu điều kiện bắt buộc ⇒ KHÔNG BAO GIỜ sẵn sàng");
  assert.ok(nhapThieu.missing.some((m) => m.key === "ADDRESS"), "phải nêu đúng điều kiện đang thiếu");

  // CHƯA BIẾT GIÁ in ra là CHƯA BIẾT (null), không phải 0 (AGENTS.md mục 42).
  const chuaCoGia = state({ ...du, quotedTotal: null });
  const nhapChuaGia = buildOrderDraft({
    state: chuaCoGia, missing: missingOrderRequirements(chuaCoGia), confirmed: true, offer: null,
    productCode: "", sku: "", sourcePageId: "", sourceConversationId: "", humanTakeoverAt: null,
  });
  assert.equal(nhapChuaGia.total, null, "chưa ai tính giá ⇒ tổng là CHƯA BIẾT, không phải 0đ");
  assert.equal(nhapChuaGia.codAmount, null, "và thu hộ cũng vậy");
  assert.ok(nhapChuaGia.missing.some((m) => m.key === "PRICE"));

  // Lệch tiền thì IN RA, không sửa hộ: giá kênh khác giá khai là chuyện hợp lệ, người quyết.
  const lech = state({ ...du, quotedTotal: 700_000 });
  const nhapLech = buildOrderDraft({
    state: lech, missing: missingOrderRequirements(lech), confirmed: true, offer,
    productCode: "Q004", sku: "", sourcePageId: "", sourceConversationId: "", humanTakeoverAt: null,
  });
  assert.ok(nhapLech.warnings.includes("PRICE_DISAGREES_WITH_OFFER"), "tổng lệch với đơn giá + ship ⇒ phải cảnh báo");
  assert.equal(nhapLech.total, 700_000, "và KHÔNG được sửa con số máy chủ đã tính");

  // Ô chưa khai thì không kết luận được gì — nói "lệch" lúc đó là dựng ra một mâu thuẫn không có thật.
  const khongCoOffer = buildOrderDraft({
    state: du, missing: missingOrderRequirements(du), confirmed: true, offer: null,
    productCode: "", sku: "", sourcePageId: "", sourceConversationId: "", humanTakeoverAt: null,
  });
  assert.ok(!khongCoOffer.warnings.includes("PRICE_DISAGREES_WITH_OFFER"), "chưa khai giá thì không kết luận lệch");
  assert.ok(khongCoOffer.warnings.includes("OFFER_NOT_DECLARED"), "nhưng phải nói ra là KHÔNG CÓ GÌ ĐỂ ĐỐI CHIẾU");

  // Màu ngoài bảng khai, số lượng bất thường, người đang cầm việc — cảnh báo, không chặn.
  const la = state({ ...du, color: "Xanh neon", quantity: QUANTITY_WARN_FROM });
  const nhapLa = buildOrderDraft({
    state: la, missing: missingOrderRequirements(la), confirmed: true, offer,
    productCode: "", sku: "", sourcePageId: "", sourceConversationId: "", humanTakeoverAt: new Date(),
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

  console.log(
    `✓ Hồi quy nhân sự bán hàng: ${SEED_REGRESSION_CASES.length} ca dựng sẵn ĐẠT và ổn định qua hai lượt chạy · phép so bắt đủ 7 loại lỗi · "vâng" không còn là màu Vàng · "size gì" không còn là size G · bản nháp đơn thiếu điều kiện thì KHÔNG bao giờ sẵn sàng, và chưa có giá thì in CHƯA BIẾT chứ không in 0đ · bóc tách theo ${RUN_BREAKDOWNS.length} chiều cộng lại ĐÚNG BẰNG shadowMetrics (không có nguồn sự thật thứ hai) · truy vấn tình trạng vận hành CHẠY THẬT trên lược đồ đã migrate`,
  );
}
