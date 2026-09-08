import { createHash } from "node:crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { vnStartOfDay } from "@/lib/format";
import { legBaseCode, mergeVtpOrderLists, vtpSaysCodReceived, type CodPaymentSummary, type StatementDetailRow, type StatementSummary, type VtpOrderListRow } from "@/lib/integrations/viettelpost/statement";
import { materializeShipmentState } from "@/lib/integrations/viettelpost/state";
import { resolveVtpStatus } from "@/lib/integrations/viettelpost/status";

/** Tạo / cập nhật đợt nhận tiền theo mã bảng kê (tổng hợp, chưa cần chi tiết vận đơn) */
/**
 * Ghi đợt nhận tiền từ bảng kê.
 *
 * `preserveExisting` dùng cho luồng nhập CHI TIẾT: khi đợt đã tồn tại (nhập từ bảng kê tổng hợp)
 * thì số của đợt là số trên chứng từ gốc, KHÔNG được ghi đè bằng số cộng từ file chi tiết hay
 * bằng ngày mặc định của form. Trước đây nhập chi tiết đè cả ngày về lẫn tổng tiền của đợt,
 * tức xoá mất số thật đang hiển thị ở bảng đối soát.
 */
export async function upsertStatementBatches(rows: StatementSummary[], createdBy: string, options: { preserveExisting?: boolean } = {}) {
  const db = await getDb();
  let created = 0;
  let updated = 0;
  for (const r of rows) {
    const values = {
      reference: r.reference,
      carrier: "Viettel Post",
      receivedAt: vnStartOfDay(r.receivedAt),
      totalAmount: r.netAmount,
      codGross: r.codGross,
      feeTotal: r.feeTotal,
      source: "VTP_STATEMENT",
      createdBy,
    };
    const existing = await db.query.codBatches.findFirst({ where: eq(schema.codBatches.reference, r.reference), columns: { id: true } });
    if (existing) {
      if (options.preserveExisting) {
        // Chỉ điền ô còn trống; không đụng ngày về và các số đã có từ chứng từ gốc.
        await db
          .update(schema.codBatches)
          .set({
            totalAmount: sql`case when ${schema.codBatches.totalAmount} = 0 then ${values.totalAmount} else ${schema.codBatches.totalAmount} end`,
            codGross: sql`case when ${schema.codBatches.codGross} = 0 then ${values.codGross} else ${schema.codBatches.codGross} end`,
            feeTotal: sql`case when ${schema.codBatches.feeTotal} = 0 then ${values.feeTotal} else ${schema.codBatches.feeTotal} end`,
          })
          .where(eq(schema.codBatches.id, existing.id));
      } else {
      await db.update(schema.codBatches).set({ receivedAt: values.receivedAt, totalAmount: values.totalAmount, codGross: values.codGross, feeTotal: values.feeTotal, source: values.source }).where(eq(schema.codBatches.id, existing.id));
      }
      updated += 1;
    } else {
      await db.insert(schema.codBatches).values({ ...values, note: "Bảng kê Viettel Post" });
      created += 1;
    }
  }
  return { created, updated };
}

/**
 * ĐỢT TIỀN VỀ LẬP TỪ CHÍNH BẢNG KÊ.
 *
 * Trước đây chủ shop phải gõ tay số tổng của từng đợt rồi ERP ghép file với đợt BẰNG CÁCH SO TIỀN
 * — thủ công, và ghép nhầm ngay khi hai đợt trùng số. Nay phần "KẾT LUẬN ĐỐI SOÁT" in sẵn trong
 * tệp cho đủ ba số và ngày chốt, nên mỗi tệp bảng kê tự là một đợt tiền về.
 *
 * Khoá tự nhiên là NGÀY CHỐT của bảng kê: Viettel Post mỗi ngày chốt trả một lần. Nếu đã có đợt
 * gõ tay đúng ngày và đúng số tiền thì nhận lại đợt đó thay vì tạo bản trùng.
 */
export async function upsertBatchFromStatementFile(filename: string, summary: CodPaymentSummary, actor: string) {
  const db = await getDb();
  const ngay = summary.statementDate;
  if (!ngay || summary.netTotal <= 0) return null;
  const receivedAt = vnStartOfDay(ngay);
  const reference = `BK-${ngay}`;

  // Đợt gõ tay cùng ngày & cùng số tiền chính là đợt này — nhận lại, không tạo bản trùng.
  const [trung] = await db
    .select({ id: schema.codBatches.id, reference: schema.codBatches.reference })
    .from(schema.codBatches)
    .where(and(eq(schema.codBatches.receivedAt, receivedAt), eq(schema.codBatches.totalAmount, summary.netTotal)))
    .limit(1);

  const values = {
    carrier: "Viettel Post" as const,
    receivedAt,
    totalAmount: summary.netTotal,
    codGross: summary.codTotal,
    feeTotal: summary.feeTotal,
    source: "VTP_STATEMENT_MAIL",
    note: filename,
    createdBy: actor,
  };
  if (trung) {
    await db.update(schema.codBatches).set(values).where(eq(schema.codBatches.id, trung.id));
    return { id: trung.id, reference: trung.reference, created: false };
  }
  const [moi] = await db
    .insert(schema.codBatches)
    .values({ ...values, reference })
    .onConflictDoUpdate({ target: schema.codBatches.reference, set: values })
    .returning({ id: schema.codBatches.id, reference: schema.codBatches.reference });
  const row = moi ?? (await db.query.codBatches.findFirst({ where: eq(schema.codBatches.reference, reference), columns: { id: true, reference: true } }));
  return row ? { id: row.id, reference: row.reference, created: true } : null;
}

