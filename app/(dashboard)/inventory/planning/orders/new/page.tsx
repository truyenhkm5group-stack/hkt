import { notFound } from "next/navigation";
import { ProductionEditor } from "@/app/(dashboard)/inventory/planning/orders/production-editor";
import { PageHeader } from "@/components/page-header";
import { requirePermission } from "@/lib/auth/session";
import { buildMatrixForProduct } from "@/lib/queries/production";
import { designOptionsForPo, requireApprovedDesignFlag } from "@/lib/queries/production-os";
import { activeSupplierNames } from "@/lib/queries/suppliers";
import { getNewPoPrefill } from "@/lib/queries/production-shortcuts";
import type { SearchParams } from "@/lib/search-params";
import { addDays, todayVN } from "@/lib/format";

export const metadata = { title: "Bảng chốt đặt hàng" };

export default async function NewProductionOrderPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requirePermission("planning:write");
  const raw = await searchParams;
  const productId = typeof raw.product === "string" ? raw.product : "";
  // Giữ đúng tham số của bảng kế hoạch vừa xem: số ngày muốn đủ bán và có trừ hàng sắp về hay không.
  const soNgay = Number(typeof raw.ngay === "string" ? raw.ngay : "");
  const m = productId
    ? await buildMatrixForProduct(productId, {
        coverDays: Number.isFinite(soNgay) && soNgay >= 0 ? soNgay : undefined,
        countIncoming: raw.hoan !== "0",
      })
    : null;
  if (!m) notFound();
  const due = addDays(todayVN(), m.leadTimeDays);
  const [designOptions, requireApprovedDesign] = await Promise.all([designOptionsForPo(m.product.id), requireApprovedDesignFlag()]);
  /*
    LỐI TẮT "Lập lệnh SX" từ một bản duyệt (Agent SC): `?design=` chọn sẵn bản duyệt đó — chỉ khi nó thuộc
    CHÍNH mẫu của sản phẩm (máy chủ kiểm lại lúc lưu) — và điền xưởng của topic / của mẫu được duyệt. Ô số
    lượng vẫn là gợi ý của Kế hoạch SX như mọi lần mở trang này.
  */
  const tuLoiTat = await getNewPoPrefill(designOptions, typeof raw.design === "string" ? raw.design : null);
  return (
    <div className="space-y-5">
      <PageHeader eyebrow="Kho" title={`Bảng chốt đặt hàng · ${m.product.code ? `${m.product.code} · ` : ""}${m.product.name}`} description={`Số lượng khởi tạo theo đề xuất của ERP cho ${m.coverDays} ngày bán — sửa rồi bấm Chốt.`}
 hint={`Số lượng khởi tạo theo đề xuất của ERP: tồn khả dụng${m.countIncoming ? " cộng hàng đang ở ngoài / chờ hoàn về sắp quay lại kho" : ""}, tốc độ bán, thời gian sản xuất ${m.leadTimeDays} ngày và ${m.coverDays} ngày muốn đủ bán sau khi hàng về — đã TRỪ hàng đặt xưởng chưa về (lệnh đã gửi + lô đang mở, trừ phần đã nhập qua phiếu nối). Sửa từng ô rồi bấm Chốt để lưu và in / gửi xưởng.`} />
      {tuLoiTat.designVersionId || tuLoiTat.invalidDesign ? (
        <p className={tuLoiTat.invalidDesign ? "rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/60 dark:text-amber-200" : "rounded-md border bg-muted/40 px-3 py-2 text-sm"}>
          {tuLoiTat.invalidDesign
            ? "Bản duyệt trên đường dẫn không thuộc mẫu của sản phẩm này — không chọn sẵn bản nào."
            : `Mở từ bản duyệt V${tuLoiTat.designVersion ?? "—"}: đã chọn sẵn bản duyệt${tuLoiTat.supplier ? ` và xưởng “${tuLoiTat.supplier.name}” (${tuLoiTat.supplier.source === "TOPIC" ? "xưởng của topic" : "xưởng đã làm mẫu được duyệt"})` : " (chưa biết xưởng — gõ tên xưởng)"}. Số lượng = gợi ý của Kế hoạch SX; sửa ô nào thì ghi lý do.`}
        </p>
      ) : null}
      <ProductionEditor
        init={{
          product: m.product,
          colors: m.colors,
          sizes: m.sizes,
          cells: m.cells,
          detail: m.detail,
          images: m.images,
          unitCost: m.unitCost,
          supplier: tuLoiTat.supplier?.name ?? "",
          note: "",
          dueDate: due,
          // Ô khởi tạo LÀ đề xuất của máy ⇒ lưu gợi ý (máy chủ tính lại theo đúng căn cứ này) và so từng ô.
          initialFromSuggestion: true,
          suggestionBasis: { coverDays: m.coverDays, countIncoming: m.countIncoming },
          designOptions,
          // Mở thường: KHÔNG chọn sẵn — trỏ lệnh vào bản duyệt nào là lựa chọn của người lập bảng. Mở từ nút
          // "Lập lệnh SX" của MỘT bản duyệt: người đã chọn bản đó bằng cú bấm ⇒ chọn sẵn (vẫn đổi được).
          designVersionId: tuLoiTat.designVersionId,
          requireApprovedDesign,
        }}
        supplierOptions={await activeSupplierNames()}
      />
    </div>
  );
}
