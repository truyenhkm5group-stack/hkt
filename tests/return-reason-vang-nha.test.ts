/**
 * «KHÁCH VẮNG NHÀ» TÁCH KHỎI «KHÔNG LIÊN LẠC ĐƯỢC» (chủ shop chốt 21/10/2026).
 *
 * Chữ ĐVVC «Tồn - Khách hàng nghỉ, không có nhà» từng về `CUSTOMER_UNREACHABLE` ⇒ nhóm «Không liên lạc được khách» (phòng Bán hàng —
 * khâu xác nhận số). Đo 21/10: 488/718 ca của nhóm đó thật ra là khách vắng nhà — bưu tá đã tới nơi, việc là hẹn khung giờ giao (phòng
 * Giao vận). Nay câu đó ⇒ `CUSTOMER_AWAY` ⇒ nhóm «Khách vắng nhà». Đo tập câu production (db-query run 39543012056): đúng một dạng chuẩn.
 * Cách xếp CŨ (LEGACY) không đổi số: cả hai lý do cùng nhóm «Giao lâu».
 */
import assert from "node:assert/strict";
import { REASON_NEEDS_HUMAN, RETURN_REASON_GROUP_OF, RETURN_REASON_TEXT_RULES, VTP_REASON_TO_RETURN_REASON } from "@/lib/constants/return-reason";
import { evidenceGroupDepartment, evidenceGroupOf } from "@/lib/constants/return-reason-evidence";
import { reasonFromStatusText } from "@/lib/queries/return-reason";
import { classifyRaw } from "@/lib/returns/reason-classify";

const AWAY = "Tồn - Khách hàng nghỉ, không có nhà";
const UNREACH = "Không liên lạc được khách hàng nhận";

export function testReturnReasonKhachVangNha(): void {
  // Đường chữ trạng thái (báo cáo hoàn) và đường quan sát (bảng nguyên nhân) cùng một luật.
  assert.equal(reasonFromStatusText(AWAY), "CUSTOMER_AWAY");
  assert.equal(reasonFromStatusText("tồn - khach hang nghi, khong co nha"), "CUSTOMER_AWAY", "gõ thiếu dấu / chữ thường vẫn cùng lý do");
  assert.equal(reasonFromStatusText("Tồn - Khách không có nhà"), "CUSTOMER_AWAY", "dạng ngắn (luật chung «không có nhà», có từ trước) cùng lý do");
  assert.deepEqual([classifyRaw(AWAY, "CARRIER_TEXT").reason, classifyRaw(AWAY, "CARRIER_TEXT").matched], ["CUSTOMER_AWAY", true], "chữ ĐVVC kết luận được «khách vắng nhà» — không rơi về «chưa xếp»");
  assert.equal(REASON_NEEDS_HUMAN.CUSTOMER_AWAY, false, "lý do máy đọc được từ chữ ĐVVC");
  assert.equal(evidenceGroupOf("CUSTOMER_AWAY", "CARRIER_TEXT"), "KHACH_VANG_NHA");
  assert.equal(evidenceGroupDepartment("KHACH_VANG_NHA"), "LOGISTICS", "việc của khâu giao (hẹn khung giờ), không phải khâu xác nhận số");

  // «Không liên lạc được» giữ nguyên nhóm và phòng.
  for (const t of [UNREACH, "Phát thất bại nhiều lần - Không liên lạc được khách hàng nhận"]) assert.equal(reasonFromStatusText(t), "CUSTOMER_UNREACHABLE", t);
  assert.equal(evidenceGroupOf("CUSTOMER_UNREACHABLE", "CARRIER_TEXT"), "KHONG_LIEN_LAC");
  assert.equal(evidenceGroupDepartment("KHONG_LIEN_LAC"), "SALES");
  // Mã lý do VTP 36 / 47 / 2 đều nghĩa «không liên lạc được» — không đổi.
  for (const c of [36, 47, 2]) assert.equal(VTP_REASON_TO_RETURN_REASON[c], "CUSTOMER_UNREACHABLE", `mã ${c}`);

  // Câu mang cả hai ⇒ nơi bưu tá đã tới là chứng cứ cụ thể hơn: luật «không có nhà» đứng TRƯỚC «không liên lạc».
  const at = (m: string) => RETURN_REASON_TEXT_RULES.findIndex((r) => r.match === m);
  assert.ok(at("khach hang nghi, khong co nha") >= 0 && at("khong co nha") < at("khong lien lac"));
  assert.equal(reasonFromStatusText(`${AWAY} - ${UNREACH}`), "CUSTOMER_AWAY");

  // Cách xếp CŨ (LEGACY): hai lý do cùng nhóm ⇒ số cũ không đổi khi cờ còn LEGACY.
  assert.equal(RETURN_REASON_GROUP_OF.CUSTOMER_AWAY, RETURN_REASON_GROUP_OF.CUSTOMER_UNREACHABLE);
  console.log("✓ «Khách vắng nhà» tách khỏi «Không liên lạc được»: «khách hàng nghỉ, không có nhà» ⇒ CUSTOMER_AWAY ⇒ nhóm Khách vắng nhà (Giao vận) · không liên lạc / mã 36·47·2 giữ nguyên · cách xếp cũ không đổi số");
}