export type DetailMatch = StatementDetailRow & { shipmentId: string | null; orderId: string | null; orderLabel: string; codStatus: string | null; codAmount: number };

/** Ghép từng dòng bảng kê với vận đơn trong ERP (mã VTP hoặc mã vận đơn) */
export async function matchStatementRows(rows: StatementDetailRow[]): Promise<DetailMatch[]> {
  const db = await getDb();
  const codes = [...new Set(rows.map((r) => r.trackingCode))];
  const found = codes.length
    ? await db
        .select({ id: schema.shipments.id, orderId: schema.shipments.orderId, vtp: schema.shipments.vtpOrderNumber, tracking: schema.shipments.trackingCode, codStatus: schema.shipments.codStatus, codAmount: schema.shipments.codAmount, systemId: schema.orders.systemId, name: schema.orders.billFullName })
        .from(schema.shipments)
        .leftJoin(schema.orders, eq(schema.orders.id, schema.shipments.orderId))
        .where(or(inArray(sql`upper(${schema.shipments.vtpOrderNumber})`, codes), inArray(sql`upper(${schema.shipments.trackingCode})`, codes)))
    : [];
  const byCode = new Map<string, (typeof found)[number]>();
  for (const f of found) {
    if (f.vtp) byCode.set(f.vtp.toUpperCase(), f);
    if (f.tracking) byCode.set(f.tracking.toUpperCase(), f);
  }
  return rows.map((r) => {
    const f = byCode.get(r.trackingCode);
    return { ...r, shipmentId: f?.id ?? null, orderId: f?.orderId ?? null, orderLabel: f ? `#${f.systemId ?? ""} ${f.name ?? ""}`.trim() : "", codStatus: f?.codStatus ?? null, codAmount: f?.codAmount ?? 0 };
  });
}

/** Áp chi tiết bảng kê: gắn vận đơn vào đợt, đánh dấu đã về ngân hàng, ghi cước thực tế */
export async function applyStatementDetail(summary: StatementSummary, rows: StatementDetailRow[], createdBy: string) {
  const db = await getDb();
  const matches = await matchStatementRows(rows);
  const matched = matches.filter((m) => m.shipmentId);
  const codGross = summary.codGross || rows.reduce((a, r) => a + r.cod, 0);
  const feeTotal = summary.feeTotal || rows.reduce((a, r) => a + r.fee, 0);
  const net = summary.netAmount || codGross - feeTotal;
  await upsertStatementBatches([{ ...summary, codGross, feeTotal, netAmount: net }], createdBy, { preserveExisting: true });
  const batch = await db.query.codBatches.findFirst({ where: eq(schema.codBatches.reference, summary.reference), columns: { id: true, receivedAt: true } });
  if (!batch) throw new Error("Không tạo được đợt nhận tiền");
  const now = new Date();
  let updatedShipments = 0;
  for (const m of matched) {
    await db
      .update(schema.shipments)
      .set({
        codStatus: "PAID_TO_BANK",
        codPaidToBankAt: batch.receivedAt,
        codBatchId: batch.id,
        codReconciledAt: sql`coalesce(${schema.shipments.codReconciledAt}, ${now})`,
        codCollected: m.cod > 0 ? m.cod : sql`case when ${schema.shipments.codCollected} = 0 then ${schema.shipments.codAmount} else ${schema.shipments.codCollected} end`,
        shippingFee: m.fee > 0 ? m.fee : schema.shipments.shippingFee,
        updatedAt: now,
      })
      .where(eq(schema.shipments.id, m.shipmentId as string));
    if (m.orderId && m.fee > 0) await db.update(schema.orders).set({ partnerFee: m.fee }).where(eq(schema.orders.id, m.orderId));
    updatedShipments += 1;
  }
  return { batchId: batch.id, matched: matched.length, unmatched: matches.length - matched.length, updatedShipments, codGross, feeTotal, net };
}

// ───────── Danh sách vận đơn (Quản lý vận đơn → xuất Excel) ─────────

