import { NextResponse } from "next/server";
import { memoSize } from "@/lib/cache";
import { since, summaries } from "@/lib/perf/registry";
import { requirePermission } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/**
 * SỔ ĐO HIỆU NĂNG TRÊN CHÍNH MÁY CHỦ THẬT.
 *
 * Trả về p50/p95, tỷ lệ trúng đệm và chi phí TÍNH LẠI (khi trượt đệm) của từng báo cáo nặng, gom
 * theo TÊN báo cáo. Mọi báo cáo nặng đều đi qua `memo()` nên chỉ cần đo ở đó là đo được tất cả,
 * không phải rải mã đo khắp nơi.
 *
 * Vì sao cần: số đo trên máy lập trình không thay được số đo trên VPS 2 nhân. Trước đây muốn biết
 * trang nào chậm trên máy thật thì phải đoán; nay `GET /api/perf` trả lời trực tiếp.
 *
 * Dữ liệu chỉ nằm trong RAM của tiến trình (vòng đệm 200 mẫu mỗi báo cáo), mất khi khởi động lại,
 * và KHÔNG chứa thông tin cá nhân: chỉ tên báo cáo, thời gian, trúng/trượt đệm.
 *
 * `?reset=1` xoá sổ để bắt đầu một lượt đo mới.
 */
export async function GET(request: Request) {
  await requirePermission("settings:manage");
  const url = new URL(request.url);
  if (url.searchParams.get("reset") === "1") {
    const { resetPerf } = await import("@/lib/perf/registry");
    resetPerf();
    return NextResponse.json({ ok: true, message: "Đã xoá sổ đo" });
  }
  const rows = summaries();
  return NextResponse.json({
    doTu: new Date(since()).toISOString(),
    soMucDangDem: memoSize(),
    /** Ngân sách hiệu năng — xem docs/erp-performance-p0-report.md */
    nganSachP95Ms: 1000,
    vuotNganSach: rows.filter((r) => r.p95 > 1000).map((r) => r.name),
    baoCao: rows,
  });
}
