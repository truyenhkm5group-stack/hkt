import assert from "node:assert/strict";
import { CASE_ACTION, CASE_SLA_HOURS, CASE_TEAM, CASE_TYPE_LABEL, KIND_TO_CASE, type CaseType } from "@/lib/constants/action-queue";
import { AGING_BUCKETS, NGOAI_PHEU, OPERATING_FUNNEL, STAGE_BY_KEY, nextStage } from "@/lib/constants/operating-funnel";
import { CO_MAU_TOI_THIEU, RECOVERY_MEASURABLE, combineImpact, type RecoveryRate } from "@/lib/queries/impact";

/**
 * ═══════════ HỢP ĐỒNG PHỄU VẬN HÀNH VÀ BỘ ƯỚC LƯỢNG TIỀN ═══════════
 *
 * Hai thứ được khoá ở đây, và cả hai đều là loại lỗi KHÔNG lộ ra khi chạy — bảng vẫn hiện, số vẫn
 * ra, chỉ là sai:
 *
 *  1. MỘT LOẠI VIỆC CHỈ THUỘC MỘT KHÂU. Khai ở hai khâu thì tiền của nó được cộng hai lần vào tổng
 *     "đang treo", và chủ shop đọc một con số to gấp rưỡi sự thật. Đây đã suýt xảy ra: bản đầu của
 *     sổ đăng ký khai `ORDER_CONFIRMATION_STALE` ở cả khâu "Chờ xác nhận" lẫn "Chờ bàn giao", và
 *     `CUSTOMER_RECOVERY` ở cả "Hoàn về" lẫn "Mua lại".
 *
 *  2. SỰ THẬT KHÔNG BAO GIỜ BỊ TRỘN VỚI ƯỚC TÍNH. `moneyAtRisk` phải là tổng cộng thẳng, không
 *     nhân hệ số nào; `estimatedRecoverable` phải là `null` khi chưa đủ mẫu, KHÔNG phải 0.
 *
 * Chạy riêng: npx tsx --tsconfig tsconfig.json tests/operating-funnel.test.ts
 */
