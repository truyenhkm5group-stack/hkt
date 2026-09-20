/**
 * HẠN XỬ LÝ CHO "MÁY XIN NGƯỜI VÀO MÀ CHƯA AI NHẬN".
 *
 * Bài kiểm này canh hai thứ, và cái thứ hai quan trọng hơn: ngưỡng KHÔNG được có mặc định nghiệp
 * vụ, và cơ chế này KHÔNG được biến thành một nguồn việc thứ ba ở cùng độ mịn một hội thoại.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  HANDOFF_LIFECYCLE,
  HANDOFF_SLA_STATES,
  MACHINE_HANDOFF_SLA_KEY,
  openHandoffLifecycle,
  parseSlaMinutes,
  planTakeover,
  slaStateOf,
  TAKEOVER_SELF_REASON,
} from "@/lib/constants/machine-handoff";
import { ALERT_KINDS_OWNED_ELSEWHERE, WORK_SOURCES } from "@/lib/constants/work-sources";

test("ngưỡng KHÔNG có mặc định nghiệp vụ — chưa khai là CHƯA BIẾT", () => {
  /*
    "Bao nhiêu phút thì muộn" là quyết định của chủ shop. Ghi cứng một con số là lặng lẽ quyết thay
    họ một chính sách vận hành, và con số ấy sẽ sống mãi vì không ai biết nó từ đâu ra.

    Hai mặc định cùng tệ: 0 làm mọi việc quá hạn ngay lập tức; vô cùng làm không việc nào quá hạn
    bao giờ. Cả hai đều là một chính sách được quyết lặng lẽ.
  */
  assert.equal(parseSlaMinutes(undefined), null);
  assert.equal(parseSlaMinutes(null), null);
  assert.equal(parseSlaMinutes(""), null);
  assert.equal(parseSlaMinutes(0), null, "0 phút KHÔNG được coi là một ngưỡng hợp lệ");
  assert.equal(parseSlaMinutes(-5), null);
  assert.equal(parseSlaMinutes("abc"), null);
  assert.equal(parseSlaMinutes(30), 30);
  assert.equal(parseSlaMinutes("45"), 45);

  // Chưa khai ⇒ UNKNOWN, KHÔNG phải "trong hạn". Một việc treo 3 ngày không được hiện ra là "OK"
  // chỉ vì chưa ai khai ngưỡng.
  assert.equal(slaStateOf(4320, null), "UNKNOWN");
  assert.equal(slaStateOf(null, 30), "UNKNOWN", "không có mốc xin thì không tính được tuổi");
  assert.equal(slaStateOf(31, 30), "OVERDUE");
  assert.equal(slaStateOf(30, 30), "OK", "đúng bằng ngưỡng là còn trong hạn");
  assert.equal(slaStateOf(0, 30), "OK");
  assert.equal(HANDOFF_SLA_STATES.length, 3);
});

