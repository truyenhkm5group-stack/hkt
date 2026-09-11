import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  CAPABILITY_PROBE_LIMIT,
  FRESHNESS_BY_STAGE,
  TRACKING_CAPABILITIES,
  classifyFreshness,
  thresholdFor,
} from "@/lib/constants/logistics-freshness";

/**
 * ═══════════ ĐỘ TƯƠI LÀ SỨC KHOẺ DỮ LIỆU, KHÔNG PHẢI KẾT QUẢ KINH DOANH ═══════════
 *
 * Đây là ranh giới nguy hiểm nhất của cả tính năng này, và nó dễ bị vượt qua một cách vô tình.
 *
 * Một vận đơn "đang đi giao" im lặng 30 giờ trông rất giống một đơn đã giao xong mà chưa kịp báo.
 * Cám dỗ là để hệ thống "đoán giúp". Nhưng suy ra `DELIVERED` hay `RETURNED` từ sự IM LẶNG là bịa
 * ra một sự kiện chưa từng xảy ra — và nó sẽ đi thẳng vào doanh thu, giá vốn, tồn kho, lương.
 *
 * Luật: **im lặng chỉ sinh ra CẢNH BÁO ĐỘ TƯƠI, không bao giờ sinh ra kết luận.** Kết quả đơn vẫn
 * theo chứng từ cuối cùng, dù chứng từ đó cũ tới đâu.
 *
 * Bài kiểm này đọc MÃ NGUỒN: lớp độ tươi không được đụng tới `ORDER_OUTCOME`, không được ghi, và
 * không được nhắc tới bất kỳ giá trị kết quả đơn nào.
 *
 * Chạy riêng: npx tsx --tsconfig tsconfig.json tests/logistics-freshness.test.ts
 */

const goc = path.resolve(__dirname, "..");
const doc = (p: string) => fs.readFileSync(path.join(goc, p), "utf8");

/**
 * Bỏ chú thích trước khi soi.
 *
 * Bài kiểm này soi MÃ, không soi lời giải thích. Chính chú thích nói "suy ra kết quả từ im lặng là
 * điều `ORDER_OUTCOME` cấm" đã làm nó đỏ ở lần chạy đầu — một lá chắn bắt người viết vì đã giải
 * thích cẩn thận thì nó dạy sai điều.
 */
