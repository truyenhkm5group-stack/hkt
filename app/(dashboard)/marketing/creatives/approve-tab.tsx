import Link from "next/link";
import { CalendarClock, History, ShieldAlert } from "lucide-react";
import { ApproveBatchButton, RejectBatchButton, RejectVariantButton } from "@/app/(dashboard)/marketing/creatives/batch-actions";
import { Countdown, ExpandText } from "@/app/(dashboard)/marketing/creatives/creative-bits";
import { GeneChips, ModeChip, VariantImage } from "@/app/(dashboard)/marketing/creatives/variant-bits";
import { StatStrip } from "@/components/stat-tile";
import { DescriptionList, EmptyState, SectionCard } from "@/components/ui-bits";
import { getDb } from "@/db";
import {
  BATCH_STATUS_LABEL,
  CREATIVE_VERDICT_LABEL,
  CREATIVE_WRITE_ACTION_LABEL,
  VARIANT_STATUSES,
  VARIANT_STATUS_LABEL,
  type BatchStatus,
  type CreativeWriteAction,
  type VariantStatus,
} from "@/lib/constants/creative-loop";
import { describeRule } from "@/lib/creative/judge";
import { formatDate, formatDateTime, formatNumber, formatVND, vnShortStamp } from "@/lib/format";
import { getBatchDetail, listRecentBatches, readCurrentCreativeConfig, type BatchDetail, type BatchSummary, type PendingBatch, type VariantCard } from "@/lib/queries/creative-loop";
import { cn } from "@/lib/utils";

/**
 * ═══════════ TAB DUYỆT LÔ ═══════════
 *
 * Người duyệt phải trả lời được bốn câu TRƯỚC khi bấm: chạy lúc nào · tốn bao nhiêu · máy được tự làm
 * gì (luật tắt) · có gì chặn không. Và sau đó, ở phần lịch sử: máy đã ĐỊNH làm gì và cái gì chặn nó
 * (sổ `creative_fb_actions`, kể cả lượt bị chặn).
 */

const BATCH_TONE: Partial<Record<BatchStatus, string>> = {
  PENDING_APPROVAL: "bg-brand/10 text-brand",
  PUBLISHED: "bg-success/15 text-success",
  EXPIRED: "bg-muted text-muted-foreground",
  REJECTED: "bg-muted text-muted-foreground",
  FAILED: "bg-destructive/10 text-destructive",
};

const FB_WRITE_LABEL: Record<string, string> = { APPLIED: "Đã áp", DENIED: "Bị chặn", FAILED: "Hỏng" };
const FB_WRITE_TONE: Record<string, string> = { APPLIED: "text-success", DENIED: "text-warning", FAILED: "text-destructive" };

/** Mẫu có thể GẠT: còn trong lô chờ duyệt và chưa đăng. */
const REJECTABLE: VariantStatus[] = ["GENERATED", "PLANNED", "GEN_FAILED"];

function BatchStatusChip({ status }: { status: BatchStatus }) {
  return <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-semibold", BATCH_TONE[status] ?? "bg-muted text-foreground")}>{BATCH_STATUS_LABEL[status] ?? status}</span>;
}

function CountChips({ counts }: { counts: Partial<Record<VariantStatus, number>> }) {
  const keys = VARIANT_STATUSES.filter((s) => (counts[s] ?? 0) > 0);
  if (!keys.length) return <span className="text-muted-foreground">Chưa có mẫu</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {keys.map((s) => (
        <span key={s} className="rounded bg-muted px-1.5 py-0.5 text-[10.5px]">
          {VARIANT_STATUS_LABEL[s]} <b className="numeric">{formatNumber(counts[s] ?? 0)}</b>
        </span>
      ))}
    </div>
  );
}

