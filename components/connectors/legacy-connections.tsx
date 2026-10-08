import { ConnectorGroupTable } from "@/components/connectors/connector-group-table";
import { OrgPosPanel } from "@/components/connectors/org-pos-panel";
import { SectionCard } from "@/components/ui-bits";
import type { ConnectorView } from "@/lib/connectors/types";

/**
 * Mục «Kết nối cũ / chuyển đổi» cuối trang Kết nối của tổ chức KHÁCH (lib/connectors/legacy.ts): Pancake chỉ còn cho shop đang
 * dùng Pancake và cho lượt chuyển sang Facebook trực tiếp. Gập lại với shop mới; mở sẵn khi tổ chức đang khai một dòng Pancake.
 */
export function LegacyConnections({ orgCode, rows, open, secretsReady, plain = false }: { orgCode: string; rows: ConnectorView[]; open: boolean; secretsReady: boolean; plain?: boolean }) {
  return (
    <details open={open} className="group space-y-3 rounded-xl border bg-muted/20 p-4" data-testid="connections-legacy">
      <summary className="cursor-pointer select-none text-sm font-semibold">
        Kết nối cũ / chuyển đổi — Pancake <span className="font-normal text-muted-foreground">· chỉ cho shop ĐANG dùng Pancake; shop mới không cần</span>
      </summary>
      <p className="text-xs leading-5 text-muted-foreground">
        Đang dùng Pancake và muốn chuyển: nối Facebook trực tiếp ở đầu trang, kiểm tin vào Hộp thư {plain ? "của cửa hàng" : "ERP"}, rồi tắt kết nối Pancake của page đó (một page chỉ nhận tin qua một đường). Đồng bộ đơn Pancake POS là kết nối riêng — giữ hay bỏ tuỳ shop.
      </p>
      <OrgPosPanel orgCode={orgCode} />
      {rows.length ? (
        <SectionCard title="Kết nối Pancake" description={plain ? `${rows.length} kết nối` : `${rows.length} connector`} padded={false} contentClassName="overflow-x-auto p-0">
          <ConnectorGroupTable rows={rows} secretsReady={secretsReady} plain={plain} />
        </SectionCard>
      ) : null}
    </details>
  );
}
