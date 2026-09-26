import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { chayKhongJit, getDb, schema } from "@/db";
import { memo } from "@/lib/cache";
import { STAGE_SINCE_SQL } from "@/lib/constants/shipment-status-age";
import { CARRIER_HANDOFF_AT_SQL } from "@/lib/constants/carrier-handoff";
import { DQ_CHECK_SPECS, isFixable, type DqCheck, type DqCheckSpec } from "@/lib/constants/data-quality-issues";
import { TARGETABLE_METRICS } from "@/lib/constants/metric-registry";
import { IS_MISSING_COGS } from "@/lib/queries/data-quality";
import { csCustomerCond } from "@/lib/queries/cs";
import { reconcileOrderNotCreated } from "@/lib/cs/reconcile-order-created";
import { PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import { MODEL_STATE_LABELS } from "@/lib/constants/model-lifecycle";
import { LIFECYCLE_EVIDENCE_TEXT } from "@/lib/constants/evidence-gaps";
import { listLifecycleEvidenceGaps, listLinkableReceipts } from "@/lib/queries/evidence-gaps";
import { formatDate } from "@/lib/format";

/**
 * ═══════════ ĐẾM CÁC LỖ HỔNG DỮ LIỆU — MỖI PHÉP ĐẾM MỘT LƯỢT ═══════════
 *
 * Mỗi mục trả về ĐỦ năm thứ để hành động: đếm được bao nhiêu · lần gần nhất là khi nào · vài dòng
 * ví dụ · nặng tới đâu · và ai làm gì. Thiếu ví dụ thì người nhận việc phải tự đi tìm; thiếu mốc
 * gần nhất thì không biết vấn đề đang lớn lên hay đã dừng.
 *
 * KHÔNG N+1: mỗi lỗ hổng đúng một truy vấn tổng hợp, và mẫu lấy kèm bằng một truy vấn giới hạn 5
 * dòng. Không có vòng lặp nào chạy truy vấn cho từng dòng.
 */

const s = schema.shipments;
const o = schema.orders;
const oi = schema.orderItems;

export type DqIssueRow = DqCheckSpec & {
  /** `null` = CHƯA ĐẾM ĐƯỢC (nguồn chưa sẵn sàng), KHÁC HẲN 0 = đã đếm và không có gì. */
  count: number | null;
  /** Lần gần nhất gặp. `null` = chưa gặp lần nào, hoặc nguồn không có mốc thời gian. */
  lastSeen: Date | null;
  /** Vài dòng ví dụ để người nhận việc bắt đầu được ngay, không phải tự đi tìm. */
  sample: string[];
  /** Ví dụ MỞ ĐƯỢC: mỗi dòng dẫn thẳng tới đúng chỗ sửa (mẫu, phiếu). Rỗng = mục chỉ có ví dụ chữ. */
  links: { label: string; href: string }[];
  fixable: boolean;
};

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export async function getDataQualityIssues(): Promise<DqIssueRow[]> {
  const db = await getDb();
  return memo("data-quality:issues:v2", 90_000, async () => {
    const dung = (key: DqCheck, r: { count: number | null; lastSeen?: Date | null; sample?: string[]; links?: { label: string; href: string }[] }): DqIssueRow => ({
      ...DQ_CHECK_SPECS[key],
      count: r.count,
      lastSeen: r.lastSeen ?? null,
      sample: r.sample ?? [],
      links: r.links ?? [],
      fixable: isFixable(DQ_CHECK_SPECS[key].kind),
    });

    /* ───── Vận đơn không biết vào chặng hiện tại lúc nào ─────
       CHỈ đếm trên kiện CHƯA tới chặng kết thúc: kiện đã giao xong hay đã hoàn xong thì mốc vào
       chặng không còn là việc của ai, và đếm chúng vào đây sẽ thổi con số lên bằng cả kho lịch sử. */
    // Vị ngữ (truy vấn con tương quan vào shipment_events) đặt ở WHERE, không lặp trong hai
    // `filter`: cùng tập dòng ⇒ cùng `count`/`max`, mỗi kiện chỉ chạy truy vấn con một lần.
    const [changStart] = await db
      .select({
        n: sql<number>`count(*)`,
        lastSeen: sql<Date | null>`max(${s.createdAt})`,
      })
      .from(s)
      .where(sql`${s.stage}::text not in ('DELIVERED','RETURNED','CANCELLED') and ${sql.raw(STAGE_SINCE_SQL)} is null`);
    const changStartMau = await db
      .select({ code: s.vtpOrderNumber, stage: s.stage })
      .from(s)
      .where(sql`${s.stage}::text not in ('DELIVERED','RETURNED','CANCELLED') and ${sql.raw(STAGE_SINCE_SQL)} is null`)
      .orderBy(desc(s.createdAt))
      .limit(5);

    /* ───── Vận đơn chưa có chứng cứ ĐVVC tiếp nhận ───── */
    const [handoff] = await db
      .select({
        n: sql<number>`count(*)`,
        lastSeen: sql<Date | null>`max(${s.createdAt})`,
      })
      .from(s)
      .where(sql`${sql.raw(CARRIER_HANDOFF_AT_SQL)} is null`);
    const handoffMau = await db
      .select({ code: s.vtpOrderNumber, stage: s.stage })
      .from(s)
      .where(sql`${sql.raw(CARRIER_HANDOFF_AT_SQL)} is null`)
      .orderBy(desc(s.createdAt))
      .limit(5);

    /* ───── Vận đơn hoàn lần ra nhiều đơn ───── */
    // Vận đơn chiều về mang `order_id` rỗng và `order_reference` là mã gốc; mã gốc lần ra NHIỀU
    // vận đơn chiều đi có đơn khác nhau ⇒ mơ hồ. Đếm thẳng bằng SQL thay vì dựng lại trong bộ nhớ.
    const mơHồ = sql`${s.orderId} is null and ${s.orderReference} is not null and (
      select count(distinct g.order_id) from shipments g
      where g.vtp_order_number = ${s.orderReference} and g.order_id is not null
    ) > 1`;
    const [ambiguous] = await db.select({ n: sql<number>`count(*)`, lastSeen: sql<Date | null>`max(${s.createdAt})` }).from(s).where(mơHồ);
    const ambiguousMau = await db.select({ code: s.vtpOrderNumber, ref: s.orderReference }).from(s).where(mơHồ).orderBy(desc(s.createdAt)).limit(5);

    /* ───── Dòng tiền chưa phân loại ───── */
    const bt = schema.bankTransactions;
    const chuaPhanLoai = eq(bt.accountingGroup, "UNCLASSIFIED");
    const [bank] = await db.select({ n: sql<number>`count(*)`, lastSeen: sql<Date | null>`max(${bt.txnAt})` }).from(bt).where(chuaPhanLoai);
    const bankMau = await db.select({ ref: bt.bankRef, desc: bt.description }).from(bt).where(chuaPhanLoai).orderBy(desc(bt.txnAt)).limit(5);

    /* ───── Đơn đã giao mà chưa tra được giá vốn ───── */
    /*
      Vị ngữ đặt ở WHERE thay vì lặp trong hai `filter (where …)`: `IS_MISSING_COGS` mang
      `ORDER_OUTCOME` SỐNG + giá vốn, chạy trên MỌI đơn; viết hai lần là mỗi đơn tính hai lần. Cùng
      tập dòng ⇒ cùng kết quả (không dòng nào khớp: `count` = 0, `max` = NULL — như bản cũ).
      TẮT JIT: cùng họ câu kết quả đơn đã đo 95–99 % là JIT biên dịch (docs/perf/JIT-bat-tat-2026-09-23.md).
    */
    const [cogs] = await chayKhongJit(db, (tx) => tx
      .select({ n: sql<number>`count(*)`, lastSeen: sql<Date | null>`max(${o.insertedAt})` })
      .from(o)
      .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
      .where(IS_MISSING_COGS));

    /* ───── Việc chưa nối được về tài khoản ───── */
    // Ba miền, một lượt đọc mỗi miền. Cộng lại thành một con số vì câu hỏi của người quản lý là
    // "còn bao nhiêu việc không biết ai làm", không phải "miền nào thiếu bao nhiêu".
    const cs = schema.csCases;
    const [csThieu] = await db.select({ n: sql<number>`count(*)` }).from(cs).where(isNull(cs.assigneeUserId));
    const care = schema.shipmentCare;
    const [careThieu] = await db.select({ n: sql<number>`count(*)` }).from(care).where(isNull(care.ownerId));

    /* ───── Dòng hàng chưa ghép được mẫu mã ───── */
    const [variant] = await db.select({ n: sql<number>`count(*)` }).from(oi).where(isNull(oi.variantId));
    const variantMau = await db.select({ sku: oi.sku, name: oi.productName }).from(oi).where(isNull(oi.variantId)).limit(5);

    /* ───── Chỉ số đo được nhưng chưa ai đặt đích ───── */
    const daDatDich = await db.selectDistinct({ key: schema.metricTargets.metricKey }).from(schema.metricTargets);
    const coDich = new Set(daDatDich.map((r) => r.key));
    const thieuDich = Object.values(TARGETABLE_METRICS).filter((m) => m.targetable && !coDich.has(m.key));

    /* ───── Kết nối dữ liệu đã lâu không về ───── */
    // Đọc thẳng `sync_runs`: lần chạy THÀNH CÔNG gần nhất của mỗi loại job. Quá 24 giờ là đứng.
    const sr = schema.syncRuns;
    const cu = await db
      .select({ kind: sr.source, lastOk: sql<Date | null>`max(${sr.finishedAt})` })
      .from(sr)
      .where(and(eq(sr.status, "SUCCESS"), isNotNull(sr.finishedAt)))
      .groupBy(sr.source);
    const nguong = Date.now() - 24 * 3600_000;
    const dung24h = cu.filter((r) => r.lastOk && new Date(r.lastOk).getTime() < nguong);

    /* ───── CSKH · "chưa tạo đơn" đã hết lý do tồn tại ─────
       Đọc bằng CHÍNH máy đối chiếu (`reconcileOrderNotCreated` ở chế độ chạy thử), không viết lại
       ba bậc chứng cứ ở đây. Hai bản luật song song sẽ lệch, và cái lệch chỉ lộ ra khi có người
       ngồi so hai màn hình. Con số báo ở đây là phần máy KHÔNG tự đóng được (đã có người nhận
       hoặc đã ghi kết luận) — đó mới là việc của người. */
    const donChuaTao = await reconcileOrderNotCreated({ dryRun: true });

    /* ───── CSKH · một khách chiếm nhiều dòng ───── */
    const cs2 = schema.csCases;
    const khoaKhach = sql`case when ${cs2.customerId} is not null then 'c:' || ${cs2.customerId} when ${cs2.customerPhone} <> '' then 'p:' || ${cs2.customerPhone} else 'x:' || ${cs2.id} end`;
    const trungKhach = await db
      .select({ khoa: sql<string>`${khoaKhach}`, n: sql<number>`count(*)` })
      .from(cs2)
      .where(and(sql`${cs2.status} in ('OPEN','IN_PROGRESS')`, csCustomerCond()))
      .groupBy(khoaKhach)
      .having(sql`count(*) > 1`);
    // Đếm số DÒNG THỪA (tổng case của các nhóm trùng, trừ đi một dòng mỗi nhóm) — đó là con số
    // thật sự dư ra trong hàng đợi, không phải số nhóm.
    const dongThua = trungKhach.reduce((t, r) => t + Number(r.n) - 1, 0);

    /* ───── Hàng hoàn · kết quả lượt đối soát sổ viết tay ─────
       Bảng rỗng (chưa chạy đối soát lần nào) ⇒ đếm 0, KHÔNG phải `null`: 0 ở đây là câu trả lời
       đúng — chưa có dòng nguồn nào thì chưa có dòng nào không khớp. */
    const hmt = schema.hmtReturnReconciliation;
    const [doiSoat] = await db
      .select({
        khongCoKien: sql<number>`count(*) filter (where ${hmt.matchStatus} = 'UNMATCHED_TRACKING')`,
        khongRaMauMa: sql<number>`count(*) filter (where ${hmt.matchStatus} in ('AMBIGUOUS_SKU','SKU_MISMATCH'))`,
        lechSo: sql<number>`count(*) filter (where ${hmt.matchStatus} in ('QUANTITY_CONFLICT','DUPLICATE_SOURCE_ROW','CONFLICT'))`,
        lastSeen: sql<Date | null>`max(${hmt.processedAt})`,
      })
      .from(hmt);
    const hmtMau = await db
      .select({ status: hmt.matchStatus, sheet: hmt.sheet, row: hmt.sourceRow, tracking: hmt.trackingRaw, detail: hmt.detail })
      .from(hmt)
      .where(sql`${hmt.matchStatus} <> 'MATCHED' and ${hmt.matchStatus} <> 'ALREADY_RECEIVED'`)
      .orderBy(desc(hmt.processedAt))
      .limit(15);
    /** Ví dụ của MỘT nhóm lỗi, viết đủ để người mở bảng tính nhảy thẳng tới đúng dòng. */
    const mauTheoNhom = (nhom: string[]) =>
      hmtMau
        .filter((r) => nhom.includes(r.status))
        .slice(0, 5)
        .map((r) => `${r.sheet} dòng ${r.row} · ${r.tracking || "(trống)"} · ${r.detail}`);

    /* ───── Một kiện hoàn có NHIỀU phiếu tái nhập ─────
       Mỗi phiếu cộng tồn một lần; hai phiếu cho một kiện là tồn ảo không hiện ra ở đâu. */
    const sri = schema.stockReceiptItems;
    const trungPhieu = await db
      .select({ shipmentId: sri.shipmentId, n: sql<number>`count(distinct ${sri.receiptId})` })
      .from(sri)
      .where(isNotNull(sri.shipmentId))
      .groupBy(sri.shipmentId)
      .having(sql`count(distinct ${sri.receiptId}) > 1`);

    /* ───── Kiện đã nhận mà không biết trong đó có gì ─────
       `RECEIVED` (chưa đếm) và vận đơn không lần ra dòng hàng nào — kể cả qua mã gốc của vận đơn
       chiều về. Người kho đứng trước kiện và không có gì để so. */
    const ri = schema.returnInspections;
    const khongBietHang = sql`${ri.status} = 'RECEIVED' and not exists (
      select 1 from shipments sh
      join order_items oi2 on oi2.order_id = coalesce(
        sh.order_id,
        (select g.order_id from shipments g where g.vtp_order_number = sh.order_reference and g.order_id is not null limit 1)
      )
      where sh.id = ${ri.shipmentId}
    )`;
    const [muMo] = await db.select({ n: sql<number>`count(*)`, lastSeen: sql<Date | null>`max(${ri.receivedAt})` }).from(ri).where(khongBietHang);
    const muMoMau = await db
      .select({ code: s.vtpOrderNumber, ref: s.orderReference })
      .from(ri)
      .innerJoin(s, eq(s.id, ri.shipmentId))
      .where(khongBietHang)
      .orderBy(desc(ri.receivedAt))
      .limit(5);

    /* ───── Lời khai ≠ chứng cứ (Agent P2) ─────
       Hai phép chiếu tính lúc đọc: luật ở lib/constants/evidence-gaps.ts, dữ kiện ở lib/queries/evidence-gaps.ts. */
    const [khaiKhongChungCu, phieuChuaNoi] = await Promise.all([listLifecycleEvidenceGaps(), listLinkableReceipts()]);
    const mocKhai = khaiKhongChungCu.map((g) => g.stateChangedAt).filter((x): x is Date => !!x);

    return [
      dung("shipment-no-handoff", { count: num(handoff?.n), lastSeen: handoff?.lastSeen ?? null, sample: handoffMau.map((r) => `${r.code ?? "(chưa có mã)"} · ${r.stage}`) }),
      dung("shipment-no-stage-start", {
        count: num(changStart?.n),
        lastSeen: changStart?.lastSeen ?? null,
        sample: changStartMau.map((r) => `${r.code ?? "(chưa có mã)"} · ${r.stage}`),
      }),
      dung("shipment-order-ambiguous", { count: num(ambiguous?.n), lastSeen: ambiguous?.lastSeen ?? null, sample: ambiguousMau.map((r) => `${r.code ?? "?"} ← mã gốc ${r.ref ?? "?"}`) }),
      dung("bank-unclassified", { count: num(bank?.n), lastSeen: bank?.lastSeen ?? null, sample: bankMau.map((r) => `${r.ref} · ${(r.desc ?? "").slice(0, 60)}`) }),
      dung("cogs-unknown", { count: num(cogs?.n), lastSeen: cogs?.lastSeen ?? null }),
      dung("attribution-unknown", { count: (num(csThieu?.n) ?? 0) + (num(careThieu?.n) ?? 0), sample: [`CSKH chưa nối tài khoản: ${num(csThieu?.n) ?? 0}`, `Đợt chăm sóc chưa ai nhận: ${num(careThieu?.n) ?? 0}`] }),
      dung("variant-unmapped", { count: num(variant?.n), sample: variantMau.map((r) => `${r.sku || "(không mã)"} · ${r.name}`) }),
      dung("metric-target-missing", { count: thieuDich.length, sample: thieuDich.slice(0, 5).map((m) => m.label) }),
      dung("integration-stale", { count: dung24h.length, lastSeen: dung24h.length ? new Date(Math.max(...dung24h.map((r) => new Date(r.lastOk!).getTime()))) : null, sample: dung24h.slice(0, 5).map((r) => r.kind) }),
      dung("cs-stale-order-not-created", {
        count: donChuaTao.humanTouched,
        sample: [
          `${donChuaTao.openBefore} case đang mở · ${donChuaTao.closedTotal} máy tự đóng được`,
          `hội thoại đã có đơn: ${donChuaTao.closed.CONVERSATION_HAS_ORDER}`,
          `SĐT đã lên đơn sau: ${donChuaTao.closed.PHONE_ORDERED_AFTER}`,
          `đã có vận đơn gửi tới SĐT: ${donChuaTao.closed.SHIPMENT_CREATED}`,
          `còn treo thật (không chứng cứ): ${donChuaTao.stillPending}`,
        ],
      }),
      dung("cs-duplicate-actionable-customer", {
        count: dongThua,
        sample: trungKhach
          .sort((a, b) => Number(b.n) - Number(a.n))
          .slice(0, 5)
          .map((r) => `${r.khoa} · ${r.n} việc`),
      }),
      dung("return-tracking-not-found", { count: Number(doiSoat?.khongCoKien ?? 0), lastSeen: doiSoat?.lastSeen ?? null, sample: mauTheoNhom(["UNMATCHED_TRACKING"]) }),
      dung("return-sku-unresolved", { count: Number(doiSoat?.khongRaMauMa ?? 0), lastSeen: doiSoat?.lastSeen ?? null, sample: mauTheoNhom(["AMBIGUOUS_SKU", "SKU_MISMATCH"]) }),
      dung("return-qty-mismatch", { count: Number(doiSoat?.lechSo ?? 0), lastSeen: doiSoat?.lastSeen ?? null, sample: mauTheoNhom(["QUANTITY_CONFLICT", "DUPLICATE_SOURCE_ROW", "CONFLICT"]) }),
      dung("return-duplicate-receipt", { count: trungPhieu.length, sample: trungPhieu.slice(0, 5).map((r) => `${r.shipmentId} · ${r.n} phiếu`) }),
      dung("return-received-without-expected-item", { count: num(muMo?.n), lastSeen: muMo?.lastSeen ?? null, sample: muMoMau.map((r) => `${r.code ?? "(chưa có mã)"}${r.ref ? ` ← gốc ${r.ref}` : ""}`) }),
      dung("lifecycle-without-evidence", {
        count: khaiKhongChungCu.length,
        lastSeen: mocKhai.length ? new Date(Math.max(...mocKhai.map((d) => new Date(d).getTime()))) : null,
        sample: khaiKhongChungCu.slice(0, 5).map((g) => `${g.code} · khai “${MODEL_STATE_LABELS[g.state]}” · ${LIFECYCLE_EVIDENCE_TEXT[g.missing].missing}`),
        links: khaiKhongChungCu.slice(0, 5).map((g) => ({ label: `${g.code} — ${LIFECYCLE_EVIDENCE_TEXT[g.missing].action.toLowerCase()} hoặc sửa trạng thái`, href: g.fixStateHref })),
      }),
      dung("receipt-linkable-to-po", {
        count: phieuChuaNoi.length,
        lastSeen: phieuChuaNoi.length ? new Date(Math.max(...phieuChuaNoi.map((r) => r.receivedAt.getTime()))) : null,
        sample: phieuChuaNoi
          .slice(0, 5)
          .map((r) => `Phiếu ${formatDate(r.receivedAt)}${r.reference ? ` · ${r.reference}` : ""} → ${r.candidates.length === 1 ? `lệnh ${r.candidates[0].code}` : `${r.candidates.length} lệnh ứng viên (${r.candidates.map((c) => c.code).join(", ")}) — người chọn`}`),
        links: phieuChuaNoi.slice(0, 5).map((r) => ({
          label: `Phiếu ${formatDate(r.receivedAt)}${r.reference ? ` · ${r.reference}` : ""} → ${r.candidates.length === 1 ? `nối lệnh ${r.candidates[0].code}` : `chọn 1 trong ${r.candidates.length} lệnh`}`,
          href: `/inventory/receipts?receipt=${encodeURIComponent(r.receiptId)}${r.candidates.length === 1 ? `&po=${encodeURIComponent(r.candidates[0].id)}` : ""}#chi-tiet`,
        })),
      }),
    ];
  });
}
