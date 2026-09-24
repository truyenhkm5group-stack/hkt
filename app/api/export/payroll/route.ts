import type { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { canOpenPayroll, canSeeAllPayroll, payrollLineVisible, resolvePayrollScope } from "@/lib/auth/payroll-scope";
import { PAYROLL_BASIS_LABEL, PAYROLL_BASIS_SHORT, parsePayrollBasis } from "@/lib/constants/payroll";
import { employeeMatchesUser, getPayrollReport, type PayrollLine } from "@/lib/queries/payroll";
import { getPayrollPeriodState, type PayrollSnapshot } from "@/lib/queries/payroll-period";
import { PAYROLL_RUN_STATUS_LABEL } from "@/lib/constants/payroll-lifecycle";
import { param, resolvePeriod, type SearchParams } from "@/lib/search-params";

export const dynamic = "force-dynamic";

function csvCell(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * ═══════ XUẤT CSV ĐÚNG BẢNG LƯƠNG ĐANG XEM ═══════
 *
 * ─── KỲ ĐÃ ĐÓNG BĂNG THÌ ĐỌC ẢNH CHỤP, KHÔNG TÍNH LẠI ───
 *
 * Đây là điều quan trọng nhất ở tệp này, và bản trước làm sai: nó luôn xuất bản tính SỐNG. Phiếu
 * lương và bảng trên màn hình của một kỳ `LOCKED` / `PAID` đọc ảnh chụp, nên tệp CSV — thứ người
 * ta thật sự cầm đi chuyển khoản — lại là nơi DUY NHẤT in ra một con số khác con số đã duyệt.
 * Giá vốn đổi, một đơn hoàn về muộn, một tỷ lệ được sửa: bất kỳ thứ nào cũng đủ làm lệch, và
 * không có gì trên tệp nói cho người đọc biết là nó đã lệch (AGENTS.md mục 21).
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
/**
 * ═══ DÒNG XUẤT DỰNG TỪ ẢNH CHỤP ═══
 *
 * DANH TÍNH lấy từ bản SỐNG, TIỀN lấy từ ẢNH CHỤP. Hai chiều khác nhau và cả hai đều cần thiết:
 *
 *  · Tiền phải là tiền đã duyệt — đó là toàn bộ lý do có ảnh chụp.
 *  · Danh tính phải là danh tính HÔM NAY, vì bộ lọc "chỉ xem lương của mình" so khớp bằng KHOÁ TÀI
 *    KHOẢN (`employeeMatchesUser`), và ảnh chụp KHÔNG giữ khoá ấy. Dựng dòng chỉ từ ảnh chụp thì
 *    người có quyền "xem của mình" tải về một tệp RỖNG — trông y hệt "kỳ này bạn không có lương".
 *
 * Người đã bị xoá khỏi hồ sơ sau khi kỳ khoá vẫn được in cho người xem toàn bộ (tiền ấy đã trả
 * thật), nhưng mang một danh tính KHÔNG khớp được với tài khoản nào — nên bộ lọc "của mình" bỏ
 * qua họ, đúng phía an toàn.
 */
function snapshotRows(snapshot: PayrollSnapshot, live: readonly PayrollLine[]) {
  const theoId = new Map(live.map((l) => [l.employee.id, l]));
  return snapshot.lines.map((s) => {
    const hienTai = theoId.get(s.employeeId);
    const employee = hienTai
      ? { ...hienTai.employee, percentTotal: s.percentTotal, percentPersonal: s.percentPersonal, percentRevenue: s.percentRevenue }
      : {
          id: s.employeeId,
          name: s.name,
          shortName: s.shortName,
          department: s.department,
          percentTotal: s.percentTotal,
          percentPersonal: s.percentPersonal,
          percentRevenue: s.percentRevenue,
          aliases: [],
          accountIds: [],
          // Không khớp được tài khoản nào: bộ lọc "của mình" sẽ bỏ qua dòng này.
          userEmail: "",
          fixed: s.fixedMonthly,
          active: false,
          note: "",
        };
    return {
      employee,
      fixedMonthly: s.fixedMonthly,
      fixed: s.fixed,
      totalProfit: s.totalProfit,
      personalProfit: s.personalProfit,
      personalRevenue: s.personalRevenue,
      bonusTotal: s.bonusTotal,
      bonusPersonal: s.bonusPersonal,
      bonusRevenue: s.bonusRevenue,
      salary: s.salary,
      // Ảnh chụp đời cũ (`undefined`) chưa gồm điều chỉnh trong `salary` — ô để TRỐNG, không tự tính lại.
      legacyAdjustments: s.legacyAdjustments ?? null,
      /*
        `undefined` = ảnh chụp dựng TRƯỚC khi ảnh chụp giữ sổ lỗ. Bảy cột ấy để TRỐNG và cột Ghi
        chú nói vì sao — KHÔNG đi tính lại chúng bằng dữ liệu hôm nay, vì tính lại một kỳ đã trả
        tiền chính là thứ ảnh chụp sinh ra để ngăn.
      */
      carry: s.carry
        ? { ...s.carry, openingEstablished: true, openingBasis: "SNAPSHOT" as const }
        : s.carry === null
          ? null
          : undefined,
      carryMissing: s.carry === undefined,
      engine: s.engine
        ? {
            segments: s.engine.segments.map((sg) => ({
              policyId: sg.policyCode ? sg.policyCode : null,
              policyCode: sg.policyCode,
              policyName: sg.policyCode,
              policyVersion: sg.policyVersion,
            })),
            splitAcrossSegments: s.engine.segments.filter((sg) => sg.working).length > 1,
            result: {
              components: s.engine.components,
              adjustments: s.engine.adjustments.map((a) => ({ ...a, basisKey: null as string | null, basisValue: null as number | null })),
              grossEarnings: s.engine.grossEarnings,
              totalDeductions: s.engine.totalDeductions,
              netPay: s.engine.netPay,
              /* Ảnh chụp không giữ hai danh sách này: chúng là trạng thái của LÚC TÍNH, và kỳ đã
                 khoá thì không còn việc gì để đi làm nốt. */
              missing: [] as { label: string; message: string }[],
              problems: [] as string[],
            },
          }
        : null,
    };
  });
}

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return new Response("Chưa đăng nhập", { status: 401 });
  /*
    CỔNG XUẤT TỆP DÙNG ĐÚNG MỘT MÁY TÍNH PHẠM VI VỚI MÀN HÌNH. Đây là chỗ dễ lệch nhất: ẩn một cái
    nút trên giao diện không chặn được ai gõ thẳng địa chỉ này, và tệp CSV thì mang đi được.
  */
  const scope = resolvePayrollScope(user);
  if (!canOpenPayroll(scope)) return new Response("Không có quyền xuất bảng lương", { status: 403 });
  const viewAll = canSeeAllPayroll(scope);

  const raw = Object.fromEntries(request.nextUrl.searchParams.entries()) as SearchParams;
  const period = resolvePeriod(raw, "month");
  const basis = parsePayrollBasis(param(raw, "basis"));
  const [report, state] = await Promise.all([getPayrollReport(period, basis), getPayrollPeriodState(period, basis)]);

  /*
    MỘT NGUỒN CHO CẢ TỆP: ảnh chụp nếu kỳ đã đóng băng, bản tính sống nếu chưa.

    Chọn MỘT LẦN ở đây rồi đưa xuống cùng một vòng lặp, thay vì hai nhánh in hai kiểu — hai nhánh
    in là hai nơi sẽ lệch nhau, đúng cái lỗi mà tệp này vừa sửa.
  */
  const dongBang = state.frozen && state.snapshot !== null;
  const nguon = dongBang && state.snapshot ? snapshotRows(state.snapshot, report.lines) : report.lines;
  const lines = nguon.filter((l) => payrollLineVisible(scope, l.employee, user, employeeMatchesUser));

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
    // Điều chỉnh của đường tính cũ (thưởng, tạm ứng, khấu trừ, quyết toán kỳ trước) — ĐÃ nằm trong
    // "Tổng lương". Người đi máy chung để trống: điều chỉnh của họ nằm trong bốn cột máy chung.
    "Điều chỉnh (đ)",
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
    if ("carryMissing" in l && l.carryMissing) {
      ghiChu.push("Bảy cột sổ lỗ để TRỐNG: ảnh chụp của kỳ này dựng trước khi ảnh chụp giữ sổ lỗ. Tính lại chúng bằng dữ liệu hôm nay sẽ ra một con số khác con số đã trả, nên không tính.");
    }
    for (const a of l.legacyAdjustments?.items ?? []) ghiChu.push(`${a.label}: ${a.amount.toLocaleString("vi-VN")} đ — ${a.reason}`);
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
        l.legacyAdjustments ? l.legacyAdjustments.total : "",
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
      dongBang
        ? `Nguồn số: ẢNH CHỤP lúc ${state.lockedAt ? state.lockedAt.toISOString() : "khoá kỳ"} (${PAYROLL_RUN_STATUS_LABEL[state.status === "NONE" ? "LOCKED" : state.status]}). Kỳ đã đóng băng không tính lại — đây đúng là con số đã duyệt để trả.`
        : "Nguồn số: BẢN TÍNH SỐNG. Kỳ chưa đóng băng nên con số còn đổi theo dữ liệu nguồn.",
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
