import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { memo } from "@/lib/cache";
import { COD_OVERDUE_DAYS, type SettlementStatus } from "@/lib/constants/cod";
import { ORDER_OUTCOME } from "@/lib/queries/return-rate";
import type { Period } from "@/lib/search-params";

/**
 * ĐỐI SOÁT COD THEO TỪNG ĐƠN — không phải theo từng lần nhập file.
 *
 * Câu hỏi phải trả lời được, đúng theo thứ tự chủ shop cần:
 *   1. Đơn đã phát thành công thì Viettel Post đã trả tiền chưa? Trả ngày nào, sau bao nhiêu ngày?
 *   2. Trả đủ hay trả thiếu so với tiền thu hộ khai báo? Thiếu bao nhiêu?
 *   3. Đơn nào đã giao, có tiền, mà quá hạn vẫn chưa thấy trên bảng kê nào?
 *   4. Cước Viettel Post trừ của đơn đó là bao nhiêu?
 *
 * Nguồn: SỔ CHỨNG TỪ `cod_statement_lines` (từng dòng của từng bảng kê) ghép với vận đơn. Không
 * đọc các cột tiền trên `shipments` vì đó chỉ là ảnh chụp dựng lại từ sổ.
 */

/**
 * `db.execute` trả mảng (PGlite) hoặc `{ rows }` (node-postgres) tuỳ trình điều khiển — đọc thống
 * nhất một chỗ để truy vấn SQL thô chạy đúng ở cả bản chạy thật lẫn bản kiểm thử.
 */
function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

/** Tiền và chứng từ của từng vận đơn, gom từ mọi bảng kê đã nhận. */
const SO_CHUNG_TU = sql`
  select l.shipment_id,
         coalesce(sum(l.cod) filter (where l.cod_reported), 0) as cod_tra,
         coalesce(max(l.fee), 0) as cuoc,
         max(l.statement_at) filter (where l.cod > 0) as ngay_tra,
         (array_agg(l.source_file order by (l.cod > 0) desc, l.statement_at desc))[1] as bang_ke,
         count(*) as so_dong
  from cod_statement_lines l
  where l.shipment_id is not null
  group by l.shipment_id`;

/**
 * Phân loại tình trạng thanh toán của một vận đơn.
 *
 * ĐI TỪ KẾT QUẢ ĐƠN (`ORDER_OUTCOME`), KHÔNG đi từ trạng thái Viettel Post báo. Viettel Post ghi
 * "Giao thành công" cho cả những đơn khách không nhận hàng, chỉ trả tiền ship để xem hàng — bưu tá
 * nhập lại doanh thu bằng đúng số khách đưa. Lấy `stage = DELIVERED` làm căn cứ thì 230 vận đơn
 * kiểu này bị tính là Viettel Post còn nợ 15,9 triệu, trong khi thực thu chỉ 6 triệu và theo quy
 * tắc của shop chúng là ĐƠN HOÀN. Số nợ ảo gần 10 triệu.
 *
 * `GIAO_NHUNG_HOAN` tách riêng chính nhóm đó: Viettel Post báo phát thành công nhưng tiền thực thu
 * dưới ngưỡng nên kết quả đơn là hoàn. Không phải nợ, nhưng phải nhìn thấy được vì đó là hàng đi
 * rồi quay về.
 */
const TINH_TRANG = sql<SettlementStatus>`case
  when coalesce(shipments.cod_amount, 0) <= 0 then 'KHONG_PHAI_TRA'
  when shipments.stage = 'DELIVERED' and ${ORDER_OUTCOME} in ('RETURNED','RETURNED_BY_RULE') then 'GIAO_NHUNG_HOAN'
  when ${ORDER_OUTCOME} in ('RETURNED','RETURNED_BY_RULE','CANCELLED') then 'KHONG_PHAI_TRA'
  when coalesce(t.cod_tra, 0) >= coalesce(shipments.cod_amount, 0) then 'DA_TRA_DU'
  when coalesce(t.cod_tra, 0) > 0 then 'TRA_THIEU'
  when shipments.stage <> 'DELIVERED' then 'CHUA_GIAO'
  when coalesce(shipments.delivered_at, shipments.vtp_status_date) < now() - (${COD_OVERDUE_DAYS} || ' days')::interval then 'QUA_HAN'
  else 'CHUA_TRA' end`;

