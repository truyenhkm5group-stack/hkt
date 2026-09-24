/**
 * ═══════════ ĐỐI CHIẾU LƯƠNG CŨ / MỚI — CHỈ ĐỌC, KHÔNG BAO GIỜ GHI ═══════════
 *
 * Chạy:
 *   npm run payroll:reconcile                      (tự tìm kỳ gần nhất CÓ dữ liệu)
 *   npm run payroll:reconcile -- --from 2026-09-01 --to 2026-09-30
 *   npm run payroll:reconcile -- --from 2026-09-01 --to 2026-09-30 --employee nv-1,nv-2
 *   npm run payroll:reconcile -- --from 2026-09-01 --to 2026-09-30 --json bao-cao.json
 *   npm run payroll:reconcile -- --from 2026-09-01 --to 2026-09-30 --csv bao-cao.csv
 *
 * ─── VÌ SAO SCRIPT NÀY TỒN TẠI ───
 *
 * Trước khi gán chính sách cho người đầu tiên trên production, phải trả lời được: "nếu chuyển,
 * người này nhận nhiều hơn hay ít hơn, và vì sao". Câu ấy KHÔNG trả lời được bằng suy luận — phải
 * chạy cả hai đường tính trên CÙNG dữ liệu thật rồi đặt cạnh nhau.
 *
 * ─── CHỈ ĐỌC, VÀ ĐÓ LÀ RÀNG BUỘC CỨNG ───
 *
 * Script này KHÔNG `insert`, KHÔNG `update`, KHÔNG `delete`, KHÔNG gán chính sách, KHÔNG khoá kỳ,
 * KHÔNG ghi settings. Nó gọi đúng hai hàm ĐỌC (`previewLegacyMigration` và bảng lương) rồi in ra.
 *
 * `tests/payroll-reconcile-script.test.ts` quét mã nguồn để giữ điều đó. Lý do phải có bài kiểm
 * thay vì một lời hứa: một script chạy trên production với quyền ghi mà ai đó "tiện tay" thêm một
 * dòng `update` là một lượt sửa dữ liệu thật không ai duyệt.
 *
 * ─── FAIL CLOSED: KHÔNG CHỨNG MINH ĐƯỢC CHỈ ĐỌC THÌ DỪNG, KHÔNG CHẠY ───
 *
 * Bản trước chỉ khuyên "nên dùng tài khoản chỉ có SELECT". Một lời khuyên trong khối chú thích
 * không ngăn được gì. Nay script HỎI CHÍNH POSTGRES (`current_setting('transaction_read_only')`)
 * và DỪNG nếu câu trả lời không phải `on` — trước khi đọc một dòng dữ liệu nào.
 *
 * Và nó chụp ảnh đếm các bảng lương TRƯỚC / SAU để chứng minh không ghi gì, thay vì khẳng định.
 *
 * ─── KHÔNG KẾT LUẬN "KHỚP" TRÊN DỮ LIỆU RỖNG ───
 *
 * Hai phép tính cùng ra 0 trên một kỳ không có đơn, không có chi phí, không có gì — điều đó KHÔNG
 * chứng minh chúng đồng ý, nó chỉ chứng minh không có gì để bất đồng. Script tự tìm một kỳ CÓ
 * hoạt động nguồn; không tìm được thì kết luận là `INSUFFICIENT_DATA`, không phải "đạt".
 */
import "dotenv/config";

/*
  ═══ ÉP CHỈ ĐỌC Ở TẦNG CSDL, TRƯỚC KHI BẤT KỲ TỆP NÀO MỞ KẾT NỐI ═══

  Dòng này phải đứng TRƯỚC mọi `import` chạm tới `@/db` — đó là lý do nó nằm ngay sau `dotenv` và
  trước các import còn lại, chứ không phải ở trong `main()`.

  Vì sao cần nó dù script không viết một lệnh ghi nào: script gọi `previewLegacyMigration`, thứ kéo
  theo hàng chục tệp, trong đó có những tệp CÓ lệnh ghi (đồng bộ Pancake, đồng bộ Facebook, bộ
  chạy job). Script không gọi tới chúng — nhưng "hôm nay không gọi" là một lời hứa về mã nguồn,
  còn đây là một RÀNG BUỘC của máy chủ: `default_transaction_read_only=on` làm Postgres từ chối
  mọi INSERT/UPDATE/DELETE/DDL, bất kể mã nào chạy. Cùng cơ chế mà thao tác `db-query` của kho mã
  này vẫn dùng để tra production.
*/
process.env.ERP_READ_ONLY = "1";

