/**
 * ═══ ops `vtp-direct-sync-probe` — ĐẾM SAU / TRƯỚC CỦA vtp-direct-sync (2) BẰNG ĐÚNG HÀM CỦA TRANG (CHỈ ĐỌC, 26/10/2026) ═══
 *
 * #1079 thôi đếm vận đơn BỊ THAY THẾ (PKE chưa bàn giao mà đơn đã đi bằng lần gửi khác) ở «chờ lấy», «COD chưa thu», hàng đợi đối
 * chiếu, tháp giao vận, cảnh báo VTP_ORDER_LIST_DUE. Số SAU lấy từ CHÍNH các hàm trang gọi (shipmentFacets · shipmentSummary ·
 * getVtpReconcileQueue · getDeliveryTower · listOrders) với tham số mặc định của trang; số TRƯỚC = SAU + phần bị loại, đo bằng CÙNG
 * mệnh đề `supersededAttemptSql` (không viết luật thứ hai). Không ghi gì (ERP_READ_ONLY), không gọi mạng.
 * Tóm tắt [ops:tom-tat] chỉ số đếm / tiền; mã vận đơn / mã đơn chỉ ở phần MÃ HOÁ.
 * arg: "[--order=<số đơn POS>]" (mặc định 6571 — mẫu đơn «POS huỷ mà hàng vẫn đi»).
 */
export {};