/** Vận đơn Viettel Post phải trả tiền: kết quả đơn là GIAO THÀNH CÔNG và có thu hộ. */
const PHAI_TRA = sql`(coalesce(shipments.cod_amount, 0) > 0 and ${ORDER_OUTCOME} = 'DELIVERED')`;

/**
 * SỐ TIỀN VIETTEL POST PHẢI TRẢ CHO MỘT ĐƠN.
 *
 * Có dòng bảng kê ⇒ chính là số trên bảng kê: Viettel Post chỉ nợ đúng phần đã thu của khách.
 * Chưa có bảng kê ⇒ TẠM TÍNH theo tiền thu hộ khai báo và phải gắn nhãn ước tính — chưa biết
 * không được biến thành 0, cũng không được coi là con số đã xác minh.
 */
const SO_PHAI_TRA = sql`(case when t.cod_tra is not null then t.cod_tra else coalesce(shipments.cod_amount, 0) end)`;

/** Chỉ xét vận đơn có tiền thu hộ — đơn không thu hộ không có gì để đối soát. */
const CO_THU_HO = sql`coalesce(shipments.cod_amount, 0) > 0`;

function loc(period: Period) {
  if (!period.from || !period.to) return sql`true`;
  return sql`coalesce(shipments.delivered_at, shipments.vtp_status_date, shipments.created_at) between ${period.from} and ${period.to}`;
}

export type CodSettlementSummary = {
  /** Đơn giao thành công có thu hộ — Viettel Post phải trả tiền cho những đơn này. */
  phaiThu: { count: number; amount: number };
  /** Phần của "phải trả" chưa có bảng kê nên đang TẠM TÍNH theo tiền thu hộ khai báo. */
  uocTinh: { count: number; amount: number };
  /** Trong đó bảng kê đã trả bao nhiêu. */
  daTra: { count: number; amount: number };
  /** Phần còn lại chưa thấy trên bảng kê nào. */
  conThieu: number;
  /** Đơn đã giao quá hạn mà chưa có đồng nào trên bảng kê. */
  quaHan: { count: number; amount: number };
  /** Đơn giao thành công mà bảng kê trả ít hơn tiền thu hộ khai báo. */
  traThieu: { count: number; gap: number };
  /** Viettel Post báo phát thành công nhưng tiền thu dưới ngưỡng ⇒ kết quả đơn là hoàn. */
  giaoNhungHoan: { count: number; khaiBao: number; thucThu: number };
  /** Cước Viettel Post trừ trên bảng kê (gồm cả cước chiều hoàn). */
  cuoc: number;
  /** Tiền thực nhận về tài khoản theo phần kết luận của các bảng kê. */
  thucNhan: number;
  /** Tiền trên bảng kê chưa ghép được về vận đơn nào trong ERP. */
  chuaGhep: { count: number; amount: number };
  /** Số ngày trung vị từ lúc phát thành công tới lúc tiền có trên bảng kê. */
  soNgayTraTB: number | null;
  overdueDays: number;
};

