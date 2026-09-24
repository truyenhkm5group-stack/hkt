import assert from "node:assert/strict";
import { inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { clearMemo } from "@/lib/cache";
import { codSettlementCounts } from "@/lib/queries/cod-settlement";
import { cheLoi, codStatementAuditLines, loaiTep, soBangKe, tien } from "@/scripts/cod-statement-audit";

const ALL = { key: "all" as const, from: null, to: null, label: "Toàn bộ", fromKey: null, toKey: null };

/**
 * ops `cod-statement-audit` — đo "vì sao /cod quá hạn nhiều" bằng SỐ TỔNG HỢP ra thẳng log công khai.
 *
 * Hai điều phải giữ:
 *   1. số của script là số của TRANG (đọc qua đúng hàm của trang), và phép chia theo ngày giao cộng
 *      lại đúng bằng số trên tab — không thì người đọc log và người xem trang cãi nhau;
 *   2. không một dòng nào mang dữ liệu cá nhân: tên tệp do người dùng đặt, nội dung chuyển khoản,
 *      câu lỗi có SĐT / email. Kho mã PUBLIC, log ai cũng đọc được.
 *
 * Chạy SAU `testCodReconciliation` để có sẵn vận đơn quá hạn / trả đủ / trả thiếu.
 */
export async function testCodStatementAudit() {
  // ── Hàm thuần
  assert.equal(loaiTep("BangKeChiCOD_30873899_1790000000000.xlsx"), "BANG_KE_EMAIL");
  assert.equal(loaiTep("Bao_cao_chi_tiet_bang_ke_14_09_2026 11_04_37.xlsx"), "BAO_CAO_CHI_TIET");
  assert.equal(loaiTep("Báo cáo chi tiết bảng kê.xlsx"), "BAO_CAO_CHI_TIET");
  assert.equal(loaiTep("Danh sách vận đơn 01-09.xlsx"), "DANH_SACH_VAN_DON");
  assert.equal(loaiTep("Nguyen Van A.xlsx"), "KHAC");
  assert.equal(soBangKe("BangKeChiCOD_30873899_1790000000000.xlsx"), "30873899");
  assert.equal(soBangKe("VTP GLMTQY18 180926 30873899"), "30873899");
  assert.equal(soBangKe("Tong cong ty co phan Buu chinh Viet VTP GLMTQY09 090926 30566351. TU: TONG CTY"), "30566351");
  assert.equal(soBangKe("HO KHAC TRUYEN chuyen tien 0912345678"), null, "không đoán số bảng kê từ một dãy số bất kỳ");
  assert.equal(tien(33082937), "33.082.937 ₫");
  assert.equal(tien(0), "0 ₫");
  assert.equal(cheLoi("Tệp 'khach 0912345678.xlsx' lỗi dòng 12345 — gửi ban.hang@shop.vn"), "Tệp '…' lỗi dòng #### — gửi •@•");

  // ── Trên CSDL mẫu
  const db = await getDb();
  const SO_CO = "39990001";
  const SO_THIEU = "39990002";
  const tepCo = `BangKeChiCOD_${SO_CO}_1790000000001.xlsx`;
  const bankIds = ["csa-bank-1", "csa-bank-2"];
  const nhapIds = ["csa-nhap-1"];
  const lineKey = "BK-CSA-TEST";
  await db.insert(schema.bankTransactions).values([
    { id: bankIds[0], bankRef: "csa-ref-1", txnAt: new Date(Date.now() - 2 * 86_400_000), amount: 11268242, description: `Tong cong ty co phan Buu chinh Viet VTP GLMTQY18 180926 ${SO_CO}. TU: TONG CTY`, accountingGroup: "COD_SETTLEMENT" },
    { id: bankIds[1], bankRef: "csa-ref-2", txnAt: new Date(Date.now() - 1 * 86_400_000), amount: 7900195, description: `VTP GLMTQY23 230926 ${SO_THIEU}`, accountingGroup: "COD_SETTLEMENT" },
  ]);
  await db.insert(schema.codStatementLines).values({ statementKey: lineKey, sourceFile: tepCo, trackingCode: "PKE3999000001", cod: 0, fee: 17000, net: -17000, codReported: false, statementAt: new Date() });
  await db.insert(schema.vtpImportBatches).values({
    id: nhapIds[0],
    filename: "Nguyen Thi Bi Mat 0912345678.xlsx",
    checksum: "csa-checksum",
    kind: "ERROR",
    mode: "APPLY",
    uploadedBy: "ban.hang@shop.vn",
    error: "Không đọc được 'Nguyen Thi Bi Mat 0912345678.xlsx' — liên hệ ban.hang@shop.vn",
  });

  try {
    clearMemo();
    const dem = await codSettlementCounts(ALL);
    const lines = await codStatementAuditLines(21);
    const all = lines.join("\n");

    assert.ok(lines.length <= 60, `kênh tóm tắt chỉ cho 60 dòng ra log, script in ${lines.length}`);
    assert.ok(lines[0]!.startsWith(`TRANG /cod: quá hạn ${dem.QUA_HAN} đơn`), `dòng đầu phải là số của tab Quá hạn (${dem.QUA_HAN}): ${lines[0]}`);
    assert.ok(dem.QUA_HAN > 0, "fixture COD phải có ít nhất một đơn quá hạn để phép chia theo ngày có nghĩa");

    // Phép chia theo ngày giao cộng lại đúng bằng số trên tab.
    const iNgay = lines.findIndex((d) => d.startsWith("QUÁ HẠN THEO NGÀY GIAO"));
    let cong = 0;
    for (const d of lines.slice(iNgay + 1)) {
      const m = /^ {2}(?:\S+|… \d+ ngày cũ hơn): (\d+) đơn/.exec(d);
      if (!m) break;
      cong += Number(m[1]);
    }
    assert.equal(cong, dem.QUA_HAN, "tổng các ngày giao phải bằng số của tab Quá hạn");

    // Sao kê: đợt có sổ chứng từ và đợt tiền ĐÃ VỀ mà không có bảng kê.
    assert.ok(lines.some((d) => d.includes(`bảng kê ${SO_CO}`) && d.includes("sổ chứng từ: có")), "đợt có dòng sổ chứng từ phải báo 'có'");
    assert.ok(lines.some((d) => d.includes(`bảng kê ${SO_THIEU}`) && d.includes("tệp: CHƯA NHẬN") && d.includes("sổ chứng từ: KHÔNG")), "đợt chưa có tệp phải báo CHƯA NHẬN / KHÔNG");
    assert.ok(lines.some((d) => /⇒ 1\/2 đợt tiền ĐÃ VỀ mà sổ chứng từ không có bảng kê/.test(d)), "phải đếm số đợt tiền về mà thiếu bảng kê");

    // Lần nhập tệp lỗi: hiện LOẠI tệp + lỗi đã che, không hiện tên tệp / người tải.
    assert.ok(lines.some((d) => d.includes("KHAC · ERROR/APPLY") && d.includes("lỗi: Không đọc được '…' — liên hệ •@•")), "lần nhập lỗi phải hiện, với câu lỗi đã che");

    // Không một chữ nào của dữ liệu cá nhân / nội dung chuyển khoản ra log.
    for (const bi of ["Nguyen Thi Bi Mat", "0912345678", "ban.hang@shop.vn", "TONG CTY", "GLMTQY18", "PKE3999000001"]) {
      assert.ok(!all.includes(bi), `dòng tóm tắt lộ "${bi}"`);
    }
    assert.ok(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(all), "không địa chỉ email nào ra log (ký hiệu che •@• thì được)");
    console.log(`✓ cod-statement-audit: ${lines.length} dòng tóm tắt · quá hạn ${dem.QUA_HAN} đơn khớp tab, chia theo ngày cộng lại đúng · 1/2 đợt tiền về thiếu bảng kê · 0 dữ liệu cá nhân ra log`);
  } finally {
    await db.delete(schema.bankTransactions).where(inArray(schema.bankTransactions.id, bankIds));
    await db.delete(schema.vtpImportBatches).where(inArray(schema.vtpImportBatches.id, nhapIds));
    await db.delete(schema.codStatementLines).where(inArray(schema.codStatementLines.statementKey, [lineKey]));
    clearMemo();
  }
}