export type OrderListMatch = VtpOrderListRow & {
  shipmentId: string | null;
  orderLabel: string;
  currentStage: string | null;
  currentCod: string | null;
  mapped: ReturnType<typeof resolveVtpStatus>;
  /**
   * direct = khớp mã vận đơn trong ERP;
   * leg    = vận đơn chiều về của vận đơn gốc (ghi thành vận đơn riêng, không đè trạng thái đơn gốc);
   * phone  = ERP có đơn nhưng vận đơn CHƯA có mã (shop tạo đơn thẳng trên web VTP), khớp theo SĐT người nhận.
   */
  matchKind: "direct" | "leg" | "phone" | null;
  /** Mã vận đơn gốc khi đây là vận đơn chiều về */
  legOf: string | null;
  matchIssue?: string;
};

/** 9 số cuối: đủ phân biệt thuê bao mà không lệ thuộc 0/84/+84 hay khoảng trắng. */
function phoneKey(value: string | null | undefined): string {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length >= 9 ? digits.slice(-9) : "";
}

export async function matchVtpOrderList(rows: VtpOrderListRow[]): Promise<OrderListMatch[]> {
  const db = await getDb();
  // File VTP để mã vận đơn chiều về ("…1P1") ở cột Mã Vận Đơn, mã gốc ở cột Mã đơn hàng → tra cả ba dạng
  const codes = [...new Set(rows.flatMap((r) => [r.trackingCode, r.orderCode, legBaseCode(r.trackingCode)]).filter(Boolean))];
  const found = codes.length
    ? await db
        .select({ id: schema.shipments.id, vtp: schema.shipments.vtpOrderNumber, tracking: schema.shipments.trackingCode, stage: schema.shipments.stage, codStatus: schema.shipments.codStatus, systemId: schema.orders.systemId, name: schema.orders.billFullName })
        .from(schema.shipments)
        .leftJoin(schema.orders, eq(schema.orders.id, schema.shipments.orderId))
        .where(or(inArray(sql`upper(${schema.shipments.vtpOrderNumber})`, codes), inArray(sql`upper(${schema.shipments.trackingCode})`, codes)))
    : [];
  const byCode = new Map<string, (typeof found)[number]>();
  const ambiguous = new Set<string>();
  for (const f of found) {
    for (const code of [f.vtp, f.tracking].filter((c): c is string => Boolean(c))) {
      const key = code.toUpperCase();
      if (byCode.has(key) && byCode.get(key)!.id !== f.id) ambiguous.add(key);
      byCode.set(key, f);
    }
  }
  // Shop tạo đơn thẳng trên web Viettel Post: ERP có đơn (từ Pancake/POS) nhưng vận đơn CHƯA có mã,
  // còn cột "Mã đơn hàng" của file là mã VTP tự sinh nên không tra ngược được. Bằng chứng còn lại là
  // SĐT người nhận — dùng nó để gắn mã vào đúng vận đơn thay vì bỏ rơi cả dòng.
  const needPhone = new Set(
    rows
      .filter((r) => !legBaseCode(r.trackingCode) && !byCode.has(r.trackingCode) && !byCode.has(r.orderCode))
      .map((r) => phoneKey(r.receiverPhone))
      .filter(Boolean),
  );
  const NO_CODE = sql`coalesce(nullif(${schema.shipments.vtpOrderNumber}, ''), nullif(${schema.shipments.trackingCode}, '')) is null`;
  const SHIPMENT_PHONE = sql<string>`right(regexp_replace(coalesce(nullif(${schema.shipments.receiverPhone}, ''), nullif(${schema.orders.shipPhone}, ''), ${schema.orders.billPhone}, ''), '[^0-9]', '', 'g'), 9)`;
  const codeless = needPhone.size
    ? await db
        .select({ id: schema.shipments.id, cod: schema.shipments.codAmount, phone: SHIPMENT_PHONE,
          stage: schema.shipments.stage, codStatus: schema.shipments.codStatus, systemId: schema.orders.systemId, name: schema.orders.billFullName })
        .from(schema.shipments)
        .leftJoin(schema.orders, eq(schema.orders.id, schema.shipments.orderId))
        .where(and(NO_CODE, inArray(SHIPMENT_PHONE, [...needPhone])))
    : [];
  const byPhone = new Map<string, typeof codeless>();
  for (const c of codeless) {
    const list = byPhone.get(c.phone) ?? [];
    list.push(c);
    byPhone.set(c.phone, list);
  }

  return rows.map((r) => {
    // Mã có đuôi P (…1P1) là vận đơn CHIỀU VỀ: cột "Mã đơn hàng" của file chính là mã gốc, tin hơn suy từ chuỗi.
    // Phải xét chiều về TRƯỚC, nếu không mã gốc ở cột "Mã đơn hàng" sẽ bị coi là khớp trực tiếp và đè trạng thái đơn gốc.
    const isLeg = Boolean(legBaseCode(r.trackingCode));
    const base = isLeg ? r.orderCode || legBaseCode(r.trackingCode) : "";
    const direct = isLeg ? undefined : byCode.get(r.trackingCode);
    const leg = isLeg && base ? byCode.get(base) : undefined;
    const usedCode = isLeg ? base : r.trackingCode;
    const conflictingReferences = !isLeg && byCode.has(r.trackingCode) && byCode.has(r.orderCode) && byCode.get(r.trackingCode)!.id !== byCode.get(r.orderCode)!.id;
    let matchIssue = ambiguous.has(usedCode) || conflictingReferences ? "Mã tham chiếu ghép được nhiều vận đơn; cần đối chiếu" : undefined;
    // Chỉ xét SĐT khi mã không ghép được — mã vẫn là bằng chứng mạnh hơn.
    let byPhoneMatch: (typeof codeless)[number] | undefined;
    if (!matchIssue && !direct && !leg && !isLeg) {
      const key = phoneKey(r.receiverPhone);
      const all = key ? byPhone.get(key) ?? [] : [];
      // Nhiều đơn cùng SĐT thì lấy đúng đơn có COD khai báo trùng khít; vẫn nhập nhằng thì không đoán.
      const exact = r.cod === null ? [] : all.filter((c) => Number(c.cod) === r.cod);
      const narrowed = exact.length ? exact : all;
      if (narrowed.length === 1) byPhoneMatch = narrowed[0];
      else if (narrowed.length > 1) matchIssue = `SĐT ${r.receiverPhone} có ${narrowed.length} vận đơn chưa có mã; cần đối chiếu`;
    }
    const f = matchIssue ? undefined : direct ?? leg ?? byPhoneMatch;
    return {
      ...r,
      shipmentId: f?.id ?? null,
      orderLabel: f ? `#${f.systemId ?? ""} ${f.name ?? ""}`.trim() : "",
      currentStage: f?.stage ?? null,
      currentCod: f?.codStatus ?? null,
      // Tệp xuất từ viettelpost.vn không có mã số trạng thái, chỉ có chữ — nhưng vẫn đi qua ĐÚNG
      // bộ dịch mà webhook dùng, để cùng một trạng thái của ĐVVC không cho ra hai kết luận.
      mapped: resolveVtpStatus({ code: null, text: r.statusText }),
      matchKind: f ? (direct ? "direct" : leg ? "leg" : "phone") : null,
      legOf: leg ? (leg.vtp ?? base) : null,
      matchIssue,
    };
  });
}