export function testOperatingFunnel() {
  // ───────── 1. MỖI LOẠI VIỆC THUỘC ĐÚNG MỘT KHÂU ─────────
  const dem = new Map<CaseType, string[]>();
  for (const stage of OPERATING_FUNNEL) {
    for (const t of stage.caseTypes) dem.set(t, [...(dem.get(t) ?? []), stage.key]);
  }
  const trung = [...dem.entries()].filter(([, keys]) => keys.length > 1);
  assert.deepEqual(
    trung.map(([t, keys]) => `${t} ở ${keys.join(" và ")}`),
    [],
    "một loại việc khai ở nhiều khâu ⇒ tiền của nó bị cộng nhiều lần vào tổng đang treo",
  );

  // ───────── 2. KHÔNG LOẠI VIỆC NÀO BIẾN MẤT KHÔNG DẤU VẾT ─────────
  //
  // Mọi loại việc phải hoặc nằm trong một khâu, hoặc được khai là cắt ngang KÈM LÝ DO. Thêm loại
  // mới mà quên xếp khâu thì nó sẽ im lặng không hiện ở đâu — đúng dạng "xây rồi không nối" đã lặp
  // lại bảy lần trong kho mã này.
  const moiLoai = [...new Set(Object.values(KIND_TO_CASE))];
  const lacLoai = moiLoai.filter((t) => !dem.has(t) && !NGOAI_PHEU[t]);
  assert.deepEqual(lacLoai, [], `loại việc không thuộc khâu nào và cũng không khai ngoài phễu: ${lacLoai.join(", ")}`);

  const thuaKhai = Object.keys(NGOAI_PHEU).filter((t) => dem.has(t as CaseType));
  assert.deepEqual(thuaKhai, [], `khai NGOAI_PHEU nhưng vẫn nằm trong một khâu: ${thuaKhai.join(", ")}`);
  for (const [t, ly] of Object.entries(NGOAI_PHEU)) {
    assert.ok((ly ?? "").length > 30, `NGOAI_PHEU.${t} phải nói VÌ SAO, một dòng lý do thật`);
  }

  // ───────── 3. MỖI KHÂU NÓI ĐỦ BỐN CÂU ─────────
  //
  // Thiếu bất kỳ ô nào là khâu đó không dùng để điều hành được: thấy tắc mà không biết gọi ai,
  // hoặc biết gọi ai mà không biết bấm vào đâu để xem.
  const thuTu = OPERATING_FUNNEL.map((s) => s.order);
  assert.deepEqual(thuTu, [...thuTu].sort((a, b) => a - b), "khâu phải khai theo đúng thứ tự dòng chảy");
  assert.equal(new Set(thuTu).size, thuTu.length, "hai khâu trùng số thứ tự ⇒ không tính được tỷ lệ chuyển");
  for (const s of OPERATING_FUNNEL) {
    assert.ok(s.label.length > 3, `${s.key} thiếu tên tiếng Việt`);
    assert.ok(s.href.startsWith("/"), `${s.key} phải có đường tra ngược — con số không bấm được là con số không kiểm chứng được`);
    assert.ok(s.moneyMeaning.length > 30, `${s.key} phải nói TIỀN Ở ĐÂY NGHĨA LÀ GÌ; trộn lẫn các loại tiền là cách nhanh nhất để mất tin cậy`);
    assert.ok(s.sourceNote.length > 10, `${s.key} phải nói nguồn dữ liệu của nó`);
    assert.ok(CASE_TEAM[s.caseTypes[0] ?? "OTHER"] !== undefined, `${s.key} có loại việc lạ`);
  }
  assert.equal(nextStage(OPERATING_FUNNEL[0].key)?.order, 2, "khâu kế tiếp phải tra được");
  assert.equal(nextStage(OPERATING_FUNNEL[OPERATING_FUNNEL.length - 1].key), null, "khâu cuối không có khâu sau");

  // ───────── 4. KHÂU DÙNG LẠI MÁY MÓC CỦA HÀNG ĐỢI, KHÔNG DỰNG LUẬT THỨ HAI ─────────
  for (const s of OPERATING_FUNNEL) {
    for (const t of s.caseTypes) {
      assert.ok(CASE_ACTION[t], `${t} phải có hành động khuyến nghị sẵn trong sổ hàng đợi, không viết lại ở phễu`);
      assert.ok(CASE_TYPE_LABEL[t], `${t} phải có tên sẵn trong sổ hàng đợi`);
      assert.ok(t in CASE_SLA_HOURS, `${t} phải có mục hạn xử lý (kể cả cố ý null)`);
    }
  }

  // ───────── 5. MỐC TUỔI VIỆC PHỦ KÍN, KHÔNG CHỒNG LẤN ─────────
  const moc = AGING_BUCKETS.map((b) => b.maxHours);
  assert.deepEqual(moc, [...moc].sort((a, b) => a - b), "mốc tuổi phải tăng dần");
  assert.equal(moc[moc.length - 1], Number.POSITIVE_INFINITY, "mốc cuối phải hứng mọi việc còn lại — không việc nào được rơi ra ngoài mọi mốc");
  assert.equal(new Set(AGING_BUCKETS.map((b) => b.key)).size, AGING_BUCKETS.length, "khoá mốc tuổi trùng nhau");

  // ───────── 6. SỰ THẬT KHÔNG BỊ NHÂN HỆ SỐ ─────────
  const rong = new Map<CaseType, RecoveryRate>();
  const chuaDo = combineImpact(
    [
      { type: "DELIVERY_FAILED", amount: 10_000_000 },
      { type: "COD_OVERDUE", amount: 5_000_000 },
    ],
    rong,
  );
  assert.equal(chuaDo.moneyAtRisk, 15_000_000, "tiền đang treo phải là tổng cộng thẳng, không nhân hệ số nào");
  assert.equal(chuaDo.estimatedRecoverable, null, "chưa đo được tỷ lệ ⇒ KHÔNG ước tính, và null chứ không phải 0");
  assert.equal(chuaDo.unestimatedAtRisk, 15_000_000, "phải nói rõ toàn bộ tiền đang nằm ở loại chưa đo được");

  // ───────── 7. CÓ MẪU THÌ ƯỚC TÍNH RIÊNG TỪNG LOẠI, KHÔNG DÙNG TỶ LỆ TRUNG BÌNH ─────────
  const co = new Map<CaseType, RecoveryRate>([
    ["DELIVERY_FAILED", { type: "DELIVERY_FAILED", rate: 0.5, sample: 40, recovered: 20, basis: "phát lại thành công" }],
  ]);
  const tron = combineImpact(
    [
      { type: "DELIVERY_FAILED", amount: 10_000_000 },
      { type: "COD_OVERDUE", amount: 5_000_000 },
    ],
    co,
  );
  assert.equal(tron.moneyAtRisk, 15_000_000, "có ước tính cũng KHÔNG được đụng vào con số sự thật");
  assert.equal(tron.estimatedRecoverable, 5_000_000, "chỉ nhân tỷ lệ vào loại việc CÓ tỷ lệ đo được (10tr × 50%)");
  assert.equal(tron.unestimatedAtRisk, 5_000_000, "5tr của COD quá hạn chưa có cách đo ⇒ phải nói ra, không im lặng bỏ qua");
  assert.ok(tron.estimateBasis?.includes("40 ca"), "ước tính phải kèm cỡ mẫu — con số không truy được nguồn thì không dùng để quyết định được");

  // ───────── 8. NGƯỠNG MẪU LÀ THẬT, KHÔNG PHẢI TRANG TRÍ ─────────
  assert.ok(CO_MAU_TOI_THIEU >= 20, "dưới 20 mẫu thì tỷ lệ đo được nói về sự ngẫu nhiên, không nói về shop");
  for (const [t, basis] of Object.entries(RECOVERY_MEASURABLE)) {
    assert.ok(CASE_TEAM[t as CaseType], `${t} không phải loại việc có thật`);
    assert.ok((basis ?? "").length > 10, `${t} phải nói "cứu được" ở loại này NGHĨA LÀ GÌ`);
  }
  // Loại việc mà "cứu được" nghĩa ngược lại tuyệt đối không được dùng chung định nghĩa giao thành công.
  assert.ok(!RECOVERY_MEASURABLE.CANCELLED_BUT_SHIPPING, "đơn đã huỷ mà hàng vẫn đi: cứu được nghĩa là CHẶN được, đo bằng 'giao thành công' là đo ngược");
  assert.ok(!RECOVERY_MEASURABLE.COD_OVERDUE, "COD quá hạn: cứu được nghĩa là tiền về, kết quả đơn không nói gì về việc đó");

  console.log(
    `✓ Phễu vận hành: ${OPERATING_FUNNEL.length} khâu · ${dem.size} loại việc xếp khâu · ${Object.keys(NGOAI_PHEU).length} cắt ngang có lý do · 0 loại đếm hai lần · ` +
      `sự thật tách khỏi ước tính · ngưỡng ${CO_MAU_TOI_THIEU} mẫu · ${Object.keys(STAGE_BY_KEY).length} khâu tra được theo khoá`,
  );
}

if (process.argv[1] && /operating-funnel\.test\.ts$/.test(process.argv[1])) {
  testOperatingFunnel();
}
