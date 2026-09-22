import assert from "node:assert/strict";
import {
  CARE_BACKLOG_GROUPS,
  CARE_ROUND_BANDS,
  CARE_ROUND_BAND_KEYS,
  CARE_ROUND_MERGE_MINUTES,
  CARE_TIMELINE_IS_ROUND,
  CARE_TIMELINE_KINDS,
  careBacklogGroup,
  careRoundAppend,
  careRoundBand,
  careRoundCount,
  careStatusArrow,
  type CareRoundEntry,
} from "@/lib/constants/care-rounds";
import { CARE_STATUS_LABEL } from "@/lib/constants/care";

/**
 * ═══════════ "ĐÃ XỬ LÝ MẤY LƯỢT" — BÀI KIỂM CỦA MỘT PHÉP ĐẾM CHẤM NGƯỜI ═══════════
 *
 * Con số này đi vào thẻ "Chưa ai đụng" của Báo cáo hiệu quả care, tức là nó tham gia vào việc chủ
 * shop đánh giá đội. Nên nó phải sai về phía ĐẾM THIẾU (ca nổi lên hàng đợi, có người mở ra nhìn)
 * chứ không bao giờ sai về phía ĐẾM THỪA (ca trông như đã xử lý rồi và chìm xuống).
 *
 * MỐC THỜI GIAN DỰNG TỪ CHÍNH DỮ LIỆU CỦA BÀI KIỂM (`T0` + số phút), không ghim một ngày tuyệt đối
 * rồi gieo dữ liệu tương đối so với nó, và không có cửa sổ "N giờ trước" nào trỏ vào dữ liệu ngày
 * cố định — luật 50. Mọi hàm ở đây THUẦN và nhận `now` từ ngoài, nên bài kiểm cho cùng kết luận
 * lúc 3 giờ sáng thứ Tư và 5 giờ chiều Chủ nhật.
 */
const T0 = new Date("2026-09-22T01:00:00Z");
const phut = (n: number) => new Date(T0.getTime() + n * 60_000);
const ghi = (phutThu: number, actorId: string | null, kind: "ACTION" | "DECISION" = "ACTION"): CareRoundEntry => ({ at: phut(phutThu), actorId, kind });

