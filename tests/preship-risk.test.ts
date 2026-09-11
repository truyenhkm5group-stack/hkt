import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inArray } from "drizzle-orm";
import { type Db, schema } from "@/db";
import { clearMemo } from "@/lib/cache";
import {
  composeRisk,
  BACKTEST_MIN_ORDERS,
  MAX_UNMEASURABLE_FOR_HIGH,
  MIN_LIFT_TO_CLAIM,
  MIN_SAMPLE_FOR_RATE,
  RISK_BAND_ACTION,
  RISK_BAND_LABEL,
  RISK_MAX_POSITIVE,
  RISK_SIGNALS,
  RISK_THRESHOLDS,
} from "@/lib/constants/preship-risk";
import { listPreshipRisk, scorePreshipRisk, summarizePreshipRisk, type RiskFacts } from "@/lib/queries/preship-risk";
import { getPreshipRiskBacktest } from "@/lib/queries/preship-risk-backtest";

const ALL = { key: "all" as const, from: null, to: null, label: "Toàn bộ", fromKey: null, toKey: null };

/** Đơn "sạch": mọi tín hiệu tra được, không tín hiệu nào xấu. Mốc so sánh của cả bài kiểm. */
const SACH: RiskFacts = {
  orderId: "prs-base",
  systemId: 1,
  customerName: "Khách",
  phone: "0912345678",
  province: "Hà Nội",
  createdAt: new Date(),
  orderValue: 499_000,
  cod: 499_000,
  prepaid: 0,
  customerDelivered: 2,
  customerReturned: 0,
  isBlocked: false,
  otherOrders: 2,
  distinctCustomers: 1,
  addressComplete: true,
  addressLength: 40,
  phoneShapeOk: true,
  variantReturnRate: 0.1,
  variantSample: 50,
  variantName: "Đầm A",
  provinceReturnRate: 0.2,
  provinceSample: 100,
  sourceReturnRate: 0.3,
  sourceSample: 100,
  sourceKey: "Facebook",
};

/**
 * ═══════════ ĐIỂM RỦI RO TRƯỚC KHI GIAO ═══════════
 *
 * Đặc tả: `docs/revenue-conversion-contract.md`.
 *
 * Bài kiểm này khoá bốn cách một điểm rủi ro nói dối:
 *
 *  1. **không phân biệt được gì** — đơn xấu và đơn tốt cùng điểm;
 *  2. **phán chắc trên dữ liệu mỏng** — thiếu 8/11 tín hiệu mà vẫn kết luận "rủi ro cao";
 *  3. **trộn tiền vào xác suất** — đơn to bị soát trước đơn của khách đã hoàn bốn lần;
 *  4. **kiểm định tự chấm bài của mình** — công bố "có tác dụng" khi mẫu chưa đủ.
 *
 * Và một luật tuyệt đối: điểm cao KHÔNG được tự huỷ đơn của khách.
 */
