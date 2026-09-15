/**
 * ═══════════ ĐỐI CHIẾU LƯƠNG CŨ / MỚI — CHỈ ĐỌC, KHÔNG BAO GIỜ GHI ═══════════
 *
 * Chạy:
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
 * ─── NẾU KHÔNG CHẮC KẾT NỐI LÀ CHỈ-ĐỌC THÌ ĐỪNG CHẠY TRÊN PRODUCTION ───
 *
 * Script không tự kiểm được quyền của `DATABASE_URL` nó nhận. Cách an toàn nhất là chạy bằng một
 * tài khoản CSDL chỉ có `SELECT`; khi ấy dù mã có sai thì CSDL vẫn từ chối.
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
import type { Period } from "@/lib/search-params";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : null;
}

const tien = (v: number | null) => (v === null ? "—" : v.toLocaleString("vi-VN"));

async function main() {
  const from = arg("from");
  const to = arg("to");
  if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    throw new Error("Thiếu hoặc sai --from / --to (dạng YYYY-MM-DD). Ví dụ: --from 2026-09-01 --to 2026-09-30");
  }
  const chiNhungAi = (arg("employee") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const period: Period = { key: "custom", from: vnStartOfDay(from), to: vnEndOfDay(to), fromKey: from, toKey: to, label: `${from} → ${to}` };
  const key = payrollPeriodKey(period.from, period.to);

  console.log(`\n═══ ĐỐI CHIẾU LƯƠNG CŨ / MỚI · kỳ ${key} ═══`);
  console.log("CHỈ ĐỌC: phiên kết nối bật `default_transaction_read_only=on` — CHÍNH POSTGRES từ chối mọi lệnh ghi, không phải mã nguồn tự hứa.\n");

  const rows = (await previewLegacyMigration(period, "profit1")).filter((r) => !chiNhungAi.length || chiNhungAi.includes(r.proposal.employeeId));
  if (!rows.length) {
    console.log("Không có nhân sự nào khớp bộ lọc.");
    return;
  }

  const bang: Record<string, unknown>[] = [];
  let coLech = 0;
  let chuaGiaiThich = 0;

  for (const r of rows) {
    const p = r.proposal;
    console.log(`── ${p.employeeName} (${p.employeeId}) ${r.alreadyMigrated ? "· ĐÃ CHUYỂN" : ""}`);
    if (p.blockers.length) for (const b of p.blockers) console.log(`   ⚠ ${b}`);
    if (!r.recon) {
      console.log("   Không có dòng lương ở đường cũ cho kỳ này — chưa đối chiếu được.\n");
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
    if (r.recon.netDiff !== 0) coLech += 1;
    if (r.recon.hasUnexplained) chuaGiaiThich += 1;
    console.log("");
  }

  console.log("═══ TỔNG KẾT ═══");
  console.log(`${rows.length} nhân sự · ${coLech} người có lệch ở dòng thực nhận · ${chuaGiaiThich} người còn lệch CHƯA giải thích được.`);
  if (chuaGiaiThich > 0) {
    console.log("\nKHÔNG kích hoạt chính sách cho những người còn lệch chưa rõ nguyên nhân — trừ khi đó là một");
    console.log("sửa ĐÚNG có chủ ý, và khi ấy phải ghi lý do ở màn hình Xem trước chuyển đổi để nó vào nhật ký.");
  }
  // Dấu hiệu đọc bảng: `!` = lệch chưa giải thích được · `~` = lệch có lý do · `?` = một bên chưa biết.
  console.log("\nDấu:  ! lệch chưa giải thích được   ~ lệch có lý do   ? một bên CHƯA BIẾT (không so được)");

  const jsonPath = arg("json");
  if (jsonPath) {
    writeFileSync(jsonPath, JSON.stringify({ period: key, generatedAt: new Date().toISOString(), rows: bang }, null, 2));
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
