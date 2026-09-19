import assert from "node:assert/strict";
import { METRIC_BINDINGS } from "@/lib/constants/metric-bindings";
import { METRIC_CATALOG } from "@/lib/constants/metric-catalog";
import { canTargetPerson, canTargetProduct, metricOf, scopesFor, TARGETABLE_KEYS, TARGET_PRECEDENCE, TARGET_SCOPES } from "@/lib/constants/metric-registry";
import { PERIOD_KINDS, delta, resolveTarget, verdict, type TargetRow } from "@/lib/constants/metric-targets";
import { attainment, evaluateMetric, trendOf, type ScorecardInput } from "@/lib/metrics/scorecard";
import { targetInput } from "@/lib/validation/metric-targets";

/**
 * ═══════════ ĐÍCH CÓ THẨM QUYỀN CHO CẢ HAI SỔ CHỈ SỐ ═══════════
 *
 * Trước bản này, `metric_targets` chỉ nhận khoá của sổ hiệu suất (14 khoá mức người/phòng). Sổ
 * chỉ số kinh doanh (14 khoá mà KR và ô BSC nối vào) KHÔNG có đường nào tới một đích có thẩm
 * quyền — `okr_key_results` tự giữ `target` riêng. Nên "tỷ lệ hoàn" có thể có hai đích khác nhau
 * ở hai màn hình, và không ai buộc chúng bằng nhau.
 */

function dich(p: Partial<TargetRow> & Pick<TargetRow, "metricKey" | "scope" | "target">): TargetRow {
  return { scopeRef: null, targetMax: null, warningAt: null, criticalAt: null, periodKind: "ANY", note: "", effectiveTo: null, version: 1, ownerDepartment: null, effectiveFrom: new Date("2026-01-01"), ...p };
}

/* ───── 1 · Sổ gộp: dẫn xuất, không khai lại, và hai không gian khoá KHÔNG giao nhau ───── */
export function testMetricRegistry() {
  assert.equal(TARGETABLE_KEYS.length, METRIC_CATALOG.length + Object.keys(METRIC_BINDINGS).length, "sổ gộp phải chứa ĐÚNG tổng hai sổ — thừa nghĩa là có khoá khai thêm ở đây, thiếu nghĩa là có khoá bị nuốt");

  /*
    ĐIỀU KIỆN ĐỂ GỘP ĐƯỢC, nên nó được KIỂM chứ không phải được hy vọng. Một khoá trùng sẽ làm
    đích của chỉ số này âm thầm áp cho chỉ số kia, và không màn hình nào có cách nào biết.
  */
  const trung = METRIC_CATALOG.map((m) => m.key).filter((k) => k in METRIC_BINDINGS);
  assert.deepEqual(trung, [], "hai sổ chỉ số KHÔNG được có khoá trùng nhau");

  for (const k of TARGETABLE_KEYS) {
    const m = metricOf(k);
    assert.ok(m, `${k}: đọc lại không ra`);
    assert.ok(m.label && m.basis, `${k}: thiếu nhãn hoặc thiếu câu căn cứ`);
    assert.ok(!m.targetable || m.direction !== "CONTEXT", `${k}: chỉ số bối cảnh không được đánh dấu đặt-đích-được`);
    if (!m.targetable) assert.ok(m.missingWhat, `${k}: chưa đặt đích được thì phải nói rõ thiếu cái gì`);
  }

  // Chỉ số chưa có nguồn KHÔNG nối được vào đích — y như không nối được vào KR.
  assert.equal(metricOf("inventory_accuracy")?.targetable, false, "độ chính xác tồn kho khai UNAVAILABLE (chưa có kiểm kê định kỳ) nên không đặt đích được");
  assert.equal(metricOf("sales_contribution")?.targetable, false, "chỉ số ĐÓNG GÓP là bối cảnh, không có chiều tốt/xấu");
  assert.equal(metricOf("delivery_success_rate")?.targetable, true, "GTC đo được ⇒ đặt đích được — đây là thứ bản cũ không cho");
  assert.equal(metricOf("khong-co-that"), null);

  console.log(`✓ Sổ đích gộp: ${TARGETABLE_KEYS.length} khoá dẫn xuất từ hai sổ · không khoá nào trùng · chỉ số chưa có nguồn không đặt đích được`);
}