/** Danh sách vận đơn cập nhật logistics/COD khai báo; không chứng minh tiền thực thu hay ngân hàng. */
export async function applyVtpOrderList(rows: VtpOrderListRow[], actor = "VTP_IMPORT") {
  const db = await getDb();
  const matches = await matchVtpOrderList(mergeVtpOrderLists(rows));
  const now = new Date();
  let updated = 0;
  let legs = 0;
  /** Vận đơn ERP chưa có mã, nay được gắn mã nhờ SĐT người nhận trên file. */
  let linked = 0;
  let stale = 0;
  let duplicate = 0;
  let missingDate = 0;
  let conflicts = matches.filter((m) => m.matchIssue).length;
  for (const m of [...matches].sort((a, b) => a.trackingCode.localeCompare(b.trackingCode))) {
    if (!m.shipmentId || m.mapped.stage === "UNKNOWN") continue;
    const occurredAt = m.statusAt ? new Date(m.statusAt) : m.statusDate ? vnStartOfDay(m.statusDate) : null;
    if (!occurredAt || !Number.isFinite(occurredAt.getTime())) { missingDate++; continue; }
    const result = await db.transaction(async (tx) => {
      const isLeg = m.matchKind === "leg";
      if (isLeg) {
        // Không sinh số 0 thay cho ô chưa biết trong schema shipments legacy NOT NULL.
        if (m.cod === null || m.fee === null) return "conflict";
        await tx.insert(schema.shipments).values({ carrier: "Viettel Post", vtpOrderNumber: m.trackingCode,
          trackingCode: m.trackingCode, orderReference: m.legOf, codAmount: m.cod, shippingFee: m.fee,
          codStatus: "NOT_APPLICABLE" }).onConflictDoNothing({ target: schema.shipments.vtpOrderNumber });
      }
      const [current] = await tx.select().from(schema.shipments)
        .where(isLeg ? eq(schema.shipments.vtpOrderNumber, m.trackingCode) : eq(schema.shipments.id, m.shipmentId!)).for("update");
      if (!current || (isLeg && (current.orderId !== null || current.orderReference !== m.legOf))) return "conflict";
      if (m.matchKind === "phone") {
        // Gắn mã vận đơn vào vận đơn ERP chưa có mã. Kiểm tra lại trong transaction: nếu mã đã
        // thuộc vận đơn khác (hoặc vận đơn này vừa có mã) thì dừng, không đụng ràng buộc duy nhất.
        if (current.vtpOrderNumber || current.trackingCode) return "conflict";
        const [taken] = await tx.select({ id: schema.shipments.id }).from(schema.shipments)
          .where(or(eq(schema.shipments.vtpOrderNumber, m.trackingCode), eq(schema.shipments.trackingCode, m.trackingCode)));
        if (taken) return "conflict";
        await tx.update(schema.shipments).set({
          carrier: "Viettel Post", vtpOrderNumber: m.trackingCode, trackingCode: m.trackingCode, updatedAt: now,
          ...(m.orderCode && !current.orderReference ? { orderReference: m.orderCode } : {}),
          ...(current.receiverName || !m.receiverName ? {} : { receiverName: m.receiverName }),
          ...(current.receiverPhone || !m.receiverPhone ? {} : { receiverPhone: m.receiverPhone }),
          ...(current.receiverAddress || !m.receiverAddress ? {} : { receiverAddress: m.receiverAddress }),
        }).where(eq(schema.shipments.id, current.id));
      }
      const snapshot = { trackingCode: m.trackingCode, orderCode: m.orderCode, statusText: m.statusText,
        cod: m.cod, fee: m.fee, codReconciliationText: m.codReconciliationText ?? "", paymentText: m.paymentText ?? "", codPaymentText: m.codPaymentText ?? "",
        returnFlag: m.returnFlag ?? false, forwardFlag: m.forwardFlag ?? false };
      const [existing] = await tx.select().from(schema.shipmentEvents).where(and(eq(schema.shipmentEvents.shipmentId, current.id),
        eq(schema.shipmentEvents.source, "VTP_IMPORT"), eq(schema.shipmentEvents.status, m.statusText), eq(schema.shipmentEvents.occurredAt, occurredAt)));
      if (existing) {
        const previous = existing.raw as { snapshot?: typeof snapshot } | null;
        return previous?.snapshot && Object.keys(snapshot).every((key) => previous.snapshot![key as keyof typeof snapshot] === snapshot[key as keyof typeof snapshot]) ? "duplicate" : "conflict";
      }
      const older = current.vtpStatusDate !== null && current.vtpStatusDate > occurredAt;
      const sameTimeConflict = current.vtpStatusDate?.getTime() === occurredAt.getTime() && current.stage !== m.mapped.stage;
      const before = { stage: current.stage, codAmount: current.codAmount, shippingFee: current.shippingFee, vtpStatusDate: current.vtpStatusDate };
      if (!older && !sameTimeConflict) {
        // ĐVVC tự khai "Đã nhận COD" ⇒ nâng chiều tiền lên COLLECTED (tiền đang ở ĐVVC). Không
        // nâng thẳng lên "đã về ngân hàng": chỉ bảng kê đối soát mới chứng minh tiền về tài khoản.
        // Cũng không bao giờ HẠ trạng thái đã có chứng từ mạnh hơn.
        const codKhaiBao = m.cod !== null ? m.cod : current.codAmount;
        const nangCod = vtpSaysCodReceived(m.codPaymentText) && codKhaiBao > 0 && ["PENDING", "NOT_APPLICABLE"].includes(current.codStatus);
        // CỐ Ý chỉ ghi TIỀN và cước ở đây. Trạng thái, mốc thời gian và cờ kết thúc do
        // materializeShipmentState() phía dưới dựng lại từ lịch sử — một chỗ duy nhất được ghi
        // chiều logistics (SHIPMENT_STAGE_WRITERS trong lib/constants/truth.ts).
        await tx.update(schema.shipments).set({ lastVtpSyncAt: now, updatedAt: now,
          ...(nangCod ? { codStatus: "COLLECTED" as const } : {}),
          ...(m.cod !== null ? { codAmount: m.cod } : {}), ...(m.fee !== null ? { shippingFee: m.fee } : {}),
        }).where(eq(schema.shipments.id, current.id));
      }
      const disposition = older ? "stale" : sameTimeConflict ? "conflict" : "applied";
      await tx.insert(schema.shipmentEvents).values({ shipmentId: current.id, source: "VTP_IMPORT", status: m.statusText,
        statusName: m.statusText, occurredAt, normalizedStage: m.mapped.stage, legType: isLeg ? "RETURN" : "OUTBOUND",
        verificationStatus: "PENDING", sourceReference: m.sourceHash ? `${m.sourceHash}:row:${m.sourceRow}` : null,
        raw: { snapshot, disposition, sourceHash: m.sourceHash ?? null, sourceRow: m.sourceRow ?? null, importedBy: actor } });
      await tx.insert(schema.auditLogs).values({ userEmail: actor, action: "VTP_ORDER_LIST_ROW", entity: "SHIPMENT", entityId: current.id,
        detail: { before, snapshot, disposition, sourceHash: m.sourceHash ?? null, sourceRow: m.sourceRow ?? null } });
      // Trạng thái cuối cùng luôn do lịch sử sự kiện quyết định, không phụ thuộc luồng nào ghi sau.
      // Nhờ vậy dòng tệp đến muộn không kéo lùi trạng thái mà vẫn được lưu vào hành trình.
      await materializeShipmentState(tx as unknown as Parameters<typeof materializeShipmentState>[0], current.id);
      if (disposition !== "applied") return disposition;
      return isLeg ? "leg" : m.matchKind === "phone" ? "linked" : "updated";
    });
    if (result === "updated") updated++;
    else if (result === "linked") { linked++; updated++; }
    else if (result === "leg") legs++;
    else if (result === "stale") stale++;
    else if (result === "duplicate") duplicate++;
    else conflicts++;
  }
  return { total: rows.length, matched: matches.filter((m) => m.shipmentId).length, updated, linked, paid: 0, legs, stale, duplicate, conflicts, missingDate,
    unmatched: matches.filter((m) => !m.shipmentId).length, unknown: matches.filter((m) => m.shipmentId && m.mapped.stage === "UNKNOWN").length };
}

