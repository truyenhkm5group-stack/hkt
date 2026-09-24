import { Brain } from "lucide-react";
import { StatStrip } from "@/components/stat-tile";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { getDb } from "@/db";
import { GENE_KEYS, GENE_LABEL, GENE_VALUE_LABEL, GENE_VOCAB, type GeneKey } from "@/lib/constants/creative-loop";
import type { GeneStat } from "@/lib/creative/learn";
import { formatDate, formatDateTime, formatNumber, formatPercent, formatVND, pctOrNull } from "@/lib/format";
import { getLatestLearning, type LearningPoint } from "@/lib/queries/creative-loop";
import { cn } from "@/lib/utils";

/**
 * ═══════════ TAB MÁY ĐÃ HỌC GÌ ═══════════
 *
 * Bảng gen × giá trị từ dòng sổ học mới nhất. Giá trị CHƯA THỬ in "chưa thử" — trung bình hậu nghiệm
 * 0,5 của nó là điểm xuất phát của phép lấy mẫu, không phải một kết quả; in "50%" là nói máy đã biết
 * một điều nó chưa hề đo. ĐỘ PHỦ luôn đứng cạnh: bao nhiêu quan sát, bao nhiêu trong số đó chỉ đứng
 * trên nền TƯƠNG ĐỐI (chưa có luật giữ). Không tô màu, không xếp hạng "gen tốt / gen kém" (mục 44).
 */

type Row = { key: GeneKey; value: string; stat: GeneStat | null };

function buildRows(stats: GeneStat[]): Row[] {
  const byKey = new Map(stats.map((s) => [`${s.key}|${s.value}`, s]));
  const out: Row[] = [];
  for (const key of GENE_KEYS) {
    const rows: Row[] = (GENE_VOCAB[key] as readonly string[]).map((value) => {
      const s = byKey.get(`${key}|${value}`) ?? null;
      return { key, value, stat: s && s.tests > 0 ? s : null };
    });
    // Đã thử trước, theo hậu nghiệm giảm dần; chưa thử cuối, giữ thứ tự từ vựng.
    rows.sort((a, z) => {
      if (a.stat && z.stat) return z.stat.posteriorMean - a.stat.posteriorMean || z.stat.tests - a.stat.tests;
      return a.stat ? -1 : z.stat ? 1 : 0;
    });
    out.push(...rows);
  }
  return out;
}

function Series({ series }: { series: LearningPoint[] }) {
  const max = Math.max(1, ...series.map((p) => p.observations ?? 0));
  return (
    <div className="flex items-end gap-1" role="img" aria-label="Số quan sát 14 ngày gần nhất">
      {series.map((p) => (
        <div key={p.day} className="flex w-9 flex-col items-center gap-0.5" title={`${formatDate(p.day)}: ${p.observations === null ? "không có lượt học" : `${formatNumber(p.observations)} quan sát, ${formatNumber(p.relativeObservations)} theo nền tương đối`}`}>
          <span className="numeric text-[10.5px]">{formatNumber(p.observations)}</span>
          <div className="flex h-10 w-3 items-end rounded-sm bg-muted">
            {p.observations !== null ? <div className="w-full rounded-sm bg-foreground/60" style={{ height: `${Math.max(4, (p.observations / max) * 100)}%` }} /> : null}
          </div>
          <span className="text-[9.5px] text-muted-foreground">{p.day.slice(8, 10)}/{p.day.slice(5, 7)}</span>
        </div>
      ))}
    </div>
  );
}

