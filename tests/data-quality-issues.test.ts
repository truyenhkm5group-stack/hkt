import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { DEPARTMENT_LABEL } from "@/lib/constants/departments";
import { DQ_CHECKS, DQ_CHECK_LIST, DQ_CHECK_SPECS, DQ_SEVERITY_LABEL, UNKNOWN_KINDS, UNKNOWN_KIND_LABEL, isFixable } from "@/lib/constants/data-quality-issues";

/**
 * ═══════ MỘT BẢNG CHẤT LƯỢNG DỮ LIỆU PHẢI DẪN TỚI VIỆC LÀM ĐƯỢC ═══════
 *
 * Bài kiểm này không đo dữ liệu — nó đo BẢN KHAI. Một mục thiếu "việc phải làm" hoặc thiếu phòng
 * chịu trách nhiệm vẫn hiện ra đẹp trên màn hình và vẫn vô dụng, và không có gì tự phát hiện ra
 * điều đó ngoài một bài kiểm đọc chính bản khai.
 */
export function testDataQualityIssues() {
  assert.equal(DQ_CHECK_LIST.length, DQ_CHECKS.length, "danh sách dựng từ sổ phải đủ mục");

  for (const spec of DQ_CHECK_LIST) {
    assert.ok(spec.label.trim(), `${spec.key}: thiếu nhãn`);
    assert.ok(spec.why.trim().length > 20, `${spec.key}: phải nói RÕ chỗ trống này làm con số nào nói sai`);
    assert.ok(spec.source.trim(), `${spec.key}: phải trỏ tới bảng/cột có thật — không có nguồn thì không có mục`);
    assert.ok(spec.action.trim().length > 20, `${spec.key}: phải có VIỆC PHẢI LÀM, viết cho người sẽ làm nó`);
    assert.ok(DEPARTMENT_LABEL[spec.owner], `${spec.key}: phòng chịu trách nhiệm không có thật`);
    assert.ok(DQ_SEVERITY_LABEL[spec.severity], `${spec.key}: mức nặng không hợp lệ`);
    assert.ok(UNKNOWN_KIND_LABEL[spec.kind], `${spec.key}: loại chỗ trống không hợp lệ`);
    // Đường dẫn phải là đường dẫn nội bộ — một mục dẫn ra ngoài thì người nhận việc mất dấu.
    if (spec.href) assert.ok(spec.href.startsWith("/"), `${spec.key}: đường dẫn phải là tuyến nội bộ`);
    assert.equal(spec.key, DQ_CHECK_SPECS[spec.key].key, `${spec.key}: khoá trong sổ không khớp chính nó`);
  }

  /*
    PHÂN LOẠI CHỖ TRỐNG LÀ CỘT QUAN TRỌNG NHẤT.

    "Sửa được" phải SUY RA từ loại, không khai tay — hai chỗ khai là hai chỗ lệch, và cái lệch sẽ
    là cái nói rằng một chỗ trống KHÔNG có chứng cứ nào thì vẫn "sửa được". Đó chính là lời mời
    lấp nó bằng một phép đoán.
  */
  assert.equal(isFixable("RESOLVABLE"), true, "dữ liệu đã có mà chưa nối ⇒ sửa được bằng mã nguồn");
  assert.equal(isFixable("STALE"), true, "đường ống chưa chạy lại ⇒ sửa được bằng cách chạy job");
  assert.equal(isFixable("TRUE_UNKNOWN"), false, "KHÔNG có chứng cứ nào ⇒ giữ nguyên là câu trả lời ĐÚNG, mọi cách 'sửa' đều là đoán");
  assert.equal(isFixable("AMBIGUOUS"), false, "nhiều ứng viên ⇒ người quyết; máy chọn bừa trông y hệt máy biết");
  assert.equal(UNKNOWN_KINDS.length, 4);

  // Mốc bàn giao thiếu là TRUE_UNKNOWN, không phải việc phải sửa bằng mã: đo production 13/09/2026
  // cho thấy 119/120 kiện nhóm này đang ở PENDING — ĐVVC chưa lấy được, và đó là sự thật.
  assert.equal(DQ_CHECK_SPECS["shipment-no-handoff"].kind, "TRUE_UNKNOWN", "thiếu chứng cứ bàn giao KHÔNG phải lỗi nối dữ liệu — 119/120 kiện là ĐVVC chưa lấy được");
  assert.equal(DQ_CHECK_SPECS["shipment-order-ambiguous"].kind, "AMBIGUOUS", "mã gốc ra nhiều đơn thì ERP KHÔNG chọn hộ");
  assert.equal(DQ_CHECK_SPECS["cogs-unknown"].severity, "BLOCKING", "giá vốn thiếu bị tính bằng 0 nên lợi nhuận CAO HƠN thực tế — sai theo hướng dễ chịu nhất là hướng nguy hiểm nhất");
  assert.equal(DQ_CHECK_SPECS["bank-unclassified"].kind, "RESOLVABLE");

  // Truy vấn phải tồn tại — một sổ không ai đọc là một sổ chết.
  assert.ok(readdirSync("lib/queries").includes("data-quality-issues.ts"), "sổ phải có truy vấn đọc nó");

  console.log(`✓ Sổ lỗ hổng dữ liệu: ${DQ_CHECK_LIST.length} mục, mỗi mục đủ nguồn thật · việc phải làm · phòng chịu trách nhiệm · và "sửa được" SUY RA từ loại chỗ trống`);
}
