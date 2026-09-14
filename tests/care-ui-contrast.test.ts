import assert from "node:assert/strict";
import { CARE_STATUSES, CARE_STATUS_LABEL, CARE_STATUS_TONE } from "@/lib/constants/care";
import { BUSINESS_ACTIONS, BUSINESS_ACTION_LABEL, BUSINESS_ACTION_TONE, CARE_WORKFLOW_LABEL } from "@/lib/constants/care-outcome";
import { CARE_SLA_BUCKETS, CARE_SLA_BUCKET_HINT, CARE_SLA_BUCKET_LABEL, CARE_SLA_BUCKET_TONE } from "@/lib/care/filters";

/**
 * ═══════ MÀU PHẢI PHÂN BIỆT ĐƯỢC THỨ ĐÒI HÀNH ĐỘNG KHÁC NHAU ═══════
 *
 * Bản trước tô CÙNG MỘT màu hổ phách cho ba trạng thái chờ: chờ KHÁCH, chờ ĐVVC, theo dõi tiếp.
 * Người trực nhìn hàng đợi thấy một mảng vàng và phải đọc chữ từng dòng mới biết nên gọi ai. Màu
 * mà không phân biệt được thì nó chỉ còn là trang trí.
 */
export function testCareUiContrast() {
  /* ───── Ba kiểu "chờ" phải ba màu khác nhau ───── */
  const cho = ["WAITING_CUSTOMER", "WAITING_CARRIER", "WAITING_REDELIVERY"] as const;
  const mau = cho.map((s) => CARE_STATUS_TONE[s]);
  assert.equal(new Set(mau).size, 3, "chờ KHÁCH · chờ ĐVVC · theo dõi tiếp đòi ba hành động khác nhau nên phải ba màu khác nhau");

  // Leo thang KHÔNG được trùng màu với "chờ ĐVVC" — hai thứ này hay đứng cạnh nhau trong hàng đợi.
  assert.notEqual(CARE_STATUS_TONE.ESCALATED, CARE_STATUS_TONE.WAITING_CARRIER, "leo thang phải tách khỏi chờ ĐVVC");

  /* ───── Mỗi trạng thái khai đủ nền + chữ cho CẢ HAI chế độ ───── */
  for (const s of CARE_STATUSES) {
    const t = CARE_STATUS_TONE[s];
    assert.ok(t, `${s}: thiếu màu`);
    assert.ok(CARE_STATUS_LABEL[s], `${s}: thiếu nhãn tiếng Việt`);
    if (t.includes("bg-muted")) continue; // dùng token của hệ, đã tự lo hai chế độ
    assert.match(t, /dark:bg-/, `${s}: thiếu nền cho chế độ tối`);
    assert.match(t, /dark:text-/, `${s}: thiếu màu chữ cho chế độ tối — chữ tối trên nền tối là không đọc được`);
    // Sắc độ chữ phải ĐẬM ở chế độ sáng và NHẠT ở chế độ tối; ngược lại là mất tương phản.
    assert.match(t, /text-\w+-(800|900)\b/, `${s}: chữ ở chế độ sáng phải đủ đậm`);
    assert.match(t, /dark:text-\w+-(200|300)\b/, `${s}: chữ ở chế độ tối phải đủ nhạt`);
  }

  /* ───── Quyết định nghiệp vụ KHÁC dải màu với trạng thái xử lý ───── */
  for (const a of BUSINESS_ACTIONS) {
    assert.ok(BUSINESS_ACTION_TONE[a], `${a}: thiếu màu`);
    assert.ok(BUSINESS_ACTION_LABEL[a], `${a}: thiếu nhãn`);
    assert.match(BUSINESS_ACTION_TONE[a], /dark:text-/, `${a}: thiếu màu chữ cho chế độ tối`);
  }
  /*
    "Duyệt hoàn" là QUYẾT ĐỊNH của shop; "Đang xử lý" là ĐỘI ĐANG Ở ĐÂU. Hai loại thông tin khác
    nhau thì không được trùng màu, nếu không người đọc lại phải đọc chữ mới phân biệt — đúng vấn đề
    mà việc tách hai chiều sinh ra để giải quyết.
  */
  const trungMau = BUSINESS_ACTIONS.filter((a) => (CARE_STATUSES as readonly string[]).some((s) => CARE_STATUS_TONE[s as (typeof CARE_STATUSES)[number]] === BUSINESS_ACTION_TONE[a]));
  assert.deepEqual(trungMau, [], `quyết định nghiệp vụ trùng màu với trạng thái xử lý: ${trungMau.join(", ")}`);

  // Hai chiều phải phủ đủ nhãn — thiếu một nhãn là một ô trống trên màn hình.
  for (const s of CARE_STATUSES) assert.ok(CARE_WORKFLOW_LABEL[s], `${s}: thiếu nhãn trong CARE_WORKFLOW_LABEL`);

  /* ───── Chip HẠN là bộ điều khiển, không phải nhãn của dòng ─────

     Màn hình care đã có hai dải NỀN ĐẶC nói về dòng: trạng thái xử lý và quyết định nghiệp vụ. Chip
     hạn nói về BỘ LỌC. Cho nó một cái nền đặc nữa là dựng thứ ba trông y hệt hai thứ kia nhưng
     thuộc hạng mục khác — người đọc lại phải đọc chữ mới biết mình đang nhìn cái gì. */
  const mauHan = CARE_SLA_BUCKETS.map((k) => CARE_SLA_BUCKET_TONE[k]);
  assert.equal(new Set(mauHan).size, CARE_SLA_BUCKETS.length, "ba mức hạn đòi ba mức khẩn khác nhau nên phải ba màu khác nhau");
  for (const k of CARE_SLA_BUCKETS) {
    assert.ok(CARE_SLA_BUCKET_LABEL[k], `${k}: thiếu nhãn tiếng Việt`);
    assert.ok(CARE_SLA_BUCKET_HINT[k], `${k}: thiếu câu giải thích — người dùng phải đoán 'sắp quá hạn' là bao lâu`);
    assert.doesNotMatch(CARE_SLA_BUCKET_TONE[k], /\bbg-/, `${k}: chip hạn không được có nền đặc, nếu không nó lẫn với nhãn trạng thái trên từng dòng`);
    if (CARE_SLA_BUCKET_TONE[k].includes("text-muted-foreground")) continue; // token của hệ, tự lo hai chế độ
    assert.match(CARE_SLA_BUCKET_TONE[k], /dark:text-/, `${k}: thiếu màu chữ cho chế độ tối`);
  }
  // Và không được trùng với dải màu của trạng thái xử lý — cùng lý do như quyết định nghiệp vụ.
  const hanTrungTrangThai = CARE_SLA_BUCKETS.filter((k) => (CARE_STATUSES as readonly string[]).some((st) => CARE_STATUS_TONE[st as (typeof CARE_STATUSES)[number]] === CARE_SLA_BUCKET_TONE[k]));
  assert.deepEqual(hanTrungTrangThai, [], `chip hạn trùng màu với trạng thái xử lý: ${hanTrungTrangThai.join(", ")}`);

  console.log("✓ Màu care: ba kiểu 'chờ' ba màu khác nhau · leo thang tách khỏi chờ ĐVVC · đủ nền+chữ cho chế độ tối · quyết định nghiệp vụ và chip hạn đều không trùng dải màu trạng thái");
}