/* ───── 2 · Đặt đích cho một CON NGƯỜI: ba điều kiện, không cái nào nới được ───── */
export function testPersonTargetGuard() {
  /*
    TỶ LỆ GIAO THÀNH CÔNG vẫn KHÔNG đặt đích cho một cá nhân — kết luận không đổi, nhưng LÝ DO đã
    đổi và đó là một cải thiện chứ không phải một lần nới luật.

    Trước đây mọi chỉ số của `METRIC_BINDINGS` bị chặn chung một câu "đo ở mức công ty". Câu ấy sai
    với chính chỉ số này: đơn của một marketer ĐẾM ĐƯỢC, nên nó đọc được ở mức người thật. Thứ làm
    nó không thành điểm chấm người là ĐVVC — bưu tá giao được hay không nằm ngoài tay người bán.
    Nên nay nó bị chặn bằng cờ `shared`, đúng AGENTS.md mục 24 và 27, và câu từ chối nói đúng thứ
    người đọc cần biết để khỏi đi tìm cách "sửa" cho nó đo được ở mức người.
  */
  const congTy = canTargetPerson("delivery_success_rate");
  assert.equal(congTy.ok, false, "GTC là kết quả chung — không đặt đích cho một cá nhân");
  assert.ok(congTy.reason?.includes("KẾT QUẢ CHUNG"), "và nói rõ vì sao: ĐVVC đồng quyết định, không phải vì ERP đo không nổi");

  // Chỉ số mức CÔNG TY thật (không ai đọc được ở mức một người) vẫn bị chặn bằng đúng câu cũ.
  const mucCongTy = canTargetPerson("delivered_revenue");
  assert.equal(mucCongTy.ok, false);
  assert.ok(mucCongTy.reason?.includes("mức công ty"), "chỉ số mức công ty vẫn phải nói đúng lý do của nó");

  // Chỉ số mang cờ KẾT QUẢ CHUNG = chấm người bằng thứ họ không quyết được (AGENTS mục 24, 27).
  assert.equal(metricOf("sales_delivered_quality")?.shared, true, "đơn từ case này giao thành công — bưu tá quyết phần lớn");
  const chung = canTargetPerson("sales_delivered_quality");
  assert.equal(chung.ok, false, "chỉ số KẾT QUẢ CHUNG không được thành đích chấm một cá nhân");
  assert.ok(chung.reason?.includes("KẾT QUẢ CHUNG"));

  // Chỉ số mức NGƯỜI, không shared, đo được ⇒ đặt được.
  assert.equal(canTargetPerson("sales_followup_sla").ok, true, "trả lời/đóng case trong hạn là việc người đó tự quyết");
  assert.ok(scopesFor("sales_followup_sla").includes("USER"));
  assert.ok(!scopesFor("delivery_success_rate").includes("USER"), "ô chọn phạm vi cũng không được hiện 'Cá nhân' cho chỉ số mức công ty");
  assert.deepEqual(scopesFor("inventory_accuracy"), [], "chỉ số chưa có nguồn thì không có phạm vi nào");

  /*
    CHẶN Ở CẢ HAI LỚP — lược đồ đầu vào VÀ hàm tính (AGENTS.md mục 31: mọi nhánh lỗi rơi về phía
    HẸP HƠN). Bản trước chỉ chặn ở server action; lược đồ cho qua về hình dạng, nên bất kỳ đường
    ghi thứ hai nào quên gọi `canTargetPerson` sẽ ghi thẳng vào bảng.
  */
  const lauNgoai = targetInput.safeParse({ metricKey: "delivery_success_rate", scope: "USER", scopeRef: "u1", target: 90, note: "thử lách", effectiveFrom: "2026-01-01" });
  assert.equal(lauNgoai.success, false, "lược đồ từ chối ngay: GTC không đặt đích cho một cá nhân");
  assert.equal(canTargetPerson("delivery_success_rate").ok, false, "…và luật nghiệp vụ chặn lần nữa trước khi ghi");

  assert.ok(TARGET_PRECEDENCE.USER > TARGET_PRECEDENCE.POSITION, "cá nhân là tầng HẸP nhất trong ba tầng NGƯỜI, đè lên chức danh");

  console.log("✓ Đích cho cá nhân: chặn chỉ số mức công ty · chặn chỉ số KẾT QUẢ CHUNG · chặn chỉ số chưa có nguồn");
}

