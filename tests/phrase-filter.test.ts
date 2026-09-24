import assert from "node:assert/strict";
import { CARE_ATTEMPT_BAND_KEYS, CARE_COD_BAND_KEYS, CARE_SLA_BUCKETS } from "@/lib/care/filters";
import { PHRASE_EXAMPLES, parsePhraseFilter } from "@/lib/care/phrase-filter";
import { CARE_REASON_LABEL } from "@/lib/constants/care";
import { CARE_ROUND_BAND_KEYS } from "@/lib/constants/care-rounds";
import { FOLLOW_UP_FILTERS, RESOLUTION_FILTER_KEYS } from "@/lib/constants/care-resolution";
import { CARRIER_SUBSTATES } from "@/lib/constants/carrier-substate";

/**
 * LỌC BẰNG CÂU CHỈ ÁP NHỮNG GÌ NÓ HIỂU CHẮC — phần còn lại phải NÓI RA, không áp gần đúng.
 *
 * Ba lỗi bài kiểm này tồn tại để chặn:
 *  1. "trên 800K" bị làm tròn thành một dải có sẵn ⇒ giấu kiện 800K–999K khỏi người trực.
 *  2. "quá hẹn" (cái hẹn gọi lại) bị hiểu thành "quá hạn" (SLA) — bỏ dấu thì hai chữ chỉ khác một nguyên âm.
 *  3. "đã hoàn" bị hiểu thành QUYẾT ĐỊNH của đội thay vì trạng thái ĐVVC báo.
 */