import { writeFileSync } from "node:fs";
import { payrollPeriodKey } from "@/lib/constants/payroll";
import { vnEndOfDay, vnStartOfDay } from "@/lib/format";
import { previewLegacyMigration } from "@/lib/queries/payroll-migration";
import { getPayrollReport } from "@/lib/queries/payroll";
import {
  assertReadOnlySession,
  diffSnapshots,
  findPeriodWithActivity,
  payrollTableSnapshot,
} from "@/lib/queries/payroll-reconcile-source";
import {
  ACTIVITY_LABEL,
  ACTIVITY_SOURCES,
  RECON_STATUS_HINT,
  RECON_STATUS_LABEL,
  classifyEmployee,
  gateVerdict,
  hasActivity,
  tallyStatuses,
  type ReconStatus,
} from "@/lib/payroll/reconcile-gate";
import { RECONCILIATION_ONLY_SYNTHETIC_CONTEXT } from "@/lib/payroll/reconcile-context";
import type { Period } from "@/lib/search-params";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : null;
}

const tien = (v: number | null) => (v === null ? "—" : v.toLocaleString("vi-VN"));

/**
 * KÊNH TÓM TẮT CỦA THAO TÁC OPS. Qua workflow "Vận hành ERP trên VPS", toàn bộ kết quả của script
 * này (lương từng người kèm tên) được MÃ HOÁ; chỉ dòng mang tiền tố dưới đây được in ra log công
 * khai. Vì thế CHỈ dòng đếm / kết luận đi qua đây — không bao giờ tên hay số tiền của một người.
 * Tiền tố viết lại tại chỗ (không import): ops lấy script từ `main` nhưng `lib/` từ ảnh đang chạy.
 */
