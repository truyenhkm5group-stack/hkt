import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { GHTK_LABEL_PATTERN } from "@/lib/constants/carrier-ghtk";

export const metadata = { title: "Nhãn in vận đơn" };

/**
 * NHÃN IN NHIỀU VẬN ĐƠN CỦA HÃNG IN TỪNG ĐƠN (GHTK · POS tự chủ).
 *
 * Tài liệu In nhãn của GHTK trả MỘT tệp PDF cho MỘT đơn. Trang này liệt kê từng nhãn, mỗi nhãn mở qua tuyến chuyển tiếp của ERP
 * (`/api/carriers/label` — phiên + quyền + mã phải là lần gửi ERP tạo). Trang không gọi hãng; mã lạ bị bỏ, không tạo link.
 */
export default async function CarrierLabelsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePermission("shipments:manage");
  const sp = await searchParams;
  const carrier = typeof sp.carrier === "string" && sp.carrier === "GHTK" ? "GHTK" : null;
  const raw = typeof sp.codes === "string" ? sp.codes : "";
  const codes = [...new Set(raw.split(",").map((c) => c.trim()).filter((c) => GHTK_LABEL_PATTERN.test(c)))].slice(0, 100);
  return (
    <div className="space-y-4">
      <PageHeader title="Nhãn in vận đơn" description="GHTK in một nhãn cho mỗi đơn — mở từng nhãn bên dưới, mỗi nhãn là một tệp PDF." />
      <SectionCard title={carrier ? `${codes.length} nhãn ${carrier}` : "Không có nhãn"}>
        {carrier && codes.length ? (
          <ol className="list-decimal space-y-1 pl-6 text-sm">
            {codes.map((c) => (
              <li key={c}>
                <a className="text-primary underline" href={`/api/carriers/label?carrier=${carrier}&code=${encodeURIComponent(c)}`} target="_blank" rel="noopener noreferrer">
                  {c}
                </a>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-muted-foreground">Không có mã vận đơn hợp lệ trong đường dẫn — quay lại danh sách đơn và chọn lại.</p>
        )}
      </SectionCard>
    </div>
  );
}
