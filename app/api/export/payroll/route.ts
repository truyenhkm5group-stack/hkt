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
    /*
      BẢY CỘT BÙ TRỪ LỖ LŨY KẾ.

      Cột "HH có dấu" GIỮ SỐ ÂM trong tệp, dù tiền phải trả bằng 0. Bỏ dấu đi để "bảng tính cho
      đẹp" là làm mất đúng thứ chủ shop cần thấy: một người đang âm bao nhiêu. Ô để TRỐNG khi chưa
      biết — ghi 0 là để bảng tính sau đó cộng nó vào tổng như một con số đã xác minh.
    */
    "Tháng sổ lỗ",
    "Lỗ đầu tháng (đ)",
    "LN thực tháng (đ)",
    "Lỗ được bù (đ)",
    "LN tính HH sau bù (đ)",
    "HH có dấu (đ)",
    "HH phải trả (đ)",
    "Lỗ chuyển tiếp (đ)",
    "Căn cứ số dư",
    /*
      BỐN CỘT CỦA MÁY TÍNH LƯƠNG CHUNG.

      Người CHƯA gán chính sách để TRỐNG bốn ô này — trống nghĩa là "không áp dụng", khác hẳn 0.
      Cột "Tổng lương" phía trên đã là con số ĐANG DÙNG ĐỂ TRẢ cho cả hai đường tính, nên bốn cột
      này là phần giải thích, không phải một khoản cộng thêm. Cộng chúng vào tổng là trả hai lần.
    */
    "Chính sách lương",
    "Tổng thu nhập (đ)",
    "Tổng khấu trừ (đ)",
    "Thực nhận (đ)",
    "Ghi chú",
  ];
  const out = [header.join(",")];
  for (const l of lines) {
    const ghiChu: string[] = [];
    if (l.fixed === null) ghiChu.push("Lương cứng CHƯA BIẾT: kỳ không có mốc đầu/cuối nên không chia theo ngày được.");
    if (l.bonusPersonal === null) ghiChu.push(report.cashRatioReason ?? "Thưởng theo LN cá nhân CHƯA BIẾT.");
    if (l.carry && !l.carry.openingEstablished) ghiChu.push(`Số dư lỗ đầu tháng CHƯA ĐỦ CĂN CỨ ĐỂ CHỐT: ${l.carry.openingReason}`);
    for (const m of l.engine?.result.missing ?? []) ghiChu.push(`THIẾU “${m.label}”: ${m.message}`);
    for (const p of l.engine?.result.problems ?? []) ghiChu.push(p);
    if (l.engine?.splitAcrossSegments) {
      ghiChu.push("Kỳ có nhiều đoạn (vào/nghỉ/đổi chính sách giữa kỳ) nên số đo của cả kỳ được chia theo SỐ NGÀY của từng đoạn — đây là một ước tính.");
    }
    const chinhSach = l.engine
      ? [...new Map(l.engine.segments.filter((sg) => sg.policyId).map((sg) => [sg.policyCode, sg])).values()].map((sg) => `${sg.policyCode} #${sg.policyVersion ?? "?"}`).join(" → ")
      : "";
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
        l.carry?.monthKey ?? "không áp dụng",
        l.carry?.openingBalance ?? "",
        l.carry?.realProfit ?? "",
        l.carry?.lossApplied ?? "",
        l.carry?.commissionBase ?? "",
        l.carry?.signedCommission ?? "",
        l.carry ? (l.bonusPersonal ?? "") : "",
        l.carry?.closingBalance ?? "",
        l.carry?.openingReason ?? "",
        chinhSach,
        l.engine ? (l.engine.result.grossEarnings ?? "") : "",
        l.engine ? (l.engine.result.totalDeductions ?? "") : "",
        l.engine ? (l.engine.result.netPay ?? "") : "",
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
  /*
    ═══ KHỐI THỨ HAI: TỪNG THÀNH PHẦN CỦA TỪNG NGƯỜI ═══

    Bảng trên trả lời "trả bao nhiêu"; khối này trả lời "vì sao chừng đó". Cả hai lấy từ CÙNG một
    bản báo cáo (`getPayrollReport`) — tệp xuất KHÔNG tự tính lại một phép nhân nào, vì một tệp
    xuất tự cộng lại theo cách riêng là cách chắc chắn để hai con số của cùng một khoản lương đi
    hai ngả.

    Vắng mặt khi chưa ai được gán chính sách — in một tiêu đề rỗng chỉ làm tệp dài thêm.
  */
  const coMayChung = lines.some((l) => l.engine);
  if (coMayChung) {
    out.push("");
    out.push("CHI TIẾT THÀNH PHẦN LƯƠNG (máy tính chung)");
    out.push(["Nhân sự", "Khoản", "Loại", "Đại lượng", "Giá trị đại lượng", "Thành tiền (đ)", "Diễn giải"].join(","));
    for (const l of lines) {
      if (!l.engine) continue;
      for (const c of [...l.engine.result.components, ...l.engine.result.adjustments]) {
        out.push(
          [
            l.employee.shortName || l.employee.name,
            c.label,
            c.kind,
            c.basisKey ?? "",
            c.basisValue ?? "",
            // Ô TRỐNG khi chưa biết — ghi 0 là để bảng tính sau đó cộng nó như một số đã xác minh.
            c.amount ?? "",
            c.explain.map((st) => `${st.label}${st.value === null ? "" : `: ${st.value}`}${st.note ? ` (${st.note})` : ""}`).join(" · "),
          ]
            .map(csvCell)
            .join(","),
        );
      }
    }
  }

  out.push("");
  out.push(
    [
      `Kỳ: ${period.label}${period.fromKey ? ` (${period.fromKey} → ${period.toKey ?? ""})` : ""}`,
      `Cơ sở lợi nhuận: ${PAYROLL_BASIS_SHORT[basis]} — ${PAYROLL_BASIS_LABEL[basis]}`,
      report.fixedBasis.bounded
        ? `Lương cứng chia theo ${report.fixedBasis.days} ngày của kỳ (khai theo tháng)`
        : "Lương cứng CHƯA BIẾT: kỳ không có mốc đầu/cuối",
      viewAll ? "Phạm vi: toàn bộ nhân sự" : "Phạm vi: chỉ dòng của chính người xuất",
      lines.some((l) => l.carry)
        ? "Sổ lỗ lũy kế: ĐANG ÁP DỤNG. Hoa hồng tính trên lợi nhuận SAU khi bù hết lỗ mang sang; tiền phải trả không âm, cột “HH có dấu” giữ số âm để theo dõi."
        : "Sổ lỗ lũy kế: KHÔNG ÁP DỤNG cho kỳ này (chưa bật, kỳ không phải một tháng lịch, hoặc tháng nằm trước mốc mở sổ).",
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