/* ───── 2b · Đích riêng cho MỘT MÃ HÀNG: chỉ mở cho chỉ số đọc được ở mức mã ───── */
export function testProductTargetGuard() {
  assert.ok(TARGET_SCOPES.includes("PRODUCT"), "PRODUCT tồn tại vì ĐÃ có chỉ số khai productGrain — trước đó nó cố ý không có");

  /*
    PRODUCT KHÔNG mở đại trà. Nó chỉ có nghĩa khi TỬ SỐ và MẪU SỐ đều đếm trên đúng tập đơn của
    mã ấy. Chỉ số mức người/phòng gắn vào một mã là chấm mã bằng con số của người; chỉ số PHÂN BỔ
    (tiền quảng cáo chia theo tỷ trọng) gắn vào một mã là đặt đích cho một phép chia.
  */
  assert.equal(canTargetProduct("delivery_success_rate").ok, true, "GTC đếm trên đúng tập vận đơn của mã ⇒ đặt được");
  assert.equal(canTargetProduct("return_rate").ok, true, "tỷ lệ hoàn cùng tập đơn ⇒ đặt được");
  const khongDuoc = canTargetProduct("care_sla");
  assert.equal(khongDuoc.ok, false, "SLA chăm sóc đo ở mức người/phòng — không đọc được trên một mã hàng");
  assert.ok(khongDuoc.reason?.includes("mã hàng"), "và nói rõ vì sao, kèm lối ra");
  assert.equal(canTargetProduct("inventory_accuracy").ok, false, "chỉ số chưa có nguồn thì mọi phạm vi đều đóng");

  // Số chỉ số mở PRODUCT phải ĐÚNG bằng số chỉ số khai cờ — không có đường nào mở thêm ở nơi khác.
  const coCo = TARGETABLE_KEYS.filter((k) => metricOf(k)?.productGrain === true);
  const moPham = TARGETABLE_KEYS.filter((k) => scopesFor(k).includes("PRODUCT"));
  assert.deepEqual(moPham.sort(), coCo.sort(), "ô chọn phạm vi phải suy từ CỜ trong sổ chỉ số, không phải từ một danh sách thứ hai");
  assert.ok(!scopesFor("care_sla").includes("PRODUCT"), "ô chọn không được hiện 'Mã hàng' cho chỉ số mức người");

  // Lược đồ đầu vào chặn CÙNG một luật — hai lớp, vì một lớp sẽ có ngày bị đi vòng (mục 31).
  const lach = targetInput.safeParse({ metricKey: "care_sla", scope: "PRODUCT", scopeRef: "Q004", target: 80, note: "thử lách", effectiveFrom: "2026-01-01" });
  assert.equal(lach.success, false, "lược đồ từ chối phạm vi không hợp lệ với chỉ số");

  const cuoiKy = new Date("2026-09-30T00:00:00Z");
  const rows = [
    dich({ metricKey: "delivery_success_rate", scope: "COMPANY", target: 65 }),
    dich({ metricKey: "delivery_success_rate", scope: "PRODUCT", scopeRef: "Q004", target: 55 }),
  ];
  const tra = (productCode: string | null) => resolveTarget(rows, { metricKey: "delivery_success_rate", departmentCode: null, positionId: null, productCode, at: cuoiKy });
  assert.equal(tra("Q004")?.target, 55, "mã có mức riêng thì mức riêng THẮNG mức chung");
  assert.equal(tra("Q004")?.scope, "PRODUCT", "và màn hình phải đọc được rằng đang chấm bằng mức riêng");
  assert.equal(tra("Q001")?.target, 65, "mã không có mức riêng rơi về mức toàn shop — KHÔNG mượn mức của mã khác");
  assert.equal(tra("q004")?.target, 55, "mã viết thường vẫn khớp: custom_id do người gõ tay, hai cách viết là một mã");

  /*
    ĐÍCH CỦA MỘT MÃ KHÔNG BAO GIỜ LỌT VÀO PHÉP CHẤM MỘT CON NGƯỜI. Chủ thể NGƯỜI không mang
    `productCode`, nên mọi dòng tầng PRODUCT bị loại — nếu không, một mức 55% đặt cho hàng mới ra
    mắt sẽ âm thầm trở thành chuẩn chấm cả phòng.
  */
  const chiCoMa = [dich({ metricKey: "delivery_success_rate", scope: "PRODUCT", scopeRef: "Q004", target: 55 })];
  assert.equal(resolveTarget(chiCoMa, { metricKey: "delivery_success_rate", departmentCode: "LOGISTICS", positionId: "pos-lead", userId: "u-an", at: cuoiKy }), null, "chủ thể NGƯỜI không thấy đích của mã hàng");

  console.log("✓ Đích mức MÃ HÀNG: chỉ mở cho chỉ số khai productGrain · mức riêng đè mức chung · không mã nào mượn mức của mã khác · không lọt vào phép chấm một con người");
}

