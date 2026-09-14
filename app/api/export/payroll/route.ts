import type { NextRequest } from "next/server";
import { can, getCurrentUser } from "@/lib/auth/session";
import { PAYROLL_BASIS_LABEL, PAYROLL_BASIS_SHORT, parsePayrollBasis } from "@/lib/constants/payroll";
import { employeeMatchesUser, getPayrollReport } from "@/lib/queries/payroll";
import { param, resolvePeriod, type SearchParams } from "@/lib/search-params";

export const dynamic = "force-dynamic";

function csvCell(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * ═══════ XUẤT CSV ĐÚNG BẢNG LƯƠNG ĐANG XEM ═══════
 *
 * ─── HAI ĐIỀU TỆP NÀY KHÔNG ĐƯỢC PHÉP LÀM ───
 *
 * 1. **Ra số khác màn hình.** Nên nó gọi ĐÚNG `getPayrollReport(period, basis)` mà trang gọi, với
 *    kỳ và cơ sở đọc từ CHÍNH những tham số URL của trang. Một tệp xuất tự cộng lại theo cách riêng
 *    là cách chắc chắn để hai con số của cùng một khoản lương đi hai ngả.
 *
 * 2. **Mở rộng quyền.** Cổng xuất phải HẸP ĐÚNG BẰNG cổng của màn hình: `payroll:view` thấy tất,
 *    `payroll:view-own` chỉ thấy dòng của chính mình (so khớp bằng KHOÁ TÀI KHOẢN — xem
 *    `employeeMatchesUser`), không quyền nào thì 403. Một đường xuất quên lọc là cả bảng lương của
 *    shop nằm trong một lần bấm.
 *
 * ─── CHƯA BIẾT VẪN LÀ CHƯA BIẾT TRONG TỆP CSV ───
 *
 * Lương cứng của kỳ "Toàn bộ", và thưởng theo LN cá nhân khi cơ sở dòng tiền không quy đổi được,
 * là `null`. Ghi 0 vào ô ấy là để một bảng tính sau đó CỘNG nó vào tổng tiền phải trả. Ô để TRỐNG,
 * và cột "Ghi chú" nói vì sao.
 */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return new Response("Chưa đăng nhập", { status: 401 });
  const viewAll = can(user, "payroll:view");
  if (!viewAll && !can(user, "payroll:view-own")) return new Response("Không có quyền xuất bảng lương", { status: 403 });

  const raw = Object.fromEntries(request.nextUrl.searchParams.entries()) as SearchParams;
  const period = resolvePeriod(raw, "month");
  const basis = parsePayrollBasis(param(raw, "basis"));
  const report = await getPayrollReport(period, basis);

  const lines = report.lines.filter((l) => viewAll || employeeMatchesUser(l.employee, user));

  const header = [
    "Nhân sự",
    "Tên ngắn",
    "Phòng ban",
    "Lương cứng khai (đ/tháng)",
    "Lương cứng thuộc kỳ (đ)",
    "% LN tổng",
    "LN tổng kỳ (đ)",
    "Thưởng % LN tổng (đ)",
    "% LN cá nhân",
    "LN cá nhân (đ)",
    "Thưởng % LN cá nhân (đ)",
    "% DT cá nhân",
    "DT cá nhân (đ)",
    "Thưởng % DT (đ)",
    "Tổng lương (đ)",
    "Ghi chú",
  ];
  const out = [header.join(",")];
  for (const l of lines) {
    const ghiChu: string[] = [];
    if (l.fixed === null) ghiChu.push("Lương cứng CHƯA BIẾT: kỳ không có mốc đầu/cuối nên không chia theo ngày được.");
    if (l.bonusPersonal === null) ghiChu.push(report.cashRatioReason ?? "Thưởng theo LN cá nhân CHƯA BIẾT.");
    out.push(
      [
        l.employee.name,
        l.employee.shortName,
        l.employee.department,
        l.fixedMonthly,
        l.fixed ?? "",
        l.employee.percentTotal,
        l.totalProfit,
        l.bonusTotal,
        l.employee.percentPersonal,
        l.personalProfit ?? "",
        l.bonusPersonal ?? "",
        l.employee.percentRevenue,
        l.personalRevenue ?? "",
        l.bonusRevenue,
        l.salary ?? "",
        ghiChu.join(" "),
      ]
        .map(csvCell)
        .join(","),
    );
  }

  /*
    HAI DÒNG CUỐI NÓI RÕ TỆP NÀY ĐỨNG TRÊN CÁI GÌ: kỳ nào, cơ sở lợi nhuận nào, lương cứng chia
    theo bao nhiêu ngày. Một tệp CSV rời khỏi màn hình rồi thì không còn bộ lọc nào đi kèm nó nữa.
  */
  out.push("");
  out.push(
    [
      `Kỳ: ${period.label}${period.fromKey ? ` (${period.fromKey} → ${period.toKey ?? ""})` : ""}`,
      `Cơ sở lợi nhuận: ${PAYROLL_BASIS_SHORT[basis]} — ${PAYROLL_BASIS_LABEL[basis]}`,
      report.fixedBasis.bounded
        ? `Lương cứng chia theo ${report.fixedBasis.days} ngày của kỳ (khai theo tháng)`
        : "Lương cứng CHƯA BIẾT: kỳ không có mốc đầu/cuối",
      viewAll ? "Phạm vi: toàn bộ nhân sự" : "Phạm vi: chỉ dòng của chính người xuất",
    ]
      .map(csvCell)
      .join(","),
  );

  return new Response(`﻿${out.join("\r\n")}`, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="bang-luong-${period.fromKey ?? "toan-bo"}-${period.toKey ?? ""}-${basis}.csv"`,
    },
  });
}
