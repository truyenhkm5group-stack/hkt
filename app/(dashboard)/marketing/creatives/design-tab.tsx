import { Shirt } from "lucide-react";
import Link from "next/link";
import { DesignProductionButton } from "@/app/(dashboard)/marketing/creatives/design-actions";
import { DnaChips, VariantImage } from "@/app/(dashboard)/marketing/creatives/variant-bits";
import { StatStrip } from "@/components/stat-tile";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { getDb } from "@/db";
import { DESIGN_MOQ, DESIGN_NOVELTY, DESIGN_PARENT_RULES, DESIGN_STATUS_LABEL, type DesignStatus } from "@/lib/constants/creative-loop";
import { PRODUCTION_STATUS_LABEL } from "@/lib/constants/production";
import { formatDate, formatNumber, formatVND } from "@/lib/format";
import { listDesignConcepts, productDnaCoverage } from "@/lib/queries/creative-design";
import { designModelLinks } from "@/lib/queries/early-topic";
import { readCurrentCreativeConfig } from "@/lib/queries/creative-loop";
import { cn } from "@/lib/utils";

/**
 * ═══════════ TAB THIẾT KẾ MỚI ═══════════
 *
 * Chủ shop 24/09/2026: máy thiết kế mẫu áo / váy CHƯA TỪNG CÓ (lai DNA của mã bán tốt), quảng cáo và
 * nhận đơn như hàng thường, sản xuất sau. Bảng này trả lời: thiết kế nào đang test, đã ra bao nhiêu đơn
 * (qua `ORDER_AD_ID` về các mẩu mang thiết kế: `ad_id`, không có thì bài viết của ĐÚNG MỘT mẩu — CHỈ ĐỌC),
 * và cái nào đáng đưa vào sản xuất.
 *
 * Cột MOQ (§5h): `x/50 đơn` đếm SỐNG theo hai đường (sản phẩm Pancake mã TK · `ORDER_AD_ID` về mẩu), hợp theo
 * id đơn; đủ thì máy đã dựng NHÁP lệnh sản xuất — link tới nháp. Máy không gửi xưởng. Căn cứ đường quảng
 * cáo (mang `ad_id` · qua bài viết) in ở dòng phụ + tooltip (B2, 26/09/2026).
 *
 * Topic sản xuất SỚM (quy tắc chủ shop 25/09/2026 · Agent T): thiết kế đang test / thắng mà đã có mẫu trong
 * sổ (`product_models.design_concept_id`) ⇒ link "Mở topic sản xuất" để xưởng báo giá, làm mẫu song song
 * với test quảng cáo — kể cả khi chưa có mã Pancake. Đã có topic đang mở ⇒ link tới topic đó. Thiết kế
 * chưa vào sổ ⇒ nhắc "Đồng bộ sổ mẫu trước" (không tự đăng ký).
 */

/** Trạng thái thiết kế mà việc mở topic sớm có nghĩa: đang test / đã thắng (Chờ test, Loại, Đã đưa vào SX thì không). */
export const EARLY_TOPIC_DESIGN_STATUSES: readonly DesignStatus[] = ["TESTING", "WIN"];

const STATUS_TONE: Record<DesignStatus, string> = {
  DRAFT: "bg-muted text-muted-foreground",
  TESTING: "bg-primary/10 text-primary",
  WIN: "bg-success/15 text-success",
  LOSE: "bg-muted text-muted-foreground",
  PRODUCTION: "bg-brand/15 text-brand",
};