function boChuThich(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

export function testLogisticsFreshness() {
  // ───────── 1. LỚP ĐỘ TƯƠI KHÔNG ĐƯỢC CHẠM VÀO KẾT QUẢ ĐƠN ─────────
  for (const f of ["lib/queries/logistics-freshness.ts", "lib/constants/logistics-freshness.ts"]) {
    const src = boChuThich(doc(f));
    assert.ok(!/ORDER_OUTCOME/.test(src), `${f} KHÔNG được dùng ORDER_OUTCOME — độ tươi là sức khoẻ dữ liệu, không phải kết quả đơn`);
    for (const ket of ["'DELIVERED'", "'RETURNED'", "'RETURNED_BY_RULE'", "'CANCELLED'"]) {
      assert.ok(!src.includes(ket), `${f} nhắc tới kết quả đơn ${ket} — im lặng KHÔNG được phép suy ra kết luận`);
    }
    // Không ghi: một lớp chỉ-đo mà biết ghi thì sớm muộn sẽ "sửa cho đúng".
    assert.ok(!/\.update\s*\(|\.insert\s*\(|\.delete\s*\(/.test(src), `${f} CHỈ ĐƯỢC ĐỌC — lớp đo không bao giờ được tự sửa dữ liệu`);
  }

  // ───────── 2. NGƯỠNG THEO CHẶNG PHẢI TĂNG DẦN VÀ CÓ LÝ DO ─────────
  const changs = Object.entries(FRESHNESS_BY_STAGE);
  assert.ok(changs.length >= 5, `phải khai ngưỡng cho ít nhất 5 chặng, hiện ${changs.length}`);
  for (const [stage, t] of changs) {
    assert.ok(t.aging < t.stale && t.stale < t.critical, `${stage}: ngưỡng phải tăng dần (aging < stale < critical)`);
    assert.ok(t.why.length > 30, `${stage} phải nói VÌ SAO ngưỡng là con số đó, không phải một số rơi từ trên trời`);
  }

  /*
    Chặng "đang đi giao" phải NGẶT hơn "chờ lấy hàng".

    Một kiện chờ ĐVVC tới lấy ba ngày là chậm nhưng bình thường; một kiện đang trên xe đi giao mà
    im ba ngày nghĩa là ERP không biết nó đã tới tay khách hay chưa — và đó là tiền.
  */
  assert.ok(
    thresholdFor("OUT_FOR_DELIVERY").aging < thresholdFor("PENDING").aging,
    "đang đi giao phải có ngưỡng ngặt hơn chờ lấy hàng",
  );
  assert.ok(
    thresholdFor("DELIVERY_FAILED").aging < thresholdFor("RETURNING").aging,
    "giao hụt cần người gọi ngay, phải ngặt hơn chiều hoàn vốn chậm sẵn",
  );

  // ───────── 3. KHÔNG CÓ TIN TỨC LÀ TỆ NHẤT, KHÔNG PHẢI TỐT NHẤT ─────────
  assert.equal(
    classifyFreshness(null, "IN_TRANSIT"),
    "CRITICAL_STALE",
    "chưa có sự kiện nào ⇒ CRITICAL_STALE. Trả FRESH cho dữ liệu TRỐNG là biến 'không biết gì' thành 'mọi thứ ổn'",
  );

  // ───────── 4. XẾP HẠNG ĐÚNG THEO NGƯỠNG CỦA CHÍNH CHẶNG ĐÓ ─────────
  const t = thresholdFor("OUT_FOR_DELIVERY");
  assert.equal(classifyFreshness(t.aging - 0.1, "OUT_FOR_DELIVERY"), "FRESH");
  assert.equal(classifyFreshness(t.aging, "OUT_FOR_DELIVERY"), "AGING");
  assert.equal(classifyFreshness(t.stale, "OUT_FOR_DELIVERY"), "STALE");
  assert.equal(classifyFreshness(t.critical, "OUT_FOR_DELIVERY"), "CRITICAL_STALE");
  // Cùng một số giờ, hai chặng khác nhau ⇒ hai hạng khác nhau. Đó chính là mục đích của ngưỡng theo chặng.
  assert.notEqual(
    classifyFreshness(30, "OUT_FOR_DELIVERY"),
    classifyFreshness(30, "RETURNING"),
    "30 giờ im lặng ở chặng đang giao và ở chặng hoàn về KHÔNG thể cùng một mức nghiêm trọng",
  );

  // ───────── 5. KHẢ NĂNG TRA CỨU: BA TRẠNG THÁI, KẾT LUẬN CÓ GIỚI HẠN ─────────
  assert.deepEqual([...TRACKING_CAPABILITIES], ["API_TRACKABLE", "WEBHOOK_ONLY", "UNKNOWN_CAPABILITY"]);
  assert.ok(CAPABILITY_PROBE_LIMIT >= 2 && CAPABILITY_PROBE_LIMIT <= 5, "thử 2–5 lần rồi kết luận; thử mãi là quay lại đúng vấn đề cần sửa");

  /*
    ═══ BỘ TRA CỨU PHẢI THÔI HỎI VẬN ĐƠN ĐÃ CHỨNG MINH LÀ KHÔNG HỎI ĐƯỢC ═══

    Đo được 11/09/2026: nguồn `VTP_POLL` sinh ra 0 sự kiện từ trước tới nay, `sync_runs` ghi "tài
    khoản API không thấy vận đơn nào — lượt thứ 548 liên tiếp". Nếu điều kiện lọc này biến mất, ERP
    lại gọi một API không bao giờ trả về gì cho hàng trăm vận đơn mỗi 10 phút.
  */
  const sync = doc("lib/integrations/viettelpost/sync.ts");
  assert.match(sync, /trackingCapability\}? <> 'WEBHOOK_ONLY'/, "vòng tra cứu phải LOẠI vận đơn WEBHOOK_ONLY");
  assert.match(sync, /CAPABILITY_PROBE_LIMIT/, "phải kết luận khả năng sau số lần thử có giới hạn");
  assert.match(sync, /API_TRACKABLE/, "tra được thì phải ghi nhận bằng chứng theo hướng ngược lại, để còn quay về vòng đối chiếu");

  console.log(
    `✓ Độ tươi vận đơn: ${changs.length} chặng có ngưỡng riêng kèm lý do · không tin tức ⇒ CRITICAL_STALE (không phải FRESH) · ` +
      `lớp đo KHÔNG chạm ORDER_OUTCOME và KHÔNG ghi · bộ tra cứu thôi hỏi vận đơn WEBHOOK_ONLY sau ${CAPABILITY_PROBE_LIMIT} lần`,
  );
}

if (process.argv[1] && /logistics-freshness\.test\.ts$/.test(process.argv[1])) {
  testLogisticsFreshness();
}