process.env.ERP_READ_ONLY = "1";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s}`);

async function main() {
  const so = Number(process.argv.find((a) => a.startsWith("--order="))?.slice(8) ?? "6571");
  if (!Number.isInteger(so) || so < 1 || so > 9_999_999) {
    tomTat("vtp-direct-sync-probe: --order phải là số đơn POS 1..9999999");
    process.exit(64);
  }
  const { getDb } = await import("@/db");
  const { sql } = await import("drizzle-orm");
  const { rowsOf } = await import("@/lib/sql-rows");
  const { parseListParams } = await import("@/lib/search-params");
  const { shipmentFacets, shipmentSummary, SHIPMENT_SORTABLE } = await import("@/lib/queries/shipments");
  const { getVtpReconcileQueue } = await import("@/lib/queries/vtp-reconcile-queue");
  const { getDeliveryTower } = await import("@/lib/queries/delivery-tower");
  const { listOrders, ORDER_SORTABLE } = await import("@/lib/queries/orders");
  const { supersededAttemptSql } = await import("@/lib/queries/shipment-superseded");
  const db = await getDb();
  const SUP = sql.raw(supersededAttemptSql("s"));

  // Tham số mặc định của trang /shipments (app/(dashboard)/shipments/page.tsx) — kỳ 30 ngày, không lọc.
  const opts = { defaultSort: "createdAt", filterKeys: ["product", "stage", "carrierState", "care", "carrier", "cod", "owner", "source", "final", "linked", "attempt"], sortable: SHIPMENT_SORTABLE, defaultPeriod: "30d" as const };
  const macDinh = parseListParams({}, opts);
  const chiBiThay = parseListParams({ attempt: "superseded" }, opts);
  const [f, fSup, sum] = await Promise.all([shipmentFacets(macDinh), shipmentFacets(chiBiThay), shipmentSummary(macDinh)]);
  const choLay = f.stages.find((x) => x.value === "PENDING")?.count ?? 0;
  const choLayBiThay = fSup.stages.find((x) => x.value === "PENDING")?.count ?? 0;
  const oBiThay = f.attempts.find((x) => x.value === "superseded")?.count ?? 0;
  const tu = macDinh.period.from ? macDinh.period.from.toISOString() : null;
  const [codBiThay] = rowsOf<{ n: number; tien: number }>(
    await db.execute(sql`select count(*)::int as n, coalesce(sum(s.cod_amount), 0)::bigint as tien from shipments s
      where s.cod_status = 'PENDING' and ${SUP} ${tu ? sql`and s.created_at >= ${tu}::timestamptz` : sql``}`),
  );
  tomTat(`/shipments 30 ngày · chờ lấy SAU ${choLay} · TRƯỚC ${choLay + choLayBiThay} (bị thay thế ${choLayBiThay}) · ô «Đã bị thay thế» ${oBiThay}`);
  tomTat(`/shipments 30 ngày · COD chưa thu SAU ${Number(sum.codPending)} ₫ / ${Number(sum.codPendingCount)} vận đơn · TRƯỚC ${Number(sum.codPending) + Number(codBiThay?.tien ?? 0)} ₫ / ${Number(sum.codPendingCount) + Number(codBiThay?.n ?? 0)} vận đơn`);

  // Toàn bộ kho (không kỳ) — số 549 / 363 của phép đo 25/10.
  const [kho] = rowsOf<{ pending: number; pending_cod: number; cancelled: number; cancelled_cod: number }>(
    await db.execute(sql`select count(*) filter (where s.stage = 'PENDING' and not s.is_final)::int as pending,
      coalesce(sum(s.cod_amount) filter (where s.stage = 'PENDING' and not s.is_final), 0)::bigint as pending_cod,
      count(*) filter (where s.stage = 'CANCELLED')::int as cancelled,
      coalesce(sum(s.cod_amount) filter (where s.stage = 'CANCELLED'), 0)::bigint as cancelled_cod
      from shipments s where ${SUP}`),
  );
  tomTat(`toàn kho bị thay thế · PENDING ${kho?.pending ?? 0} (COD ${Number(kho?.pending_cod ?? 0)} ₫) · CANCELLED ${kho?.cancelled ?? 0} (COD ${Number(kho?.cancelled_cod ?? 0)} ₫) — đo 25/10: 549 / 320.647.997 ₫ · 363 / 163.852.000 ₫`);

  // Trang tối đa (hàm tự kẹp ở QUEUE_MAX_PAGES = 20) — bộ đếm theo lý do là của TOÀN tập, không phải trang đang tải.
  const q = await getVtpReconcileQueue(20);
  tomTat(`hàng đợi đối chiếu SAU · ${q.total} kiện · ${Object.entries(q.counts).map(([k, n]) => `${k} ${n}`).join(" · ")}`);
  const [hdTruoc] = rowsOf<{ n: number }>(
    await db.execute(sql`select count(*)::int as n from shipments s where ${SUP} and s.vtp_order_number is not null and s.vtp_order_number <> ''
      and s.stage in ('PENDING','PICKED_UP','IN_TRANSIT','OUT_FOR_DELIVERY','DELIVERY_FAILED','RETURNING')`),
  );
  tomTat(`hàng đợi đối chiếu · vận đơn bị thay thế đang chạy (đã RA khỏi hàng đợi, trước đây là ứng viên «im lặng») ${hdTruoc?.n ?? 0}`);

  const t = await getDeliveryTower();
  const awaiting = t.buckets.find((b) => b.key === "AWAITING_PICKUP");
  tomTat(`tháp giao vận SAU · AWAITING_PICKUP ${awaiting?.count ?? 0} · ngoại lệ ${t.exceptions} / theo dõi ${t.tracked}`);

  const [due] = rowsOf<{ sau: number; truoc: number }>(
    await db.execute(sql`select count(*) filter (where not ${SUP})::int as sau, count(*)::int as truoc from shipments s where s.stage = 'PENDING' and s.is_final = false`),
  );
  tomTat(`VTP_ORDER_LIST_DUE «chờ lấy» · SAU ${due?.sau ?? 0} · TRƯỚC ${due?.truoc ?? 0}`);

  const o = await listOrders(parseListParams({ q: String(so), period: "all" }, { defaultSort: "insertedAt", filterKeys: [], sortable: ORDER_SORTABLE, defaultPeriod: "30d" }));
  const don = o.rows.find((r) => r.systemId === so);
  console.log(`đơn #${so}: ${don ? `stage ${don.stage} · lần gửi chính ${don.shipment?.vtpOrderNumber ?? "—"} (${don.shipment?.stage ?? "—"}) · dòng «POS huỷ — hàng vẫn đang đi» ${don.shippingDespitePosCancel ?? "không"}` : "không tìm thấy"}`);
  tomTat(`/orders đơn mẫu · ${don ? (don.shippingDespitePosCancel !== null ? "CÓ dòng «POS huỷ — hàng vẫn đang đi»" : `KHÔNG có dòng (stage ${don.stage})`) : "không tìm thấy đơn"}`);
  process.stdout.write("", () => process.exit(0));
}

void main().catch((e: unknown) => {
  tomTat(`vtp-direct-sync-probe lỗi: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`);
  process.exit(1);
});