export function testPhraseFilter() {
  const p = parsePhraseFilter;

  // Câu mẫu hiện trên màn hình phải được hiểu TRỌN — một câu mẫu mà máy không hiểu là tự bắn vào chân.
  for (const cau of PHRASE_EXAMPLES) {
    const r = p(cau);
    assert.deepEqual(r.unknown, [], `câu mẫu "${cau}" còn phần chưa hiểu: ${r.unknown.join(" ")}`);
    assert.ok(r.understood.length > 0, `câu mẫu "${cau}" không ra bộ lọc nào`);
  }

  // Có dấu và không dấu ra CÙNG kết quả.
  assert.deepEqual(p("cod trên 1 triệu chưa ai nhận").patch, { tien: "gte1m", nguoi: "none" });
  assert.deepEqual(p("cod tren 1 trieu chua ai nhan").patch, { tien: "gte1m", nguoi: "none" });

  // Năm dải COD — và chỉ năm dải đó.
  assert.equal(p("không thu hộ").patch.tien, "0");
  assert.equal(p("dưới 500k").patch.tien, "lt500");
  assert.equal(p("500k - 600k").patch.tien, "500-600");
  assert.equal(p("từ 600k đến 1 triệu").patch.tien, "600-1m");
  assert.equal(p("≥1tr").patch.tien, "gte1m");
  const tam = p("trên 800k");
  assert.equal(tam.patch.tien, undefined, "không có dải 'trên 800K' ⇒ KHÔNG được áp gần đúng");
  assert.ok(tam.unknown.includes("800k"), "…và phần ấy phải hiện là chưa hiểu");

  // Hạn (SLA) ≠ hẹn (gọi lại). "sắp quá hạn" không được rơi vào "quá hạn".
  assert.deepEqual(p("quá hạn").patch, { han: "breached" });
  assert.deepEqual(p("sắp quá hạn").patch, { han: "soon" });
  assert.deepEqual(p("quá hẹn").patch, { hen: "overdue" });
  assert.deepEqual(p("hẹn hôm nay").patch, { hen: "today" });

  // Trạng thái ĐVVC đọc từ sổ nhãn; "đã hoàn" một mình là CHỨNG TỪ, "kết quả đã hoàn" mới là quyết định.
  assert.deepEqual(p("quá hạn chờ phát lại").patch, { han: "breached", dvvc: "WAITING_REDELIVERY" });
  assert.deepEqual(p("đã hoàn").patch, { dvvc: "RETURNED" });
  assert.deepEqual(p("kết quả đã hoàn").patch, { ketqua: "CARE_RETURN" });
  assert.deepEqual(p("chưa quyết định").patch, { ketqua: "none" });

  // Lý do care không trùng tên trạng thái ĐVVC.
  assert.deepEqual(p("khách không nghe máy").patch, { lydo: "NO_CONTACT" });

  // Phát hụt và số lượt xử lý — hai phép đếm khác nhau.
  assert.deepEqual(p("hụt 2 lần chưa xử lý lần nào").patch, { hut: "2", luot: "0" });
  assert.deepEqual(p("hụt 3 lần trở lên").patch, { hut: "3plus" });

  // Mã / SĐT / chữ trong ngoặc kép là tìm theo chữ, giữ nguyên dấu.
  assert.deepEqual(p("0987654321 quá hạn").patch, { q: "0987654321", han: "breached" });
  assert.equal(p('"Nguyễn Văn A"').patch.q, "Nguyễn Văn A");

  // Hai giá trị cùng một chiều: giữ cái đầu, cái sau vào `conflicts` — không lặng lẽ nuốt.
  const trung = p("hụt 1 lần hụt 2 lần");
  assert.equal(trung.patch.hut, "1");
  assert.equal(trung.conflicts.length, 1);

  // Từ lạ không bị ép vào đâu cả.
  const la = p("hà nội quá hạn");
  assert.deepEqual(la.patch, { han: "breached" });
  assert.deepEqual(la.unknown, ["ha", "noi"]);

  // Mọi giá trị hàm trả ra phải là một khoá HỢP LỆ của bộ lọc tương ứng — không có giá trị ma.
  const hopLe: Record<string, readonly string[]> = {
    tien: CARE_COD_BAND_KEYS,
    han: CARE_SLA_BUCKETS,
    hut: CARE_ATTEMPT_BAND_KEYS,
    luot: CARE_ROUND_BAND_KEYS,
    hen: FOLLOW_UP_FILTERS,
    ketqua: RESOLUTION_FILTER_KEYS,
    dvvc: CARRIER_SUBSTATES,
    lydo: Object.keys(CARE_REASON_LABEL),
    nguoi: ["none"],
  };
  const cauThu = ["không thu hộ", "dưới 500k", "500k-600k", "600k đến 1 triệu", "trên 1 triệu", "quá hạn", "sắp quá hạn", "trong hạn", "quá hẹn", "hẹn mai", "chưa hẹn", "chưa ai nhận", "chưa ai chạm", "đã xử lý 2 lượt", "chưa hụt", "hụt 1 lần", "chưa quyết định", "kết quả phát tiếp", "kết quả xử lý sau", "đang chuyển hoàn", "chờ lấy hàng", "đang đi giao", "khách không nghe máy", "im lặng quá ngưỡng", "giao thất bại"];
  for (const cau of cauThu) {
    const r = p(cau);
    assert.ok(r.understood.length === 1, `"${cau}" phải ra đúng một bộ lọc, ra ${r.understood.length}: ${JSON.stringify(r.patch)}`);
    for (const [k, v] of Object.entries(r.patch)) {
      if (k === "q") continue;
      assert.ok(hopLe[k]?.includes(v!), `"${cau}" → ${k}=${v} không phải giá trị lọc hợp lệ`);
    }
  }

  // Hàm thuần: gọi hai lần ra cùng kết quả.
  assert.deepEqual(p("cod trên 1 triệu chưa ai nhận quá hạn"), p("cod trên 1 triệu chưa ai nhận quá hạn"));

  console.log("✓ Lọc bằng câu: chỉ áp bộ lọc đã hiểu chắc · 'trên 800K' không bị làm tròn · hạn ≠ hẹn · 'đã hoàn' là chứng từ ĐVVC · có dấu = không dấu");
}