/* ───── 3 · Chọn đích: bốn tầng · kỳ · hạn hiệu lực · không chấm lại kỳ đã chốt ───── */
export function testTargetWindowAndPeriod() {
  const cuoiKy = new Date("2026-09-30T00:00:00Z");
  const rows = [
    dich({ metricKey: "care_sla", scope: "COMPANY", target: 80 }),
    dich({ metricKey: "care_sla", scope: "DEPARTMENT", scopeRef: "LOGISTICS", target: 85 }),
    dich({ metricKey: "care_sla", scope: "POSITION", scopeRef: "pos-lead", target: 92 }),
    dich({ metricKey: "care_sla", scope: "USER", scopeRef: "u-an", target: 95 }),
  ];
  const chuThe = { departmentCode: "LOGISTICS", positionId: "pos-lead", userId: "u-an" };
  assert.equal(resolveTarget(rows, { metricKey: "care_sla", ...chuThe, at: cuoiKy })?.target, 95, "cá nhân đè chức danh đè phòng đè công ty");
  assert.equal(resolveTarget(rows, { metricKey: "care_sla", ...chuThe, userId: "u-khac", at: cuoiKy })?.target, 92, "người khác rơi về tầng chức danh");

  // ───── HẠN HIỆU LỰC ─────
  const hetHan = [dich({ metricKey: "care_sla", scope: "COMPANY", target: 70, effectiveTo: new Date("2026-06-30") })];
  assert.equal(resolveTarget(hetHan, { metricKey: "care_sla", departmentCode: null, positionId: null, at: cuoiKy }), null, "đích đã hết hiệu lực TRƯỚC khi kỳ kết thúc thì không nói gì về kỳ đó");
  assert.equal(resolveTarget(hetHan, { metricKey: "care_sla", departmentCode: null, positionId: null, at: new Date("2026-05-01") })?.target, 70, "nhưng vẫn áp cho kỳ nằm trong khoảng của nó");

  // ───── KỲ ─────
  // Một đích "500 đơn mỗi THÁNG" đem chấm một TUẦN là chấm sai gấp bốn, và nó trông hoàn toàn
  // bình thường trên màn hình — không có gì đỏ, không có gì thiếu.
  const theoThang = [dich({ metricKey: "delivered_orders", scope: "COMPANY", target: 500, periodKind: "MONTH" })];
  assert.equal(resolveTarget(theoThang, { metricKey: "delivered_orders", departmentCode: null, positionId: null, at: cuoiKy, periodKind: "MONTH" })?.target, 500);
  assert.equal(resolveTarget(theoThang, { metricKey: "delivered_orders", departmentCode: null, positionId: null, at: cuoiKy, periodKind: "WEEK" }), null, "đích khai theo THÁNG không được đem chấm một TUẦN");
  /*
    HAI ĐÍCH KHÁC HÌNH DẠNG KỲ SỐNG SONG SONG — và mỗi kỳ chọn đúng cái của mình.

    Đây là lý do `period_kind` PHẢI nằm trong khoá duy nhất của bảng. Thiếu nó thì hai dòng này
    không cùng tồn tại được, và bài kiểm dưới đây sẽ không bao giờ chạy được trên dữ liệu thật.
  */
  const haiKy = [
    dich({ metricKey: "delivered_orders", scope: "COMPANY", target: 500, periodKind: "WEEK" }),
    dich({ metricKey: "delivered_orders", scope: "COMPANY", target: 2000, periodKind: "MONTH" }),
  ];
  assert.equal(resolveTarget(haiKy, { metricKey: "delivered_orders", departmentCode: null, positionId: null, at: cuoiKy, periodKind: "WEEK" })?.target, 500, "xem theo TUẦN thì lấy đích tuần");
  assert.equal(resolveTarget(haiKy, { metricKey: "delivered_orders", departmentCode: null, positionId: null, at: cuoiKy, periodKind: "MONTH" })?.target, 2000, "xem theo THÁNG thì lấy đích tháng — KHÔNG phải đích tuần nhân bốn");

  const moiKy = [dich({ metricKey: "delivered_orders", scope: "COMPANY", target: 500, periodKind: "ANY" })];
  assert.equal(resolveTarget(moiKy, { metricKey: "delivered_orders", departmentCode: null, positionId: null, at: cuoiKy, periodKind: "WEEK" })?.target, 500, "'ANY' nghĩa là chưa khai kỳ ⇒ áp cho mọi kỳ");
  assert.ok(PERIOD_KINDS.includes("QUARTER"));

  // ───── KHÔNG CHẤM LẠI KỲ ĐÃ CHỐT ─────
  const datSau = [...rows, dich({ metricKey: "care_sla", scope: "COMPANY", target: 99, effectiveFrom: new Date("2026-10-01") })];
  assert.equal(resolveTarget(datSau, { metricKey: "care_sla", departmentCode: null, positionId: null, at: cuoiKy })?.target, 80, "đích đặt SAU mốc kỳ không chấm lại kỳ đó");

  console.log("✓ Chọn đích: bốn tầng (cá nhân hẹp nhất) · hạn hiệu lực hai đầu · đích theo THÁNG không chấm một TUẦN · không chấm lại kỳ đã chốt");
}