export type StatementFileMatch = {
  filename: string;
  rows: number;
  codGross: number;
  feeTotal: number;
  netAmount: number;
  /** Đợt khớp CHÍNH XÁC theo số tiền; null nghĩa là chưa đủ căn cứ để gắn. */
  batchId: string | null;
  batchReference: string | null;
  batchReceivedAt: Date | null;
  /** Vì sao không gắn được — hiển thị thẳng cho người dùng. */
  issue: string | null;
  matchedShipments: number;
  unmatchedCodes: number;
  /** Giai đoạn file phủ, lấy từ cột Ngày phát thành công. */
  periodFrom: string | null;
  periodTo: string | null;
};

/**
 * Ghép FILE CHI TIẾT với ĐỢT TIỀN VỀ bằng SỐ TIỀN, không đoán theo ngày.
 *
 * File chi tiết Viettel Post không chứa mã bảng kê, còn tên file chỉ là "Bao_cao_chi_tiet_bang_ke_8".
 * Nhưng tổng "Tiền thu hộ" và tổng "Tiền thu về" của file trùng khít với codGross/totalAmount của
 * đúng một đợt đã nhập từ bảng kê tổng hợp — đó là bằng chứng đủ mạnh để gắn tự động.
 * Chỉ gắn khi khớp DUY NHẤT một đợt; khớp nhiều hoặc không khớp thì báo để người dùng tự chọn.
 */
