/**
 * ═══════════ ĐỘ PHỦ ĐỒNG BỘ VIETTEL POST — ERP ĐANG BIẾT BAO NHIÊU (P0 chủ shop 22/10/2026) ═══════════
 *
 * Shop tạo / tạo lại vận đơn thẳng trên viettelpost.vn. VTP KHÔNG cấp API tra cứu cho tài khoản shop (chủ shop chốt
 * 24/09/2026), nên nguồn vào chỉ có WEBHOOK + tệp «Danh sách vận đơn». Màn hình GTC phải nói ra ERP đang đứng trên
 * tập nào: lần đồng bộ cuối của từng nguồn, số vận đơn ERP ghi nhận trong kỳ, bao nhiêu đã gắn đơn, bao nhiêu chưa —
 * và KHÔNG in một «tổng vận đơn trên Viettel Post»: ERP không có cách nào đếm nó ngoài tệp, nên con số đó là
 * `null` = «chưa đo được — cần tệp Danh sách vận đơn» (AGENTS 42: chưa biết không in thành 0).
 *
 * Phân loại vận đơn KHÔNG ĐƠN (độ mịn VẬN ĐƠN, không trộn vào GTC theo đơn):
 *  · chiều hoàn `[số]P[số]` — dòng riêng không đơn là ĐÚNG quy ước (AGENTS 3.7), không phải sự cố;
 *  · lô huỷ — không tham chiếu và ĐVVC đã huỷ (VTP 101 / 107 / 201): lô tạo nhầm, không phải đơn bị bỏ sót;
 *  · chưa ghép được — phần còn lại: việc của người đối chiếu (trang Chất lượng dữ liệu).
 * Mã thử của ĐVVC (`VTP_TEST_TRACKING_CODES`) đứng ngoài mọi nhóm.
 */
import { sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { memo } from "@/lib/cache";
import { PANCAKE_ORDER_SYNC_JOBS } from "@/lib/constants/data-as-of";
import { sqlIsTestTracking } from "@/lib/constants/truth";
import { rowsOf } from "@/lib/sql-rows";

export type VtpSyncCoverage = {
  /** Gói tin webhook Viettel Post cuối cùng ERP nhận được (giờ ERP nhận). */
  lastWebhookAt: Date | null;
  /** Lần NHẬP THẬT (không phải chạy thử) tệp «Danh sách vận đơn» gần nhất. */
  lastFileImportAt: Date | null;
  /** Bảng kê COD (tệp `STATEMENT_DETAIL`) ERP đọc gần nhất — vế TIỀN của ORDER_OUTCOME đứng trên nó. `null` = chưa từng có. */
  lastCodStatementAt: Date | null;
  /** Lượt đồng bộ ĐƠN Pancake THÀNH CÔNG cuối (`sync_runs`, `PANCAKE_ORDER_SYNC_JOBS`). Lượt lỗi / dở dang không tính. */
  lastPancakeSyncAt: Date | null;
  /** Vận đơn VTP ERP ghi nhận lần đầu trong kỳ (theo `shipments.created_at`), trừ mã thử. */
  known: number;
  linked: number;
  returnLegs: number;
  orphanCancelledBatch: number;
  orphanUnmatched: number;
  /** Gói tin webhook VTP xử lý LỖI trong kỳ (`webhook_events.status = 'FAILED'`). */
  syncErrors: number;
  /** Không có API ⇒ ERP không đếm được tổng vận đơn trên viettelpost.vn. Luôn `null`, có câu giải thích. */
  carrierTotal: null;
  carrierTotalNote: string;
};

/**
 * Mốc một tệp bảng kê VTP thật sự được ERP ĐỌC (không phải lần đầu thấy tên tệp): khoá tự nhiên của `vtp_statement_files` là
 * TÊN TỆP, gửi lại đúng tệp cũ chỉ đổi `last_imported_at` còn mốc nhận đứng im. MỘT định nghĩa cho cả thẻ Kết nối dữ liệu
 * (lib/queries/integration-health.ts) lẫn chỉ báo «nguồn» (OD-UX-03). Dựng từ CỘT của lược đồ, không gõ tên cột: trường
 * `receivedAt` nằm ở cột `created_at`, và chép tay tên cột đã từng sai đúng chỗ này.
 */
export const STATEMENT_FILE_SEEN_AT = sql`greatest(${schema.vtpStatementFiles.receivedAt}, coalesce(${schema.vtpStatementFiles.lastImportedAt}, ${schema.vtpStatementFiles.receivedAt}))`;

export const VTP_CARRIER_TOTAL_UNKNOWN = "chưa đo được — cần tệp «Danh sách vận đơn» xuất từ viettelpost.vn";

/** Chiều hoàn `[số]P[số]` — cùng hình dạng với `legBaseCode` (lib/integrations/viettelpost/statement.ts). */
export const RETURN_LEG_SQL = `s.vtp_order_number ~* '^[a-z0-9]{8,}[0-9]?p[0-9]+$'`;
const CANCELLED_BY_CARRIER_SQL = `exists (select 1 from shipment_events ev where ev.shipment_id = s.id and ev.status in ('101','107','201'))`;

export async function getVtpSyncCoverage(period: { from: Date | null; to: Date | null }): Promise<VtpSyncCoverage> {
  const key = ["vtp-sync-coverage", period.from?.toISOString() ?? "-", period.to?.toISOString() ?? "-"].join(":");
  return memo(key, 60_000, () => getVtpSyncCoverageUncached(period));
}

async function getVtpSyncCoverageUncached(period: { from: Date | null; to: Date | null }): Promise<VtpSyncCoverage> {
  const db = await getDb();
  const from = period.from ?? new Date(0);
  const to = period.to ?? new Date("9999-12-31T00:00:00Z");
  const [row] = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select
        count(*)::int as known,
        count(*) filter (where s.order_id is not null)::int as linked,
        count(*) filter (where s.order_id is null and ${sql.raw(RETURN_LEG_SQL)})::int as return_legs,
        count(*) filter (where s.order_id is null and not (${sql.raw(RETURN_LEG_SQL)}) and coalesce(s.order_reference, '') = '' and ${sql.raw(CANCELLED_BY_CARRIER_SQL)})::int as orphan_cancelled,
        count(*) filter (where s.order_id is null and not (${sql.raw(RETURN_LEG_SQL)}) and not (coalesce(s.order_reference, '') = '' and ${sql.raw(CANCELLED_BY_CARRIER_SQL)}))::int as orphan_unmatched,
        (select max(w.received_at) from webhook_events w where w.source = 'VIETTELPOST') as last_webhook_at,
        (select max(b.created_at) from vtp_import_batches b where b.mode = 'APPLY' and b.kind = 'ORDER_LIST') as last_import_at,
        (select max(${STATEMENT_FILE_SEEN_AT}) from ${schema.vtpStatementFiles} where ${schema.vtpStatementFiles.kind} = 'STATEMENT_DETAIL') as last_cod_statement_at,
        (select max(r.finished_at) from sync_runs r where r.source = 'PANCAKE' and r.status = 'SUCCESS' and r.finished_at is not null
           and r.job in (${sql.join(PANCAKE_ORDER_SYNC_JOBS.map((j) => sql`${j}`), sql`, `)})) as last_pancake_sync_at,
        (select count(*)::int from webhook_events w where w.source = 'VIETTELPOST' and w.status = 'FAILED' and w.received_at between ${from} and ${to}) as sync_errors
      from shipments s
      where s.vtp_order_number is not null
        and not (${sql.raw(sqlIsTestTracking("s.vtp_order_number"))})
        and s.created_at between ${from} and ${to}`),
  );
  const n = (v: unknown) => Number(v ?? 0);
  const d = (v: unknown) => (v === null || v === undefined ? null : v instanceof Date ? v : new Date(String(v)));
  return {
    lastWebhookAt: d(row?.last_webhook_at),
    lastFileImportAt: d(row?.last_import_at),
    lastCodStatementAt: d(row?.last_cod_statement_at),
    lastPancakeSyncAt: d(row?.last_pancake_sync_at),
    known: n(row?.known),
    linked: n(row?.linked),
    returnLegs: n(row?.return_legs),
    orphanCancelledBatch: n(row?.orphan_cancelled),
    orphanUnmatched: n(row?.orphan_unmatched),
    syncErrors: n(row?.sync_errors),
    carrierTotal: null,
    carrierTotalNote: VTP_CARRIER_TOTAL_UNKNOWN,
  };
}