export async function codSettlementSummary(period: Period): Promise<CodSettlementSummary> {
  return memo(`cod-settlement:${period.key}:${period.fromKey ?? ""}:${period.toKey ?? ""}`, 90, async () => {
    const db = await getDb();
    const rows = rowsOf(await db.execute(sql`
      with t as (${SO_CHUNG_TU})
      select
        count(*) filter (where ${PHAI_TRA}) phai_thu_count,
        coalesce(sum(${SO_PHAI_TRA}) filter (where ${PHAI_TRA}), 0) phai_thu,
        count(*) filter (where ${PHAI_TRA} and t.cod_tra is null) uoc_tinh_count,
        coalesce(sum(shipments.cod_amount) filter (where ${PHAI_TRA} and t.cod_tra is null), 0) uoc_tinh,
        count(*) filter (where ${PHAI_TRA} and coalesce(t.cod_tra, 0) > 0) da_tra_count,
        coalesce(sum(t.cod_tra) filter (where ${PHAI_TRA}), 0) da_tra,
        count(*) filter (where ${TINH_TRANG} = 'QUA_HAN') qua_han_count,
        coalesce(sum(shipments.cod_amount) filter (where ${TINH_TRANG} = 'QUA_HAN'), 0) qua_han,
        count(*) filter (where ${TINH_TRANG} = 'TRA_THIEU') tra_thieu_count,
        coalesce(sum(shipments.cod_amount - coalesce(t.cod_tra, 0)) filter (where ${TINH_TRANG} = 'TRA_THIEU'), 0) tra_thieu_gap,
        count(*) filter (where ${TINH_TRANG} = 'GIAO_NHUNG_HOAN') gnh_count,
        coalesce(sum(shipments.cod_amount) filter (where ${TINH_TRANG} = 'GIAO_NHUNG_HOAN'), 0) gnh_khai_bao,
        coalesce(sum(t.cod_tra) filter (where ${TINH_TRANG} = 'GIAO_NHUNG_HOAN'), 0) gnh_thuc_thu,
        coalesce(sum(t.cuoc), 0) cuoc,
        percentile_cont(0.5) within group (
          order by extract(epoch from (t.ngay_tra - coalesce(shipments.delivered_at, shipments.vtp_status_date))) / 86400
        ) filter (where t.ngay_tra is not null and coalesce(shipments.delivered_at, shipments.vtp_status_date) is not null) so_ngay_tra
      from shipments
        left join orders on orders.id = shipments.order_id
        left join t on t.shipment_id = shipments.id
      where ${loc(period)}
    `));
    const r = rows[0] ?? {};

    const cg = rowsOf(await db.execute(sql`
      select count(*) n, coalesce(sum(cod), 0) tien from cod_statement_lines where shipment_id is null and cod > 0
    `))[0] ?? {};

    const tn = rowsOf(await db.execute(sql`
      select coalesce(sum(total_amount), 0) tien from cod_batches
      ${period.from && period.to ? sql`where received_at between ${period.from} and ${period.to}` : sql``}
    `))[0] ?? {};

    const n = (v: unknown) => Number(v ?? 0);
    const phaiThu = n(r.phai_thu);
    const daTra = n(r.da_tra);
    return {
      phaiThu: { count: n(r.phai_thu_count), amount: phaiThu },
      uocTinh: { count: n(r.uoc_tinh_count), amount: n(r.uoc_tinh) },
      daTra: { count: n(r.da_tra_count), amount: daTra },
      conThieu: Math.max(0, phaiThu - daTra),
      quaHan: { count: n(r.qua_han_count), amount: n(r.qua_han) },
      traThieu: { count: n(r.tra_thieu_count), gap: n(r.tra_thieu_gap) },
      giaoNhungHoan: { count: n(r.gnh_count), khaiBao: n(r.gnh_khai_bao), thucThu: n(r.gnh_thuc_thu) },
      cuoc: n(r.cuoc),
      thucNhan: n(tn.tien),
      chuaGhep: { count: n(cg.n), amount: n(cg.tien) },
      soNgayTraTB: r.so_ngay_tra === null || r.so_ngay_tra === undefined ? null : Math.round(Number(r.so_ngay_tra) * 10) / 10,
      overdueDays: COD_OVERDUE_DAYS,
    };
  });
}

export type CodSettlementRow = {
  id: string;
  vtpOrderNumber: string | null;
  orderId: string | null;
  systemId: number | null;
  customer: string;
  stage: string;
  deliveredAt: string | null;
  codDeclared: number;
  codPaid: number;
  fee: number;
  paidAt: string | null;
  statementFile: string | null;
  gap: number;
  waitingDays: number | null;
  status: SettlementStatus;
};

