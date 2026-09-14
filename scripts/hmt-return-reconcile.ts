/**
 * ═══════════ ĐỐI SOÁT MỘT LẦN: SỔ HÀNG HOÀN VIẾT TAY (HMT) ↔ ERP ═══════════
 *
 *   npm run returns:hmt                        ← đọc bản MỚI NHẤT người dùng tải lên qua ERP
 *   npm run returns:hmt -- --apply
 *   npm run returns:hmt -- --file '/duong/dan/Ban sao cua Hang hoan HMT.xlsx'   ← tệp trên đĩa
 *
 * MẶC ĐỊNH LÀ CHẠY THỬ. Đổi dữ liệu production phải là một quyết định tường minh (`--apply`), chứ
 * không phải tác dụng phụ của việc chạy một lệnh để xem thử — cùng luật với
 * `reconcileOrderNotCreated`.
 *
 * Lượt ghi duy nhất là **kiện đã về tới kho**. TỒN KHO KHÔNG ĐỔI MỘT MÓN NÀO: bảng tính chứng minh
 * hàng đã về, không chứng minh hàng còn bán được. Kiện đi tiếp vào hàng đợi ĐẾM ở
 * `/inventory/returns`, và người kho vẫn phải mở ra đếm (AGENTS.md mục 10).
 *
 * ─── QUY TRÌNH BẮT BUỘC ───
 *
 *   1. chạy thử, đọc bảng kiểm đếm nguồn — số dòng / số mã / số ô trống phải khớp thứ nhìn thấy
 *      khi mở tệp bằng Excel;
 *   2. đọc bảng phân loại và VÀI DÒNG VÍ DỤ của từng nhóm lỗi;
 *   3. chỉ khi hai bảng trên đúng mới chạy `--apply`;
 *   4. chạy thử lại — số khớp mới phải bằng 0.
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { HMT_MATCH, HMT_MATCH_STATUSES, HMT_SHEETS, HMT_SHEET_ROLES, HMT_SOURCE, HMT_WORKBOOK_LABEL, type HmtMatchStatus } from "@/lib/constants/hmt-returns";
import { systemActor } from "@/lib/constants/actor";
import { applyHmtReconciliation, planHmtReconciliation, type HmtPlan } from "@/lib/returns/hmt-reconcile";
import { readHmtWorkbook, unknownSheetNames, type HmtWorkbook } from "@/lib/returns/hmt-workbook";
import { latestHmtWorkbook, looksLikeXlsx, markHmtWorkbookUsed, sha256Of, type HmtSource } from "@/lib/returns/hmt-source";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const n = (v: number) => v.toLocaleString("vi-VN");

function inNguon(wb: HmtWorkbook) {
  console.log(`\n═══ KIỂM ĐẾM NGUỒN · ${wb.label} ═══`);
  const la = unknownSheetNames(wb.sheetNames);
  if (la.length) console.log(`⚠ Sheet không nằm trong ba vai trò đã khai (KHÔNG được đọc): ${la.join(", ")}`);
  for (const role of HMT_SHEET_ROLES) {
    const a = wb.audit[role];
    console.log(`\n── ${HMT_SHEETS[role].name} ${a.found ? "" : "· KHÔNG TÌM THẤY"}`);
    if (!a.found) {
      for (const w of a.warnings) console.log(`   ⚠ ${w}`);
      continue;
    }
    console.log(`   vùng khai báo ${a.declaredRange || "—"} · tiêu đề ở dòng ${a.headerRow}: ${a.headers.filter(Boolean).join(" | ")}`);
    console.log(`   dòng quét ${n(a.totalRows)} · có dữ liệu ${n(a.populatedRows)} · có mã vận đơn ${n(a.rowsWithTracking)}`);
    console.log(`   mã vận đơn khác nhau ${n(a.uniqueTracking)} · hậu tố 1P1 ${n(a.returnLegTracking)} · mã lặp ${n(a.duplicateTracking)}`);
    console.log(`   ô mã trống ${n(a.blankTracking)} → kế thừa từ ô gộp ${n(a.blankTrackingInherited)} · KHÔNG suy được ${n(a.blankTrackingUnresolved)} (vùng gộp trong sheet: ${n(a.mergedRanges)})`);
    if (HMT_SHEETS[role].grain === "ITEM") {
      console.log(`   dòng trùng (cùng mã + cùng sản phẩm) ${n(a.duplicateTrackingProductRows)} · dòng không đọc được mã hàng ${n(a.rowsWithoutProductCode)}`);
      console.log(`   mã hàng ${n(a.productCodes.length)}: ${a.productCodes.slice(0, 12).map((x) => `${x.code}×${x.rows}`).join(", ")}${a.productCodes.length > 12 ? " …" : ""}`);
      console.log(`   màu ${n(a.colors.length)}: ${a.colors.slice(0, 12).map((x) => `${x.value}×${x.rows}`).join(", ")}${a.colors.length > 12 ? " …" : ""}`);
      console.log(`   size ${n(a.sizes.length)}: ${a.sizes.slice(0, 12).map((x) => `${x.value}×${x.rows}`).join(", ")}${a.sizes.length > 12 ? " …" : ""}`);
    }
    for (const w of a.warnings) console.log(`   ⚠ ${w}`);
  }
}

function inKeHoach(plan: HmtPlan) {
  console.log(`\n═══ PHÂN LOẠI TỪNG SHEET ═══`);
  for (const s of plan.sheets) {
    console.log(`\n── ${s.sheetName}`);
    console.log(`   dòng nguồn ${n(s.sourceRows)} · mã vận đơn khác nhau ${n(s.uniqueTracking)} · lần ra kiện trong ERP ${n(s.trackingFoundInErp)}`);
    console.log(`   mẫu mã lần ra đúng một ${n(s.exactSkuMatch)} · số lượng trong ngưỡng kỳ vọng ${n(s.qtyWithinExpected)}`);
    for (const st of HMT_MATCH_STATUSES) if (s.byStatus[st]) console.log(`     ${st.padEnd(20)} ${String(n(s.byStatus[st])).padStart(6)}  ${HMT_MATCH[st].label}`);
  }

  const c = plan.combined;
  console.log(`\n═══ TỔNG HỢP ═══`);
  console.log(`   dòng món ${n(c.itemRows)} · kiện khác nhau ${n(c.uniqueShipments)}`);
  console.log(`   SẼ GHI NHẬN ĐÃ VỀ KHO: ${n(c.wouldReceiveShipments)} kiện · ${n(c.wouldReceiveItemRows)} dòng món · ${n(c.wouldReceiveUnits)} món`);
  console.log(`   → vào hàng đợi ĐẾM: ${n(c.inspectionCandidates)} kiện (TỒN KHO KHÔNG ĐỔI — chờ người kho đếm)`);
  console.log(`   GIỮ NGUYÊN: ${n(c.untouchedRows)} dòng`);
  for (const st of HMT_MATCH_STATUSES) if (c.byStatus[st]) console.log(`     ${st.padEnd(20)} ${String(n(c.byStatus[st])).padStart(6)}  ${HMT_MATCH[st].label}`);

  const cov = plan.coverage;
  console.log(`\n═══ ĐỘ PHỦ so với "${HMT_SHEETS.TRACKING_INDEX.name}" ═══`);
  console.log(`   dòng ${n(cov.trackingIndexRows)} · mã khác nhau ${n(cov.trackingIndexUnique)} · có mặt ở sheet chi tiết ${n(cov.coveredByItemSheets)}`);
  console.log(`   sheet tổng CÓ mà chi tiết KHÔNG: ${n(cov.missingFromItemSheets.length)}${cov.missingFromItemSheets.length ? ` (vd: ${cov.missingFromItemSheets.slice(0, 8).join(", ")})` : ""}`);
  console.log(`   chi tiết CÓ mà sheet tổng KHÔNG: ${n(cov.extraInItemSheets.length)}${cov.extraInItemSheets.length ? ` (vd: ${cov.extraInItemSheets.slice(0, 8).join(", ")})` : ""}`);

  console.log(`\n═══ VÍ DỤ TỪNG NHÓM ═══`);
  for (const st of HMT_MATCH_STATUSES) {
    const vd = plan.samples[st as HmtMatchStatus];
    if (!vd?.length) continue;
    console.log(`\n── ${st} · ${HMT_MATCH[st].label}`);
    console.log(`   ${HMT_MATCH[st].hint}`);
    for (const r of vd) console.log(`   [${r.sheetName} dòng ${r.rowNumber}] ${r.trackingRaw || "(trống)"} · ${r.productText || "(trống)"} → ${r.detail}`);
  }
}

/**
 * ═══════════ TỆP NGUỒN: CSDL TRƯỚC, ĐĨA SAU ═══════════
 *
 * Mặc định đọc bản MỚI NHẤT người dùng đã tải lên qua màn hình Kiểm đếm hàng hoàn. Đó là đường duy
 * nhất không đòi ai mở terminal, và là đường chủ shop thật sự dùng được từ máy Windows của mình.
 *
 * `--file` vẫn còn cho người vận hành đang ngồi ngay trên máy chủ. Hai đường, MỘT cách đọc
 * (`readHmtWorkbook`), nên không thể ra hai kết quả khác nhau.
 *
 * BĂM LUÔN ĐƯỢC IN RA, dù nguồn nào. Nó là thứ đối chiếu được giữa lượt chạy thử và lượt ghi: khác
 * băm nghĩa là đang đối soát một BẢN KHÁC, và số liệu của hai lượt không so được với nhau.
 */
