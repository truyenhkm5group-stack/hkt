/**
 * ═══════ VÒNG ĐỜI KỲ LƯƠNG: QUYỀN · BẤT BIẾN · KHÔNG CÓ LỐI TẮT ═══════
 *
 * Bộ này khoá BẢNG CHUYỂN TRẠNG THÁI và lời khai quyền đi cùng nó. Đây là phần mà một lỗi không
 * lộ ra ở con số nào: kỳ vẫn ra đúng tiền, chỉ là nó đi tới trạng thái "đã duyệt" bằng một lối
 * không ai định cho phép.
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import {
  PAYROLL_ACTION_SPEC,
  PAYROLL_RUN_ACTIONS,
  PAYROLL_RUN_STATUSES,
  PAYROLL_RUN_TRANSITIONS,
  availableActions,
  canTransition,
  isFrozen,
  isMutable,
  normalizePayrollStatus,
} from "@/lib/constants/payroll-lifecycle";

export function testPayrollLifecycle() {
  // ─────────── 1. `FINAL` CŨ ĐỌC THÀNH `LOCKED`, KHÔNG BỊ VIẾT LẠI ───────────
  /*
    Production đang có `status = 'FINAL'` từ trước bản sáu trạng thái — đó là các kỳ ĐÃ TRẢ TIỀN.
    Đọc nó đúng nghĩa thì không mất gì; viết đè lên nó thì mất chính cái mà `payroll_periods` sinh
    ra để giữ.
  */
  assert.equal(normalizePayrollStatus("FINAL"), "LOCKED");
  assert.equal(normalizePayrollStatus(null), "DRAFT");
  assert.equal(normalizePayrollStatus("khong-ton-tai"), "DRAFT", "giá trị lạ rơi về DRAFT — phía HẸP HƠN, không phải phía đã khoá");
  for (const s of PAYROLL_RUN_STATUSES) assert.equal(normalizePayrollStatus(s), s);

  // ─────────── 2. KHÔNG CÓ LỐI TẮT TỪ NHÁP TỚI ĐÃ KHOÁ ───────────
  /*
    Đây là thứ bản trước KHÔNG có: một lượt bấm đi thẳng từ chưa có gì tới bất biến, gộp mất chỗ
    để soát và chỗ để ký tên.
  */
  assert.ok(!canTransition("DRAFT", "LOCK"), "nháp KHÔNG khoá thẳng được — phải đi qua tính, soát, duyệt");
  assert.ok(!canTransition("DRAFT", "APPROVE"), "nháp KHÔNG duyệt thẳng được");
  assert.ok(!canTransition("CALCULATED", "APPROVE"), "vừa tính xong chưa duyệt ngay được — phải qua vòng soát");
  assert.ok(!canTransition("LOCKED", "CALCULATE"), "kỳ đã khoá KHÔNG tính lại được");
  assert.ok(!canTransition("PAID", "UNLOCK"), "kỳ đã trả tiền là điểm cuối");
  assert.deepEqual(PAYROLL_RUN_TRANSITIONS.PAID, [], "không có đường nào đi ra khỏi ĐÃ TRẢ");

  // Đường đi ĐÚNG phải thông suốt, nếu không thì không ai chốt được kỳ nào.
  const duong: [Parameters<typeof canTransition>[0], Parameters<typeof canTransition>[1]][] = [
    ["DRAFT", "CALCULATE"],
    ["CALCULATED", "SUBMIT_REVIEW"],
    ["UNDER_REVIEW", "APPROVE"],
    ["APPROVED", "LOCK"],
    ["LOCKED", "MARK_PAID"],
  ];
  for (const [from, action] of duong) assert.ok(canTransition(from, action), `đường chính phải thông: ${from} → ${action}`);

  // ─────────── 3. TÍNH LẠI ĐƯỢC SUỐT VÒNG SOÁT, VÀ CHỈ TỚI ĐÓ ───────────
  /*
    Bốn trạng thái đầu tồn tại chính là để còn phát hiện được sai. Đóng băng sớm hơn là bỏ mất
    chỗ ấy; đóng băng muộn hơn là để một kỳ đã trả tiền đổi số.
  */
  for (const s of ["DRAFT", "CALCULATED", "UNDER_REVIEW", "APPROVED"] as const) {
    assert.ok(isMutable(s), `${s} phải còn tính lại được`);
    assert.ok(!isFrozen(s), `${s} chưa đóng băng`);
    assert.ok(canTransition(s === "APPROVED" ? "UNDER_REVIEW" : s, "CALCULATE") || s === "APPROVED", `${s} tính lại được`);
  }
  for (const s of ["LOCKED", "PAID"] as const) {
    assert.ok(isFrozen(s), `${s} phải đóng băng`);
    assert.ok(!isMutable(s), `${s} không được sửa`);
  }

  // ─────────── 4. QUYỀN: DUYỆT TÁCH KHỎI KHAI ───────────
  /*
    Người KHAI số và người DUYỆT số không nên là một. Nếu một ngày có ai hạ `APPROVE` xuống
    `payroll:manage` thì bài này đỏ — và đó đúng là lúc phải hỏi lại.
  */
  assert.equal(PAYROLL_ACTION_SPEC.APPROVE.permission, "payroll:approve");
  assert.equal(PAYROLL_ACTION_SPEC.LOCK.permission, "payroll:approve");
  assert.equal(PAYROLL_ACTION_SPEC.UNLOCK.permission, "payroll:approve");
  assert.equal(PAYROLL_ACTION_SPEC.MARK_PAID.permission, "payroll:approve");
  assert.equal(PAYROLL_ACTION_SPEC.CALCULATE.permission, "payroll:manage", "tính toán KHÔNG cần quyền duyệt — nó không làm đổi một đồng đã trả");

  // ─────────── 5. BA VIỆC NGUY HIỂM ĐI QUA NGƯỜI THỨ HAI ───────────
  for (const a of ["APPROVE", "UNLOCK", "MARK_PAID"] as const) {
    assert.equal(PAYROLL_ACTION_SPEC[a].secondApproval, true, `${a} phải cần người thứ hai`);
  }
  for (const a of ["CALCULATE", "SUBMIT_REVIEW"] as const) {
    assert.equal(PAYROLL_ACTION_SPEC[a].secondApproval, false, `${a} KHÔNG cần — nó không làm đổi một đồng đã trả`);
  }
  // Hai việc làm đổi một kỳ ĐÃ CÓ SỐ phải bắt buộc có lý do.
  assert.equal(PAYROLL_ACTION_SPEC.UNLOCK.requiresReason, true);
  assert.equal(PAYROLL_ACTION_SPEC.REJECT.requiresReason, true);

  // ─────────── 6. MỌI VIỆC PHẢI GHI NHẬT KÝ, VÀ MỖI VIỆC MỘT KHOÁ RIÊNG ───────────
  const khoa = PAYROLL_RUN_ACTIONS.map((a) => PAYROLL_ACTION_SPEC[a].auditAction);
  assert.equal(new Set(khoa).size, khoa.length, "mỗi việc một khoá nhật ký riêng — gộp lại là không lần ngược được việc nào đã xảy ra");
  for (const a of PAYROLL_RUN_ACTIONS) assert.ok(PAYROLL_ACTION_SPEC[a].auditAction.startsWith("PAYROLL_RUN_"), `${a} phải có khoá nhật ký`);

  // ─────────── 7. MÀN HÌNH VÀ MÁY CHỦ ĐỌC CÙNG MỘT BẢNG ───────────
  /*
    `availableActions` là hàm mà màn hình dùng để quyết định hiện nút nào; `canTransition` là hàm
    máy chủ dùng để cho qua. Chúng phải nhất quán, nếu không sẽ có nút hiện rồi server từ chối —
    bắt người dùng phát hiện luật bằng cách bấm nhầm.
  */
  for (const s of PAYROLL_RUN_STATUSES) {
    for (const a of availableActions(s)) {
      assert.ok(canTransition(s, a), `màn hình hiện nút “${a}” ở trạng thái ${s} nhưng máy chủ sẽ từ chối`);
    }
    for (const a of PAYROLL_RUN_ACTIONS) {
      if (availableActions(s).includes(a)) continue;
      assert.ok(!canTransition(s, a), `máy chủ cho phép “${a}” ở ${s} nhưng màn hình không hiện nút — một đường đi không ai thấy`);
    }
  }

  // ─────────── 8. SERVER ACTION PHẢI KIỂM LẠI BÊN TRONG KHOÁ ───────────
  /*
    Quét mã nguồn ĐÃ VÀO KHO. Hai yêu cầu "duyệt" gửi cùng lúc đều đọc `UNDER_REVIEW` rồi cùng ghi
    `APPROVED` — hai chữ ký cho một kỳ, và không ai biết cái nào có hiệu lực. Đọc lại BÊN TRONG
    khoá là thứ chặn nó; đọc trước khi vào giao dịch thì không.
  */
  /*
    Từ 25/09/2026 khoá tên + đọc lại trong khoá nằm ở LÕI DÙNG CHUNG `lib/payroll/run-service.ts`
    (lương tự động đi cùng cửa ấy), còn quyền + người thứ hai ở lại server action. Quét CẢ HAI tệp:
    lõi phải giữ khoá, cửa của người phải giữ quyền — và lõi phải tự chặn máy làm việc của người.
  */
  const nguon = execSync("git show HEAD:lib/payroll/run-service.ts", { encoding: "utf8" });
  const cua = execSync("git show HEAD:lib/actions/payroll-run.ts", { encoding: "utf8" });
  const viTriKhoa = nguon.indexOf("pg_advisory_xact_lock");
  const viTriDocLai = nguon.indexOf("Đọc LẠI bên trong khoá");
  assert.ok(viTriKhoa > 0, "lượt chuyển trạng thái phải cầm một khoá TÊN");
  assert.ok(viTriDocLai > viTriKhoa, "và phải đọc lại trạng thái SAU khi đã cầm khoá");
  assert.ok(cua.includes('can(user, spec.permission)'), "máy chủ phải kiểm quyền — nút ẩn không phải một lớp bảo vệ");
  assert.ok(cua.includes("guardSecondApproval"), "ba việc nguy hiểm phải đi qua cổng người thứ hai");
  assert.ok(cua.indexOf("guardSecondApproval") < cua.indexOf("transitionPayrollRunAs("), "cổng người thứ hai phải đứng TRƯỚC lượt ghi");
  assert.ok(/actor\.id === null && !MACHINE_RUN_ACTIONS\.includes\(action\)/.test(nguon), "lõi phải tự chặn MÁY làm việc của người (duyệt · khoá · mở khoá · đánh dấu trả)");
  assert.ok(!/^"use server"/.test(nguon.trimStart()), "lõi KHÔNG được là server action — nó không kiểm quyền nên không được gọi thẳng từ trình duyệt");

  // ─────────── 9. TỆP XUẤT KHÔNG ĐƯỢC TỰ TÍNH LẠI ───────────
  /*
    Một tệp xuất tự cộng lại theo cách riêng là cách chắc chắn để hai con số của cùng một khoản
    lương đi hai ngả — và tệp xuất là thứ rời khỏi màn hình rồi không còn bộ lọc nào đi kèm.
  */
  const xuat = execSync("git show HEAD:app/api/export/payroll/route.ts", { encoding: "utf8" });
  assert.ok(xuat.includes("getPayrollReport(period, basis)"), "tệp xuất phải gọi ĐÚNG hàm mà màn hình gọi");
  assert.ok(!/\*\s*\(?\s*\w+\s*\/\s*100/.test(xuat), "tệp xuất không được nhân lại một tỷ lệ phần trăm nào");
  assert.ok(!xuat.includes("calculatePayrollItem"), "tệp xuất không được tự chạy lại máy tính — nó đọc kết quả đã có");

  console.log("  ✓ Vòng đời kỳ lương: không lối tắt nháp→khoá · duyệt tách khỏi khai · ba việc nguy hiểm cần người thứ hai · màn hình và máy chủ cùng một bảng · tệp xuất không tự tính");
}