/* ───── 4 · DẢI và ngưỡng: ra ngoài ở hai đầu đều là chưa đạt ───── */
export function testRangeAndBands() {
  assert.equal(verdict({ value: 30, target: 15, targetMax: 45, direction: "RANGE" }), "MET", "nằm trong dải ⇒ đạt");
  assert.equal(verdict({ value: 5, target: 15, targetMax: 45, direction: "RANGE" }), "MISSED", "dưới cận dưới ⇒ chưa đạt");
  assert.equal(verdict({ value: 60, target: 15, targetMax: 45, direction: "RANGE" }), "MISSED", "trên cận trên cũng chưa đạt — tồn quá nhiều cũng là hỏng");
  assert.equal(verdict({ value: 30, target: 15, targetMax: null, direction: "RANGE" }), "NO_TARGET", "khai dải mà thiếu cận trên thì không kết luận, không tự coi là một chiều");

  assert.equal(delta({ value: 30, target: 15, targetMax: 45, direction: "RANGE" }), 0, "trong dải ⇒ không lệch");
  assert.equal(delta({ value: 5, target: 15, targetMax: 45, direction: "RANGE" }), -10, "thiếu 10 so với cạnh gần nhất");
  assert.equal(delta({ value: 60, target: 15, targetMax: 45, direction: "RANGE" }), -15, "thừa 15 — vẫn mang dấu âm vì vẫn là chưa đạt");

  // ───── PHẦN TRĂM ĐẠT ĐÍCH: phép chia dễ nói dối nhất ─────
  assert.equal(attainment({ value: 90, target: 80, direction: "HIGHER_BETTER" }), 112.5);
  // Đây là cái bẫy: chỉ số CÀNG THẤP CÀNG TỐT mà chia value/target thì 10 lỗi trên đích 5 lỗi ra
  // 200% — trông như vượt đích gấp đôi trong khi đang tệ gấp đôi.
  assert.equal(attainment({ value: 10, target: 5, direction: "LOWER_BETTER" }), 50, "gấp đôi số lỗi cho phép ⇒ đạt 50% đích, KHÔNG phải 200%");
  assert.equal(attainment({ value: 5, target: 10, direction: "LOWER_BETTER" }), 200, "chỉ một nửa số lỗi cho phép ⇒ vượt đích");
  assert.equal(attainment({ value: 0, target: 0, direction: "LOWER_BETTER" }), 100, "0 lỗi trên đích 0 lỗi là đạt trọn");
  assert.equal(attainment({ value: 0, target: 5, direction: "HIGHER_BETTER" }), 0, "0 đã đo được vẫn là 0%, không phải chưa biết");
  assert.equal(attainment({ value: 5, target: 0, direction: "HIGHER_BETTER" }), null, "chia cho đích 0 thì phép chia vô nghĩa ⇒ null, KHÔNG phải Infinity");
  assert.equal(attainment({ value: null, target: 80, direction: "HIGHER_BETTER" }), null, "chưa đo được thì không có phần trăm");
  assert.equal(attainment({ value: 60, target: 15, targetMax: 45, direction: "RANGE" }), null, "ra ngoài dải KHÔNG quy thành một phần trăm — hai đầu là hai vấn đề khác nhau");

  // ───── XU HƯỚNG đã quy theo chiều: UP luôn nghĩa là TỐT LÊN ─────
  assert.equal(trendOf({ value: 9, previous: 5, direction: "HIGHER_BETTER" }), "UP");
  assert.equal(trendOf({ value: 9, previous: 5, direction: "LOWER_BETTER" }), "DOWN", "tỷ lệ hoàn TĂNG là XẤU ĐI — ghi cứng UP ở đây làm đảo ngược mọi chỉ số càng-thấp-càng-tốt");
  assert.equal(trendOf({ value: 5, previous: 5, direction: "HIGHER_BETTER" }), "FLAT");
  assert.equal(trendOf({ value: 9, previous: null, direction: "HIGHER_BETTER" }), null, "chưa có kỳ trước ⇒ chưa có xu hướng, KHÔNG phải đi ngang");
  assert.equal(trendOf({ value: 9, previous: 5, direction: "HIGHER_BETTER", sourceChanged: true }), "SOURCE_CHANGED", "đổi nguồn giữa hai kỳ thì KHÔNG vẽ mũi tên (AGENTS mục 40)");

  console.log("✓ Dải và ngưỡng: ra ngoài hai đầu đều chưa đạt · phần trăm đạt đích không đảo chiều cho chỉ số càng-thấp-càng-tốt · chia cho 0 ra null không ra Infinity · xu hướng quy theo chiều");
}

