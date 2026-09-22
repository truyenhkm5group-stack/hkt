import { notFound } from "next/navigation";
import { TableToolsFor } from "@/components/data-table/table-tools";
import { NavLink } from "@/components/nav-progress";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { GAP_SEVERITY_LABEL, type GapSeverity } from "@/lib/constants/webhook-gap";
import { getVtpImportBatch } from "@/lib/queries/vtp-import-batches";
import { formatDateTime, formatNumber } from "@/lib/format";

export const metadata = { title: "Chi tiết lần nhập tệp VTP" };

/**
 * ═══════════ MỘT LẦN NHẬP, ĐỌC LẠI ĐƯỢC ĐẦY ĐỦ ═══════════
 *
 * Trang này tồn tại cho đúng một tình huống: một con số bị nghi ngờ, và câu hỏi là *"lần nhập nào
 * đã đổi nó, người nào bấm, tệp nào, và lúc đó ERP thấy gì"*.
 *
 * Bốn phán quyết `SAME` · `DUPLICATE_ROW` · `OLDER` · `UNKNOWN_STATUS` in RIÊNG chứ không gộp
 * thành một nhãn "bỏ qua" (luật 49): mỗi cái nói một chuyện khác, và gộp lại thì người đọc không
 * biết tệp có vấn đề hay chính ERP có vấn đề.
 */
