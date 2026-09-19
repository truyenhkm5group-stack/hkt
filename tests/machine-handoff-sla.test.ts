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
  HANDOFF_SLA_STATES,
  MACHINE_HANDOFF_SLA_KEY,
  parseSlaMinutes,
  slaStateOf,
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

test("đọc ĐÚNG cột: có mốc xin, KHÔNG có khoá người", () => {
  /*
    `human_takeover_at` có HAI nơi ghi nói hai điều ngược nhau — nhân viên tự nhận việc, và CHÍNH
    MÁY xin người vào. Phân biệt bằng `takeover_by_user_id`. Đọc nhầm cột là gộp luôn những cuộc
    đã có người cầm, và con số "chưa ai nhận" sẽ phồng lên vô nghĩa.
  */
  const nguon = execFileSync("git", ["show", "HEAD:lib/queries/machine-handoff.ts"], { encoding: "utf-8" });
  assert.ok(/isNotNull\(schema\.salesConversations\.humanTakeoverAt\)/.test(nguon), "phải đòi CÓ mốc xin");
  assert.ok(/isNull\(schema\.salesConversations\.takeoverByUserId\)/.test(nguon), "phải đòi KHÔNG có khoá người");
});
