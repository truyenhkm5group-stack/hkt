/**
 * ═══════ ĐỐI CHIẾU PHẢI CHẠY ĐƯỢC TRƯỚC LƯỢT CHUYỂN, KHÔNG PHẢI SAU ═══════
 *
 * ─── SỰ CỐ BỘ NÀY SINH RA ĐỂ CHẶN ───
 *
 * Lượt đối chiếu production 18/09/2026 kết luận **4/4 nhân sự “Thiếu khai báo”** và cổng dừng ở
 * `RECONCILIATION_BLOCKED_BY_CONFIG`. Nhưng chính bản in của lượt ấy cho thấy phép tính ĐÃ CHẠY và
 * ĐÃ KHỚP: lương cứng `3.000.000 = 3.000.000`, lệch 0 ₫.
 *
 * Nguyên nhân là một cái NHÃN, không phải một phép tính: `proposal.blockers` gộp hai loại thiếu
 * khác hẳn nhau, và phép phân loại đọc cả danh sách ấy. “Chưa khai phân công lao động” là việc của
 * mô hình MỚI — thứ mà phép đối chiếu vốn đã tự dựng bối cảnh ứng viên trong bộ nhớ để đi qua.
 *
 * Bắt phép đối chiếu đòi dữ liệu của mô hình mới là bắt nó chạy SAU thứ nó phải chạy TRƯỚC: nó tồn
 * tại để trả lời *“nếu chuyển thì con số có đổi không”* — câu hỏi chỉ có nghĩa khi chưa ai chuyển.
 *
 * Bài 1 dưới đây là bài quan trọng nhất: nó dựng ĐÚNG tình huống production (không phân công, không
 * gán chính sách, hồ sơ cũ đủ) và đòi kết quả phải là ĐỐI CHIẾU ĐƯỢC.
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { clearMemo } from "@/lib/cache";
import { PAYROLL_EMPLOYEES_KEY, type Employee } from "@/lib/constants/payroll";
import { classifyEmployee } from "@/lib/payroll/reconcile-gate";
import {
  RECONCILIATION_ONLY_SYNTHETIC_CONTEXT,
  buildCandidateEmployments,
  legacyConfigGaps,
  newModelConfigGaps,
} from "@/lib/payroll/reconcile-context";
import { previewLegacyMigration } from "@/lib/queries/payroll-migration";
import type { EmploymentRow } from "@/lib/payroll/policy-resolve";
import type { Period } from "@/lib/search-params";
import { setSettingJson } from "@/lib/settings";

const d = (iso: string) => new Date(`${iso}T00:00:00+07:00`);
const dEnd = (iso: string) => new Date(`${iso}T23:59:59+07:00`);

/** Tháng 05/2028 — cố ý xa mọi fixture khác để không ai đụng vào số của ai. */
const KY: Period = { key: "custom", from: d("2028-05-01"), to: dEnd("2028-05-31"), label: "Tháng 5/2028", fromKey: "2028-05-01", toKey: "2028-05-31" };

const nhanSu = (over: Partial<Employee> & { id: string }): Employee => ({
  name: `Nhân sự ${over.id}`,
  shortName: over.id,
  department: "Kho / Đóng gói",
  aliases: [],
  accountIds: [],
  fixed: 0,
  percentTotal: 0,
  percentPersonal: 0,
  percentRevenue: 0,
  active: true,
  note: "",
  ...over,
});

/** ĐỦ hồ sơ cũ: lương cứng khai rõ. Không một dòng nào của mô hình mới. */
const DU = nhanSu({ id: "rc-du", fixed: 12_000_000 });
/** THIẾU THẬT: bốn ô cũ đều trống ⇒ không có gì để ánh xạ, cũng không có gì để so. */
const TRONG = nhanSu({ id: "rc-trong" });
/** MÂU THUẪN: một tỷ lệ khai số âm — hai đường tính sẽ đứng trên hai luật khác nhau. */
const AM = nhanSu({ id: "rc-am", fixed: 5_000_000, percentTotal: -5 });