/* ───── 5 · Thẻ điểm: chưa đủ dữ liệu KHÔNG được in ra giống làm kém ───── */
export function testScorecardEvaluator() {
  const nen = (p: Partial<ScorecardInput>): ScorecardInput => ({
    metricKey: "sales_followup_sla",
    value: 90,
    sample: 100,
    trust: "TRUSTED",
    targets: [dich({ metricKey: "sales_followup_sla", scope: "COMPANY", target: 85 })],
    subject: { departmentCode: "SALES", positionId: null, userId: "u1" },
    period: { endsAt: new Date("2026-09-30"), kind: "MONTH", label: "Tháng 9" },
    ...p,
  });

  const dat = evaluateMetric(nen({}))!;
  assert.equal(dat.status, "GOOD");
  assert.equal(dat.verdict, "MET");
  assert.equal(dat.canConclude, true);
  assert.equal(dat.attainmentPct !== null && Math.round(dat.attainmentPct), 106);
  assert.equal(dat.periodLabel, "Tháng 9", "ô phải mang theo KỲ của chính nó — một con số không có kỳ thì không so được với gì");
  assert.ok(dat.basis, "và mang theo câu căn cứ để người đọc kiểm chứng");
  assert.equal(dat.owner, "SALES", "người chịu trách nhiệm là PHÒNG BAN, không bao giờ một cá nhân");

  // ───── BA LỐI RA KHÔNG PHẢI "LÀM KÉM" ─────
  const chuaDo = evaluateMetric(nen({ value: null, sample: 0 }))!;
  assert.equal(chuaDo.status, "UNKNOWN", "không quan sát nào ⇒ CHƯA ĐO ĐƯỢC, tuyệt đối không phải CRITICAL");
  assert.equal(chuaDo.canConclude, false);
  assert.ok(chuaDo.reason?.includes("KHÔNG phải bằng 0"), "và nói thẳng ra màn hình rằng đây không phải số 0");

  // Mẫu 0 thì con số truyền vào cũng bị bỏ — một con số dựng trên 0 quan sát không phải một con số.
  const mauRong = evaluateMetric(nen({ value: 100, sample: 0 }))!;
  assert.equal(mauRong.value, null, "mẫu 0 ⇒ giá trị về null trước khi bất kỳ phép so sánh nào chạm vào");
  assert.equal(mauRong.status, "UNKNOWN");

  const chuaDich = evaluateMetric(nen({ targets: [] }))!;
  assert.equal(chuaDich.status, "NO_TARGET", "chưa ai đặt đích ⇒ hiện thực tế, KHÔNG kết luận");
  assert.equal(chuaDich.canConclude, false);
  assert.equal(chuaDich.value, 90, "nhưng vẫn hiện con số thật — chưa có đích không phải lý do giấu số liệu");

  const yeu = evaluateMetric(nen({ trust: "WEAK" }))!;
  assert.equal(yeu.canConclude, false, "mẫu dưới ngưỡng hoặc nối bằng ô chữ ⇒ đọc làm bối cảnh, không kết luận về một con người");
  assert.ok(yeu.reason?.includes("bối cảnh"));

  // ───── NGƯỠNG CHỈ CÓ KHI CHỦ SHOP KHAI ─────
  const khongNguong = evaluateMetric(nen({ value: 10, targets: [dich({ metricKey: "sales_followup_sla", scope: "COMPANY", target: 85 })] }))!;
  assert.equal(khongNguong.status, "WARNING", "chưa khai ngưỡng thì chỉ có hai mức từ chính đích — KHÔNG tự nghĩ ra một mức 'đang hỏng'");

  const coNguong = evaluateMetric(nen({ value: 10, targets: [dich({ metricKey: "sales_followup_sla", scope: "COMPANY", target: 85, warningAt: 70, criticalAt: 40 })] }))!;
  assert.equal(coNguong.status, "CRITICAL", "chủ shop đã khai 40 là mức hỏng thì 10 là đang hỏng");
  const giuaHai = evaluateMetric(nen({ value: 60, targets: [dich({ metricKey: "sales_followup_sla", scope: "COMPANY", target: 85, warningAt: 70, criticalAt: 40 })] }))!;
  assert.equal(giuaHai.status, "WARNING");

  // Chỉ số CÀNG THẤP CÀNG TỐT: ngưỡng chạy ngược chiều.
  const nguocChieu = evaluateMetric(
    nen({ metricKey: "return_rate", value: 40, subject: { departmentCode: "LOGISTICS", positionId: null }, targets: [dich({ metricKey: "return_rate", scope: "COMPANY", target: 10, warningAt: 20, criticalAt: 35 })] }),
  )!;
  assert.equal(nguocChieu.status, "CRITICAL", "tỷ lệ hoàn 40% vượt mức hỏng 35% — ngưỡng phải chạy ngược chiều, nếu không mọi chỉ số càng-thấp-càng-tốt bị đảo");

  assert.equal(evaluateMetric(nen({ metricKey: "khong-co-that" })), null, "chỉ số không có trong sổ thì không dựng ô nào");

  console.log("✓ Thẻ điểm dùng chung: CHƯA ĐO ĐƯỢC và CHƯA ĐẶT ĐÍCH tách hẳn khỏi ĐANG HỎNG · mẫu 0 không thành một con số · ngưỡng chỉ có khi chủ shop khai và chạy đúng chiều");
}