function VariantTile({ v, reserve, canReject }: { v: VariantCard; reserve: boolean; canReject: boolean }) {
  const loai = v.status === "REJECTED" || v.status === "GEN_FAILED";
  return (
    <div className={cn("flex flex-col overflow-hidden rounded-xl border bg-card shadow-xs", loai && "opacity-60")}>
      <div className="relative">
        <VariantImage imageId={v.imageId} available={v.imageAvailable} alt={v.headline || `Mẫu #${v.slot}`} className="aspect-square w-full" />
        <span className="absolute left-2 top-2 rounded bg-background/90 px-1.5 py-0.5 text-[11px] font-bold">#{v.slot}</span>
        <span className="absolute right-2 top-2">
          <ModeChip mode={v.mode} why={v.why} />
        </span>
        {reserve ? (
          <span className="absolute bottom-2 left-2 right-2 rounded bg-background/90 px-1.5 py-0.5 text-center text-[10.5px]" title="Lô đăng tối đa số mẫu của cấu hình, theo thứ tự ô — gạt bớt để tự chọn">
            Dự phòng — ngoài số mẫu sẽ chạy
          </span>
        ) : null}
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-3">
        <p className="line-clamp-2 text-[13px] font-semibold leading-snug">{v.headline || <span className="font-normal italic text-muted-foreground">Chưa có tiêu đề</span>}</p>
        <ExpandText text={v.primaryText} />
        <p className="line-clamp-1 text-[11.5px] text-muted-foreground" title={v.productId ?? undefined}>
          Mã hàng: <span className="text-foreground">{v.productName ?? v.productId ?? "—"}</span>
        </p>
        <GeneChips genes={v.genes} mutated={v.mode === "EXPLOIT" ? v.mutatedGene : undefined} />
        {v.why ? <p className="line-clamp-2 text-[11px] text-muted-foreground" title={v.why}>Vì sao: {v.why}</p> : null}
        {v.status === "GEN_FAILED" ? <p className="text-[11.5px] text-destructive">Sinh lỗi: {v.genError || "không rõ lý do"}</p> : null}
        {v.status === "REJECTED" ? <p className="text-[11.5px] text-muted-foreground">Đã gạt{v.rejectReason ? `: ${v.rejectReason}` : ""}</p> : null}
        <div className="mt-auto flex items-center justify-between gap-2 border-t pt-1.5">
          <span className="text-[11px] text-muted-foreground">{VARIANT_STATUS_LABEL[v.status]}</span>
          {canReject && REJECTABLE.includes(v.status) ? <RejectVariantButton variantId={v.id} slot={v.slot} /> : null}
        </div>
      </div>
    </div>
  );
}

