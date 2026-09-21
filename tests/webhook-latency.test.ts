import assert from "node:assert/strict";
import { clearMemo } from "@/lib/cache";
import {
  webhookLatencyVerdict,
  WEBHOOK_LATENCY_LAGGING_FLOOR_SECONDS,
  WEBHOOK_LATENCY_MIN_SAMPLE,
  WEBHOOK_LATENCY_MULTIPLIER,
  WEBHOOK_LATENCY_STALLED_SECONDS,
  WEBHOOK_LATENCY_VERDICTS,
} from "@/lib/constants/webhook-latency";
import { vtpWebhookHealth } from "@/lib/queries/vtp-webhook-health";

/**
 * ═══════════ SỰ CỐ 21/09/2026: GÓI TIN VỀ ĐỦ SỐ NHƯNG ĐỀU CŨ 28 PHÚT ═══════════
 *
 * Viettel Post gửi 738 gói trong ngày — cao hơn mọi hôm — nên `liveness` báo `HEALTHY` suốt. Đo
 * thật: trung vị trễ **1.679 giây (28 phút)**, p90 41 phút, 548/738 gói trễ quá 5 phút, trong khi
 * 13 ngày trước đó trung vị là **31–37 giây**. Gói "Chuyển hoàn bưu cục gốc" của PKE1521276709
 * xảy ra 17:02:43, ERP nhận 17:35:22.
 *
 * Không gói nào lỗi, 736/738 gói `delivery_count = 1` (ERP trả lời ngay từ lần đầu). Loại hỏng
 * này không để lại dấu vết nào ngoài chính độ trễ — nên nếu không đo nó thì không thấy nó.
 */