test("đây là BÁO CÁO, không phải nguồn việc thứ ba", () => {
  /*
    Kho mã đã có hai bộ máy dò việc sót ở CÙNG ĐỘ MỊN MỘT HỘI THOẠI (`getSalesLeakageQueue`,
    `copilotQueue`). Khai thêm một NGUỒN VIỆC ở đúng độ mịn ấy là mời cộng hai lần ở mọi tổng hợp
    — luật 19, và `ALERT_KINDS_OWNED_ELSEWHERE` không đỡ được vì đây không phải một "alert kind".
  */
  const tenNguon = Object.keys(WORK_SOURCES ?? {});
  assert.ok(
    !tenNguon.some((k) => /MACHINE_HANDOFF|UNCLAIMED_HANDOFF/i.test(k)),
    "không được khai thành nguồn việc — nó là báo cáo, và hai bộ máy kia đã giữ độ mịn hội thoại",
  );
  assert.ok(!(ALERT_KINDS_OWNED_ELSEWHERE as readonly string[]).some((k) => /HANDOFF/i.test(k)));

  // Và truy vấn phải CHỈ ĐỌC: không ghi, không gọi mô hình, không gửi gì.
  const nguon = execFileSync("git", ["show", "HEAD:lib/queries/machine-handoff.ts"], { encoding: "utf-8" })
    .split("\n")
    .filter((d) => !/^\s*(\/\/|\*|\/\*)/.test(d))
    .join("\n");
  for (const cam of [/\.insert\(/, /\.update\(/, /\.delete\(/, /runModelStep/, /sendMessage/i, /createOrder/i]) {
    assert.ok(!cam.test(nguon), `truy vấn báo cáo không được chứa ${cam}`);
  }
  assert.equal(MACHINE_HANDOFF_SLA_KEY, "work.machineHandoffSlaMinutes");
});

test("đọc ĐÚNG cột: lấy cả hàng đợi đang mở, phân loại bằng KHOÁ NGƯỜI", () => {
  /*
    `human_takeover_at` có HAI nơi ghi nói hai điều ngược nhau — nhân viên tự nhận việc, và CHÍNH
    MÁY xin người vào. Nên báo cáo lấy MỌI hội thoại còn mốc xin rồi phân loại bằng
    `takeover_by_user_id`: một hàng đợi chỉ hiện việc chưa ai nhận thì không đo được việc đã nhận
    mà nằm im, và đó đúng là nửa còn lại của câu hỏi "việc chuyển người có chạy không".
  */
  const nguon = execFileSync("git", ["show", "HEAD:lib/queries/machine-handoff.ts"], { encoding: "utf-8" });
  assert.ok(/isNotNull\(schema\.salesConversations\.humanTakeoverAt\)/.test(nguon), "phải đòi CÓ mốc xin");
  assert.ok(
    /openHandoffLifecycle\(/.test(nguon),
    "phải phân loại bằng hàm thuần dùng chung, không viết lại điều kiện 'đã có chủ' lần thứ hai",
  );

  assert.equal(openHandoffLifecycle({ handoffAt: new Date(), ownerUserId: null }), "UNCLAIMED");
  assert.equal(openHandoffLifecycle({ handoffAt: new Date(), ownerUserId: "u1" }), "CLAIMED");
  // Không mốc xin, không khoá người = không phải việc chuyển người. `null`, không phải "UNCLAIMED".
  assert.equal(openHandoffLifecycle({ handoffAt: null, ownerUserId: null }), null);
  assert.equal(HANDOFF_LIFECYCLE.length, 3);
});

test("NHẬN VIỆC MÁY CHUYỂN SANG PHẢI GHI ĐƯỢC KHOÁ NGƯỜI", () => {
  /*
    ĐÂY LÀ BÀI KIỂM ĐÁNG LẼ PHẢI CÓ TỪ ĐẦU.

    Bản trước gác nhánh ghi bằng `humanTakeoverAt`. Với một việc NHÂN VIÊN tự nhận (cột rỗng) thì
    đúng; với một việc MÁY chuyển sang thì cột ấy đã có giá trị do chính máy ghi, nhánh bị bỏ qua,
    và `takeover_by_user_id` không bao giờ được ghi. Sản phẩm trông vẫn chạy: nút bấm được, không
    báo lỗi, nhật ký vẫn ghi "đã nhận". Chỉ có con số là nói thật — 202 việc, 0 chủ.

    Một bài kiểm chỉ thử ca "cột rỗng" sẽ xanh suốt quãng thời gian ấy. Ca dưới đây là ca vỡ.
  */
  const machineHandoffAt = new Date("2026-09-19T02:00:00Z");
  const now = new Date("2026-09-19T09:00:00Z");
  const ke = planTakeover(
    { humanTakeoverAt: machineHandoffAt, takeoverByUserId: null, takeoverReason: "SIZE_DATA_MISSING" },
    "nv-1",
    undefined,
    now,
  );
  assert.equal(ke.kind, "CLAIM", "việc máy chuyển sang mà bấm nhận thì PHẢI ghi khoá người");
  if (ke.kind !== "CLAIM") return;

  // GIỮ mốc cũ: đó là lúc khách BẮT ĐẦU CHỜ. Đè bằng lúc nhận việc là xoá 7 giờ chờ khỏi mọi phép đo.
  assert.equal(ke.humanTakeoverAt.getTime(), machineHandoffAt.getTime());
  assert.equal(ke.takeoverClaimedAt.getTime(), now.getTime());
  // GIỮ lý do máy khai: nó là VÌ SAO máy phải gọi người, đúng thứ cần đọc khi xem lại việc đã xử lý.
  assert.equal(ke.takeoverReason, "SIZE_DATA_MISSING");
});

test("nhận việc: bốn ca còn lại", () => {
  const now = new Date("2026-09-19T09:00:00Z");

  // Nhân viên tự nhận một hội thoại máy chưa xin ai: mốc chờ bắt đầu từ chính lúc nhận.
  const tuNhan = planTakeover({ humanTakeoverAt: null, takeoverByUserId: null, takeoverReason: "" }, "nv-1", undefined, now);
  assert.equal(tuNhan.kind, "CLAIM");
  if (tuNhan.kind === "CLAIM") {
    assert.equal(tuNhan.humanTakeoverAt.getTime(), now.getTime());
    assert.equal(tuNhan.takeoverReason, TAKEOVER_SELF_REASON);
  }

  // Máy không khai lý do (luật 13 đòi phải có, nhưng dữ liệu cũ thì chưa): ghi chú của người thay vào.
  const coGhiChu = planTakeover({ humanTakeoverAt: now, takeoverByUserId: null, takeoverReason: "" }, "nv-1", "khách hỏi bảo hành", now);
  assert.equal(coGhiChu.kind === "CLAIM" && coGhiChu.takeoverReason, "khách hỏi bảo hành");

  // Bấm lại trên việc chính mình đang cầm: KHÔNG ghi đè gì — ghi lại sẽ dời `takeover_claimed_at`
  // về hiện tại và làm mọi phép đo "nhận rồi để đó bao lâu" bằng 0 mãi mãi.
  assert.equal(planTakeover({ humanTakeoverAt: now, takeoverByUserId: "nv-1", takeoverReason: "x" }, "nv-1", undefined, now).kind, "ALREADY_MINE");

  // Việc người khác đang cầm: chặn. Không cướp việc đang có người gõ dở câu trả lời.
  const cuaNguoiKhac = planTakeover({ humanTakeoverAt: now, takeoverByUserId: "nv-2", takeoverReason: "x" }, "nv-1", undefined, now);
  assert.equal(cuaNguoiKhac.kind, "TAKEN_BY_OTHER");
  assert.equal(cuaNguoiKhac.kind === "TAKEN_BY_OTHER" && cuaNguoiKhac.ownerUserId, "nv-2");
});

test("server action nhận việc KHÔNG được gác bằng mốc thời gian", () => {
  /*
    Bài kiểm ở mức mã nguồn, vì cái sai cũ không phải một giá trị sai mà là một ĐIỀU KIỆN sai nằm
    lẫn trong một server action — chỗ không bài kiểm đơn vị nào với tới.
  */
  const nguon = execFileSync("git", ["show", "HEAD:lib/actions/sales-copilot.ts"], { encoding: "utf-8" })
    .split("\n")
    .filter((d) => !/^\s*(\/\/|\*|\/\*)/.test(d))
    .join("\n");
  const than = nguon.slice(nguon.indexOf("export async function takeoverConversation"));
  const ketThuc = than.indexOf("export async function releaseConversation");
  const thanNhanViec = ketThuc > 0 ? than.slice(0, ketThuc) : than;
  assert.ok(/planTakeover\(/.test(thanNhanViec), "quyết định phải đi qua hàm thuần đã có bài kiểm");
  assert.ok(
    !/if\s*\(!?\s*[\w.]*\.?humanTakeoverAt\s*\)/.test(thanNhanViec),
    "không được gác nhánh ghi bằng `humanTakeoverAt` — chính máy cũng ghi cột ấy",
  );

  // Trả việc phải xoá CẢ `takeover_claimed_at`: bỏ sót nó thì lần chuyển người sau đọc ra một mốc
  // nhận việc của một vòng đời đã đóng.
  const thanTra = nguon.slice(nguon.indexOf("export async function releaseConversation"));
  assert.ok(/takeoverClaimedAt:\s*null/.test(thanTra), "trả việc phải xoá mốc nhận");
});
