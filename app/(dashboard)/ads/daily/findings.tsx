import { CircleAlert, CircleCheck, Target, TriangleAlert } from "lucide-react";
import { SectionCard } from "@/components/ui-bits";
import { InfoHint } from "@/components/info-hint";
import { DataWarnings } from "@/components/data-warnings";
import { MARKETING_DIAGNOSIS } from "@/lib/constants/marketing-diagnosis";
import { CELL_STATUS_LABEL } from "@/lib/metrics/scorecard";
import { TARGET_SCOPE_LABEL } from "@/lib/constants/metric-registry";
import { baselineOf, diagnose, lossStreakOf, sortFindings, type DiagnoseSnapshot } from "@/lib/marketing/diagnose";
import { evaluateMarketingTargets } from "@/lib/queries/marketing-targets";
import { DEPARTMENT_LABEL } from "@/lib/constants/departments";
import { MISSING_TEXT } from "@/lib/format";
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

export async function MarketingFindings({ data }: { data: MarketingDaily }) {
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

  /*
    ĐÍCH ĐƯỢC PHÉP KHÔNG CÓ GÌ: chưa ai đặt đích ⇒ khối đích không hiện (không có ngưỡng mặc
    định — AGENTS.md mục 38).
  */
  const targets = await evaluateMarketingTargets(data.totals, data.period, data.previousTotals, data.filters);

  return (
    <SectionCard
      title={`Chẩn đoán ngày ${last.day}`}
      description={baseline ? `So với trung bình ${baselineRows.length} ngày liền trước` : "Chưa đủ ngày để dựng nền so sánh"}
      hint={
        <>
          {baseline ? null : <p className="mb-2">Chưa đủ ngày để dựng nền so sánh — chỉ hiện những phát hiện không cần nền.</p>}
          <p>
            Mỗi phát hiện là một TỔ HỢP chỉ số, không phải một chỉ số riêng lẻ: &lsquo;CPA tăng&rsquo; một mình không nói được phải sửa ở khâu quảng cáo
            hay khâu chốt đơn. Ngưỡng lên tiếng nằm ở lib/constants/marketing-diagnosis.ts và không đụng tới một công thức tiền nào.
          </p>
        </>
      }
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
                  <p className="text-sm font-medium">
                    {f.title}
                    {/* Ở ĐÂU: một phát hiện không nói phạm vi thì người đọc phải tự đoán nó nói về cả shop hay về một chiến dịch. */}
                    <span className="ml-1.5 font-normal text-muted-foreground">· {f.scopeLabel}</span>
                  </p>
                  {/* BẰNG CHỨNG TRƯỚC, VIỆC PHẢI LÀM SAU: một khuyến nghị không kèm số của chính nó thì không kiểm chứng được. */}
                  <ul className="space-y-0.5 text-xs text-muted-foreground">
                    {f.evidence.map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                  </ul>
                  {/*
                    GIẢ THUYẾT ĐỨNG RIÊNG, VÀ NÓI RÕ NÓ LÀ GIẢ THUYẾT. Trộn nó vào danh sách bằng
                    chứng là mời người đọc hành động với một phỏng đoán như thể nó đã được đo.
                  */}
                  <p className="text-xs italic text-muted-foreground">Nguyên nhân có khả năng nhất: {f.why}</p>
                  <ul className="space-y-0.5 text-xs">
                    {f.actions.map((a) => (
                      <li key={a}>→ {a}</li>
                    ))}
                  </ul>
                  {/* AI LÀM: phòng ban, không bao giờ một cái tên — máy không biết hôm nay ai nghỉ. */}
                  <p className="text-[11px] text-muted-foreground">Phòng xử lý: {DEPARTMENT_LABEL[f.owner]}</p>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {targets.cells.length ? (
        <div className="mt-4 border-t pt-3">
          <div className="mb-2 flex flex-wrap items-center gap-1.5 text-xs font-medium">
            <Target className="size-3.5" /> So với đích đã đặt
            {/* Vì sao tầng hẹp KHÔNG áp được — vẫn nói ra (nhãn ⚠), vì im lặng ở đây làm chủ shop tin là đích cá nhân đang chạy. */}
            <DataWarnings items={targets.notes.map((n) => n.text)} />
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {targets.cells.map((t) => (
              <div key={t.cellKey} className="rounded-lg border p-2 text-xs">
                <p className="text-muted-foreground">{t.label}</p>
                <p className="font-medium">
                  {t.cell.value === null ? MISSING_TEXT : t.cell.value}
                  {t.cell.target ? <span className="text-muted-foreground"> / đích {t.cell.target.target}</span> : null}
                </p>
                {/* canConclude = false ⇒ hiện thực tế, KHÔNG tô màu, KHÔNG gắn nhãn đạt/không đạt. */}
                <p className="text-muted-foreground">{t.cell.canConclude ? CELL_STATUS_LABEL[t.status] : (t.cell.reason ?? "Chưa kết luận được")}</p>
                {/*
                  TẦNG NÀO ĐANG ÁP — không phải chi tiết cho vui. Đích tầng hẹp đè tầng rộng, nên
                  hai người nhìn cùng một ô với hai bộ lọc khác nhau có thể thấy hai đích khác
                  nhau; không in tầng ra thì đó trông như một con số nhảy lung tung.
                */}
                {t.cell.target ? (
                  <p className="text-[11px] text-muted-foreground">
                    Đích tầng {TARGET_SCOPE_LABEL[t.cell.target.scope]}
                    {t.cell.target.criticalAt !== null ? ` · ngưỡng đỏ ${t.cell.target.criticalAt}` : ""}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p className="mt-4 flex items-center gap-1.5 border-t pt-3 text-xs text-muted-foreground">
          <Target className="size-3.5" /> Chưa đặt đích
          <InfoHint>
            Chưa ai đặt đích cho CPQC/đơn, ROAS, tỷ lệ chốt, margin, tỷ lệ giao thành công hay tỷ lệ hoàn. ERP cố ý KHÔNG tự nghĩ ra một ngưỡng — đặt đích
            ở màn hình Mục tiêu (năm tầng: công ty → phòng ban → chức danh → người → mã hàng, tầng hẹp đè tầng rộng), rồi mỗi ô ở đây sẽ tự chấm theo đích
            đó. ROAS hoà vốn khai ở ô &ldquo;ngưỡng đỏ&rdquo; của chính chỉ số ROAS, không phải một chỉ số thứ hai.
          </InfoHint>
        </p>
      )}

      {/*
        KHÔNG CÒN ĐOẠN "DIỄN GIẢI" BẰNG AI Ở ĐÂY (chủ shop chốt 24/09/2026, rà mọi trang ERP).

        Nó chỉ VIẾT LẠI THÀNH VĂN đúng những gì khối này vừa in: lời nhắc hệ thống cấm mô hình tự
        tính số và bắt nó dùng lại nguyên văn `why` / `owner` của từng phát hiện — mà bằng chứng,
        nguyên nhân, việc phải làm và phòng xử lý đều đã có ngay phía trên, từ hàm thuần
        `diagnose()`. Đổi lại nó gọi mô hình bậc `analysis` (đắt nhất) ngoài trần chi tiêu AI hằng
        ngày và ngoài nhật ký `ai_interactions`, bị gọi lại mỗi lần tổng số đổi hay đồng bộ chạy, giữ
        trang 10–15 giây, và mô tả sai phạm vi ("Toàn shop") khi đang lọc theo một chiều.
        Ai cần hỏi thêm về số liệu thì trợ lý AI (Copilot) ở góc trên vẫn mở được từ trang này.
      */}
    </SectionCard>
  );
}