function PendingBlock({ pending, now, canApprove, canEdit }: { pending: PendingBatch; now: Date; canApprove: boolean; canEdit: boolean }) {
  const { batch: b, variants, config, configProblems } = pending;
  const coAnh = variants.filter((v) => v.status === "GENERATED");
  const tran = config.batchSize;
  const seChay = Math.min(coAnh.length, tran);
  const reserveIds = new Set([...coAnh].sort((a, z) => a.slot - z.slot).slice(tran).map((v) => v.id));
  const quaHan = now.getTime() >= new Date(b.approvalDeadline).getTime();
  const choDuyet = b.status === "PENDING_APPROVAL";
  const lyDoKhoa = !canApprove
    ? "Cần quyền “Chi phí: ghi” để duyệt lô."
    : !choDuyet
      ? "Lô đang dựng (viết câu chữ / sinh ảnh) — chưa duyệt được."
      : quaHan
        ? `Đã quá hạn duyệt lúc ${vnShortStamp(b.approvalDeadline)} — lô này sẽ không chạy, không đồng nào được chi.`
        : coAnh.length === 0
          ? "Lô chưa có mẫu nào có ảnh."
          : null;
  const lyDoKhoaTuChoi = !canApprove ? "Cần quyền “Chi phí: ghi”." : !choDuyet ? "Chỉ từ chối được lô đang chờ duyệt." : null;
  const gat = (b.variantCounts.REJECTED ?? 0) + (b.variantCounts.GEN_FAILED ?? 0);

  return (
    <SectionCard
      title={
        <span className="flex flex-wrap items-center gap-2">
          Lô chạy ngày {formatDate(b.batchDay)} <BatchStatusChip status={b.status} />
        </span>
      }
      description={`Dựng lúc ${formatDateTime(b.createdAt)} · ${formatNumber(variants.length)} ô.`}
      hint={
        <>
          Duyệt MỘT lần cho cả lô. Phiếu duyệt khoá đúng ảnh, câu chữ, ngân sách, khung giờ và luật tắt bạn đang thấy: ai đó gạt thêm một mẫu sau khi bạn mở hộp xác nhận
          thì phiếu vô hiệu và bạn phải mở lại. Quá hạn duyệt ⇒ lô “Quá hạn”, không một đồng nào được chi. Duyệt không gọi Facebook — lượt chạy kế tiếp của vòng mới
          đăng, và nó kiểm lại phiếu một lần nữa.
        </>
      }
      actions={
        <>
          <RejectBatchButton batchId={b.id} disabledReason={lyDoKhoaTuChoi} />
          <ApproveBatchButton batchId={b.id} disabledReason={lyDoKhoa} />
        </>
      }
    >
      <div className="space-y-4">
        <StatStrip
          columns={5}
          items={[
            { label: "Giờ chạy", value: `${vnShortStamp(b.startAt)}`, note: `tới ${vnShortStamp(b.endAt)}`, icon: CalendarClock },
            {
              label: "Hạn duyệt",
              value: vnShortStamp(b.approvalDeadline),
              note: <Countdown deadline={b.approvalDeadline} serverNow={now.toISOString()} />,
              tone: quaHan ? "rose" : "default",
            },
            { label: "Mẫu có ảnh", value: `${formatNumber(coAnh.length)} / ${formatNumber(variants.length)}`, note: gat ? `${formatNumber(gat)} bị gạt / sinh lỗi` : "chưa gạt mẫu nào" },
            {
              label: "Sẽ chạy",
              value: formatNumber(seChay),
              note: `trần ${formatNumber(tran)} mẫu / lô`,
              hint: "Máy đăng theo thứ tự ô, tối đa số mẫu của cấu hình. Mẫu dư là dự phòng — gạt bớt để tự chọn mẫu nào chạy.",
            },
            {
              label: "Tổng tiền cam kết nếu duyệt",
              value: formatVND(pending.committedIfApprovedVnd),
              note: `${formatNumber(seChay)} × ${formatVND(config.budgetPerVariantVnd)}`,
              hint: "Ngân sách TRỌN ĐỜI trên Facebook, kèm end_time — ERP có chết giữa chừng cũng không tiêu quá số này. Con số chính xác lúc duyệt hiện trong hộp xác nhận.",
            },
          ]}
        />

        <div className="grid gap-3 lg:grid-cols-2">
          <div className="rounded-lg border px-3 py-2 text-[12.5px]">
            <p className="font-semibold">Luật tắt đi kèm lô</p>
            {config.killRules.length ? (
              <>
                <p className="text-muted-foreground">Duyệt = cho phép máy tắt mẫu theo các luật này, không cần hỏi lại.</p>
                <ul className="mt-1 list-disc pl-5">
                  {config.killRules.map((r, i) => (
                    <li key={i}>{describeRule(r)}</li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="text-warning">Lô này không có luật tắt — mỗi mẫu sẽ chạy hết ngân sách.</p>
            )}
          </div>
          {configProblems.length ? (
            <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-[12.5px] text-destructive">
              <p className="flex items-center gap-1.5 font-semibold">
                <ShieldAlert className="size-4" /> Duyệt cũng không đăng được
              </p>
              <ul className="mt-1 list-disc pl-5">
                {configProblems.map((p) => (
                  <li key={p.message}>{p.message}</li>
                ))}
              </ul>
              <Link href="/marketing/creatives?tab=cau-hinh" className="mt-1 inline-block underline underline-offset-2">
                Sửa cấu hình
              </Link>
            </div>
          ) : (
            <div className="rounded-lg border px-3 py-2 text-[12.5px] text-muted-foreground">
              Cấu hình chụp lúc lập lô đủ bốn trường đăng (fanpage · tài khoản · chiến dịch test · mẩu mẫu). Chốt cứng máy chủ và phiếu được kiểm lại trong hộp xác nhận.
            </div>
          )}
        </div>

        {variants.length ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {variants.map((v) => (
              <VariantTile key={v.id} v={v} reserve={reserveIds.has(v.id)} canReject={canEdit && choDuyet} />
            ))}
          </div>
        ) : (
          <EmptyState title="Lô chưa có ô nào" description="Máy đã lập lô nhưng chưa ghi ô nào — xem lỗi ở lịch sử lô bên dưới." />
        )}
      </div>
    </SectionCard>
  );
}

function HistoryTable({ rows, openId }: { rows: BatchSummary[]; openId: string | null }) {
  return (
    <SectionCard
      title={
        <span className="flex items-center gap-1.5">
          <History className="size-4" /> Lịch sử lô gần đây
        </span>
      }
      description="Bấm một lô để xem máy đã định làm gì với Facebook và cái gì chặn nó."
      padded={false}
    >
      {rows.length === 0 ? (
        <div className="p-5">
          <EmptyState title="Chưa có lô nào" description="Máy chưa lập lô nào. Lô đầu tiên xuất hiện sau khi bật vòng mẫu và có ảnh sản phẩm thật." />
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead className="border-b bg-muted/40 text-left text-[11.5px] text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Ngày chạy</th>
                <th className="px-3 py-2 font-medium">Trạng thái</th>
                <th className="px-3 py-2 font-medium">Mẫu theo trạng thái</th>
                <th className="px-3 py-2 font-medium">Người duyệt</th>
                <th className="px-3 py-2 font-medium">Ghi chú</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={cn("border-b border-hairline last:border-b-0", openId === r.id && "bg-muted/40")}>
                  <td className="whitespace-nowrap px-4 py-2 font-medium">{formatDate(r.batchDay)}</td>
                  <td className="px-3 py-2">
                    <BatchStatusChip status={r.status} />
                  </td>
                  <td className="px-3 py-2">
                    <CountChips counts={r.variantCounts} />
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">{r.approvedAt ? `${r.approvedByName || "—"} · ${vnShortStamp(r.approvedAt)}` : <span className="text-muted-foreground">—</span>}</td>
                  <td className="max-w-[280px] px-3 py-2">
                    <span className="line-clamp-2 text-muted-foreground" title={r.error || undefined}>
                      {r.error || "—"}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right">
                    <Link href={`/marketing/creatives?tab=duyet&lo=${encodeURIComponent(r.id)}#chi-tiet-lo`} className="whitespace-nowrap text-[12px] font-medium underline-offset-2 hover:underline">
                      {openId === r.id ? "Đang xem" : "Xem chi tiết"}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

function BatchDetailBlock({ d }: { d: BatchDetail }) {
  const b = d.batch;
  const slotOf = new Map(d.variants.map((v) => [v.id, v.slot]));
  const cam = d.judged.reduce<number | null>((s, v) => (v.committedBudgetVnd === null ? s : (s ?? 0) + v.committedBudgetVnd), null);
  return (
    <SectionCard
      id="chi-tiet-lo"
      title={
        <span className="flex flex-wrap items-center gap-2">
          Chi tiết lô {formatDate(b.batchDay)} <BatchStatusChip status={b.status} />
        </span>
      }
      description="Sổ ghi Facebook: mọi lượt máy XIN ghi, kể cả lượt bị cổng chặn."
      hint="Mỗi dòng là một lượt xin ghi Facebook của vòng mẫu: Đã áp (Facebook nhận) · Bị chặn (cổng từ chối trước khi gọi — kèm lý do) · Hỏng (Facebook trả lỗi). Lượt bị chặn trùng hệt chỉ ghi một lần."
    >
      <div className="space-y-4">
        <DescriptionList
          columns={3}
          items={[
            { label: "Khung chạy", value: `${vnShortStamp(b.startAt)} → ${vnShortStamp(b.endAt)}` },
            { label: "Hạn duyệt", value: vnShortStamp(b.approvalDeadline) },
            { label: "Duyệt", value: b.approvedAt ? `${b.approvedByName || "—"} · ${formatDateTime(b.approvedAt)}` : "Chưa duyệt" },
            { label: "Đăng xong", value: b.publishedAt ? formatDateTime(b.publishedAt) : "—" },
            { label: "Đã cam kết trên Facebook", value: formatVND(cam) },
            { label: "Luật tắt của lô", value: d.config.killRules.length ? d.config.killRules.map(describeRule).join(" · ") : "Không có" },
            ...(b.error ? [{ label: "Lỗi / ghi chú", value: b.error, span: true }] : []),
          ]}
        />

        {d.judged.length ? (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-[12.5px]">
              <thead className="border-b bg-muted/40 text-left text-[11.5px] text-muted-foreground">
                <tr>
                  <th className="px-3 py-1.5 font-medium">Mẫu</th>
                  <th className="px-3 py-1.5 font-medium">Trạng thái</th>
                  <th className="px-3 py-1.5 font-medium">Phán quyết</th>
                  <th className="px-3 py-1.5 text-right font-medium">Chi</th>
                  <th className="px-3 py-1.5 text-right font-medium">Đơn chốt</th>
                </tr>
              </thead>
              <tbody>
                {d.judged.map((v) => (
                  <tr key={v.id} className="border-b border-hairline last:border-b-0">
                    <td className="px-3 py-1.5">
                      #{v.slot} <span className="text-muted-foreground">{v.headline}</span>
                    </td>
                    <td className="px-3 py-1.5">{VARIANT_STATUS_LABEL[v.status]}</td>
                    <td className="px-3 py-1.5" title={v.reasons.join(" ")}>
                      {CREATIVE_VERDICT_LABEL[v.verdict]}
                    </td>
                    <td className="numeric px-3 py-1.5 text-right">{formatVND(v.metrics.spendVnd)}</td>
                    <td className="numeric px-3 py-1.5 text-right">{formatNumber(v.metrics.bookedOrders)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {d.actions.length === 0 ? (
          <EmptyState title="Chưa có lượt ghi Facebook nào" description="Máy chưa xin ghi gì cho lô này — lô chưa được duyệt, hoặc lượt đăng chưa chạy tới." />
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-[12.5px]">
              <thead className="border-b bg-muted/40 text-left text-[11.5px] text-muted-foreground">
                <tr>
                  <th className="px-3 py-1.5 font-medium">Lúc</th>
                  <th className="px-3 py-1.5 font-medium">Mẫu</th>
                  <th className="px-3 py-1.5 font-medium">Máy định làm</th>
                  <th className="px-3 py-1.5 font-medium">Kết quả</th>
                  <th className="px-3 py-1.5 font-medium">Lý do / chi tiết</th>
                  <th className="px-3 py-1.5 text-right font-medium">Tiền</th>
                  <th className="px-3 py-1.5 font-medium">Ai</th>
                </tr>
              </thead>
              <tbody>
                {d.actions.map((a) => (
                  <tr key={a.id} className="border-b border-hairline align-top last:border-b-0">
                    <td className="whitespace-nowrap px-3 py-1.5">{vnShortStamp(a.createdAt)}</td>
                    <td className="px-3 py-1.5">{a.variantId ? `#${slotOf.get(a.variantId) ?? "?"}` : "cả lô"}</td>
                    <td className="px-3 py-1.5">{CREATIVE_WRITE_ACTION_LABEL[a.action as CreativeWriteAction] ?? a.action}</td>
                    <td className={cn("whitespace-nowrap px-3 py-1.5 font-semibold", FB_WRITE_TONE[a.outcome])}>{FB_WRITE_LABEL[a.outcome] ?? a.outcome}</td>
                    <td className="max-w-[420px] px-3 py-1.5">
                      <span className="line-clamp-3" title={a.detail}>
                        {a.denial ? <b>{a.denial} · </b> : null}
                        {a.detail || "—"}
                      </span>
                    </td>
                    <td className="numeric whitespace-nowrap px-3 py-1.5 text-right">{formatVND(a.amountVnd)}</td>
                    <td className="max-w-[160px] truncate px-3 py-1.5 text-muted-foreground" title={a.actorEmail}>
                      {a.actorEmail || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </SectionCard>
  );
}

export async function ApproveTab({ pending, batchId, canApprove, canEdit }: { pending: PendingBatch | null; batchId: string | null; canApprove: boolean; canEdit: boolean }) {
  const db = await getDb();
  const now = new Date();
  const [recent, detail, current] = await Promise.all([listRecentBatches(db, 14), batchId ? getBatchDetail(db, batchId, now) : Promise.resolve(null), pending ? Promise.resolve(null) : readCurrentCreativeConfig(db)]);

  return (
    <div className="space-y-4">
      {pending ? (
        <PendingBlock pending={pending} now={now} canApprove={canApprove} canEdit={canEdit} />
      ) : (
        <SectionCard>
          <EmptyState
            icon={CalendarClock}
            title="Không có lô nào chờ duyệt"
            description={
              current
                ? current.config.enabled
                  ? `Máy dựng lô cho ngày mai lúc ${current.config.genHourVn}:00 (giờ Việt Nam) và báo khi lô sẵn sàng. Hạn duyệt là ${current.config.approvalLeadMinutes} phút trước giờ chạy ${current.config.startHourVn}:00.`
                  : "Vòng mẫu đang TẮT trong cấu hình — máy không dựng lô mới. Bật ở tab Cấu hình & luật."
                : undefined
            }
          />
        </SectionCard>
      )}

      {batchId && !detail ? <EmptyState title="Không tìm thấy lô" description="Lô trong đường dẫn không còn tồn tại." /> : null}
      {detail ? <BatchDetailBlock d={detail} /> : null}

      <HistoryTable rows={recent} openId={batchId} />
    </div>
  );
}
