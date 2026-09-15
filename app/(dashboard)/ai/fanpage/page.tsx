import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { DeleteRuleButton, FanpageForm, SourceRuleForm } from "@/app/(dashboard)/ai/fanpage/fanpage-form";
import { requirePermission } from "@/lib/auth/session";
import { formatNumber, formatVND } from "@/lib/format";
import { listFanpages, listSizeProfiles, listSourceRules, listSourcesWithoutRule, listTestProducts } from "@/lib/queries/fanpage-sales";
import { listProductChoices } from "@/lib/queries/sales-ad-map";
import { SOURCE_TYPE_LABEL, type SourceType } from "@/lib/constants/fanpage-sales";
import type { SearchParams } from "@/lib/search-params";

export const metadata = { title: "Cấu hình fanpage — nhân sự bán hàng" };

export default async function FanpagePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requirePermission("ai:view");
  const raw = await searchParams;
  const chon = (Array.isArray(raw.page) ? raw.page[0] : raw.page) ?? "";

  const [pages, choices, tests, sizes] = await Promise.all([listFanpages(), listProductChoices(), listTestProducts(), listSizeProfiles()]);
  const page = pages.find((p) => p.pancakePageId === chon) ?? pages[0];
  const [rules, unruled] = page
    ? await Promise.all([listSourceRules(page.pancakePageId), listSourcesWithoutRule(page.pancakePageId)])
    : [[], []];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Cấu hình fanpage"
        description="Một page bán một mẫu thắng. Khai mẫu ấy ở đây; máy không phải đoán lại ở từng tin nhắn."
      />

      <Card className="p-4">
        <h2 className="mb-3 text-sm font-semibold">Chọn fanpage</h2>
        <div className="flex flex-wrap gap-2">
          {pages.map((p) => (
            <a
              key={p.pancakePageId}
              href={`/ai/fanpage?page=${p.pancakePageId}`}
              className={`rounded-md border px-3 py-2 text-xs ${p.pancakePageId === page?.pancakePageId ? "border-foreground font-medium" : "text-muted-foreground"}`}
            >
              {p.name || p.pancakePageId}
              <span className="ml-2 opacity-70">{formatNumber(p.conversations)} hội thoại</span>
              {p.activeProductCode ? <span className="ml-2 font-mono">{p.activeProductCode}</span> : <span className="ml-2 opacity-70">chưa khai mẫu</span>}
            </a>
          ))}
          {pages.length === 0 ? <p className="text-sm text-muted-foreground">Chưa có page nào có hội thoại trong ERP.</p> : null}
        </div>
      </Card>

      {page ? (
        <>
          <Card className="p-4">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold">Mẫu thắng của page</h2>
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
              choices={choices}
            />
            <p className="mt-3 text-xs text-muted-foreground">
              Đổi mẫu hoặc đổi giá sẽ tăng số bản hồ sơ. Hội thoại đã chốt ngữ cảnh giữ nguyên mẫu cũ — đổi cấu hình không viết lại
              quá khứ. Giá để trống nghĩa là <span className="font-medium">chưa khai</span>, và máy sẽ không báo giá.
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Bảng số đo đang có: {sizes.length ? sizes.map((s) => s.name).join(", ") : "chưa có bảng nào — máy sẽ chuyển người khi khách hỏi size"}
            </p>
          </Card>

          <Card className="p-4">
            <h2 className="mb-1 text-sm font-semibold">Ngoại lệ nguồn ({formatNumber(rules.length)})</h2>
            <p className="mb-3 text-xs text-muted-foreground">
              Quảng cáo bán đúng mẫu thắng thì <span className="font-medium">không cần khai gì</span>. Chỉ khai những nguồn KHÁC: hàng
              test, hoặc nguồn chỉ người được trả lời.
            </p>
            {rules.length === 0 ? (
              <p className="text-sm text-muted-foreground">Chưa có ngoại lệ nào — mọi nguồn đang chạy theo mẫu thắng của page.</p>
            ) : (
              <div className="space-y-2">
                {rules.map((r) => (
                  <div key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border p-2 text-sm">
                    <span className="font-medium">{SOURCE_TYPE_LABEL[r.sourceType as SourceType] ?? r.sourceType}</span>
                    <code className="font-mono text-xs">{r.sourceId}</code>
                    {r.productCode ? <span className="text-xs">→ {r.productCode}</span> : null}
                    {r.testCode ? <span className="text-xs">→ {r.testCode}</span> : null}
                    <span className="text-xs text-muted-foreground">{formatNumber(r.conversations)} hội thoại</span>
                    <DeleteRuleButton id={r.id} />
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card className="p-4">
            <h2 className="mb-1 text-sm font-semibold">Nguồn chưa khai ngoại lệ ({formatNumber(unruled.length)})</h2>
            <p className="mb-3 text-xs text-muted-foreground">
              Đang chạy theo mẫu thắng của page. Chỉ khai những cái KHÔNG bán mẫu thắng.
            </p>
            <div className="space-y-3">
              {unruled.map((u) => (
                <SourceRuleForm
                  key={u.sourceId}
                  pancakePageId={page.pancakePageId}
                  sourceId={u.sourceId}
                  adDescription={u.adDescription}
                  conversations={u.conversations}
                  mediaUrl={u.mediaUrl}
                  choices={choices}
                  tests={tests.map((t) => ({ id: t.id, testCode: t.testCode, name: t.name }))}
                />
              ))}
              {unruled.length === 0 ? <p className="text-sm text-muted-foreground">Không có nguồn nào chưa khai.</p> : null}
            </div>
          </Card>

          <Card className="p-4">
            <h2 className="mb-3 text-sm font-semibold">Hồ sơ mẫu test ({formatNumber(tests.length)})</h2>
            {tests.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Chưa có mẫu test nào. Mẫu test tồn tại được mà chưa cần mã hàng trong ERP — máy vẫn trả lời khách, nhưng chỉ dùng dữ
                kiện khai trong hồ sơ và không được tự lên đơn.
              </p>
            ) : (
              <div className="space-y-2">
                {tests.map((t) => (
                  <div key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border p-2 text-sm">
                    <code className="font-mono text-xs">{t.testCode}</code>
                    <span>{t.name}</span>
                    <span className="text-xs text-muted-foreground">{t.status}</span>
                    <span className="text-xs text-muted-foreground">{t.price === null ? "chưa có giá" : formatVND(t.price)}</span>
                    <span className="text-xs text-muted-foreground">{t.aiReplyEnabled ? "máy được trả lời" : "máy không trả lời"}</span>
                    <span className="text-xs text-muted-foreground">{t.allowAutoOrderCreate ? "được lên đơn" : "KHÔNG được lên đơn"}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </>
      ) : null}
    </div>
  );
}