export async function matchStatementFileToBatch(filename: string, rows: StatementDetailRow[]): Promise<StatementFileMatch> {
  const db = await getDb();
  const codGross = rows.reduce((a, r) => a + r.cod, 0);
  const feeTotal = rows.reduce((a, r) => a + r.fee, 0);
  const netAmount = rows.reduce((a, r) => a + r.net, 0);
  const matches = await matchStatementRows(rows);
  const dates = rows.map((r) => r.paidDate).filter((d): d is string => Boolean(d)).sort();
  const base = {
    filename,
    rows: rows.length,
    codGross,
    feeTotal,
    netAmount,
    matchedShipments: matches.filter((m) => m.shipmentId).length,
    unmatchedCodes: matches.filter((m) => !m.shipmentId).length,
    periodFrom: dates[0] ?? null,
    periodTo: dates[dates.length - 1] ?? null,
  };

  const candidates = await db
    .select({ id: schema.codBatches.id, reference: schema.codBatches.reference, receivedAt: schema.codBatches.receivedAt })
    .from(schema.codBatches)
    .where(
      and(
        eq(schema.codBatches.totalAmount, netAmount),
        sql`coalesce(nullif(${schema.codBatches.codGross}, 0), ${schema.codBatches.totalAmount} + ${schema.codBatches.feeTotal}) = ${codGross}`,
      ),
    );

  if (candidates.length === 1) {
    return { ...base, batchId: candidates[0].id, batchReference: candidates[0].reference, batchReceivedAt: candidates[0].receivedAt, issue: null };
  }
  if (candidates.length > 1) {
    const many = `Khớp ${candidates.length} đợt cùng số tiền (${candidates.map((c) => c.reference).join(", ")}) — hãy nhập riêng từng đợt`;
    return { ...base, batchId: null, batchReference: null, batchReceivedAt: null, issue: many };
  }

  // Không khớp đợt nào. Phân biệt hai nguyên nhân rất khác nhau vì cách xử lý khác hẳn:
  //   (a) ERP CHƯA CÓ vận đơn của giai đoạn này → nhập bảng kê cũng không ghép được gì,
  //       phải đồng bộ Pancake lùi về trước đã;
  //   (b) chỉ thiếu dòng tổng của đợt → nhập bảng kê tổng hợp rồi nhập lại chi tiết.
  const [range] = await db
    .select({ first: sql<string | null>`min(coalesce(${schema.shipments.deliveredAt}, ${schema.shipments.vtpStatusDate}))::date::text` })
    .from(schema.shipments);
  const erpFrom = range?.first ?? null;
  const beforeErpData = Boolean(base.periodTo && erpFrom && base.periodTo < erpFrom);
  const issue =
    base.matchedShipments === 0 && beforeErpData
      ? `ERP chưa có vận đơn nào của giai đoạn ${base.periodFrom} → ${base.periodTo} (dữ liệu ERP bắt đầu từ ${erpFrom}). Cần đồng bộ Pancake lùi về trước ${erpFrom} rồi nhập lại bảng kê này.`
      : base.matchedShipments === 0
        ? "Không mã vận đơn nào trong file có trong ERP — kiểm tra đúng tài khoản Viettel Post, hoặc đồng bộ vận đơn trước."
        : "Không có đợt nào khớp số tiền của file — hãy nhập bảng kê tổng hợp cho đợt này trước";
  return { ...base, batchId: null, batchReference: null, batchReceivedAt: null, issue };
}

