import assert from "node:assert/strict";
import {
  CASE_OUTCOMES,
  CASE_OUTCOME_HAS_HUMAN_CREDIT,
  CASE_OUTCOME_IS_FINAL,
  CASE_OUTCOME_LABEL,
  CASE_OUTCOME_HINT,
  deriveCaseOutcome,
  PERIOD_BASES,
  PERIOD_BASIS_HINT,
  PERIOD_BASIS_LABEL,
  type CaseFacts,
} from "@/lib/constants/care-effect";

/**
 * ═══════════ CÔNG CỦA NGƯỜI KHÔNG ĐƯỢC GÁN CHO MỘT VIỆC HỌ KHÔNG LÀM ═══════════
 *
 * Đo trên production 16/09/2026: trong 44 ca mang nhãn `RESCUED_DIRECT` ("Cứu được"), chỉ **17** ca
 * có một hành động chăm sóc thật của người, và 22 ca có bất kỳ sự kiện nào không phải của máy.
 * Nghĩa là **22–27 ca là ĐVVC TỰ phục hồi** — kiện đi `Chờ phát lại → Đang giao → Giao thành công`
 * mà không ai gọi một cuộc nào.
 *
 * `care_outcome` đọc DUY NHẤT chứng từ ĐVVC nên nó không thể biết điều đó, và đó KHÔNG phải lỗi của
 * nó — đó là đúng việc của nó. Lớp `deriveCaseOutcome()` trả lời câu còn lại: *ai đã làm gì trước
 * khi điều đó xảy ra.*
 */
const NEN: CaseFacts = {
  storedOutcome: null,
  resolution: null,
  humanActionBeforeOutcome: false,
  actionKinds: [],
  humanRequestedRedelivery: false,
};

