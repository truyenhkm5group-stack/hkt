import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { FanpageForm } from "@/app/(dashboard)/ai/fanpage/fanpage-form";
import { SourceRow } from "@/app/(dashboard)/ai/fanpage/source-row";
import { BenchmarkButton } from "@/app/(dashboard)/ai/fanpage/benchmark-button";
import { requirePermission } from "@/lib/auth/session";
import { formatNumber, formatVND } from "@/lib/format";
import { listFanpages, listSizeProfiles, listSourceLines, listTestProducts } from "@/lib/queries/fanpage-sales";
import { listProductChoices } from "@/lib/queries/sales-ad-map";
import { discoverKnowledgeGaps, loadWinKnowledge } from "@/lib/queries/sales-knowledge";
import { CAPABILITY_LABEL, SALES_CAPABILITIES } from "@/lib/constants/sales-capabilities";
import type { SearchParams } from "@/lib/search-params";

export const metadata = { title: "Cấu hình fanpage — nhân sự bán hàng" };

export default async function FanpagePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requirePermission("ai:view");
  const raw = await searchParams;
  const chon = (Array.isArray(raw.page) ? raw.page[0] : raw.page) ?? "";

  const [pages, choices, tests, sizes] = await Promise.all([listFanpages(), listProductChoices(), listTestProducts(), listSizeProfiles()]);
  const page = pages.find((p) => p.pancakePageId === chon) ?? pages[0];
  const sources = page ? await listSourceLines(page.pancakePageId) : [];
  const [kienThuc, loHong] = page
    ? await Promise.all([loadWinKnowledge(page.pancakePageId), discoverKnowledgeGaps(page.pancakePageId)])
    : [null, []];
  const k = kienThuc?.knowledge ?? null;
  const combo2 = k?.comboPricing?.find((c) => c.quantity === 2) ?? null;

  const soTest = sources.filter((s) => s.status === "TEST").length;
  const soNguoi = sources.filter((s) => s.status === "HUMAN_ONLY").length;
  const soWin = sources.filter((s) => s.status === "DEFAULT_WIN").length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Cấu hình fanpage"
        description="Một page bán một mã WIN. Khai mã ấy ở đây; chỉ nguồn KHÁC mã WIN mới phải khai riêng."
      />

      <Card className="p-4">
        <h2 className="mb-3 text-sm font-semibold">Fanpage</h2>
        <div className="flex flex-wrap gap-2">
          {pages.map((p) => (
            <a
              key={p.pancakePageId}
              href={`/ai/fanpage?page=${p.pancakePageId}`}
              className={`rounded-md border px-3 py-2 text-xs ${p.pancakePageId === page?.pancakePageId ? "border-foreground font-medium" : "text-muted-foreground"}`}
            >
              {p.name || p.pancakePageId}
              <span className="ml-2 opacity-70">{formatNumber(p.conversations)} hội thoại</span>
              {p.activeProductCode ? <span className="ml-2 font-mono">{p.activeProductCode}</span> : <span className="ml-2 opacity-70">chưa có mã WIN</span>}
            </a>
          ))}
          {pages.length === 0 ? <p className="text-sm text-muted-foreground">Chưa có page nào có hội thoại trong ERP.</p> : null}
        </div>
      </Card>

      {page ? (
        <>
          <Card className="p-4">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold">1 · Mã WIN hiện tại của fanpage</h2>
              <p className="text-xs text-muted-foreground">
                hồ sơ bản {page.version} · {formatNumber(page.snapshotted)}/{formatNumber(page.conversations)} hội thoại đã chốt ngữ cảnh
              </p>
            </div>
            <FanpageForm
              pancakePageId={page.pancakePageId}
              name={page.name}
              aiMode={page.aiMode}
              activeProductId={page.activeProductId}
              unitPrice={page.unitPrice}
              shippingFee={page.shippingFee}
              colors={page.availableColors}
              sizeProfileId={page.sizeProfileId}
              material={k?.material ?? ""}
              comboPrice={combo2?.price ?? null}
              comboFreeShip={combo2?.freeShipping ?? false}
              codPolicy={k?.codPolicy ?? ""}
              inspectionPolicy={k?.inspectionPolicy ?? ""}
              deliveryEstimate={k?.deliveryEstimate ?? ""}
              exchangePolicy={k?.exchangePolicy ?? ""}
              approvedFacts={k?.approvedFacts ?? []}
              choices={choices}
              sizes={sizes}
            />
            <p className="mt-3 text-xs text-muted-foreground">
              Lưu xong, mọi hội thoại MỚI của page — trừ nguồn khai TEST/HUMAN_ONLY — mặc định là WIN với mã này, không phải đi tìm
              lại sản phẩm. Hội thoại đã chốt ngữ cảnh giữ nguyên mã cũ. Giá để trống nghĩa là{" "}
              <span className="font-medium">chưa khai</span>, và máy sẽ không báo giá.
            </p>
          </Card>

          {kienThuc ? (
            <Card className="p-4">
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
                <h2 className="text-sm font-semibold">
                  {kienThuc.ready ? "✅ SẴN SÀNG GIAO VIỆC BÁN" : "⛔ CÒN THIẾU DỮ LIỆU"}
                </h2>
                <p className="text-xs text-muted-foreground">
                  đầy đủ {kienThuc.completeness}% · sổ dữ kiện bản {kienThuc.knowledgeVersion}
                </p>
              </div>

              {kienThuc.ready ? (
                <p className="mb-3 text-xs text-muted-foreground">
                  Đủ dữ liệu cho những câu hỏi thường gặp nhất. Những năng lực còn tắt bên dưới KHÔNG chặn việc bán — máy chuyển người
                  đúng ở những câu ấy.
                </p>
              ) : (
                <p className="mb-3 text-xs">
                  Còn thiếu: <span className="font-medium">{kienThuc.missing.join(" · ")}</span>
                </p>
              )}

              <p className="mb-2 text-[11px] text-muted-foreground">
                🟢 ở đây nghĩa là <span className="font-medium">ĐỦ DỮ LIỆU</span> để trả lời, không phải đã được phép làm. Quyền hạn là
                khoá riêng ở nấc AI của page và ở chặn cứng cấp máy chủ ({" "}
                <code className="font-mono">AI_ALLOW_CUSTOMER_SEND</code> · <code className="font-mono">AI_ALLOW_ORDER_CREATE</code>) — hai
                khoá độc lập, và một khoá mở không mở hộ khoá kia.
              </p>
              <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                {SALES_CAPABILITIES.map((c) => {
                  const st = kienThuc.capabilities[c];
                  return (
                    <div key={c} className="flex items-baseline gap-2 rounded-md border p-2 text-xs">
                      <span>{st.on ? "🟢" : "⚪"}</span>
                      <span className={st.on ? "font-medium" : "text-muted-foreground"}>{CAPABILITY_LABEL[c]}</span>
                      {st.on ? null : <span className="ml-auto text-right text-[11px] text-muted-foreground">thiếu {st.missing.join(", ")}</span>}
                    </div>
                  );
                })}
              </div>

              {kienThuc.conflicts.length ? (
                <div className="mt-4">
                  <h3 className="mb-2 text-xs font-semibold">Đối chiếu với ERP</h3>
                  <div className="space-y-1.5">
                    {kienThuc.conflicts.map((c) => (
                      <div key={c.field} className="rounded-md border p-2 text-xs">
                        <span className="font-medium">
                          {c.kind === "CONFLICT" ? "⚠️ LỆCH" : c.kind === "CORROBORATED" ? "✓ khớp" : "· ERP không có để đối chiếu"} — {c.field}
                        </span>
                        <span className="ml-2 text-muted-foreground">
                          khai: {c.declared} · ERP: {c.erp}
                        </span>
                        <p className="mt-0.5 text-[11px] text-muted-foreground">{c.note}</p>
                      </div>
                    ))}
                  </div>
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    Lệch KHÔNG được sửa tự động ở đâu cả: giá kênh khác giá ERP là chuyện hợp lệ. Máy in cả hai con số để chủ shop
                    quyết cái nào đúng.
                  </p>
                </div>
              ) : null}

              {loHong.some((g) => g.todo) ? (
                <div className="mt-4">
                  <h3 className="mb-2 text-xs font-semibold">Dữ liệu còn thiếu — đã đi tìm ở đâu, và ai phải cung cấp</h3>
                  <div className="space-y-1.5">
                    {loHong
                      .filter((g) => g.todo)
                      .map((g) => (
                        <div key={g.field} className="rounded-md border p-2 text-xs">
                          <span className="font-medium">{g.field}</span>
                          <span className="ml-2 font-mono text-[11px] text-muted-foreground">{g.code}</span>
                          <p className="mt-0.5 text-muted-foreground">{g.found}</p>
                          <p className="mt-0.5">→ {g.todo}</p>
                          <p className="mt-0.5 text-[11px] text-muted-foreground">đã tra: {g.lookedAt}</p>
                        </div>
                      ))}
                  </div>
                </div>
              ) : null}
            </Card>
          ) : null}

          <Card className="p-4">
            <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold">2 · Nguồn đang phát sinh hội thoại ({formatNumber(sources.length)})</h2>
              <p className="text-xs text-muted-foreground">
                {soWin} theo mã WIN · {soTest} TEST · {soNguoi} chỉ người
              </p>
            </div>
            <p className="mb-3 text-xs text-muted-foreground">
              Quảng cáo bán đúng mã WIN thì để nguyên <span className="font-medium">DEFAULT_WIN</span> — không cần khai từng cái. Chỉ
              đổi những nguồn KHÁC.
            </p>
            <div className="space-y-3">
              {sources.map((s) => (
                <SourceRow
                  key={s.sourceId}
                  pancakePageId={page.pancakePageId}
                  sourceId={s.sourceId}
                  sourceKind={s.sourceKind}
                  status={s.status}
                  testCode={s.testCode}
                  adDescription={s.adDescription}
                  mediaUrl={s.mediaUrl}
                  conversations={s.conversations}
                  tests={tests.map((t) => ({ id: t.id, testCode: t.testCode, name: t.name }))}
                  sizes={sizes.map((z) => ({ id: z.id, name: z.name }))}
                />
              ))}
              {sources.length === 0 ? (
                <p className="text-sm text-muted-foreground">Chưa có nguồn nào — hội thoại của page này không kèm mã quảng cáo.</p>
              ) : null}
            </div>
          </Card>

          <Card className="p-4">
            <h2 className="mb-3 text-sm font-semibold">3 · Hồ sơ mẫu test ({formatNumber(tests.length)})</h2>
            {tests.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Chưa có mẫu test nào. Tạo ngay khi khai một nguồn là TEST ở trên — mẫu test không cần mã hàng chính thức.
              </p>
            ) : (
              <div className="space-y-2">
                {tests.map((t) => (
                  <div key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border p-2 text-sm">
                    <code className="font-mono text-xs">{t.testCode}</code>
                    <span>{t.name}</span>
                    <span className="text-xs text-muted-foreground">{t.status}</span>
                    <span className="text-xs text-muted-foreground">{t.price === null ? "chưa có giá" : formatVND(t.price)}</span>
                    <span className="text-xs text-muted-foreground">{t.colors.length ? t.colors.join(", ") : "chưa khai màu"}</span>
                    <span className="text-xs text-muted-foreground">{t.sizeProfileId ? "có bảng size" : "chưa có bảng size"}</span>
                    <span className="text-xs text-muted-foreground">{t.allowAutoOrderCreate ? "được lên đơn" : "KHÔNG được lên đơn"}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card className="p-4">
            <h2 className="mb-3 text-sm font-semibold">4 · Chạy thử ngầm</h2>
            <BenchmarkButton pancakePageId={page.pancakePageId} />
          </Card>
        </>
      ) : null}
    </div>
  );
}