/**
 * Gắn vận đơn của file chi tiết vào ĐÚNG đợt đã có. Không tạo đợt mới, không sửa số của đợt:
 * số tiền của đợt là số trên chứng từ gốc.
 */
/**
 * Ghi CHỨNG TỪ GỐC từ file chi tiết bảng kê Viettel Post.
 *
 * File chi tiết là chứng từ thật của ĐVVC nên luôn được ghi, KHÔNG cần có "đợt tiền về" trước.
 * Đợt chỉ là số tổng do shop nhập tay; bắt file phải khớp đợt mới cho nhập là ngược: chứng từ
 * đứng trước bản tổng hợp. Nếu có đợt khớp số tiền thì gắn thêm để biết tiền về tài khoản nào.
 *
 * Ghi cho từng vận đơn khớp mã: tiền THỰC THU, cước thật, và mốc chứng từ.
 * Không đụng vận đơn không có trong file.
 */
/**
 * Ghi chi tiết bảng kê vào SỔ CHỨNG TỪ rồi dựng lại số tiền trên vận đơn từ sổ.
 *
 * Không ghi thẳng lên vận đơn nữa. Lý do: cùng một vận đơn xuất hiện ở nhiều bảng kê (chiều đi
 * có tiền, chiều hoàn chỉ có cước), mà luồng email xử lý từ thư mới về thư cũ, nên cách ghi thẳng
 * để file cũ đè mất số của file mới — 334 vận đơn giao thành công bị đưa tiền về 0. Ghi vào sổ
 * rồi dựng lại thì nhập bao nhiêu lần, theo thứ tự nào cũng ra đúng một kết quả.
 */
/**
 * DANH TÍNH của một bảng kê — dùng làm khoá chống trùng thay cho tên file.
 *
 * Ưu tiên ngày chốt in trong phần KẾT LUẬN ĐỐI SOÁT: Viettel Post mỗi ngày chốt trả một lần nên
 * "BK-<ngày>" là khoá tự nhiên. Tệp không có phần đó (bản "Chi tiết bảng kê" tải tay kiểu cũ) thì
 * lấy vân tay nội dung: cùng tập mã vận đơn và số tiền là cùng một bảng kê, dù đặt tên gì.
 */
export function statementKeyOf(rows: StatementDetailRow[], statementDate?: string | null) {
  if (statementDate) return `BK-${statementDate}`;
  const van = rows
    .map((r) => `${r.trackingCode}:${r.cod}:${r.fee}`)
    .sort()
    .join("|");
  return `SHA-${createHash("sha256").update(van).digest("hex").slice(0, 20)}`;
}

export async function applyStatementDetailRows(rows: StatementDetailRow[], sourceRef: string, batchId: string | null, statementKey?: string) {
  const db = await getDb();
  const batch = batchId
    ? await db.query.codBatches.findFirst({ where: eq(schema.codBatches.id, batchId), columns: { id: true, receivedAt: true } })
    : null;
  const matches = await matchStatementRows(rows);
  const now = new Date();
  // Mốc chứng từ: ngày phát thành công muộn nhất trong file, không có thì lấy ngày đợt.
  const dates = rows.map((r) => r.paidDate).filter((d): d is string => Boolean(d)).sort();
  const statementAt = dates.length ? new Date(`${dates[dates.length - 1]}T00:00:00Z`) : (batch?.receivedAt ?? now);

  // 1) Ghi sổ — mỗi (file, mã vận đơn) một dòng, nhập lại thì cập nhật đúng dòng đó.
  const khoa = statementKey || statementKeyOf(rows, dates[dates.length - 1] ?? null);
  // Dòng cũ của CHÍNH tệp này nhưng mang khoá khác (nhập từ thời còn khoá theo tên file, hoặc tệp
  // đổi khoá sau khi đọc được phần kết luận) phải bỏ đi, nếu không cùng một bảng kê nằm hai chỗ.
  await db.delete(schema.codStatementLines).where(and(eq(schema.codStatementLines.sourceFile, sourceRef), sql`${schema.codStatementLines.statementKey} <> ${khoa}`));

  const seen = new Set<string>();
  const values = matches
    .filter((m) => m.trackingCode && !seen.has(m.trackingCode) && seen.add(m.trackingCode))
    .map((m) => ({
      statementKey: khoa,
      sourceFile: sourceRef,
      batchId: batch?.id ?? null,
      trackingCode: m.trackingCode,
      cod: m.cod,
      fee: m.fee,
      net: m.net,
      codReported: m.codReported !== false,
      paidDate: m.paidDate ?? null,
      statementAt,
      statusText: m.raw ? m.raw.slice(0, 200) : "",
      shipmentId: m.shipmentId,
      updatedAt: now,
    }));
  for (let i = 0; i < values.length; i += 200) {
    await db
      .insert(schema.codStatementLines)
      .values(values.slice(i, i + 200))
      .onConflictDoUpdate({
        target: [schema.codStatementLines.statementKey, schema.codStatementLines.trackingCode],
        set: {
          sourceFile: sql`excluded.source_file`,
          batchId: sql`excluded.batch_id`,
          cod: sql`excluded.cod`,
          fee: sql`excluded.fee`,
          net: sql`excluded.net`,
          codReported: sql`excluded.cod_reported`,
          paidDate: sql`excluded.paid_date`,
          statementAt: sql`excluded.statement_at`,
          statusText: sql`excluded.status_text`,
          shipmentId: sql`coalesce(excluded.shipment_id, cod_statement_lines.shipment_id)`,
          updatedAt: now,
        },
      });
  }

  // 2) Dựng lại tiền trên các vận đơn có dòng trong sổ.
  const shipmentIds = [...new Set(matches.map((m) => m.shipmentId).filter((v): v is string => Boolean(v)))];
  await materializeCodFromStatementLines(shipmentIds);

  // 3) Cước ĐVVC ghi ngược về đơn để báo cáo lợi nhuận dùng số thật.
  for (const m of matches) {
    if (m.orderId && m.fee > 0) await db.update(schema.orders).set({ partnerFee: m.fee }).where(eq(schema.orders.id, m.orderId));
  }

  const linked = shipmentIds.length;
  void khoa;
  const withCash = matches.filter((m) => m.shipmentId && m.cod > 0).length;
  return { linked, withCash, statementAt, rows: values.length, unmatched: matches.length - linked, statementKey: khoa };
}