async function nguonTep(): Promise<HmtSource> {
  const file = arg("file");
  if (file) {
    const buffer = readFileSync(file);
    if (!looksLikeXlsx(buffer)) throw new Error(`Tệp "${file}" không phải .xlsx (thiếu dấu hiệu ZIP ở đầu tệp)`);
    return { filename: file, sha256: sha256Of(buffer), bytes: buffer.length, origin: "FILE", uploadedBy: "", uploadedAt: null, lastUsedAt: null, buffer };
  }
  const db = await latestHmtWorkbook();
  if (db) return db;
  throw new Error(
    "Chưa có bảng tính nào để đối soát.\n" +
      "  · CÁCH THƯỜNG DÙNG: mở ERP → Kiểm đếm hàng hoàn → kéo tệp .xlsx vào ô “Sổ hàng hoàn viết tay”, rồi chạy lại lệnh này.\n" +
      "  · Hoặc, nếu đang ngồi trên máy chủ: truyền --file <đường dẫn tệp .xlsx>.",
  );
}

async function main() {
  const label = arg("label") ?? HMT_WORKBOOK_LABEL;
  const apply = process.argv.includes("--apply");

  const nguon = await nguonTep();
  console.log(`\n═══ TỆP NGUỒN ═══`);
  console.log(`   ${nguon.origin === "DB" ? "tải lên qua ERP" : "tệp trên máy chủ"}: ${nguon.filename}`);
  console.log(`   ${n(nguon.bytes)} byte · SHA-256 ${nguon.sha256}`);
  if (nguon.origin === "DB") console.log(`   người tải: ${nguon.uploadedBy || "—"} · lúc ${nguon.uploadedAt ? nguon.uploadedAt.toISOString() : "—"}`);

  const wb = readHmtWorkbook(nguon.buffer, label);
  inNguon(wb);

  const plan = await planHmtReconciliation(wb);
  inKeHoach(plan);

  const json = arg("json");
  if (json) {
    writeFileSync(json, JSON.stringify({ audit: wb.audit, sheetNames: wb.sheetNames, plan: { ...plan, rows: plan.rows } }, null, 2));
    console.log(`\nĐã ghi báo cáo đầy đủ: ${json}`);
  }

  if (!apply) {
    console.log(`\n▸ CHẠY THỬ — chưa ghi gì. Đọc kỹ hai bảng trên rồi chạy lại kèm --apply.`);
    return;
  }

  const kq = await applyHmtReconciliation(plan, systemActor(HMT_SOURCE));
  // Đánh dấu bản này ĐÃ ĐƯỢC DÙNG — màn hình phân biệt "vừa tải lên, chưa đối soát" với "đã đối soát".
  if (nguon.origin === "DB") await markHmtWorkbookUsed(nguon.sha256);
  console.log(`\n═══ ĐÃ GHI ═══`);
  console.log(`   kiện ghi nhận đã về kho: ${n(kq.shipmentsReceived)} (dòng món ${n(kq.itemRowsWritten)} · ${n(kq.unitsWritten)} món)`);
  console.log(`   dòng chứng cứ mới: ${n(kq.provenanceRows)} · bỏ qua vì đã ghi lần trước: ${n(kq.duplicateWrites)}`);
  console.log(`   kiện vào hàng đợi đếm: ${n(kq.inspectionCandidates)} — TỒN KHO CHƯA ĐỔI`);
  console.log(`\n▸ Chạy lại lệnh này ở chế độ chạy thử: số MATCHED phải về 0.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