export default async function ImportBatchPage({ params }: { params: Promise<{ batchId: string }> }) {
  await requirePermission("cod:write");
  const { batchId } = await params;
  const data = await getVtpImportBatch(batchId);
  if (!data) notFound();
  const { batch: b, summary, gaps, sameFile } = data;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Dữ liệu gốc"
        title={b.filename}
        description={`${b.mode === "APPLY" ? "Đã ghi" : "Chạy thử"} lúc ${formatDateTime(b.createdAt)} · ${b.uploadedBy || "không rõ người bấm"}`}
        hint={<>Danh tính một tệp là <b>checksum của NỘI DUNG</b>, không phải tên: Viettel Post đặt tên tệp theo khoảng ngày nên hai lần tải cùng một khoảng cho ra cùng TÊN với nội dung khác nhau, và cùng nội dung có thể mang hai tên.</>}
      />

      <SectionCard title="Lần nhập này thấy gì" description="Bốn phán quyết không phải lỗi được gọi tên riêng, không gộp thành “bỏ qua”.">
        <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
          <O nhan="Dòng đọc được" so={b.rows} />
          <O nhan="Ghép được vận đơn" so={b.matched} />
          <O nhan="Đã ghi" so={b.applied} />
          <O nhan="Giống ERP / trùng" so={b.duplicates} phu="không phải lỗi" />
          <O nhan="Cũ hơn ERP" so={b.stale} phu="không phải lỗi — chứng từ trong tệp cũ hơn thứ đang lưu" />
          <O nhan="Cần người quyết" so={b.conflicts} phu="cùng mốc ĐVVC nhưng khác chặng" />
          <O nhan="VTP có, ERP chưa có" so={b.unmatched} phu="không phải lỗi" />
          <O nhan="Trạng thái chưa dịch được" so={b.unknownStatus} phu="chữ gốc vẫn vào sổ đăng ký, không bị ném đi" />
          <O nhan="Dòng hỏng" so={b.invalid} />
        </div>
        {b.error ? <p className="mt-3 text-xs text-destructive">{b.error}</p> : null}
      </SectionCard>

      <SectionCard
        title="Đo chất lượng webhook của chính lượt này"
        description="Lý do một lần nhập vẫn đáng chạy kể cả khi nó không đổi một vận đơn nào."
        hint="ERP không thể tự biết mình đang thiếu một gói tin CHƯA TỪNG TỚI. Chỗ hụt chỉ lộ ra khi một nguồn ĐỘC LẬP — tệp này — nói lại cùng một sự việc."
      >
        {b.checked ? (
          <div className="grid gap-2 sm:grid-cols-3">
            <O nhan="Dòng đưa vào phép đo" so={b.checked} />
            <O nhan="ERP đã biết trước" so={b.webhookOk} phu="webhook làm đúng việc" />
            <O nhan="ERP chưa hề biết" so={b.webhookGaps} phu="webhook đã rơi gói tin" />
          </div>
        ) : (
          /* CHƯA ĐO khác hẳn ĐO RỒI VÀ KHÔNG THẤY GÌ. Lần nhập chạy trước khi phép đo tồn tại
             giữ ba con số ở 0, và in nó thành "không có khoảng hụt nào" là bịa một kết luận. */
          <p className="text-sm text-muted-foreground">Lượt này chạy trước khi phép đo tồn tại, hoặc là một lượt chạy thử — <strong>chưa đo</strong>, không phải “không có khoảng hụt nào”.</p>
        )}

        {gaps.length ? (
          <>
            <TableToolsFor tableId="import-vtp-batchid-page" />
            <div className="mt-3 overflow-x-auto rounded-md border">
              <table id="import-vtp-batchid-page" className="w-full text-[12.5px]">
                <thead className="bg-muted/50 text-left text-muted-foreground">
                  <tr>
                    <th className="p-2 font-medium">Mã vận đơn</th>
                    <th className="p-2 font-medium">ĐVVC ghi nhận</th>
                    <th className="p-2 font-medium">ERP đang biết tới</th>
                    <th className="p-2 text-right font-medium">Chậm</th>
                  </tr>
                </thead>
                <tbody>
                  {gaps.map((g) => (
                    <tr key={`${g.trackingCode}-${g.carrierEventAt.toISOString()}`} className="border-t">
                      <td className="numeric p-2">{g.trackingCode}</td>
                      <td className="p-2">
                        “{g.carrierStatusText}”
                        <span className="block text-[11px] text-muted-foreground">{formatDateTime(g.carrierEventAt)}</span>
                      </td>
                      {/* CHƯA BIẾT in ra là “—”, không phải một mốc bịa: ERP chưa hề biết gì về kiện này. */}
                      <td className="p-2">
                        {g.erpKnewAt ? formatDateTime(g.erpKnewAt) : "— chưa biết gì"}
                        {g.erpKnewSource ? <span className="block text-[11px] text-muted-foreground">qua {g.erpKnewSource}</span> : null}
                      </td>
                      <td className="numeric p-2 text-right">
                        {formatNumber(Math.round(g.gapMinutes / 60))} giờ
                        <span className="block text-[11px] text-muted-foreground">{GAP_SEVERITY_LABEL[g.severity as GapSeverity] ?? g.severity}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
      </SectionCard>

      {sameFile.length ? (
        <SectionCard title="Cùng nội dung tệp này" description="Ghép theo checksum nội dung, không theo tên tệp.">
          <ul className="space-y-1 text-[12.5px]">
            {sameFile.map((s) => (
              <li key={s.id}>
                <NavLink href={`/import-vtp/${s.id}`} className="text-primary underline underline-offset-2">
                  {formatDateTime(s.createdAt)}
                </NavLink>{" "}
                <span className="text-muted-foreground">
                  · {s.mode === "APPLY" ? "đã ghi" : "chạy thử"} · {s.uploadedBy || "không rõ người bấm"}
                </span>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      {summary ? (
        <SectionCard title="Bảng kê chi tiết lượt chạy" description="Nguyên văn thứ đường ghi trả về.">
          <pre className="max-h-96 overflow-auto rounded-md border bg-muted/30 p-3 text-[11px]">{JSON.stringify(summary, null, 2)}</pre>
        </SectionCard>
      ) : null}
    </div>
  );
}

function O({ nhan, so, phu }: { nhan: string; so: number; phu?: string }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-[12px] font-medium text-muted-foreground">{nhan}</p>
      <p className="numeric mt-0.5 text-xl font-bold">{formatNumber(so)}</p>
      {phu ? <p className="mt-0.5 text-[11px] text-muted-foreground">{phu}</p> : null}
    </div>
  );
}