/**
 * DỰNG LẠI tiền COD của vận đơn từ sổ chi tiết bảng kê. Đây là chỗ DUY NHẤT được ghi
 * `cod_collected` / `cod_status` / `cod_batch_id` từ chứng từ bảng kê.
 *
 * Chọn dòng đại diện cho mỗi vận đơn: ưu tiên dòng CÓ TIỀN, trong đó lấy dòng có mốc chứng từ
 * muộn nhất. Dòng chỉ có cước (không nói về COD) không được chọn và không hạ số đã có về 0.
 * Cước lấy dòng cao nhất chứ không cộng dồn — cùng một khoản cước có thể lặp ở hai file.
 *
 * `shipmentIds` rỗng = dựng lại toàn bộ. Vận đơn KHÔNG có dòng nào trong sổ thì không bị đụng tới.
 */
export async function materializeCodFromStatementLines(shipmentIds: string[] = []) {
  const db = await getDb();
  const loc = shipmentIds.length ? sql`and l.shipment_id in (${sql.join(shipmentIds.map((v) => sql`${v}`), sql`, `)})` : sql``;
  const result = await db.execute(sql`
    with chon as (
      select distinct on (l.shipment_id)
        l.shipment_id, l.cod, l.source_file, l.statement_at, l.batch_id
      from cod_statement_lines l
      where l.shipment_id is not null and l.cod_reported ${loc}
      order by l.shipment_id, (l.cod > 0) desc, l.statement_at desc, l.created_at desc
    ), cuoc as (
      select l.shipment_id, max(l.fee) fee
      from cod_statement_lines l
      where l.shipment_id is not null ${loc}
      group by l.shipment_id
    )
    update shipments s set
      cod_collected = c.cod,
      -- Bảng kê báo 0đ KHÔNG phải là "vận đơn không thu hộ": vận đơn vẫn có tiền thu hộ, chỉ là
      -- kỳ này ĐVVC không chi trả đồng nào cho nó. "Không thu hộ" chỉ đúng khi COD khai báo = 0.
      cod_status = case when c.cod > 0 then 'PAID_TO_BANK'::cod_status
                        when s.cod_amount > 0 then 'PENDING'::cod_status
                        else 'NOT_APPLICABLE'::cod_status end,
      cod_paid_to_bank_at = case when c.cod > 0 then coalesce(b.received_at, c.statement_at) else null end,
      cod_batch_id = c.batch_id,
      cod_statement_ref = c.source_file,
      cod_statement_at = c.statement_at,
      cod_reconciled_at = coalesce(s.cod_reconciled_at, c.statement_at),
      shipping_fee = case when coalesce(f.fee, 0) > 0 then f.fee else s.shipping_fee end,
      updated_at = now()
    from chon c
      left join cuoc f on f.shipment_id = c.shipment_id
      left join cod_batches b on b.id = c.batch_id
    where s.id = c.shipment_id
      and (s.cod_collected is distinct from c.cod
        or s.cod_batch_id is distinct from c.batch_id
        or s.cod_statement_ref is distinct from c.source_file
        or (coalesce(f.fee, 0) > 0 and s.shipping_fee is distinct from f.fee))
  `);
  return { updated: Number((result as unknown as { rowCount?: number }).rowCount ?? 0) };
}
