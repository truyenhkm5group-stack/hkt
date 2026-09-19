import { CircleAlert, CircleCheck, TriangleAlert } from "lucide-react";
import { SectionCard } from "@/components/ui-bits";
import { MARKETING_DIAGNOSIS } from "@/lib/constants/marketing-diagnosis";
import { baselineOf, diagnose, lossStreakOf, sortFindings, type DiagnoseSnapshot } from "@/lib/marketing/diagnose";
import type { MarketingDaily, MarketingDailyBase } from "@/lib/queries/marketing-daily";

/**
 * ───────────── MÁY PHÂN TÍCH: VẤN ĐỀ + VIỆC PHẢI LÀM ─────────────
 *
 * Khối này KHÔNG gọi thêm truy vấn nào: nó chạy hàm thuần `diagnose()` trên chính dữ liệu bảng vừa
 * đọc. Nhờ vậy con số trong phần chẩn đoán không bao giờ khác con số trong bảng ngay phía trên —
 * chạy một truy vấn thứ hai là mở đường cho hai con số nói về cùng một ngày.
 *
 * Nền so sánh lấy từ CHÍNH những ngày đang hiển thị, trừ ngày cuối. Đó cũng là lý do bảng phải có
 * ít nhất vài ngày trước khi phần này nói gì: một nền dựng trên hai ngày vẫn cho ra kết luận, chỉ
 * là kết luận sai.
 */

function toSnapshot(b: MarketingDailyBase): DiagnoseSnapshot {
  return {
    adSpend: b.adSpend,
    messages: b.messages,
    orders: b.orders,
    posRevenue: b.posRevenue,
    deliveredRevenue: b.deliveredRevenue,
    deliveredOrders: b.deliveredOrders,
    returnedOrders: b.returnedOrders,
    finishedOrders: b.finishedOrders,
    pendingOrders: b.pendingOrders,
    contributionProfit: b.contributionProfit,
  };
}

export function MarketingFindings({ data }: { data: MarketingDaily }) {
  const rows = data.rows;
  const last = rows.at(-1);
  if (!last) return null;

  const baselineRows = rows.slice(Math.max(0, rows.length - 1 - MARKETING_DIAGNOSIS.baselineDays), rows.length - 1);
  const baseline = baselineOf(baselineRows.map(toSnapshot), 3);
  const findings = sortFindings(
    diagnose({
      day: last.day,
      current: toSnapshot(last),
      baseline,
      lossStreak: lossStreakOf(rows),
      staleSources: data.freshness.filter((f) => f.stale).map((f) => f.label),
    }),
  );

  return (
    <SectionCard
      title={`Chẩn đoán ngày ${last.day}`}
      description={baseline ? `So với trung bình ${baselineRows.length} ngày liền trước` : "Chưa đủ ngày để dựng nền so sánh — chỉ hiện những phát hiện không cần nền"}
      hint="Mỗi phát hiện là một TỔ HỢP chỉ số, không phải một chỉ số riêng lẻ: 'CPA tăng' một mình không nói được phải sửa ở khâu quảng cáo hay khâu chốt đơn. Ngưỡng lên tiếng nằm ở lib/constants/marketing-diagnosis.ts và không đụng tới một công thức tiền nào."
    >
      {findings.length === 0 ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <CircleCheck className="size-4 text-emerald-600 dark:text-emerald-400" />
          Không có bất thường nào vượt ngưỡng. {baseline ? "" : "(Chưa đủ nền so sánh — phần lớn quy tắc chưa chạy được.)"}
        </div>
      ) : (
        <ul className="space-y-3">
          {findings.map((f) => (
            <li key={`${f.kind}:${f.scope}`} className="rounded-lg border p-3">
              <div className="flex items-start gap-2">
                {f.severity === "CRITICAL" ? <CircleAlert className="mt-0.5 size-4 shrink-0 text-rose-600 dark:text-rose-400" /> : <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />}
                <div className="min-w-0 space-y-1.5">
                  <p className="text-sm font-medium">{f.title}</p>
                  {/* BẰNG CHỨNG TRƯỚC, VIỆC PHẢI LÀM SAU: một khuyến nghị không kèm số của chính nó thì không kiểm chứng được. */}
                  <ul className="space-y-0.5 text-xs text-muted-foreground">
                    {f.evidence.map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                  </ul>
                  <ul className="space-y-0.5 text-xs">
                    {f.actions.map((a) => (
                      <li key={a}>→ {a}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