export async function testPayrollReconcileContext(db: Db) {
  /* ════════════════════════════════════════════════════════════════════════════════
     PHẦN A · HÀM THUẦN
     ════════════════════════════════════════════════════════════════════════════════ */

  // ─── A1 · PHÂN CÔNG THẬT LUÔN THẮNG BỐI CẢNH DỰNG TẠM ───
  const that: EmploymentRow = {
    id: "that-1",
    employeeId: "x",
    departmentId: null,
    departmentName: "Kế toán",
    positionId: null,
    positionName: "",
    managerUserId: null,
    employmentType: "PART_TIME",
    workMode: "REMOTE",
    status: "ACTIVE",
    standardWorkDays: 26,
    effectiveFrom: d("2028-05-10"),
    effectiveTo: null,
  };
  const coThat = buildCandidateEmployments({ employeeId: "x", legacyDepartment: "Kho", period: { from: KY.from!, to: KY.to! }, real: [that] });
  assert.equal(coThat.synthetic, false, "A1. có phân công THẬT thì không được dựng tạm");
  assert.equal(coThat.marker, null, "A1. và không mang nhãn dựng tạm");
  assert.deepEqual(coThat.employments, [that], "A1. phải dùng NGUYÊN dòng thật — đè lên nó là đổi mốc đi làm của người thật");

  // ─── A2 · KHÔNG CÓ DÒNG NÀO ⇒ DỰNG TẠM, PHỦ TRỌN KỲ, CÓ NHÃN ───
  const tam = buildCandidateEmployments({ employeeId: "x", legacyDepartment: "Kho / Đóng gói", period: { from: KY.from!, to: KY.to! }, real: [] });
  assert.equal(tam.synthetic, true, "A2. không có phân công nào ⇒ bối cảnh là dựng tạm");
  assert.equal(tam.marker, RECONCILIATION_ONLY_SYNTHETIC_CONTEXT, "A2. và nó phải tự khai điều đó");
  assert.equal(tam.employments.length, 1);
  assert.equal(tam.employments[0].effectiveFrom.getTime(), KY.from!.getTime(), "A2. phải phủ từ đầu kỳ — muộn hơn là cắt mất ngày công");
  assert.equal(tam.employments[0].effectiveTo, null, "A2. mốc mở = còn hiệu lực");
  assert.notEqual(tam.employments[0].status, "TERMINATED", "A2. đã nghỉ thì không đoạn nào là đoạn làm việc và cột mới ra 0đ");
  assert.equal(tam.employments[0].departmentName, "Kho / Đóng gói", "A2. phòng ban lấy từ hồ sơ cũ, không bịa");

  // ─── A3 · CHẠY HAI LẦN RA CÙNG MỘT KẾT QUẢ ───
  const lai = buildCandidateEmployments({ employeeId: "x", legacyDepartment: "Kho / Đóng gói", period: { from: KY.from!, to: KY.to! }, real: [] });
  assert.deepEqual(lai, tam, "A3. hàm thuần: hai lượt chạy phải ra y hệt nhau");

  // ─── A4 · HAI LOẠI THIẾU KHÔNG ĐƯỢC LẪN VÀO NHAU ───
  assert.deepEqual(legacyConfigGaps({ name: "A", fixed: 12_000_000, percentTotal: 0, percentPersonal: 0, percentRevenue: 0 }), [], "A4. khai lương cứng là đủ để đối chiếu");
  assert.deepEqual(legacyConfigGaps({ name: "A", fixed: 0, percentTotal: 0, percentPersonal: 10, percentRevenue: 0 }), [], "A4. chỉ khai tỷ lệ cũng đủ");
  assert.equal(legacyConfigGaps({ name: "A", fixed: 0, percentTotal: 0, percentPersonal: 0, percentRevenue: 0 }).length, 1, "A4. bốn ô trống ⇒ THIẾU THẬT");
  assert.equal(legacyConfigGaps({ name: "A", fixed: 9_000_000, percentTotal: -5, percentPersonal: 0, percentRevenue: 0 }).length, 1, "A4. tỷ lệ âm ⇒ THIẾU THẬT: đường cũ nhân thẳng nó, bản đề xuất bỏ hẳn khoản ấy");
  assert.equal(legacyConfigGaps({ name: "A", fixed: 9_000_000, percentTotal: Number.NaN, percentPersonal: 0, percentRevenue: 0 }).length, 1, "A4. tỷ lệ không phải số hữu hạn cũng vậy");
  // Lương cứng âm / NaN thì CẢ HAI đường đều ép về 0 bằng cùng một phép — chúng vẫn đồng ý, nên
  // loại người ấy ra khỏi mẫu đối chiếu là tự thu hẹp bằng chứng mà chẳng tránh được gì.
  assert.deepEqual(legacyConfigGaps({ name: "A", fixed: -1, percentTotal: 10, percentPersonal: 0, percentRevenue: 0 }), [], "A4. lương cứng âm KHÔNG chặn — hai đường vẫn ép về 0 như nhau");

  for (const g of newModelConfigGaps({ hasEmployment: false, hasPolicyAssignment: false })) {
    assert.equal(g.kind, "NEW_MODEL_CONFIG", "A4. thiếu của mô hình mới phải mang đúng loại của nó");
  }
  assert.deepEqual(newModelConfigGaps({ hasEmployment: true, hasPolicyAssignment: true }), [], "A4. khai đủ thì không còn gì để nói");

  // ─── A5 · PHÉP PHÂN LOẠI: CHÍNH XÁC ĐIỀU ĐÃ SAI TRÊN PRODUCTION ───
  const nen = { employeeId: "x", employeeName: "X", hasOwnActivity: true, hasLegacyLine: true, netDiff: 0, hasUnexplainedDiff: false };
  assert.equal(classifyEmployee({ ...nen, missingConfig: [] }), "MATCH", "A5. không thiếu gì THẬT ⇒ khớp");
  assert.equal(
    classifyEmployee({ ...nen, missingConfig: newModelConfigGaps({ hasEmployment: false, hasPolicyAssignment: false }).map((g) => g.message) }),
    "NEEDS_CONFIG",
    "A5. đây là hành vi CŨ, và nó đúng — lỗi nằm ở chỗ đem danh sách của mô hình MỚI vào đây",
  );

  /* ════════════════════════════════════════════════════════════════════════════════
     PHẦN B · ĐI QUA ĐƯỜNG ĐỐI CHIẾU THẬT, TRÊN CSDL THẬT
     ════════════════════════════════════════════════════════════════════════════════ */
  await db.delete(schema.employmentAssignments).where(sql`${schema.employmentAssignments.employeeId} like 'rc-%'`);
  await db.delete(schema.employeePolicyAssignments).where(sql`${schema.employeePolicyAssignments.employeeId} like 'rc-%'`);
  await setSettingJson(PAYROLL_EMPLOYEES_KEY, { list: [DU, TRONG, AM] });
  clearMemo();

  const rows = await previewLegacyMigration(KY, "profit1");
  const lay = (id: string) => rows.find((r) => r.proposal.employeeId === id);

  // ─── B1 · BÀI QUAN TRỌNG NHẤT: KHÔNG MỘT DÒNG NÀO CỦA MÔ HÌNH MỚI, VẪN ĐỐI CHIẾU ĐƯỢC ───
  const du = lay(DU.id);
  assert.ok(du, "B1. nhân sự phải có mặt trong bảng đối chiếu");
  assert.equal(du.hasEmployment, false, "B1. dựng đúng tình huống production: KHÔNG có phân công lao động");
  assert.equal(du.alreadyMigrated, false, "B1. và CHƯA gán chính sách");
  assert.equal(du.syntheticEmployment, true, "B1. nên bối cảnh phải là dựng tạm");
  assert.ok(du.newModelGaps.length > 0, "B1. vẫn phải NÓI RA rằng mô hình mới còn trống — im lặng là giấu việc");
  // `deepEqual` của node THU HẸP KIỂU về `never[]`, nên dùng `equal` trên độ dài: bài kiểm vẫn
  // nói đúng điều cần nói, mà biến còn dùng được ở dưới.
  assert.equal(du.legacyGaps.length, 0, "B1. nhưng hồ sơ CŨ đủ, nên không có chỗ thiếu nào chặn phép đối chiếu");
  assert.ok(du.recon, "B1. và phép so phải chạy ra kết quả");

  const ttDu = classifyEmployee({
    employeeId: DU.id,
    employeeName: DU.shortName,
    missingConfig: du.legacyGaps.map((g) => g.message),
    hasOwnActivity: du.recon.lines.some((l) => (l.old ?? 0) !== 0 || (l.next ?? 0) !== 0),
    hasLegacyLine: true,
    netDiff: du.recon.netDiff,
    hasUnexplainedDiff: du.recon.hasUnexplained,
  });
  assert.notEqual(ttDu, "NEEDS_CONFIG", "B1. ĐÂY LÀ LỖI ĐÃ CHẶN CỔNG GATE B: chưa khai mô hình mới KHÔNG phải “thiếu khai báo”");
  assert.equal(ttDu, "MATCH", "B1. hai đường tính trên cùng hồ sơ cũ phải ra cùng một con số");

  // Và chứng minh cái nhãn cũ mới là thủ phạm — cùng người ấy, chỉ đổi danh sách đọc vào.
  assert.ok(du.proposal.blockers.length > 0, "B1. danh sách gộp cũ VẪN có phần tử (màn hình chuyển đổi cần nó)");
  assert.equal(
    classifyEmployee({
      employeeId: DU.id,
      employeeName: DU.shortName,
      missingConfig: du.proposal.blockers,
      hasOwnActivity: true,
      hasLegacyLine: true,
      netDiff: du.recon.netDiff,
      hasUnexplainedDiff: du.recon.hasUnexplained,
    }),
    "NEEDS_CONFIG",
    "B1. đọc danh sách GỘP thì vẫn ra “thiếu khai báo” — đúng hành vi cũ, và đúng chỗ đã sai",
  );

  // ─── B2 · LƯƠNG CỨNG PHẢI KHỚP TỚI TỪNG ĐỒNG TRÊN BỐI CẢNH DỰNG TẠM ───
  const base = du.recon.lines.find((l) => l.key === "base");
  assert.ok(base, "B2. phải có dòng lương cứng");
  assert.equal(base.old, 12_000_000, "B2. kỳ đúng một tháng ⇒ đủ lương tháng ở đường cũ");
  assert.equal(base.next, base.old, "B2. và đường mới phải ra ĐÚNG con số ấy — bối cảnh dựng tạm phủ trọn kỳ nên không cắt ngày nào");
  assert.equal(base.diff, 0, "B2. lệch phải bằng ĐÚNG 0, không phải “trong ngưỡng chấp nhận”");
  assert.equal(du.recon.hasUnexplained, false, "B2. không được còn khoản lệch nào chưa giải thích");

  // ─── B3 · THIẾU THẬT VẪN PHẢI LÀ THIẾU ───
  const trong = lay(TRONG.id);
  assert.ok(trong, "B3. nhân sự phải có mặt");
  assert.ok(trong.legacyGaps.length > 0, "B3. bốn ô cũ đều trống ⇒ THIẾU KHAI BÁO NGHIỆP VỤ, và nó phải chặn");
  assert.equal(trong.legacyGaps[0].kind, "LEGACY_BUSINESS_CONFIG", "B3. đúng loại");
  assert.equal(
    classifyEmployee({ employeeId: TRONG.id, employeeName: TRONG.shortName, missingConfig: trong.legacyGaps.map((g) => g.message), hasOwnActivity: true, hasLegacyLine: true, netDiff: 0, hasUnexplainedDiff: false }),
    "NEEDS_CONFIG",
    "B3. bản vá KHÔNG được làm mất khả năng nói “chưa tính được” — nếu mọi người đều đối chiếu được thì cổng này vô dụng",
  );

  const am = lay(AM.id);
  assert.ok(am, "B3. nhân sự khai tỷ lệ âm phải có mặt");
  assert.ok(am.legacyGaps.length > 0, "B3. tỷ lệ âm là khai báo mâu thuẫn ⇒ THIẾU THẬT, không phải một khoản lệch của máy tính mới");

  /* ════════════════════════════════════════════════════════════════════════════════
     PHẦN C · QUÉT MÃ NGUỒN ĐÃ VÀO KHO
     ════════════════════════════════════════════════════════════════════════════════ */
  {
    const ctx = execSync("git show HEAD:lib/payroll/reconcile-context.ts", { encoding: "utf8" });
    // Bối cảnh ứng viên phải sống trong BỘ NHỚ. Không CSDL thì không có đường nào ghi nhầm nó xuống.
    assert.ok(!/from\s+"@\/db"/.test(ctx), "C. tệp bối cảnh ứng viên KHÔNG được chạm CSDL — nó dựng dữ liệu chưa ai duyệt");
    for (const c of [".insert(", ".update(", ".delete(", "setSettingJson"]) {
      assert.ok(!ctx.includes(c), `C. tệp bối cảnh ứng viên gọi \`${c}\` — bối cảnh dựng tạm mà ghi xuống là tự khai một phân công lao động không ai ký`);
    }
    assert.ok(!/new Date\(\)|Date\.now\(/.test(ctx), "C. không đọc đồng hồ: kết quả đối chiếu phải giống nhau dù chạy lúc nào");

    const script = execSync("git show HEAD:scripts/payroll-reconcile.ts", { encoding: "utf8" });
    assert.ok(
      !/missingConfig:\s*p\.blockers/.test(script),
      "C. script KHÔNG được kết luận bằng danh sách GỘP nữa — đó chính là lỗi đã chặn Gate B ngày 18/09/2026",
    );
    assert.ok(/missingConfig:\s*r\.legacyGaps/.test(script), "C. nó phải đọc đúng danh sách chỗ thiếu của HỒ SƠ CŨ");
    assert.ok(script.includes("newModelGaps"), "C. và vẫn phải in ra chỗ thiếu của mô hình mới — không chặn, nhưng không được giấu");
  }

  await db.delete(schema.employmentAssignments).where(sql`${schema.employmentAssignments.employeeId} like 'rc-%'`);
  await setSettingJson(PAYROLL_EMPLOYEES_KEY, { list: [] });
  clearMemo();
  console.log("  ✓ Bối cảnh ứng viên đối chiếu: thiếu dữ liệu mô hình MỚI không còn chặn phép so (lương cứng khớp 0 ₫ trên bối cảnh dựng tạm) · thiếu hồ sơ CŨ vẫn chặn · chỉ nằm trong bộ nhớ, không CSDL, không đồng hồ");
}