/* ───── 6 · Hợp đồng API của evaluator — khoá lại trước khi có nơi gọi thứ hai ───── */
export function testScorecardContract() {
  /*
    `/work/performance` HIỆN VẪN dùng đường tính riêng (xem docs/p1.2-work-performance-evaluator.md).
    Việc chuyển nó là một bản giao diện độc lập. Nhưng hợp đồng của evaluator phải đứng yên TỪ BÂY
    GIỜ — nếu nó còn đổi hình dạng thì bản chuyển kia sẽ phải sửa cả hai đầu cùng lúc, và mất luôn
    khả năng chạy song song hai đường để đối chiếu.
  */
  const nen: ScorecardInput = {
    metricKey: "sales_followup_sla",
    value: 90,
    sample: 100,
    trust: "TRUSTED",
    targets: [dich({ metricKey: "sales_followup_sla", scope: "COMPANY", target: 85 })],
    subject: { departmentCode: "SALES", positionId: null, userId: "u1" },
    period: { endsAt: new Date("2026-09-30"), kind: "MONTH", label: "Tháng 9" },
  };
  const o = evaluateMetric(nen)!;

  // Chín câu mà mỗi ô PHẢI trả lời — thiếu một trường là màn hình phải tự bịa phần còn lại.
  for (const truong of ["metric", "value", "sample", "trust", "target", "direction", "verdict", "status", "delta", "attainmentPct", "trend", "owner", "periodKind", "periodLabel", "basis", "canConclude", "reason"]) {
    assert.ok(truong in o, `hợp đồng ScorecardCell thiếu trường "${truong}"`);
  }

  // Evaluator KHÔNG tự đi đo: cùng đầu vào ⇒ cùng đầu ra, không phụ thuộc thứ tự hay số lần gọi.
  const lan2 = evaluateMetric(nen)!;
  assert.deepEqual({ ...lan2, metric: null }, { ...o, metric: null }, "hàm phải THUẦN — gọi hai lần ra đúng một kết quả");

  // `canConclude` là cờ một-lần-đọc cho mọi màn hình. Bốn lối ra, chỉ một cái cho phép kết luận.
  assert.equal(evaluateMetric({ ...nen })!.canConclude, true);
  assert.equal(evaluateMetric({ ...nen, value: null, sample: 0 })!.canConclude, false, "chưa đo được ⇒ không kết luận");
  assert.equal(evaluateMetric({ ...nen, trust: "WEAK" })!.canConclude, false, "mẫu yếu ⇒ không kết luận");
  assert.equal(evaluateMetric({ ...nen, targets: [] })!.canConclude, false, "chưa có đích ⇒ không kết luận");

  // Chỉ số KẾT QUẢ CHUNG không được thành điểm chấm người — cửa chặn nằm ở sổ, evaluator đọc lại.
  assert.equal(metricOf("sales_delivered_quality")?.shared, true);
  assert.equal(canTargetPerson("sales_delivered_quality").ok, false);

  console.log("✓ Hợp đồng evaluator: 17 trường đầy đủ · hàm THUẦN · canConclude chỉ bật khi đo được + đủ tin + có đích (đường chuyển /work/performance ghi ở docs/p1.2-work-performance-evaluator.md)");
}