export async function testPreshipRisk(db: Db) {
  /* ───────── 1. BẢNG TRỌNG SỐ PHẢI TỰ NHẤT QUÁN ───────── */
  assert.equal(RISK_MAX_POSITIVE, 100, "tổng điểm dương phải đúng 100 để điểm đọc được như mức rủi ro tương đối");
  assert.ok(RISK_THRESHOLDS.medium < RISK_THRESHOLDS.high, "ngưỡng trung bình phải thấp hơn ngưỡng cao");
  for (const s of RISK_SIGNALS) {
    // Một trọng số không có lý do là một con số bịa — khoá ở mức mã nguồn.
    assert.ok(s.rationale.length > 40, `tín hiệu ${s.key}: phải nói VÌ SAO nó có lý về nghiệp vụ`);
    assert.ok(s.source.length > 10, `tín hiệu ${s.key}: phải nói cột/biểu thức thật cấp dữ liệu`);
    assert.notEqual(s.maxPoints, 0, `tín hiệu ${s.key}: trọng số 0 thì tín hiệu này không tồn tại, bỏ nó đi`);
  }
  assert.equal(new Set(RISK_SIGNALS.map((s) => s.key)).size, RISK_SIGNALS.length, "không được khai trùng tín hiệu");
  for (const band of ["LOW", "MEDIUM", "HIGH"] as const) {
    assert.ok(RISK_BAND_ACTION[band].length > 10, `mức ${band}: phải nói việc cần làm`);
    assert.ok(RISK_BAND_LABEL[band].length > 3, `mức ${band}: phải có nhãn tiếng Việt`);
  }
  // Mức CAO tuyệt đối KHÔNG được khuyên huỷ đơn.
  assert.ok(!/hu[ỷy]\s+đơn/i.test(RISK_BAND_ACTION.HIGH.replace(/KHÔNG tự huỷ đơn[^.]*\./i, "")), "mức CAO không được khuyên huỷ đơn của khách");

  /* ───────── 2. PHÂN BIỆT ĐƯỢC ĐƠN XẤU VỚI ĐƠN TỐT ───────── */
  const tot = scorePreshipRisk({ ...SACH, customerDelivered: 5, customerReturned: 0, prepaid: 499_000 });
  const xau = scorePreshipRisk({
    ...SACH,
    customerDelivered: 1,
    customerReturned: 4,
    isBlocked: true,
    addressComplete: false,
    phoneShapeOk: false,
    variantReturnRate: 0.8,
  });
  assert.ok(xau.score > tot.score, `đơn xấu phải nhiều điểm hơn đơn tốt (${xau.score} vs ${tot.score})`);
  assert.equal(xau.band, "HIGH", "đơn hội đủ tín hiệu xấu phải là rủi ro CAO");
  assert.equal(tot.band, "LOW", "khách ruột đã trả tiền trước phải là rủi ro THẤP");
  assert.equal(tot.score, 0, "điểm không được âm — chặn ở 0");

  /* ───────── 3. ĐIỂM PHẢI GIẢI THÍCH ĐƯỢC, VÀ CỘNG LẠI ĐÚNG ───────── */
  assert.ok(xau.topReasons.length > 0 && xau.topReasons.length <= 3, "phải nêu tối đa 3 lý do đầu — không bắt người đọc duyệt 11 dòng");
  for (const r of xau.reasons) {
    // Bằng chứng phải là SỐ LIỆU THẬT của đơn đó, không phải mô tả chung.
    assert.ok(r.evidence.length > 10, `lý do ${r.key}: phải kèm bằng chứng cụ thể của chính đơn này`);
    assert.ok(r.label.length > 3, `lý do ${r.key}: phải có nhãn`);
  }
  const tong = xau.reasons.reduce((t, r) => t + r.points, 0);
  assert.equal(xau.score, Math.max(0, Math.min(100, Math.round(tong))), "điểm phải đúng bằng tổng các phần — cộng lại được thì kiểm chứng được");
  assert.deepEqual(
    [...xau.reasons].map((r) => r.points),
    [...xau.reasons].map((r) => r.points).sort((a, b) => b - a),
    "lý do phải xếp theo điểm giảm dần",
  );

  /* ───────── 4. DỮ LIỆU MỎNG THÌ KHÔNG ĐƯỢC PHÁN "CAO" ───────── */
  /*
    Đây là luật "thiếu chiều nào thì KHÔNG phán" đã có ở `classifyProduct`. Một đơn thiếu gần hết tín
    hiệu mà vẫn được dán nhãn "rủi ro cao" sẽ làm người vận hành soát sai người, rồi thôi tin cả nhãn.
  */
  const mong = scorePreshipRisk({
    ...SACH,
    customerDelivered: null,
    customerReturned: null,
    isBlocked: null,
    otherOrders: null,
    distinctCustomers: null,
    variantReturnRate: null,
    provinceReturnRate: null,
    sourceReturnRate: null,
    addressComplete: false,
    phoneShapeOk: false,
    phone: "0912345678",
  });
  assert.ok(mong.unmeasurable.length > MAX_UNMEASURABLE_FOR_HIGH, `ca mỏng phải có hơn ${MAX_UNMEASURABLE_FOR_HIGH} tín hiệu không tra được`);
  assert.notEqual(mong.band, "HIGH", "thiếu quá nhiều chiều thì KHÔNG được phán rủi ro CAO");
  assert.equal(mong.confidence, "LOW", "thiếu quá nhiều chiều thì tin cậy phải là LOW");
  assert.ok(mong.completeness < 1, "độ đầy đủ phải phản ánh phần tín hiệu thiếu");

  /*
    VÀ ĐÂY LÀ MỘT TÍNH CHẤT MẠNH HƠN, phát hiện được khi viết bài kiểm này:

    Với bảng trọng số hiện tại, ca thiếu dữ liệu KHÔNG THỂ đạt mức CAO — vì đúng những tín hiệu nặng
    nhất (lịch sử khách 30đ, Pancake chặn 18đ) lại chính là những tín hiệu bị thiếu. Tín hiệu còn lại
    cộng hết cũng chỉ tới 29đ, dưới ngưỡng CAO (40đ).
    Nên "thiếu dữ liệu không phán chắc" là một tính chất CỦA CẤU TRÚC, không phải nhờ cái chốt hạ mức.
  */
  const diemToiDaKhiThieu = RISK_SIGNALS.filter((x) => ["ADDRESS_INCOMPLETE", "PHONE_MALFORMED", "NEW_PHONE", "PHONE_SHARED"].includes(x.key))
    .reduce((t, x) => t + Math.max(0, x.maxPoints), 0);
  assert.ok(
    diemToiDaKhiThieu < RISK_THRESHOLDS.high,
    `tín hiệu không cần lịch sử cộng hết (${diemToiDaKhiThieu}đ) phải THẤP HƠN ngưỡng CAO (${RISK_THRESHOLDS.high}đ): ` +
      "nếu không, một đơn không biết gì về khách vẫn có thể bị dán nhãn rủi ro cao",
  );

  /*
    CÁI CHỐT HẠ MỨC vẫn phải hoạt động, vì trọng số có thể được chủ shop sửa. Kiểm thẳng vào
    `composeRisk` thay vì dựng một fixture không thể xảy ra với trọng số hôm nay — một bài kiểm chờ
    điều kiện không bao giờ tới thì không kiểm được gì.
  */
  const gia = composeRisk({
    reasons: [{ key: "CUSTOMER_RETURN_HISTORY", label: "giả lập", points: RISK_THRESHOLDS.high + 10, evidence: "dựng tay để kiểm chốt hạ mức" }],
    unmeasurable: ["CUSTOMER_BLOCKED", "SKU_RETURN_HISTORY", "PROVINCE_RETURN_HISTORY", "SOURCE_RETURN_HISTORY", "PHONE_SHARED", "NEW_PHONE"],
    expectedLossVnd: null,
  });
  assert.ok(gia.score >= RISK_THRESHOLDS.high, "tiền đề: điểm thô phải đủ cao để lẽ ra là mức CAO");
  assert.equal(gia.band, "MEDIUM", "điểm đủ cao NHƯNG thiếu quá nhiều chiều ⇒ mức phải bị HẠ xuống trung bình");
  assert.equal(gia.bandCapped, true, "phải NÓI RA rằng mức đã bị hạ, không hạ âm thầm");
  assert.equal(gia.confidence, "LOW", "hạ mức vì thiếu dữ liệu thì tin cậy phải là LOW");

  /* ───────── 5. MẪU NHỎ THÌ KHÔNG CÓ TỶ LỆ, VÀ KHÔNG CỘNG ĐIỂM ───────── */
  /*
    Mẫu mã hoàn 3/3 đơn KHÔNG phải "mẫu mã hoàn 100%". Cộng điểm cho nó là xếp việc theo nhiễu.
    `listPreshipRisk` trả `null` khi mẫu dưới ngưỡng, nên ở đây khẳng định tầng chấm xử lý đúng `null`.
  */
  const mauNho = scorePreshipRisk({ ...SACH, variantReturnRate: null, variantSample: 3 });
  assert.ok(mauNho.unmeasurable.includes("SKU_RETURN_HISTORY"), "mẫu mã chưa đủ mẫu phải vào danh sách CHƯA TRA ĐƯỢC");
  assert.ok(!mauNho.reasons.some((r) => r.key === "SKU_RETURN_HISTORY"), "mẫu mã chưa đủ mẫu KHÔNG được cộng điểm");

  /* ───────── 6. TIỀN LÀ ĐỘ LỚN, KHÔNG PHẢI XÁC SUẤT ───────── */
  /*
    Nếu COD vào điểm thì đơn 2 triệu của khách ruột sẽ bị soát trước đơn 300K của khách đã hoàn bốn
    lần — sai người, sai việc. Nên đổi giá trị đơn PHẢI không đổi điểm, và PHẢI đổi thiệt hại dự kiến.
  */
  const nho = scorePreshipRisk({ ...SACH, orderValue: 300_000, cod: 300_000 });
  const to = scorePreshipRisk({ ...SACH, orderValue: 5_000_000, cod: 5_000_000 });
  assert.equal(nho.score, to.score, "đổi giá trị đơn KHÔNG được đổi điểm rủi ro — tiền là độ lớn, không phải xác suất");
  assert.equal(nho.band, to.band, "đổi giá trị đơn KHÔNG được đổi mức rủi ro");
  assert.ok((to.expectedLossVnd ?? 0) > (nho.expectedLossVnd ?? 0), "đơn to hơn thì thiệt hại dự kiến phải lớn hơn");
  assert.equal(scorePreshipRisk({ ...SACH, orderValue: 0 }).expectedLossVnd, null, "chưa biết giá trị đơn thì thiệt hại là CHƯA BIẾT, không phải 0đ");

  /* ───────── 7. KHÔNG BAO GIỜ TỰ HUỶ ĐƠN ───────── */
  /*
    Khoá ở mức MÃ NGUỒN, không chỉ bằng lời: một lần ai đó thêm `update(orders).set({stage:'CANCELLED'})`
    vào tầng chấm rủi ro là shop mất khách thật vì một con số máy chấm.
  */
  for (const f of ["lib/queries/preship-risk.ts", "lib/queries/preship-risk-backtest.ts", "lib/constants/preship-risk.ts"]) {
    const src = readFileSync(f, "utf8");
    assert.ok(!/\.update\(\s*schema\.orders/.test(src), `${f}: tầng chấm rủi ro KHÔNG được ghi vào bảng orders`);
    assert.ok(!/stage:\s*["']CANCELLED["']/.test(src), `${f}: KHÔNG được tự huỷ đơn`);
    assert.ok(!/stage:\s*["']DELETED["']/.test(src), `${f}: KHÔNG được tự xoá đơn`);
  }

  /* ───────── 8. CHẤM TRÊN CSDL THẬT: PHẠM VI ĐÚNG, KHÔNG CHẤM ĐƠN ĐÃ ĐI ───────── */
  const ids = ["prs-1", "prs-2", "prs-3"];
  try {
    const now = new Date();
    await db.insert(schema.orders).values([
      // Chờ gửi, địa chỉ đủ ⇒ PHẢI có trong danh sách.
      { id: "prs-1", stage: "CONFIRMED", status: 1, insertedAt: now, totalPriceAfterDiscount: 499_000, billPhone: "0912000001", shipProvince: "Hà Nội", shipCommune: "Dịch Vọng", shipFullAddress: "So 12 ngo 5 Dich Vong Cau Giay Ha Noi", source: "Facebook" },
      // Chờ gửi, thiếu địa chỉ + SĐT sai dạng ⇒ điểm cao hơn prs-1.
      { id: "prs-2", stage: "NEW", status: 0, insertedAt: now, totalPriceAfterDiscount: 300_000, billPhone: "abc", shipProvince: "", source: "Khác" },
      // ĐÃ RỜI KHO ⇒ KHÔNG được chấm: không còn hành động nào thay đổi được kết quả.
      { id: "prs-3", stage: "CONFIRMED", status: 1, insertedAt: now, totalPriceAfterDiscount: 400_000, billPhone: "0912000003", shipProvince: "Hà Nội", shipCommune: "X" },
    ]);
    await db.insert(schema.shipments).values([{ id: "prs-s3", orderId: "prs-3", vtpOrderNumber: "PRSV3", stage: "IN_TRANSIT", pickedUpAt: now }]);
    clearMemo();

    const rows = await listPreshipRisk({ limit: 200 });
    const byId = new Map(rows.map((r) => [r.orderId, r]));
    assert.ok(byId.has("prs-1"), "đơn chờ gửi phải được chấm");
    assert.ok(byId.has("prs-2"), "đơn chờ gửi phải được chấm");
    assert.ok(!byId.has("prs-3"), "đơn ĐÃ RỜI KHO không được chấm — chấm xong cũng không làm gì được nữa");
    assert.ok((byId.get("prs-2")?.risk.score ?? 0) > (byId.get("prs-1")?.risk.score ?? 0), "đơn thiếu địa chỉ và sai SĐT phải nhiều điểm hơn");
    const lyDo2 = byId.get("prs-2")?.risk.reasons.map((r) => r.key) ?? [];
    assert.ok(lyDo2.includes("ADDRESS_INCOMPLETE"), "phải nêu đúng lý do thiếu địa chỉ");
    assert.ok(lyDo2.includes("PHONE_MALFORMED"), "phải nêu đúng lý do SĐT sai dạng");

    const tk = summarizePreshipRisk(rows);
    assert.equal(tk.total, rows.length, "tổng hợp phải đếm đủ");
    assert.equal(tk.high + tk.medium + tk.low, rows.length, "mỗi đơn phải thuộc đúng MỘT mức");

    /* ───────── 9. KIỂM ĐỊNH PHẢI TỪ CHỐI TỰ TÂNG BỐC ───────── */
    const bt = await getPreshipRiskBacktest(ALL);
    assert.ok(bt.limitations.length >= 3, "kiểm định PHẢI nói ra giới hạn của chính nó");
    for (const l of bt.limitations) assert.ok(l.length > 40, "mỗi giới hạn phải nói rõ, không một chữ");
    assert.ok(["PHÂN BIỆT ĐƯỢC", "KHÔNG PHÂN BIỆT ĐƯỢC", "KHÔNG ĐỦ MẪU"].includes(bt.verdict), "kết luận phải thuộc ba giá trị đã khai");
    assert.ok(bt.verdictReason.length > 60, "phải nói VÌ SAO ra kết luận đó");
    /*
      Dữ liệu mẫu dùng chung chỉ có vài chục đơn — nghĩa là kiểm định PHẢI trả "không đủ mẫu". Đây là
      khẳng định quan trọng nhất của cả bài kiểm: một hàm kiểm định mà không bao giờ nói "chưa biết"
      thì nó không kiểm định gì cả.
    */
    if (bt.orders < BACKTEST_MIN_ORDERS) {
      assert.equal(bt.verdict, "KHÔNG ĐỦ MẪU", `chỉ ${bt.orders} đơn trong nửa kiểm tra thì PHẢI trả "không đủ mẫu", không được tuyên bố có tác dụng`);
    }
    for (const b of bt.bands) {
      if (b.orders < MIN_SAMPLE_FOR_RATE) assert.equal(b.returnRate, null, `nhóm ${b.band} chỉ ${b.orders} đơn ⇒ KHÔNG có tỷ lệ, không phải 0%`);
      else assert.ok(Math.abs((b.returnRate ?? -1) - b.returned / b.orders) < 1e-9, `nhóm ${b.band}: tỷ lệ hoàn phải chia đúng mẫu số`);
      assert.equal(b.delivered + b.returned, b.orders, `nhóm ${b.band}: giao + hoàn phải bằng tổng đơn của nhóm`);
    }
    if (bt.verdict === "PHÂN BIỆT ĐƯỢC") {
      assert.ok((bt.uplift ?? 0) >= MIN_LIFT_TO_CLAIM, `chỉ được nói "phân biệt được" khi nâng ≥ ${MIN_LIFT_TO_CLAIM}×`);
    }

    console.log(
      `✓ Điểm rủi ro trước giao: tổng dương ${RISK_MAX_POSITIVE} điểm · đơn xấu ${xau.score}/${xau.band} vs đơn tốt ${tot.score}/${tot.band} · ` +
        `ca mỏng bị hạ mức (${mong.unmeasurable.length} tín hiệu chưa tra được, tin cậy ${mong.confidence}) · ` +
        `tiền KHÔNG vào điểm (đơn 300K và 5tr cùng ${nho.score} điểm, thiệt hại khác nhau) · ` +
        `chấm ${rows.length} đơn chờ gửi (${tk.high} cao / ${tk.medium} trung bình / ${tk.low} thấp) · ` +
        `kiểm định: ${bt.verdict} trên ${bt.orders} đơn nửa kiểm tra`,
    );
  } finally {
    await db.delete(schema.shipments).where(inArray(schema.shipments.id, ["prs-s3"]));
    await db.delete(schema.orders).where(inArray(schema.orders.id, ids));
    clearMemo();
  }
}