export function testCareRounds() {
  /* ═══════════ 1 · KHÔNG CÓ GHI NHẬN NÀO LÀ 0 — VÀ 0 LÀ MỘT CÂU TRẢ LỜI, KHÔNG PHẢI THIẾU DỮ LIỆU ═══════════ */
  assert.equal(careRoundCount([]), 0);
  assert.equal(careRoundBand(0), "0");

  /* ═══════════ 2 · CỬA SỔ GỘP: "GỌI KHÁCH XONG RỒI BẤM PHÁT TIẾP" LÀ MỘT LƯỢT ═══════════

     Đây là kịch bản THẬT của đường ghi: `addCareNote` ghi vào `care_actions`, `recordCareDecision`
     ghi vào `care_decisions`. Một thao tác của người để lại HAI dòng ở hai sổ. */
  assert.equal(careRoundCount([ghi(0, "u1", "ACTION"), ghi(2, "u1", "DECISION")]), 1, "ghi note rồi bấm kết quả trong 2 phút phải là MỘT lượt");
  assert.equal(careRoundCount([ghi(0, "u1"), ghi(CARE_ROUND_MERGE_MINUTES, "u1")]), 1, "đúng bằng cửa sổ gộp thì vẫn là một lượt (biên đóng)");
  assert.equal(careRoundCount([ghi(0, "u1"), ghi(CARE_ROUND_MERGE_MINUTES + 0.1, "u1")]), 2, "quá cửa sổ một chút là hai lượt — biên phải dứt khoát");

  /* Quay lại sau vài giờ là một lượt MỚI: đó là điều con số này sinh ra để đếm. */
  assert.equal(careRoundCount([ghi(0, "u1"), ghi(2, "u1"), ghi(360, "u1"), ghi(361, "u1")]), 2, "hai lần ngồi làm cách nhau 6 giờ = 2 lượt, dù có 4 dòng ghi");

  /* ═══════════ 3 · HAI NGƯỜI KHÁC NHAU KHÔNG BAO GIỜ GỘP ═══════════

     Ca chuyển tay giữa chừng: A gọi, một phút sau B bấm kết quả. Đó là HAI người cùng làm việc với
     kiện, và gộp lại là xoá mất công của một trong hai. */
  assert.equal(careRoundCount([ghi(0, "u1"), ghi(1, "u2")]), 2, "hai người khác nhau cách 1 phút vẫn là hai lượt");

  /* ═══════════ 4 · HAI DÒNG KHÔNG NỐI ĐƯỢC TÀI KHOẢN: GỘP, TỨC ĐẾM THIẾU ═══════════

     Lựa chọn có chủ ý và nó phải được KHOÁ LẠI, vì "sửa" nó theo hướng đếm thừa nghe rất hợp lý.
     Đếm thừa làm ca trông đã được xử lý nhiều hơn thực tế ⇒ GIẤU việc. Đếm thiếu thì ca nổi lên
     sớm hơn và người trực mở ra thấy ngay là đã làm rồi — chỉ một trong hai chiều tự sửa được. */
  assert.equal(careRoundCount([ghi(0, null), ghi(1, null)]), 1, "hai dòng chưa nối tài khoản trong cửa sổ gộp: đếm THIẾU, không đếm thừa");
  assert.equal(careRoundCount([ghi(0, null), ghi(120, null)]), 2, "nhưng cách nhau 2 giờ thì vẫn là hai lượt — cửa sổ mới là thứ quyết định");

  /* ═══════════ 5 · THỨ TỰ ĐẦU VÀO KHÔNG ĐƯỢC ĐỔI KẾT QUẢ ═══════════

     Ba sổ đọc lên bằng một `union all`, nên thứ tự dòng là thứ tự của Postgres chứ không phải thứ
     tự thời gian. Một phép đếm đổi kết quả theo thứ tự dòng là một phép đếm chạy hai lần ra hai số. */
  const xuoi = [ghi(0, "u1"), ghi(2, "u1"), ghi(400, "u2")];
  const nguoc = [...xuoi].reverse();
  const tron = [xuoi[2], xuoi[0], xuoi[1]];
  assert.equal(careRoundCount(xuoi), 2);
  assert.equal(careRoundCount(nguoc), careRoundCount(xuoi), "đảo ngược đầu vào phải ra cùng một số");
  assert.equal(careRoundCount(tron), careRoundCount(xuoi), "trộn thứ tự phải ra cùng một số");

  /* ═══════════ 5b · "SỐ LẦN CHẠM" DÙNG LẠI ĐÚNG CỬA SỔ GỘP NÀY — KHÔNG ĐƯỢC ĐẾM ĐÔI ═══════════

     Đường ghi thật soi bóng: `addCareNote` ghi MỘT dòng `care_actions` VÀ MỘT sự kiện `NOTE`;
     `recordCareDecision` ghi một dòng `care_decisions` VÀ một sự kiện `STATUS`. Hai sổ theo thiết
     kế (một sổ là việc đã làm, một sổ là nhật ký ca), nên đếm thẳng số dòng thì một thao tác ra
     HAI lần chạm — và con số ấy đứng cạnh số lượt trong cùng một tooltip.

     Bản đầu tiên của bàn care đếm thẳng, và một khẳng định trên đường ghi thật
     (`tests/care-workbench.test.ts`) bắt được. Giữ nó ở đây để lần sửa sau không phải học lại. */
  const motThaoTac = [ghi(0, "u1", "ACTION"), ghi(0.01, "u1", "DECISION")];
  assert.equal(careRoundCount(motThaoTac), 1, "một thao tác để lại hai dòng ở hai sổ vẫn là MỘT lần — cùng cửa sổ gộp, không có phép đếm thứ hai");

  /* ═══════════ 6 · BĂNG LỌC PHỦ KÍN VÀ KHÔNG CHỒNG ═══════════ */
  for (const n of [0, 1, 2, 3, 7, 40]) assert.ok(CARE_ROUND_BAND_KEYS.includes(careRoundBand(n)), `${n} lượt rơi ra ngoài mọi rổ`);
  assert.equal(careRoundBand(1), "1");
  assert.equal(careRoundBand(2), "2");
  assert.equal(careRoundBand(3), "3plus");
  assert.equal(careRoundBand(99), "3plus");
  // Không rổ nào ôm hai giá trị mà rổ khác cũng nhận: mỗi số rơi vào đúng MỘT rổ.
  for (const n of [0, 1, 2, 3, 10]) {
    const trung = CARE_ROUND_BANDS.filter((b) => n >= b.min && n <= b.max);
    assert.equal(trung.length, 1, `${n} lượt khớp ${trung.length} rổ — các rổ phải rời nhau`);
  }

  /* ═══════════ 7 · "CÒN TREO" BỔ RA BA NHÓM, VÀ CHÚNG PHẢI RỜI NHAU ═══════════ */
  const bayGio = phut(0);
  assert.equal(careBacklogGroup(0, null, bayGio), "UNTOUCHED");
  assert.equal(careBacklogGroup(0, phut(600), bayGio), "UNTOUCHED", "chưa ai đụng thì cái hẹn không cứu được — vẫn là backlog thật");
  assert.equal(careBacklogGroup(2, phut(600), bayGio), "WORKED_SCHEDULED", "đã làm và hẹn ở phía trước: KHÔNG phải việc của lúc này");
  assert.equal(careBacklogGroup(2, phut(-10), bayGio), "WORKED_DUE", "hẹn đã qua thì quay lại hàng đợi");
  assert.equal(careBacklogGroup(2, null, bayGio), "WORKED_DUE", "một cái hẹn không có giờ không phải một cái hẹn — cùng luật với careViewOf");
  assert.equal(careBacklogGroup(1, bayGio, bayGio), "WORKED_DUE", "đúng giây tới hẹn là ĐÃ tới hẹn, không phải còn trong hẹn");

  /* Mỗi (số lượt, cái hẹn) rơi vào ĐÚNG MỘT nhóm, và nhóm đó luôn là một nhóm đã khai. */
  for (const r of [0, 1, 5]) {
    for (const h of [null, phut(-60), phut(60)]) {
      const g = careBacklogGroup(r, h, bayGio);
      assert.ok(CARE_BACKLOG_GROUPS.includes(g), `(${r} lượt, hẹn ${h}) ra nhóm lạ: ${g}`);
    }
  }

  /* ═══════════ 8 · CỘNG MỘT LƯỢT VỪA GHI = ĐÚNG SỐ MÁY CHỦ SẼ ĐẾM LẠI ═══════════

     Tính chất quan trọng nhất của `careRoundAppend`: nó KHÔNG được là một luật thứ hai. Với mọi
     dãy ghi nhận, cộng dần từng dòng phải ra đúng con số mà `careRoundCount` tính một lượt trên cả
     dãy — nếu không thì trình duyệt và máy chủ sẽ nói hai số cho cùng một kiện. */
  const dayThu: CareRoundEntry[][] = [
    [ghi(0, "u1"), ghi(2, "u1"), ghi(3, "u1")],
    [ghi(0, "u1"), ghi(2, "u2"), ghi(400, "u2"), ghi(402, "u2")],
    [ghi(0, null), ghi(1, null), ghi(500, "u1")],
    [ghi(0, "u1"), ghi(CARE_ROUND_MERGE_MINUTES, "u1"), ghi(CARE_ROUND_MERGE_MINUTES * 2, "u1")],
    [ghi(0, "u1")],
  ];
  for (const day of dayThu) {
    let cong = { rounds: 0, lastRoundAt: null as Date | null, lastRoundActorId: null as string | null };
    for (const e of day) cong = careRoundAppend(cong, { at: e.at, actorId: e.actorId });
    assert.equal(cong.rounds, careRoundCount(day), `cộng dần (${cong.rounds}) phải bằng đếm một lượt (${careRoundCount(day)}) trên cùng dãy`);
    assert.equal(cong.lastRoundAt?.getTime(), day[day.length - 1].at.getTime(), "mốc lượt cuối phải là ghi nhận cuối cùng");
  }

  /* Cộng vào một đợt CHƯA CÓ lượt nào luôn ra 1 — kể cả khi `lastRoundAt` còn sót lại một giá trị. */
  assert.equal(careRoundAppend({ rounds: 0, lastRoundAt: phut(-1), lastRoundActorId: "u1" }, { at: phut(0), actorId: "u1" }).rounds, 1, "0 lượt cộng một ghi nhận phải ra 1, không ra 0");

  /* ═══════════ 9 · DÒNG NÀO LÀ MỘT LƯỢT — DẪN XUẤT, KHÔNG KHAI HAI CHỖ ═══════════

     Chỉ "việc đã làm" và "kết quả đã quyết" là một lượt. Đổi trạng thái, GIAO VIỆC, đặt hẹn thì
     KHÔNG — luật 57: một trưởng nhóm bấm giao 50 ca trong ba phút không làm 50 ca được xử lý. */
  assert.equal(CARE_TIMELINE_IS_ROUND.ACTION, true);
  assert.equal(CARE_TIMELINE_IS_ROUND.DECISION, true);
  assert.equal(CARE_TIMELINE_IS_ROUND.ASSIGN, false, "GIAO VIỆC không bao giờ là một lượt xử lý (luật 57)");
  assert.equal(CARE_TIMELINE_IS_ROUND.STATUS, false, "đổi trạng thái là “chạm vào”, không phải “đã xử lý”");
  assert.equal(CARE_TIMELINE_IS_ROUND.FOLLOW_UP, false);
  // Mọi loại dòng đã khai đều phải có câu trả lời — thêm một loại mà quên khai là một `undefined`
  // lặng lẽ được đọc thành `false`.
  for (const k of CARE_TIMELINE_KINDS) assert.equal(typeof CARE_TIMELINE_IS_ROUND[k], "boolean", `loại dòng ${k} chưa khai có phải một lượt hay không`);
  assert.equal(CARE_TIMELINE_KINDS.filter((k) => CARE_TIMELINE_IS_ROUND[k]).length, 2, "đúng HAI loại dòng được tính là lượt xử lý — thêm loại thứ ba là đổi nghĩa con số chấm người");

  /* ═══════════ 10 · NHÃN "A → B" ═══════════ */
  assert.equal(careStatusArrow("NEW", "IN_PROGRESS", CARE_STATUS_LABEL), `${CARE_STATUS_LABEL.NEW} → ${CARE_STATUS_LABEL.IN_PROGRESS}`);
  assert.equal(careStatusArrow(null, "RESOLVED", CARE_STATUS_LABEL), CARE_STATUS_LABEL.RESOLVED, "không biết trạng thái trước thì in trạng thái sau, không vẽ mũi tên từ hư không");
  assert.equal(careStatusArrow("NEW", "NEW", CARE_STATUS_LABEL), CARE_STATUS_LABEL.NEW, "tự-chuyển không vẽ mũi tên");
  assert.equal(careStatusArrow("NEW", null, CARE_STATUS_LABEL), "", "không có trạng thái sau thì không có nhãn trạng thái");

  console.log(
    `✓ Lượt xử lý care: cửa sổ gộp ${CARE_ROUND_MERGE_MINUTES} phút (biên đóng) · hai người khác nhau không gộp · dòng chưa nối tài khoản đếm THIẾU không đếm thừa · thứ tự đầu vào không đổi kết quả · cộng dần = đếm một lượt · giao việc KHÔNG phải một lượt · ba nhóm backlog rời nhau`,
  );
}