export async function DesignTab({ canEdit, canCreateTopic = false }: { canEdit: boolean; canCreateTopic?: boolean }) {
  const db = await getDb();
  const [rows, coverage, { config }] = await Promise.all([listDesignConcepts(db, 200), productDnaCoverage(db), readCurrentCreativeConfig(db)]);
  const topicRows = canCreateTopic ? rows.filter((r) => EARLY_TOPIC_DESIGN_STATUSES.includes(r.status)) : [];
  const modelOf = await designModelLinks(
    db,
    topicRows.map((r) => r.id),
  );
  const dangTest = rows.filter((r) => r.status === "TESTING").length;
  const thang = rows.filter((r) => r.status === "WIN" || r.status === "PRODUCTION").length;
  const don = rows.reduce((s, r) => s + r.bookedOrders, 0);

  return (
    <div className="space-y-4">
      <StatStrip
        columns={4}
        items={[
          { label: "Ô thiết kế mỗi lô", value: formatNumber(config.designSlots), note: config.extraCandidates ? `+ ${formatNumber(config.extraCandidates)} sinh dư` : "không sinh dư", hint: "Số ô THIẾT KẾ MỚI máy lập mỗi lô (cấu hình). Không đủ mã cha có DNA hoặc không đủ thiết kế đủ mới lạ ⇒ lô ít hơn và máy nói vì sao ở lịch sử lô." },
          {
            label: "Mã đã đọc DNA",
            value: formatNumber(coverage.withDna),
            note: coverage.failed ? `${formatNumber(coverage.failed)} mã đọc hỏng — thử lại sau 24 giờ` : "đọc dần mỗi lượt dựng lô",
            tone: coverage.withDna ? "default" : "amber",
            hint: `DNA (nhóm hàng, dáng, cổ, tay, chất liệu, hoạ tiết, màu, chi tiết, phong cách) đọc từ ảnh sản phẩm bằng mô hình đọc ảnh. Mã làm cha khi có ≥ ${DESIGN_PARENT_RULES.minDelivered} đơn giao thành công trong ${DESIGN_PARENT_RULES.lookbackDays} ngày hoặc chi / tin nhắn tốt.`,
          },
          { label: "Đang test", value: formatNumber(dangTest), note: `${formatNumber(thang)} thắng / đưa vào sản xuất` },
          { label: "Đơn chốt quy về thiết kế", value: formatNumber(don), note: "ad_id hoặc bài viết của đúng một mẩu", hint: "Đơn không huỷ quy về các mẩu quảng cáo thiết kế (cùng định nghĩa đơn chốt của vòng mẫu, cùng biểu thức cấp mẩu của /ads): ad_id Pancake gửi trước; đơn không có ad_id thì nối qua bài viết, CHỈ khi bài ấy thuộc đúng một mẩu. Bài nhiều mẩu cùng chạy không được nối — nên vẫn có thể đếm thiếu, không đếm thừa." },
        ]}
      />
      <SectionCard
        title="Thiết kế mới"
        description={`Mỗi thiết kế khác mọi mã đang có và mọi thiết kế ${DESIGN_NOVELTY.recentDesignDays} ngày gần nhất ở ít nhất ${DESIGN_NOVELTY.minDiffAttributes} thuộc tính DNA. Tạo sản phẩm trên Pancake đúng mã TK-… để nhân viên chốt đơn.`}
        hint="Giá đề nghị = giá của mã cha trội nhất; không suy được thì để trống và câu chữ quảng cáo không ghi giá. Trạng thái do máy chấm theo mẩu quảng cáo mang thiết kế (thắng khi đơn chốt vượt ngưỡng thắng của vòng); “Đưa vào sản xuất” chỉ người bấm."
        padded={false}
      >
        {rows.length === 0 ? (
          <div className="p-5">
            <EmptyState icon={Shirt} title="Chưa có thiết kế nào" description="Máy lập thiết kế khi dựng lô: cần mã bán tốt đã đọc được DNA VÀ có ảnh sản phẩm thật (ảnh tham chiếu chất ảnh của shop)." />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead className="border-b bg-muted/40 text-left text-[11.5px] text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Thiết kế</th>
                  <th className="px-3 py-2 font-medium">DNA</th>
                  <th className="px-3 py-2 font-medium">Mã cha</th>
                  <th className="px-3 py-2 text-right font-medium">Giá đề nghị</th>
                  <th className="px-3 py-2 font-medium">Trạng thái</th>
                  <th className="px-3 py-2 text-right font-medium">Đơn chốt · giao / hoàn</th>
                  <th className="px-3 py-2 text-right font-medium">Đã chi</th>
                  <th className="px-3 py-2 font-medium" title={`Đủ ${DESIGN_MOQ.minOrders} đơn đã xác nhận (không huỷ) ⇒ máy dựng NHÁP lệnh sản xuất. Đơn đếm qua hai đường: dòng hàng là sản phẩm Pancake mã TK, và quảng cáo (ad_id của mẩu QC mang thiết kế, hoặc bài viết của đúng một mẩu ấy) — đơn thấy ở cả hai tính một lần. Máy chỉ dựng nháp, không gửi xưởng.`}>
                    MOQ sản xuất
                  </th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-hairline align-top last:border-b-0">
                    <td className="px-3 py-2">
                      <div className="flex items-start gap-2">
                        <VariantImage imageId={r.imageId} available={r.imageAvailable} alt={r.code} className="size-14 shrink-0 rounded-md" iconClassName="size-4" />
                        <div className="min-w-0">
                          <p className="font-mono font-semibold">{r.code}</p>
                          <p className="text-[11px] text-muted-foreground">{r.batchDay ? `lô ${formatDate(r.batchDay)}` : formatDate(r.createdAt)}</p>
                        </div>
                      </div>
                    </td>
                    <td className="max-w-[340px] px-3 py-2" title={r.why}>
                      <DnaChips dna={r.dna} />
                    </td>
                    <td className="max-w-[160px] px-3 py-2">
                      <span className="line-clamp-2" title={r.parentProductIds.join(", ")}>
                        {r.parentLabels.join(" × ") || "—"}
                      </span>
                    </td>
                    <td className="numeric whitespace-nowrap px-3 py-2 text-right">{r.priceVnd === null ? <span className="text-muted-foreground">—</span> : formatVND(r.priceVnd)}</td>
                    <td className="px-3 py-2">
                      <span className={cn("whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-semibold", STATUS_TONE[r.status])}>{DESIGN_STATUS_LABEL[r.status] ?? r.status}</span>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">{r.ads ? `${formatNumber(r.ads)} mẩu QC` : "chưa đăng"}</p>
                    </td>
                    <td className="numeric whitespace-nowrap px-3 py-2 text-right">
                      {r.ads ? (
                        <>
                          <b>{formatNumber(r.bookedOrders)}</b>
                          <span className="text-muted-foreground">
                            {" "}
                            · {formatNumber(r.deliveredOrders)} / {formatNumber(r.returnedOrders)}
                          </span>
                        </>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="numeric whitespace-nowrap px-3 py-2 text-right">{formatVND(r.spendVnd)}</td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <p className="numeric">
                        <b>{formatNumber(r.moq.orders)}</b>
                        <span className="text-muted-foreground">/{formatNumber(DESIGN_MOQ.minOrders)} đơn</span>
                      </p>
                      <div className="mt-0.5 h-1 w-20 overflow-hidden rounded bg-muted">
                        <div className={cn("h-full", r.moq.orders >= DESIGN_MOQ.minOrders ? "bg-success" : "bg-primary")} style={{ width: `${Math.min(100, Math.round((r.moq.orders / DESIGN_MOQ.minOrders) * 100))}%` }} />
                      </div>
                      <p
                        className="mt-0.5 text-[11px] text-muted-foreground"
                        title={`${formatNumber(r.moq.viaCode)} đơn có dòng hàng mã ${r.code} · ${formatNumber(r.moq.viaAd)} đơn qua quảng cáo (${formatNumber(r.moq.viaAdDirect)} mang ad_id · ${formatNumber(r.moq.viaAdPost)} qua bài viết của đúng một mẩu) · ${formatNumber(r.moq.both)} đơn trùng hai đường (tính một lần). ${r.moq.productIds.length ? `Số lượng mã TK: ${formatNumber(r.moq.qtyKnown)} sp.` : `Chưa có sản phẩm Pancake mã ${r.code}.`}`}
                      >
                        mã TK {formatNumber(r.moq.viaCode)} · chỉ QC {formatNumber(r.moq.adOnly)}
                        {r.moq.viaAdPost > 0 ? ` · qua bài ${formatNumber(r.moq.viaAdPost)}` : ""}
                      </p>
                      {r.productionOrder ? (
                        <Link href={`/inventory/planning/orders/${r.productionOrder.id}`} className="text-[11px] font-medium text-primary hover:underline">
                          {r.productionOrder.code} · {PRODUCTION_STATUS_LABEL[r.productionOrder.status] ?? r.productionOrder.status}
                        </Link>
                      ) : r.moqReachedAt ? (
                        <p className="text-[11px] text-muted-foreground" title="Máy đã dựng nháp khi đủ MOQ; người đã xoá nó — máy không dựng lại.">
                          nháp đã xoá
                        </p>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      <DesignProductionButton id={r.id} code={r.code} production={r.status === "PRODUCTION"} canEdit={canEdit} />
                      {canCreateTopic && EARLY_TOPIC_DESIGN_STATUSES.includes(r.status) ? <EarlyTopicLink link={modelOf.get(r.id) ?? null} /> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}

/** Lối vào topic sản xuất SỚM của một thiết kế (Agent T). */
function EarlyTopicLink({ link }: { link: { modelId: string; openTopicId: string | null } | null }) {
  if (!link) {
    return (
      <Link href="/models" className="mt-1 block text-[11px] text-muted-foreground hover:underline" title="Thiết kế chưa có mẫu trong sổ Vòng đời mẫu — bấm Đồng bộ sổ ở trang Vòng đời mẫu rồi quay lại để mở topic sản xuất.">
        Đồng bộ sổ mẫu trước
      </Link>
    );
  }
  if (link.openTopicId) {
    return (
      <Link href={`/production/topics/${encodeURIComponent(link.openTopicId)}`} className="mt-1 block text-[11px] font-medium text-primary hover:underline">
        Topic sản xuất đang mở
      </Link>
    );
  }
  return (
    <Link
      href={`/production/topics/new?model=${encodeURIComponent(link.modelId)}`}
      className="mt-1 block text-[11px] font-medium text-primary hover:underline"
      title="Mở topic hỏi giá / làm mẫu với xưởng ngay khi thiết kế còn đang test — luồng song song, vòng đời mẫu không đổi (quy tắc chủ shop 25/09/2026)."
    >
      Mở topic sản xuất
    </Link>
  );
}