export function testCareEffect() {
  // ═════════ 1. GIAO ĐƯỢC: CÓ NGƯỜI CHĂM vs ĐVVC TỰ PHỤC HỒI ═════════
  assert.equal(
    deriveCaseOutcome({ ...NEN, storedOutcome: "RESCUED_DIRECT", humanActionBeforeOutcome: true, actionKinds: ["CALLED_REACHED"] }),
    "DELIVERED_AFTER_CARE",
    "có người gọi được khách rồi kiện giao thành công ⇒ công của đội",
  );
  assert.equal(
    deriveCaseOutcome({ ...NEN, storedOutcome: "RESCUED_DIRECT", humanActionBeforeOutcome: false }),
    "DELIVERED_WITHOUT_MANUAL_CARE",
    "ĐVVC tự phục hồi mà không ai làm gì ⇒ KHÔNG phải công của đội. Đây là lỗi đã đo được: 22–27 trong 44 ca từng mang nhãn 'Cứu được' thuộc nhóm này",
  );
  assert.equal(
    CASE_OUTCOME_HAS_HUMAN_CREDIT.DELIVERED_WITHOUT_MANUAL_CARE,
    false,
    "và nhóm đó tuyệt đối không được tính công cho ai",
  );

  /*
    HÀNH ĐỘNG GHI SAU KHI ĐVVC ĐÃ CHỐT KHÔNG PHẢI NGUYÊN NHÂN CỦA KẾT QUẢ.

    Truy vấn chặn ở tầng trên (`humanActionBeforeOutcome` so với `outcome_at`), nhưng luật phải
    đứng được một mình: gán công ngược thời gian là cách dễ nhất để một báo cáo tự khen.
  */
  assert.equal(
    deriveCaseOutcome({ ...NEN, storedOutcome: "RESCUED_DIRECT", humanActionBeforeOutcome: false, actionKinds: ["CALLED_REACHED"] }),
    "DELIVERED_WITHOUT_MANUAL_CARE",
    "có dòng hành động nhưng KHÔNG nằm trước mốc chốt ⇒ vẫn không được tính công",
  );

  // Yêu cầu phát lại là bằng chứng CỤ THỂ hơn "có ai đó làm gì", nên nó có nhãn riêng.
  assert.equal(
    deriveCaseOutcome({ ...NEN, storedOutcome: "RESCUED_DIRECT", humanActionBeforeOutcome: true, humanRequestedRedelivery: true }),
    "REDELIVERED_AFTER_CARE",
  );

  // ═════════ 2. HOÀN: LÝ DO THẮNG KẾT QUẢ ═════════
  //
  // "Khách xác nhận không lấy" nói được điều mà "hoàn dù đã chăm" không nói. Biết lý do thì sửa
  // được (đổi kịch bản, lọc đơn rủi ro); biết kết quả thì chỉ đếm được.
  assert.equal(
    deriveCaseOutcome({ ...NEN, storedOutcome: "RESCUE_FAILED", humanActionBeforeOutcome: true, actionKinds: ["CALLED_REACHED", "CUSTOMER_REFUSED"] }),
    "CUSTOMER_REFUSED",
  );
  assert.equal(
    deriveCaseOutcome({ ...NEN, storedOutcome: "RESCUE_FAILED", humanActionBeforeOutcome: true, actionKinds: ["CALLED_NO_ANSWER", "CALLED_NO_ANSWER"] }),
    "CUSTOMER_UNREACHABLE",
    "gọi mãi không ai bắt máy ⇒ vấn đề ở SỐ ĐIỆN THOẠI, không ở kịch bản chăm sóc",
  );
  assert.equal(
    deriveCaseOutcome({ ...NEN, storedOutcome: "RESCUE_FAILED", humanActionBeforeOutcome: true, actionKinds: ["CALLED_NO_ANSWER", "CALLED_REACHED"] }),
    "RETURNED_AFTER_CARE",
    "đã có MỘT lần nói chuyện được thì không còn là 'không liên lạc được', dù kết quả vẫn hoàn",
  );
  assert.equal(
    deriveCaseOutcome({ ...NEN, storedOutcome: "RESCUE_FAILED", humanActionBeforeOutcome: false }),
    "RETURNED_WITHOUT_MANUAL_CARE",
    "kiện hoàn mà không ai chạm vào phải được gọi tên — thiếu vế này thì mọi kiện hoàn trông như đội đã cố mà không nổi",
  );

  // ═════════ 3. CHƯA NGÃ NGŨ KHÔNG ĐƯỢC ĐOÁN THÀNH THẤT BẠI ═════════
  for (const s of [null, "PENDING", "UNATTRIBUTED"]) {
    assert.equal(deriveCaseOutcome({ ...NEN, storedOutcome: s }), "UNRESOLVED", `kết cục '${s}' là CHƯA BIẾT, không phải 'không cứu được'`);
  }
  assert.equal(CASE_OUTCOME_IS_FINAL.UNRESOLVED, false, "và nó nằm NGOÀI mẫu số của mọi tỷ lệ");

  /*
    CA MÁY MỞ RỒI TỰ ĐÓNG ĐỨNG NGOÀI MỌI TỶ LỆ — kể cả khi tình cờ có ai đó ghi một dòng ghi chú.

    Kiện mang mã 102 trước mốc lấy hàng rồi đi tiếp chưa bao giờ là điều kiện cần care. Đếm nó là
    bơm mẫu số bằng những việc chưa từng là việc.
  */
  assert.equal(
    deriveCaseOutcome({ ...NEN, resolution: "NOT_CARE_CONDITION", storedOutcome: "RESCUED_DIRECT", humanActionBeforeOutcome: true, actionKinds: ["MESSAGED"] }),
    "NO_CHANGE",
  );
  assert.equal(CASE_OUTCOME_IS_FINAL.NO_CHANGE, false);
  assert.equal(CASE_OUTCOME_HAS_HUMAN_CREDIT.NO_CHANGE, false);

  // ═════════ 4. HÀM THUẦN: CHẠY HAI LẦN RA CÙNG KẾT QUẢ ═════════
  const f: CaseFacts = { ...NEN, storedOutcome: "RESCUE_FAILED", humanActionBeforeOutcome: true, actionKinds: ["MESSAGED"] };
  assert.equal(deriveCaseOutcome(f), deriveCaseOutcome(f), "hàm thuần — không đọc CSDL, không phụ thuộc lượt chạy");

  // ═════════ 5. MỌI KẾT CỤC PHẢI KHAI ĐỦ, KHÔNG ĐỂ MỘT Ô TRỐNG ═════════
  for (const o of CASE_OUTCOMES) {
    assert.ok(CASE_OUTCOME_LABEL[o], `${o} phải có nhãn tiếng Việt`);
    assert.ok(CASE_OUTCOME_HINT[o]?.length > 30, `${o} phải giải thích được VÌ SAO nó tồn tại — một nhãn không có lý lẽ là một nhãn không ai dám dùng`);
    assert.equal(typeof CASE_OUTCOME_IS_FINAL[o], "boolean");
    assert.equal(typeof CASE_OUTCOME_HAS_HUMAN_CREDIT[o], "boolean");
  }
  // Không kết cục nào vừa CHƯA NGÃ NGŨ vừa được tính công: hai điều đó không thể cùng đúng.
  for (const o of CASE_OUTCOMES) {
    if (!CASE_OUTCOME_IS_FINAL[o]) assert.equal(CASE_OUTCOME_HAS_HUMAN_CREDIT[o], false, `${o} chưa ngã ngũ thì không được tính công cho ai`);
  }

  // ═════════ 6. KỲ BÁO CÁO PHẢI KHAI MỐC NÓ LỌC THEO ═════════
  //
  // "7 ngày gần đây" không phải một câu hỏi đầy đủ: bảy ngày của ca MỞ RA và bảy ngày của ca CHỐT
  // KẾT QUẢ là hai tập ca khác nhau và hai con số khác nhau.
  assert.equal(PERIOD_BASES.length, 2);
  for (const b of PERIOD_BASES) {
    assert.ok(PERIOD_BASIS_LABEL[b]?.includes("theo"), `${b} phải nói rõ lọc theo mốc nào`);
    assert.ok(PERIOD_BASIS_HINT[b]?.length > 60, `${b} phải nói ra HẬU QUẢ của việc chọn mốc này`);
  }

  console.log(`✓ Kết cục ca chăm sóc: ${CASE_OUTCOMES.length} nhãn · ĐVVC tự phục hồi KHÔNG tính là công của đội (22–27/44 ca đo được trên production) · lý do thắng kết quả · chưa ngã ngũ không đoán thành thất bại · kỳ phải khai mốc lọc`);
}