const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s}`);

async function main() {
  const from = arg("from");
  const to = arg("to");
  const chiNhungAi = (arg("employee") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  /*
    ═══ BƯỚC 0 · CHỨNG MINH PHIÊN LÀ CHỈ ĐỌC, TRƯỚC KHI ĐỌC MỘT DÒNG NÀO ═══

    FAIL CLOSED. `assertReadOnlySession` ném lỗi nếu Postgres không xác nhận `transaction_read_only
    = on`, và không có nhánh nào bắt lỗi ấy để chạy tiếp.
  */
  const roCheck = await assertReadOnlySession();
  console.log("\n═══ ĐỐI CHIẾU LƯƠNG CŨ / MỚI ═══");
  console.log(`CHỈ ĐỌC ĐÃ XÁC MINH: transaction_read_only=${roCheck.transactionReadOnly} · default_transaction_read_only=${roCheck.defaultReadOnly}`);
  console.log("Chính POSTGRES từ chối mọi lệnh ghi — không phải mã nguồn tự hứa.\n");

  /* ═══ BƯỚC 1 · ẢNH ĐẾM TRƯỚC ═══ */
  const anhTruoc = await payrollTableSnapshot();

  /*
    ═══ BƯỚC 2 · CHỌN KỲ CÓ DỮ LIỆU THẬT ═══

    Kỳ do người chạy chỉ định được thử TRƯỚC. Rỗng thì lùi dần từng tháng — và in ra từng kỳ đã
    thử, vì "đã thử 6 tháng đều rỗng" là một kết luận khác hẳn "chọn đại tháng đầu tiên".
  */
  const uuTien: Period | null =
    from && to && /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to)
      ? { key: "custom", from: vnStartOfDay(from), to: vnEndOfDay(to), fromKey: from, toKey: to, label: `${from} → ${to}` }
      : null;
  const chon = await findPeriodWithActivity(uuTien, Number(arg("back") ?? 6));
  const period = chon.period;
  const key = payrollPeriodKey(period.from, period.to);
  const coHoatDong = hasActivity(chon.activity);

  tomTat(`Kỳ đối chiếu: ${key}`);
  if (chon.tried.length > 1 || !coHoatDong) {
    tomTat(`Đã thử: ${chon.tried.map((t) => `${t.label} ${t.hasActivity ? "CÓ dữ liệu" : "rỗng"}`).join(" · ")}`);
  }
  tomTat("Hoạt động nguồn của kỳ:");
  for (const k of ACTIVITY_SOURCES) tomTat(`   ${ACTIVITY_LABEL[k].padEnd(30)} ${(chon.activity[k] ?? 0).toLocaleString("vi-VN")}`);
  if (!coHoatDong) {
    console.log("\n⚠ KỲ NÀY KHÔNG CÓ MỘT NGUỒN SỐ NÀO KHÁC 0.");
    console.log("  Mọi kết luận “khớp” trên kỳ ấy là RỖNG NGHĨA: hai phép tính cùng ra 0 trên dữ liệu rỗng");
    console.log("  KHÔNG chứng minh chúng đồng ý — chỉ chứng minh không có gì để bất đồng.");
  }
  console.log("");

  const report = await getPayrollReport(period, "profit1");
  const rows = (await previewLegacyMigration(period, "profit1")).filter((r) => !chiNhungAi.length || chiNhungAi.includes(r.proposal.employeeId));
  if (!rows.length) {
    console.log("Không có nhân sự nào khớp bộ lọc.");
    return;
  }
  const trangThai: ReconStatus[] = [];

  const bang: Record<string, unknown>[] = [];
  let coLech = 0;
  let chuaGiaiThich = 0;

  for (const r of rows) {
    const p = r.proposal;
    const line = report.lines.find((l) => l.employee.id === p.employeeId);
    const mkt = report.marketers.marketers.find((m) => m.marketerId === p.employeeId);

    /*
      CÓ THỨ GÌ ĐỂ HAI ĐƯỜNG BẤT ĐỒNG KHÔNG — đây là ranh giới giữa MATCH và INSUFFICIENT_DATA.

      Định nghĩa đúng KHÔNG phải "người này có doanh thu không" mà là "có dòng nào khác 0 ở ÍT NHẤT
      một trong hai bên không". Hai lý do:

       · Một người chỉ ăn % lợi nhuận TOÀN SHOP không có doanh thu riêng nào, nhưng con số của họ
         vẫn chạy qua trọn bộ máy tính lợi nhuận. Hai đường cùng ra 2.522.789đ là một phép khớp
         THẬT — gọi nó là "không đủ dữ liệu" là hạ giá một bằng chứng có giá trị.
       · Ngược lại, mọi dòng đều 0 ở CẢ HAI bên thì không có gì để bất đồng, và "0 = 0" không
         chứng minh hai phép tính đồng ý — chỉ chứng minh không có gì để so.
    */
    const coGiDeSo = (r.recon?.lines ?? []).some((l) => (l.old ?? 0) !== 0 || (l.next ?? 0) !== 0);

    console.log(`── ${p.employeeName} (${p.employeeId}) ${r.alreadyMigrated ? "· ĐÃ CHUYỂN" : ""}`);
    console.log(`   Phòng ban: ${line?.employee.department || "(chưa khai)"}`);

    /* CƠ CHẾ LƯƠNG CŨ — in nguyên lời khai, không diễn giải lại. */
    const coCheCu: string[] = [];
    if ((line?.fixedMonthly ?? 0) > 0) coCheCu.push(`lương cứng ${tien(line!.fixedMonthly)}đ/tháng`);
    if ((line?.employee.percentTotal ?? 0) > 0) coCheCu.push(`${line!.employee.percentTotal}% LN toàn shop`);
    if ((line?.employee.percentPersonal ?? 0) > 0) coCheCu.push(`${line!.employee.percentPersonal}% LN cá nhân`);
    if ((line?.employee.percentRevenue ?? 0) > 0) coCheCu.push(`${line!.employee.percentRevenue}% doanh thu cá nhân`);
    console.log(`   Cơ chế cũ: ${coCheCu.length ? coCheCu.join(" + ") : "(không khai khoản nào)"}`);
    console.log(`   Chính sách ứng viên: ${p.policyCode} — ${p.components.length} thành phần${p.components.length ? `: ${p.components.map((c) => `${c.code}/${c.kind}`).join(", ")}` : ""}`);

    /*
      ═══ HAI LOẠI "THIẾU", IN TÁCH RỜI VÌ CHỈ MỘT LOẠI CHẶN ═══

      Bản trước in chung một danh sách và kết luận bằng cả danh sách ấy — nên "chưa khai phân công
      lao động" (việc của mô hình MỚI, mà chính phép đối chiếu đã tự dựng bối cảnh ứng viên để đi
      qua) đã ném đi một phép so ĐÃ CHẠY XONG VÀ ĐÃ KHỚP. Xem `lib/payroll/reconcile-context.ts`.
    */
    if (r.syntheticEmployment) {
      console.log(`   Bối cảnh làm việc: DỰNG TẠM phủ trọn kỳ (${RECONCILIATION_ONLY_SYNTHETIC_CONTEXT}) — chỉ trong bộ nhớ, không ghi, không dùng để trả tiền.`);
    }
    for (const g of r.newModelGaps) console.log(`   · Chưa khai ở mô hình MỚI (KHÔNG chặn đối chiếu): ${g.message}`);
    for (const g of r.legacyGaps) console.log(`   ⚠ THIẾU KHAI BÁO NGHIỆP VỤ CŨ (CHẶN đối chiếu): ${g.message}`);

    /*
      ═══ BÓC TÁCH LỢI NHUẬN CHO NGƯỜI ĂN THEO % LỢI NHUẬN ═══

      In ra ĐÚNG chuỗi trừ của `PRE_VARIABLE_COMPENSATION_PROFIT`, để người đọc thấy hoa hồng KHÔNG
      nằm trong phép trừ ấy — nó bị trừ ở bước sau. Số lấy từ báo cáo, không tính lại ở đây.
    */
    if (mkt && (line?.employee.percentPersonal ?? 0) > 0) {
      console.log("   Cơ sở lợi nhuận trước lương biến đổi:");
      console.log(`      Doanh thu giao thành công        ${tien(mkt.attributedRevenue).padStart(16)}`);
      console.log(`    − Giá vốn hàng đã giao             ${tien(mkt.cogsCharged).padStart(16)}`);
      console.log(`    − Quảng cáo của chính người này    ${tien(mkt.totalSpend).padStart(16)}`);
      console.log(`    − Cước vận chuyển + phí hoàn       ${tien(mkt.shippingCharged).padStart(16)}`);
      console.log(`    − Chi phí vận hành phân bổ         ${tien(mkt.operatingCharged).padStart(16)}`);
      console.log(`    = LN trước lương biến đổi          ${tien(mkt.personalProfit).padStart(16)}`);
      if (line?.carry) {
        console.log(`    + Lỗ mang sang từ kỳ trước         ${tien(line.carry.openingBalance).padStart(16)}`);
        console.log(`    = Cơ sở tính hoa hồng (≥ 0)        ${tien(line.carry.commissionBase).padStart(16)}`);
        console.log(`      Lỗ chuyển sang kỳ sau (≤ 0)      ${tien(line.carry.closingBalance).padStart(16)}`);
      }
      console.log("      (hoa hồng KHÔNG nằm trong phép trừ trên — nó bị trừ ở BƯỚC SAU)");
    }

    if (!r.recon) {
      console.log("   Không có dòng lương ở đường cũ cho kỳ này — chưa đối chiếu được.\n");
      trangThai.push(
        classifyEmployee({
          employeeId: p.employeeId,
          employeeName: p.employeeName,
          missingConfig: r.legacyGaps.map((g) => g.message),
          hasOwnActivity: false,
          hasLegacyLine: false,
          netDiff: null,
          hasUnexplainedDiff: false,
        }),
      );
      continue;
    }
    for (const l of r.recon.lines) {
      const dau = l.diff === null ? "?" : l.diff === 0 ? " " : l.explained ? "~" : "!";
      console.log(`   ${dau} ${l.label.padEnd(34)} cũ ${tien(l.old).padStart(14)}   mới ${tien(l.next).padStart(14)}   lệch ${tien(l.diff).padStart(14)}`);
      if (l.explanation) console.log(`       ${l.explanation}`);
      bang.push({
        employeeId: p.employeeId,
        employeeName: p.employeeName,
        khoan: l.key,
        nhan: l.label,
        cu: l.old,
        moi: l.next,
        lech: l.diff,
        giaiThichDuoc: l.explained,
        giaiThich: l.explanation,
      });
    }
    /*
      ═══ BỐN DÒNG TỔNG HỢP, ĐẶT CẠNH NHAU ═══

      Đây là PHÉP CỘNG LẠI những con số hai đường tính đã trả về, KHÔNG phải một công thức lương
      thứ ba: `cong()` chỉ cộng đúng các dòng ở ngay trên. Nếu một phần là CHƯA BIẾT thì tổng cũng
      là CHƯA BIẾT — cộng `null` thành 0 ở đây là in ra một con số lương không ai tính (mục 42).

      Đường cũ không có khoản khấu trừ nào, nên "tổng thu nhập" của nó = lương cứng + biến đổi.
    */
    const dong = (k: string) => r.recon?.lines.find((l) => l.key === k) ?? null;
    const cong = (...vs: (number | null | undefined)[]): number | null =>
      vs.reduce<number | null>((t, v) => (t === null || v === null || v === undefined ? null : t + v), 0);
    const bien = (canh: "old" | "next") => cong(dong("shopProfit")?.[canh], dong("personalProfit")?.[canh], dong("revenue")?.[canh]);
    const tongHop = (["old", "next"] as const).map((canh) => {
      const base = dong("base")?.[canh] ?? null;
      const variable = bien(canh);
      return { base, variable, gross: cong(base, variable), net: dong("net")?.[canh] ?? null };
    });
    const [cuTH, moiTH] = tongHop;
    console.log("   ── Tổng hợp ──");
    for (const [nhan, a, b] of [
      ["Lương cứng (Base)", cuTH.base, moiTH.base],
      ["Biến đổi (Variable)", cuTH.variable, moiTH.variable],
      ["Tổng thu nhập (Gross)", cuTH.gross, moiTH.gross],
      ["Thực nhận (Net)", cuTH.net, moiTH.net],
    ] as const) {
      console.log(`     ${nhan.padEnd(24)} cũ ${tien(a).padStart(14)}   mới ${tien(b).padStart(14)}   lệch ${tien(cong(b, a === null ? null : -a)).padStart(14)}`);
    }

    if (r.recon.netDiff !== 0) coLech += 1;
    if (r.recon.hasUnexplained) chuaGiaiThich += 1;

    const tt = classifyEmployee({
      employeeId: p.employeeId,
      employeeName: p.employeeName,
      missingConfig: r.legacyGaps.map((g) => g.message),
      hasOwnActivity: coGiDeSo,
      hasLegacyLine: true,
      netDiff: r.recon.netDiff,
      hasUnexplainedDiff: r.recon.hasUnexplained,
    });
    trangThai.push(tt);
    console.log(`   ⇒ ${RECON_STATUS_LABEL[tt]} — ${RECON_STATUS_HINT[tt]}`);
    console.log("");
  }

  tomTat("═══ TỔNG KẾT ═══");
  tomTat(`${rows.length} nhân sự · ${coLech} người có lệch ở dòng thực nhận · ${chuaGiaiThich} người còn lệch CHƯA giải thích được.`);
  const dem = tallyStatuses(trangThai);
  for (const k of Object.keys(dem) as ReconStatus[]) tomTat(`   ${RECON_STATUS_LABEL[k].padEnd(36)} ${dem[k]}`);
  if (chuaGiaiThich > 0) {
    console.log("\nKHÔNG kích hoạt chính sách cho những người còn lệch chưa rõ nguyên nhân — trừ khi đó là một");
    console.log("sửa ĐÚNG có chủ ý, và khi ấy phải ghi lý do ở màn hình Xem trước chuyển đổi để nó vào nhật ký.");
  }

  /*
    ═══ CHỨNG MINH KHÔNG GHI: ẢNH ĐẾM SAU PHẢI BẰNG ẢNH ĐẾM TRƯỚC ═══

    Không phải một lời khẳng định mà là một phép đo. Lệch một dòng ở bất kỳ bảng nào — kể cả
    `audit_logs` — nghĩa là có đường ghi lọt qua, và lượt đối chiếu ấy KHÔNG dùng làm căn cứ được.
  */
  const anhSau = await payrollTableSnapshot();
  const lechBang = diffSnapshots(anhTruoc, anhSau);
  console.log("");
  tomTat("═══ CHỨNG MINH KHÔNG GHI DỮ LIỆU ═══");
  if (lechBang.length === 0) {
    tomTat(`Ảnh đếm ${Object.keys(anhTruoc).length} bảng lương TRƯỚC = SAU. Không một dòng nào được thêm, kể cả nhật ký.`);
  } else {
    tomTat("⚠ CÓ BẢNG ĐỔI SỐ DÒNG — lượt đối chiếu này KHÔNG dùng làm căn cứ được:");
    // Tên bảng + số dòng trước → sau: không có dữ liệu của người nào.
    for (const l of lechBang) tomTat(`   ${l}`);
  }

  /* ═══ KẾT LUẬN CỔNG ═══ */
  const ket = gateVerdict({ environmentOk: true, periodHasActivity: coHoatDong, statuses: trangThai });
  console.log("");
  tomTat("═══ KẾT LUẬN CỔNG ĐỐI CHIẾU ═══");
  tomTat(`${ket.verdict}`);
  tomTat(`${ket.why}`);
  if (lechBang.length > 0) tomTat("NHƯNG ảnh đếm bảng đã đổi — xem khối trên, kết luận ở trên KHÔNG có hiệu lực.");
  // Dấu hiệu đọc bảng: `!` = lệch chưa giải thích được · `~` = lệch có lý do · `?` = một bên chưa biết.
  console.log("\nDấu:  ! lệch chưa giải thích được   ~ lệch có lý do   ? một bên CHƯA BIẾT (không so được)");

  const jsonPath = arg("json");
  if (jsonPath) {
    writeFileSync(
      jsonPath,
      JSON.stringify(
        {
          period: key,
          generatedAt: new Date().toISOString(),
          readOnly: roCheck,
          activity: chon.activity,
          periodHasActivity: coHoatDong,
          periodsTried: chon.tried,
          tally: dem,
          verdict: ket,
          tableSnapshotBefore: anhTruoc,
          tableSnapshotAfter: anhSau,
          tableSnapshotChanged: lechBang,
          rows: bang,
        },
        null,
        2,
      ),
    );
    console.log(`\nĐã ghi ${jsonPath}`);
  }
  const csvPath = arg("csv");
  if (csvPath) {
    const cell = (v: unknown) => {
      const t = v === null || v === undefined ? "" : String(v);
      return /[",\n;]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const head = ["employeeId", "employeeName", "khoan", "nhan", "cu", "moi", "lech", "giaiThichDuoc", "giaiThich"];
    const csv = [head.join(","), ...bang.map((r) => head.map((h) => cell(r[h])).join(","))].join("\n");
    writeFileSync(csvPath, `${csv}\n`);
    console.log(`Đã ghi ${csvPath}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("✗ Đối chiếu thất bại:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