export async function testWebhookLatency() {
  /* ───── 1 · Mẫu mỏng KHÔNG được kết luận ───── */
  const mong = webhookLatencyVerdict({ medianSeconds: 30, baselineSeconds: 35, sample: WEBHOOK_LATENCY_MIN_SAMPLE - 1 });
  assert.equal(mong.verdict, "UNKNOWN", "hai gói lẻ lúc 3 giờ sáng không được quyền kết luận về đường truyền");
  assert.match(mong.note, /CHƯA BIẾT/, "và phải nói ra là chưa biết, không im lặng");
  assert.equal(webhookLatencyVerdict({ medianSeconds: null, baselineSeconds: 35, sample: 100 }).verdict, "UNKNOWN");

  /* ───── 2 · BẤT ĐỐI XỨNG: thiếu nền vẫn kết luận XẤU được, nhưng không kết luận TỐT ───── */
  const xauKhongNen = webhookLatencyVerdict({ medianSeconds: WEBHOOK_LATENCY_STALLED_SECONDS, baselineSeconds: null, sample: 50 });
  assert.equal(xauKhongNen.verdict, "STALLED", "một quan sát 15 phút tự nó đã đủ nói, không cần nền");
  const totKhongNen = webhookLatencyVerdict({ medianSeconds: WEBHOOK_LATENCY_LAGGING_FLOOR_SECONDS + 1, baselineSeconds: null, sample: 50 });
  assert.equal(totKhongNen.verdict, "UNKNOWN", "thiếu nền thì KHÔNG được nói “kịp” — đúng lỗi mà mục 52 đã cấm");
  assert.notEqual(totKhongNen.verdict, "FRESH");

  /* ───── 3 · Chính con số của sự cố phải ra STALLED ───── */
  const sc = webhookLatencyVerdict({ medianSeconds: 1679, baselineSeconds: 35, sample: 738 });
  assert.equal(sc.verdict, "STALLED", "28 phút trong khi nền 35 giây mà vẫn “khoẻ” thì màn hình này vô dụng");
  assert.match(sc.note, /28 phút/, "câu chữ phải nói ra con số để người trực biết đang tin vào dữ liệu cũ bao lâu");

  /* ───── 4 · Vượt nền nhiều lần NHƯNG còn nhỏ thì KHÔNG hét ───── */
  const nenNho = webhookLatencyVerdict({ medianSeconds: 30, baselineSeconds: 2, sample: 50 });
  assert.equal(nenNho.verdict, "FRESH", "gấp 15 lần nền nhưng 30 giây thì không quyết định nào của đội đổi đi");
  assert.ok(30 > 2 * WEBHOOK_LATENCY_MULTIPLIER, "ca này ĐÚNG là vượt bội số — nếu không nó không kiểm được cái sàn tuyệt đối");

  /* ───── 5 · Vượt CẢ HAI mới là LAGGING ───── */
  const nen = 35;
  const vuaDu = Math.max(WEBHOOK_LATENCY_LAGGING_FLOOR_SECONDS, nen * WEBHOOK_LATENCY_MULTIPLIER + 1);
  assert.equal(webhookLatencyVerdict({ medianSeconds: vuaDu, baselineSeconds: nen, sample: 50 }).verdict, "LAGGING");
  assert.equal(webhookLatencyVerdict({ medianSeconds: nen + 5, baselineSeconds: nen, sample: 50 }).verdict, "FRESH", "ngang nền là kịp");
  // Ngưỡng dựng TỪ CHÍNH HẰNG SỐ đang chạy, không gõ lại con số (mục 65).
  assert.ok(vuaDu < WEBHOOK_LATENCY_STALLED_SECONDS, "ca LAGGING phải nằm dưới ngưỡng STALLED, nếu không nó đang kiểm nhầm nhánh");

  /* ───── 6 · Hàm THUẦN: chạy hai lần ra cùng kết quả, không đọc đồng hồ ───── */
  const a = webhookLatencyVerdict({ medianSeconds: 600, baselineSeconds: 40, sample: 60 });
  const b = webhookLatencyVerdict({ medianSeconds: 600, baselineSeconds: 40, sample: 60 });
  assert.deepEqual(a, b);

  /* ───── 7 · Truy vấn thật trả đủ trường, và KHÔNG bao giờ "kịp" khi chưa có gói nào ───── */
  clearMemo();
  const h = await vtpWebhookHealth();
  assert.ok(WEBHOOK_LATENCY_VERDICTS.includes(h.latency), `kết luận độ trễ phải nằm trong sổ, nhận được "${h.latency}"`);
  assert.equal(typeof h.latencySample, "number", "ĐỘ PHỦ phải đi kèm con số, không để người đọc tự đoán mẫu");
  assert.ok(h.latencyNote.length > 0, "mỗi kết luận phải có một câu giải thích");
  if (h.latencySample < WEBHOOK_LATENCY_MIN_SAMPLE) {
    assert.equal(h.latency, "UNKNOWN", "mẫu mỏng ⇒ CHƯA BIẾT, không phải FRESH");
    assert.equal(h.latencyMedianSeconds === null || h.latencySample === 0 ? "UNKNOWN" : h.latency, "UNKNOWN");
  }
  assert.ok(h.latencyBaselineSeconds === null || h.latencyBaselineSeconds >= 0, "nền âm là vô nghĩa — lệch đồng hồ đã phải kẹp về 0 trong SQL");
  assert.ok(h.latencyMedianSeconds === null || h.latencyMedianSeconds >= 0);

  /* ───── 8 · Độ trễ ĐỘC LẬP với số lượng: đó là lý do câu hỏi này tồn tại ───── */
  assert.equal(
    webhookLatencyVerdict({ medianSeconds: 1679, baselineSeconds: 35, sample: 5000 }).verdict,
    "STALLED",
    "nhận RẤT NHIỀU gói không làm dữ liệu mới hơn — ngày 21/09 số gói cao hơn mọi hôm mà vẫn cũ 28 phút",
  );

  clearMemo();
  console.log("✓ Độ trễ webhook: mẫu mỏng là CHƯA BIẾT · thiếu nền vẫn kết luận xấu được nhưng không kết luận tốt · 28 phút trên nền 35 giây ⇒ dồn ứ · nền nhỏ không bị hét · độc lập với số lượng gói");
}