/** Danh sách đối soát theo vận đơn, lọc theo tình trạng thanh toán. */
export async function listCodSettlement(opts: { period: Period; status?: SettlementStatus | "ALL"; q?: string; page?: number; pageSize?: number }) {
  const db = await getDb();
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(200, Math.max(10, opts.pageSize ?? 50));
  const status = opts.status && opts.status !== "ALL" ? opts.status : null;
  const q = (opts.q ?? "").trim();
  const tim = q
    ? sql`and (upper(shipments.vtp_order_number) like ${`%${q.toUpperCase()}%`}
        or upper(shipments.tracking_code) like ${`%${q.toUpperCase()}%`}
        or shipments.receiver_phone like ${`%${q}%`}
        or upper(coalesce(orders.bill_full_name, '')) like ${`%${q.toUpperCase()}%`})`
    : sql``;
  const theoTinhTrang = status ? sql`and ${TINH_TRANG} = ${status}` : sql``;

  const list = rowsOf(await db.execute(sql`
    with t as (${SO_CHUNG_TU})
    select shipments.id, shipments.vtp_order_number, shipments.order_id, orders.system_id,
           coalesce(orders.bill_full_name, shipments.receiver_name, '') customer,
           shipments.stage::text stage, coalesce(shipments.delivered_at, shipments.vtp_status_date)::date::text delivered_at,
           coalesce(shipments.cod_amount, 0) cod_declared, coalesce(t.cod_tra, 0) cod_paid, coalesce(t.cuoc, 0) fee,
           t.ngay_tra::date::text paid_at, t.bang_ke statement_file,
           coalesce(shipments.cod_amount, 0) - coalesce(t.cod_tra, 0) gap,
           case when coalesce(shipments.delivered_at, shipments.vtp_status_date) is null then null
                else round(extract(epoch from (coalesce(t.ngay_tra, now()) - coalesce(shipments.delivered_at, shipments.vtp_status_date))) / 86400) end waiting_days,
           ${TINH_TRANG} status
    from shipments
      left join orders on orders.id = shipments.order_id
      left join t on t.shipment_id = shipments.id
    where ${CO_THU_HO} and ${loc(opts.period)} ${theoTinhTrang} ${tim}
    order by (${TINH_TRANG} = 'QUA_HAN') desc, coalesce(shipments.delivered_at, shipments.vtp_status_date) desc nulls last
    limit ${pageSize} offset ${(page - 1) * pageSize}
  `));

  const total = Number(rowsOf(await db.execute(sql`
    with t as (${SO_CHUNG_TU})
    select count(*) n from shipments
      left join orders on orders.id = shipments.order_id
      left join t on t.shipment_id = shipments.id
    where ${CO_THU_HO} and ${loc(opts.period)} ${theoTinhTrang} ${tim}
  `))[0]?.n ?? 0);

  return {
    rows: list.map((r): CodSettlementRow => ({
      id: String(r.id),
      vtpOrderNumber: (r.vtp_order_number as string | null) ?? null,
      orderId: (r.order_id as string | null) ?? null,
      systemId: r.system_id === null || r.system_id === undefined ? null : Number(r.system_id),
      customer: String(r.customer ?? ""),
      stage: String(r.stage ?? ""),
      deliveredAt: (r.delivered_at as string | null) ?? null,
      codDeclared: Number(r.cod_declared ?? 0),
      codPaid: Number(r.cod_paid ?? 0),
      fee: Number(r.fee ?? 0),
      paidAt: (r.paid_at as string | null) ?? null,
      statementFile: (r.statement_file as string | null) ?? null,
      gap: Number(r.gap ?? 0),
      waitingDays: r.waiting_days === null || r.waiting_days === undefined ? null : Number(r.waiting_days),
      status: String(r.status ?? "CHUA_TRA") as SettlementStatus,
    })),
    total,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}

/** Đếm theo từng tình trạng để hiện số trên tab. */
export async function codSettlementCounts(period: Period): Promise<Record<SettlementStatus, number> & { ALL: number }> {
  const db = await getDb();
  const list = rowsOf(await db.execute(sql`
    with t as (${SO_CHUNG_TU})
    select ${TINH_TRANG} status, count(*) n
    from shipments
      left join orders on orders.id = shipments.order_id
      left join t on t.shipment_id = shipments.id
    where ${CO_THU_HO} and ${loc(period)}
    group by 1
  `));
  const out = { ALL: 0, DA_TRA_DU: 0, TRA_THIEU: 0, CHUA_TRA: 0, QUA_HAN: 0, CHUA_GIAO: 0, GIAO_NHUNG_HOAN: 0, KHONG_PHAI_TRA: 0 } as Record<SettlementStatus, number> & { ALL: number };
  for (const r of list) {
    const key = String(r.status) as SettlementStatus;
    if (key in out) out[key] = Number(r.n ?? 0);
    out.ALL += Number(r.n ?? 0);
  }
  return out;
}

export type StatementPayment = {
  filename: string;
  batchReference: string | null;
  /** Ngày Viettel Post chốt trả tiền (phần kết luận của bảng kê). */
  paidOn: string | null;
  /** Khoảng ngày phát thành công mà bảng kê này chi trả. */
  periodFrom: string | null;
  periodTo: string | null;
  codTotal: number;
  feeTotal: number;
  netTotal: number;
  lines: number;
  matched: number;
  codMatched: number;
  codUnmatched: number;
};

/**
 * Từng bảng kê = một lần Viettel Post trả tiền. Số tổng lấy từ đợt tiền về do chính bảng kê lập
 * (phần KẾT LUẬN ĐỐI SOÁT), phần ghép được lấy từ sổ chứng từ.
 */
export async function listStatementPayments(limit = 40): Promise<StatementPayment[]> {
  const db = await getDb();
  const list = rowsOf(await db.execute(sql`
    select max(l.source_file) filename,
           l.statement_key,
           max(b.reference) batch_reference,
           max(b.received_at)::date::text paid_on,
           min(l.paid_date) period_from,
           max(l.paid_date) period_to,
           coalesce(max(b.cod_gross), 0) cod_total,
           coalesce(max(b.fee_total), 0) fee_total,
           coalesce(max(b.total_amount), 0) net_total,
           count(*) lines,
           count(*) filter (where l.shipment_id is not null) matched,
           coalesce(sum(l.cod) filter (where l.shipment_id is not null), 0) cod_matched,
           coalesce(sum(l.cod) filter (where l.shipment_id is null), 0) cod_unmatched
    from cod_statement_lines l
    left join cod_batches b on b.id = l.batch_id
    group by l.statement_key, l.source_file
    order by max(coalesce(b.received_at, l.statement_at)) desc
    limit ${limit}
  `));
  return list.map((r) => ({
    filename: String(r.filename ?? ""),
    batchReference: (r.batch_reference as string | null) ?? null,
    paidOn: (r.paid_on as string | null) ?? null,
    periodFrom: (r.period_from as string | null) ?? null,
    periodTo: (r.period_to as string | null) ?? null,
    codTotal: Number(r.cod_total ?? 0),
    feeTotal: Number(r.fee_total ?? 0),
    netTotal: Number(r.net_total ?? 0),
    lines: Number(r.lines ?? 0),
    matched: Number(r.matched ?? 0),
    codMatched: Number(r.cod_matched ?? 0),
    codUnmatched: Number(r.cod_unmatched ?? 0),
  }));
}

/**
 * NGÀY GIAO CHƯA ĐƯỢC BẢNG KÊ NÀO PHỦ — suy từ dữ liệu thật, không suy từ lịch trả tiền.
 *
 * Có đơn phát thành công trong ngày đó mà không dòng bảng kê nào nhắc tới ⇒ hoặc Viettel Post
 * chưa trả, hoặc thư bảng kê của kỳ đó chưa về ERP. Gom ngày liền nhau thành khoảng cho dễ đọc.
 */
export async function statementGapDays(): Promise<{ from: string; to: string; shipments: number; amount: number }[]> {
  const db = await getDb();
  const list = rowsOf(await db.execute(sql`
    with t as (${SO_CHUNG_TU})
    select coalesce(shipments.delivered_at, shipments.vtp_status_date)::date::text ngay,
           count(*) n, coalesce(sum(shipments.cod_amount), 0) tien
    from shipments
      left join orders on orders.id = shipments.order_id
      left join t on t.shipment_id = shipments.id
    where ${PHAI_TRA} and t.cod_tra is null
      and coalesce(shipments.delivered_at, shipments.vtp_status_date) is not null
    group by 1 order by 1
  `));
  const out: { from: string; to: string; shipments: number; amount: number }[] = [];
  for (const d of list) {
    const day = String(d.ngay);
    const last = out[out.length - 1];
    const cach = last ? (Date.parse(day) - Date.parse(last.to)) / 86_400_000 : Infinity;
    if (last && cach <= 2) {
      last.to = day;
      last.shipments += Number(d.n ?? 0);
      last.amount += Number(d.tien ?? 0);
    } else {
      out.push({ from: day, to: day, shipments: Number(d.n ?? 0), amount: Number(d.tien ?? 0) });
    }
  }
  return out;
}

export type MissingStatement = {
  from: string;
  to: string;
  /** Đơn giao thành công trong khoảng này chưa được bảng kê nào chi trả. */
  shipments: number;
  amount: number;
};

/**
 * KHOẢNG NGÀY THIẾU BẢNG KÊ.
 *
 * Các bảng kê đã nhận phủ liên tục các ngày phát thành công; chỗ nào hụt ở GIỮA hai bảng kê là
 * Viettel Post gửi thiếu thư (hoặc thư chưa về ERP). Chỉ xét trong khoảng đã có bảng kê — ngày mới
 * nhất chưa tới kỳ chốt thì không phải là thiếu, đó là "chờ trả".
 *
 * Trả lời đúng câu hỏi vận hành: cần lên Viettel Post tải bảng kê của những ngày nào về bổ sung.
 */
export async function missingStatementPeriods(): Promise<MissingStatement[]> {
  const db = await getDb();
  const list = rowsOf(await db.execute(sql`
    with ky as (
      -- Mỗi bảng kê phủ MỘT KHOẢNG ngày phát, không phải từng ngày rời rạc: trong khoảng đó có thể
      -- có ngày không đơn nào được chi trả, đó là Viettel Post chưa trả (xem nhóm "Quá hạn"), chứ
      -- không phải thiếu bảng kê.
      select statement_key, min(paid_date::date) tu, max(paid_date::date) den
      from cod_statement_lines where paid_date is not null group by statement_key
    ), bien as (
      select min(tu) tu, max(den) den from ky
    ), don as (
      select coalesce(shipments.delivered_at, shipments.vtp_status_date)::date ngay,
             count(*) n, coalesce(sum(shipments.cod_amount), 0) tien
      from shipments
        left join orders on orders.id = shipments.order_id
        left join (${SO_CHUNG_TU}) t on t.shipment_id = shipments.id
      where ${PHAI_TRA} and t.cod_tra is null
        and coalesce(shipments.delivered_at, shipments.vtp_status_date) is not null
      group by 1
    )
    select don.ngay::text ngay, don.n, don.tien
    from don, bien
    where don.ngay between bien.tu and bien.den
      and not exists (select 1 from ky where don.ngay between ky.tu and ky.den)
    order by 1
  `));
  const out: MissingStatement[] = [];
  for (const d of list) {
    const day = String(d.ngay);
    const last = out[out.length - 1];
    const cach = last ? (Date.parse(day) - Date.parse(last.to)) / 86_400_000 : Infinity;
    if (last && cach <= 2) {
      last.to = day;
      last.shipments += Number(d.n ?? 0);
      last.amount += Number(d.tien ?? 0);
    } else {
      out.push({ from: day, to: day, shipments: Number(d.n ?? 0), amount: Number(d.tien ?? 0) });
    }
  }
  return out;
}