export async function LearningTab() {
  const db = await getDb();
  const l = await getLatestLearning(db);
  if (!l) {
    return (
      <SectionCard>
        <EmptyState icon={Brain} title="Máy chưa học lượt nào" description="Sổ học được ghi sau khi có mẫu đã NGÃ NGŨ (thắng · hứa hẹn · tắt sớm · loại). Chưa có lô nào chạy xong thì chưa có gì để học." />
      </SectionCard>
    );
  }
  const rows = buildRows(l.geneStats);
  const tuongDoi = pctOrNull(l.relativeObservations, l.observations);

  return (
    <div className="space-y-4">
      <StatStrip
        columns={4}
        items={[
          { label: "Lượt học gần nhất", value: formatDate(l.learningDay), note: `cập nhật ${formatDateTime(l.updatedAt)}` },
          { label: "Quan sát", value: formatNumber(l.observations), note: "mẫu đã ngã ngũ đưa vào thống kê" },
          {
            label: "Đứng trên nền tương đối",
            value: formatNumber(l.relativeObservations),
            note: tuongDoi === null ? "—" : `${formatPercent(tuongDoi, 0)} số quan sát`,
            hint: "Quan sát mà thành công / thất bại chỉ so với TRUNG VỊ chi/đơn của các mẫu khác, vì chưa có luật giữ. Đây là căn cứ yếu hơn luật — khai luật giữ ở tab Cấu hình để máy học trên căn cứ thật.",
            tone: l.relativeObservations > 0 ? "amber" : "default",
          },
          { label: "Phiên bản", value: `luật v${l.ruleVersion} · gen v${l.genesVersion}`, note: "đổi phiên bản gen ⇒ thống kê không gộp với bản cũ" },
        ]}
      />

      <SectionCard title="Số quan sát 14 ngày" description="Ngày không có lượt học in “—”, không phải 0.">
        <div className="overflow-x-auto">
          <Series series={l.series} />
        </div>
      </SectionCard>

      {l.narrative ? (
        <SectionCard title="Bản tin" description="AI diễn đạt lại bảng dưới — không phải quyết định." hint={`Mô hình ${l.narrativeModel || "—"} viết lại bảng số thành lời. Chọn gen cho lô ngày mai là hàm thuần (lấy mẫu Thompson trên chính bảng này), không đọc bản tin.`}>
          <p className="whitespace-pre-line text-[13px] leading-relaxed">{l.narrative}</p>
        </SectionCard>
      ) : null}

      <SectionCard
        title="Gen × giá trị"
        description="Sắp theo gen, rồi theo trung bình hậu nghiệm. Giá trị chưa thử in “chưa thử”."
        hint="Thành công = THẮNG / HỨA HẸN theo luật (hoặc chi/đơn không tệ hơn trung vị khi chưa có luật giữ). Trung bình hậu nghiệm = (1 + thành công) / (2 + số thử) — số thử ít thì con số này còn gần 50% vì máy CHƯA BIẾT, không phải vì gen trung bình. Cột “tương đối” đếm quan sát đứng trên nền trung vị."
        padded={false}
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-[12.5px]">
            <thead className="border-b bg-muted/40 text-left text-[11.5px] text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Gen</th>
                <th className="px-3 py-2 font-medium">Giá trị</th>
                <th className="px-3 py-2 text-right font-medium">Số thử</th>
                <th className="px-3 py-2 text-right font-medium">Thành công</th>
                <th className="px-3 py-2 text-right font-medium">Thắng</th>
                <th className="px-3 py-2 text-right font-medium">TB hậu nghiệm</th>
                <th className="px-3 py-2 text-right font-medium">Chi</th>
                <th className="px-3 py-2 text-right font-medium">Đơn chốt</th>
                <th className="px-4 py-2 text-right font-medium">Tương đối</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const dauNhom = i === 0 || rows[i - 1].key !== r.key;
                const s = r.stat;
                return (
                  <tr key={`${r.key}|${r.value}`} className={cn("border-hairline", dauNhom ? "border-t" : "", !s && "text-muted-foreground")}>
                    <td className="px-4 py-1.5 font-medium">{dauNhom ? GENE_LABEL[r.key] : ""}</td>
                    <td className="px-3 py-1.5">{GENE_VALUE_LABEL[r.value] ?? r.value}</td>
                    {s ? (
                      <>
                        <td className="numeric px-3 py-1.5 text-right">{formatNumber(s.tests)}</td>
                        <td className="numeric px-3 py-1.5 text-right">{formatNumber(s.successes)}</td>
                        <td className="numeric px-3 py-1.5 text-right">{formatNumber(s.wins)}</td>
                        <td className="numeric px-3 py-1.5 text-right">{formatPercent(s.posteriorMean * 100, 0)}</td>
                        <td className="numeric px-3 py-1.5 text-right">{formatVND(s.spendVnd)}</td>
                        <td className="numeric px-3 py-1.5 text-right">{formatNumber(s.bookedOrders)}</td>
                        <td className="numeric px-4 py-1.5 text-right">{formatNumber(s.relativeCount)}</td>
                      </>
                    ) : (
                      <td colSpan={7} className="px-3 py-1.5 text-right italic">
                        chưa thử
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  );
}
