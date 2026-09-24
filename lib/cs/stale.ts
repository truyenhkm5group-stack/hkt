import { sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { CARRIER_HANDOFF_STAGES } from "@/lib/constants/carrier-handoff";
import { checkEligibility, type CaseFacts } from "@/lib/constants/case-semantics";
import { CS_BOT_ASSIGNEES, CS_BOT_SOURCES, CS_KIND_LABEL, type CsKind } from "@/lib/constants/cs";
import { checkLiveness, type LivenessFacts } from "@/lib/constants/cs-liveness";
import { isOrderMaterialized } from "@/lib/constants/order-materialized";
import { reconcileOrderNotCreated, type ReconcileResult } from "@/lib/cs/reconcile-order-created";
import { rowsOf } from "@/lib/sql-rows";

/**
 * ═══════════ MỘT CASE KHÔNG PHẢI MỘT ẢNH CHỤP BẤT BIẾN ═══════════
 *
 * Bằng chứng thì bất biến — nó ghi lại điều đã xảy ra. Nhưng VIỆC PHẢI LÀM là một khẳng định về
 * HIỆN TẠI, và hiện tại thì đổi: khách gọi lại và tự chốt, nhân viên lên đơn bằng đường khác, kiện
 * đã giao xong. Case không tự hết thì hàng đợi lớn dần theo thời gian bằng đúng những việc không
 * còn tồn tại, và người trực học được rằng phần lớn dòng trong đó không đáng đọc.
 *
 * ─── ĐỐI XỨNG NGƯỢC VỚI LÚC SINH CASE, CỐ Ý ───
 *
 * `checkEligibility` dùng CHUNG ở hai nơi, nhưng hai nơi lùi về hai phía KHÁC NHAU:
 *
 *  · **lúc SINH** — loại chưa khai điều kiện ⇒ KHÔNG tạo (lùi về phía hẹp: không đẻ việc bừa);
 *  · **lúc ĐÓNG** — loại chưa khai điều kiện ⇒ GIỮ NGUYÊN (lùi về phía hẹp: không đóng bừa).
 *
 * Cùng một hàm, hai phía an toàn ngược nhau, vì hậu quả ngược nhau. Dùng chung một mặc định cho cả
 * hai là cách chắc chắn nhất để một ngày nào đó thêm một loại case mới và im lặng đóng sạch nó.
 *
 * ─── LOẠI "CHƯA TẠO ĐƠN" CÓ MÁY RIÊNG, VÀ CHỈ MỘT MÁY ───
 *
 * `lib/cs/reconcile-order-created.ts` biết bốn bậc chứng cứ (hội thoại · SĐT · vận đơn · POS đã
 * xác nhận) và ghi `resolution` theo đúng bậc đã dùng. Ở đây KHÔNG viết lại luật đó; gọi thẳng nó
 * rồi gộp số. Hai bộ luật cho một loại case là hai câu trả lời khác nhau cho cùng câu hỏi.
 */

export const STALE_VERDICTS = ["KEEP_OPEN", "AUTO_RESOLVE", "RECLASSIFY", "NEEDS_REVIEW"] as const;
export type StaleVerdict = (typeof STALE_VERDICTS)[number];

export const STALE_VERDICT_LABEL: Record<StaleVerdict, string> = {
  KEEP_OPEN: "Vẫn còn phải làm",
  AUTO_RESOLVE: "Điều kiện không còn — máy đóng được",
  RECLASSIFY: "Việc thuộc bàn khác (Vận đơn & care)",
  NEEDS_REVIEW: "Có người đã chạm vào — để người quyết",
};

export type StaleAssessment = {
  id: string;
  kind: CsKind;
  status: string;
  title: string;
  createdAt: Date;
  verdict: StaleVerdict;
  reason: string;
  facts: CaseFacts;
  /** Ai đó đã nhận hoặc đã ghi kết luận ⇒ máy KHÔNG đóng hộ. */
  humanTouched: boolean;
};

type Row = {
  id: string;
  kind: string;
  status: string;
  title: string;
  created_at: string;
  cham_tay: boolean;
  order_stage: string | null;
  order_system_id: number | null;
  order_inserted_at: string | null;
  conv_stage: string | null;
  conv_system_id: number | null;
  conv_inserted_at: string | null;
  ship_total: number;
  ship_active: number;
  case_ship_stage: string | null;
  case_ship_final: boolean | null;
  newer_failure: boolean;
  order_ship_active: number;
  order_ship_handed_off: number;
  order_ship_settled: number;
};

/** Chặng cuối đời của một đơn — dùng chung định nghĩa với `lib/cs/chat-detect.ts`. */
const FINAL_STAGES = new Set(["DELIVERED", "PAID", "RETURNED", "CANCELLED", "DELETED", "PARTIAL_RETURN"]);

/**
 * MỘT TRUY VẤN CHO CẢ HÀNG ĐỢI.
 *
 * Không đặt truy vấn trong vòng lặp: hàng đợi production có hàng trăm case đang mở, và một lượt
 * đối chiếu N+1 sẽ chạy hàng nghìn câu lệnh cho một việc vốn chỉ cần một.
 */
async function loadOpenCases(ids?: readonly string[]): Promise<Row[]> {
  if (ids && !ids.length) return [];
  const db = await getDb();
  return rowsOf<Row>(
    await db.execute(sql`
      select c.id,
             c.kind,
             c.status,
             c.title,
             c.created_at,
             /*
               CÓ NGƯỜI THẬT ĐÃ CHẠM VÀO — không phải "ô chữ khác rỗng".

               Bản cũ đọc "assignee <> '' or resolution <> ''". Nhưng bot giao-không-thành và bot
               xác nhận SĐT tự ghi assignee = 'Bot ERP' và một câu resolution ngay khi nhắn khách,
               nên MỌI case bot đã nhắn đều bị coi là "có người cầm" và máy không bao giờ đóng
               chúng nữa — đúng loại case chiếm đa số hàng đợi (AGENTS.md mục 36: tên một job không
               phải một con người).

               Chứng cứ người thật: người phụ trách không phải bot · khoá tài khoản phụ trách · một
               dòng lịch sử case do tài khoản ghi · một lượt sửa có nhật ký của tài khoản · ô kết
               luận của case KHÔNG do bot sinh (case tay / case từ hội thoại chỉ có người ghi ô đó).
             */
             (
               (coalesce(c.assignee, '') <> '' and c.assignee not in ${[...CS_BOT_ASSIGNEES]})
               or c.assignee_user_id is not null
               or (coalesce(c.resolution, '') <> '' and c.source not in ${[...CS_BOT_SOURCES]})
               or exists (select 1 from cs_case_events e where e.case_id = c.id and e.actor_id is not null)
               or exists (select 1 from audit_logs a where a.entity = 'CS_CASE' and a.entity_id = c.id and a.user_id is not null)
             ) as cham_tay,
             o.stage::text     as order_stage,
             o.system_id       as order_system_id,
             o.inserted_at     as order_inserted_at,
             oc.stage          as conv_stage,
             oc.system_id      as conv_system_id,
             oc.inserted_at    as conv_inserted_at,
             sh.tong           as ship_total,
             sh.dang_chay      as ship_active,
             cs_s.stage::text  as case_ship_stage,
             cs_s.is_final     as case_ship_final,
             (c.kind = 'DELIVERY_FAILED' and exists (
                select 1 from cs_cases c2
                 where c2.kind = 'DELIVERY_FAILED'
                   and c2.id <> c.id
                   and c2.dedupe_key like 'failed-delivery:%'
                   and split_part(c2.dedupe_key, ':', 2) = split_part(c.dedupe_key, ':', 2)
                   and c2.created_at > c.created_at
             )) as newer_failure,
             osh.dang_chay     as order_ship_active,
             osh.da_ban_giao   as order_ship_handed_off,
             osh.da_chot       as order_ship_settled
        from cs_cases c
        left join orders o on o.id = c.order_id
        -- Đơn của HỘI THOẠI: case chưa gắn đơn vẫn có thể đã có đơn lên bằng đường khác.
        left join lateral (
          select o2.id, o2.stage::text as stage, o2.system_id, o2.inserted_at
            from orders o2
           where coalesce(c.conversation_id, '') <> ''
             and o2.conversation_id = c.conversation_id
             and o2.stage not in ('CANCELLED','DELETED')
           order by o2.inserted_at desc
           limit 1
        ) oc on true
        left join lateral (
          select count(*)::int as tong, count(*) filter (where s.is_final = false)::int as dang_chay
            from shipments s
           where (c.order_id is not null and s.order_id = c.order_id)
              or (coalesce(c.customer_phone, '') <> '' and s.receiver_phone = c.customer_phone)
        ) sh on true
        -- Kiện của ĐÚNG đơn case nói tới (theo order_id, không theo SĐT) — lib/constants/cs-liveness.ts.
        left join lateral (
          select count(*) filter (where s.is_final = false)::int as dang_chay,
                 count(*) filter (where s.stage::text in ${[...CARRIER_HANDOFF_STAGES]} or s.picked_up_at is not null)::int as da_ban_giao,
                 count(*) filter (where s.is_final and s.stage::text in ('DELIVERED','RETURNED'))::int as da_chot
            from shipments s
           where s.order_id = coalesce(c.order_id, oc.id)
        ) osh on true
        -- Vận đơn sinh ra case giao-không-thành: khoá "failed-delivery:<shipmentId>:<ngày>".
        left join shipments cs_s
          on c.kind = 'DELIVERY_FAILED'
         and c.dedupe_key like 'failed-delivery:%'
         and cs_s.id = split_part(c.dedupe_key, ':', 2)
       where c.status in ('OPEN','IN_PROGRESS')
         ${ids ? sql`and c.id in ${[...ids]}` : sql``}`),
  );
}

function factsOf(r: Row): CaseFacts {
  const stage = r.order_stage ?? r.conv_stage;
  const systemId = r.order_system_id ?? r.conv_system_id;
  const insertedAt = r.order_inserted_at ?? r.conv_inserted_at;
  return {
    orderMatch: r.order_stage ? "BY_CONVERSATION" : r.conv_stage ? "BY_CONVERSATION" : "NONE",
    orderMaterialized: isOrderMaterialized({ stage }),
    orderStage: stage,
    orderSystemId: systemId === null || systemId === undefined ? null : Number(systemId),
    orderInsertedAt: insertedAt ? new Date(insertedAt) : null,
    orderFinal: FINAL_STAGES.has(stage ?? ""),
    hasShipment: Number(r.ship_total ?? 0) > 0,
    hasActiveShipment: Number(r.ship_active ?? 0) > 0,
  };
}

function livenessOf(r: Row): LivenessFacts {
  return {
    caseShipment: r.case_ship_stage ? { stage: r.case_ship_stage, isFinal: Boolean(r.case_ship_final) } : null,
    newerFailureCase: Boolean(r.newer_failure),
    orderStage: r.order_stage ?? r.conv_stage,
    orderShipmentsActive: Number(r.order_ship_active ?? 0),
    orderShipmentsHandedOff: Number(r.order_ship_handed_off ?? 0),
    orderShipmentsSettled: Number(r.order_ship_settled ?? 0),
  };
}

/**
 * Đọc-KHÔNG-ghi: phân loại toàn bộ hàng đợi đang mở (hoặc đúng các case `ids` — màn hình dùng để
 * gắn nhãn "điều kiện đã hết" lên dòng mà máy không được đóng hộ vì đã có người cầm).
 *
 * `ORDER_NOT_CREATED` cố ý KHÔNG có mặt ở đây — nó đi qua máy riêng của nó (xem đầu tệp), và số
 * của nó được gộp vào ở `staleReport`.
 */
export async function assessOpenCases(ids?: readonly string[]): Promise<StaleAssessment[]> {
  const rows = await loadOpenCases(ids);
  const out: StaleAssessment[] = [];
  for (const r of rows) {
    const kind = r.kind as CsKind;
    if (kind === "ORDER_NOT_CREATED") continue;
    const facts = factsOf(r);
    const base = { id: r.id, kind, status: r.status, title: r.title, createdAt: new Date(r.created_at), facts, humanTouched: Boolean(r.cham_tay) };
    const dieuKien = checkEligibility(kind, facts);
    /*
      CHỨNG TỪ ĐÃ ĐI TIẾP CHƯA — `lib/constants/cs-liveness.ts`.

      Loại do máy sinh từ vận đơn / đơn (giao không thành, xác nhận SĐT) không có mặt trong
      `CASE_ELIGIBILITY` và trước bản này rơi vào nhánh "chưa khai điều kiện ⇒ giữ nguyên" — mãi
      mãi. Với loại ĐÃ khai, luật này chỉ BỔ SUNG khi bộ gác cũ còn cho là có việc (vd. POS trễ
      hơn ĐVVC); bộ gác cũ đã kết luận thì lý do của nó đứng nguyên. `null` = không kết luận được
      ⇒ đi tiếp luật cũ, không đoán.
    */
    const chuaKhai = !dieuKien.ok && dieuKien.reason.includes("chưa khai điều kiện chứng từ");
    const song = chuaKhai || dieuKien.ok ? checkLiveness(kind, livenessOf(r)) : null;
    if (song && song.alive) {
      out.push({ ...base, verdict: "KEEP_OPEN", reason: "Chứng từ vẫn đỡ được việc này" });
      continue;
    }
    if (song && !song.alive) {
      out.push({ ...base, verdict: r.cham_tay ? "NEEDS_REVIEW" : "AUTO_RESOLVE", reason: song.reason });
      continue;
    }
    /*
      LOẠI CHƯA KHAI ĐIỀU KIỆN ⇒ GIỮ NGUYÊN.

      `checkEligibility` trả `ok: false` cho loại chưa khai, và đó là mặc định ĐÚNG lúc SINH case.
      Ở đây nó là mặc định SAI: "chưa ai viết luật cho loại này" không phải bằng chứng rằng việc đã
      xong. Phân biệt hai thứ bằng chính sổ đăng ký, không bằng câu chữ của lý do.
    */
    if (chuaKhai) {
      out.push({ ...base, verdict: "KEEP_OPEN", reason: "Loại này chưa khai điều kiện đóng — máy KHÔNG tự đóng" });
      continue;
    }
    if (dieuKien.ok) {
      out.push({ ...base, verdict: "KEEP_OPEN", reason: "Chứng từ vẫn đỡ được việc này" });
      continue;
    }
    if (dieuKien.route === "SHIPMENT_CARE") {
      out.push({ ...base, verdict: "RECLASSIFY", reason: dieuKien.reason });
      continue;
    }
    /*
      CÓ NGƯỜI ĐÃ CHẠM VÀO ⇒ KHÔNG ĐÓNG HỘ.

      Một case đã có người nhận hoặc đã ghi kết luận là một việc ai đó đang làm dở. Máy đóng nó là
      xoá công của người và làm họ mất dấu thứ đang cầm — tệ hơn hẳn một dòng thừa trong hàng đợi.
    */
    out.push({ ...base, verdict: r.cham_tay ? "NEEDS_REVIEW" : "AUTO_RESOLVE", reason: dieuKien.reason });
  }
  return out;
}

export type StaleReport = {
  /** Tổng case đang mở, kể cả `ORDER_NOT_CREATED`. */
  openTotal: number;
  byVerdict: Record<StaleVerdict, number>;
  /** Theo loại × kết luận — bảng để đọc, không phải một con số tổng. */
  byKind: { kind: CsKind; label: string; total: number; counts: Record<StaleVerdict, number> }[];
  /** Máy riêng của "chưa tạo đơn" — bốn bậc chứng cứ, xem `reconcile-order-created.ts`. */
  orderNotCreated: ReconcileResult;
  /** Mẫu thật để người đọc kiểm chứng, KHÔNG phải một con số không tra được. */
  samples: { id: string; kind: CsKind; title: string; verdict: StaleVerdict; reason: string; ageDays: number }[];
};

const emptyCounts = (): Record<StaleVerdict, number> => ({ KEEP_OPEN: 0, AUTO_RESOLVE: 0, RECLASSIFY: 0, NEEDS_REVIEW: 0 });

/** Báo cáo CHẠY THỬ: không ghi một dòng nào. */
export async function staleReport(sampleSize = 20): Promise<StaleReport> {
  const [danhGia, chuaTaoDon, [dem]] = await Promise.all([
    assessOpenCases(),
    reconcileOrderNotCreated({ dryRun: true }),
    (await getDb())
      .select({ n: sql<number>`count(*)` })
      .from(schema.csCases)
      .where(sql`${schema.csCases.status} in ('OPEN','IN_PROGRESS')`),
  ]);
  const byVerdict = emptyCounts();
  const theoLoai = new Map<CsKind, Record<StaleVerdict, number>>();
  for (const a of danhGia) {
    byVerdict[a.verdict] += 1;
    const cur = theoLoai.get(a.kind) ?? emptyCounts();
    cur[a.verdict] += 1;
    theoLoai.set(a.kind, cur);
  }
  const samples = danhGia
    .filter((a) => a.verdict === "AUTO_RESOLVE")
    .slice(0, sampleSize)
    .map((a) => ({ id: a.id, kind: a.kind, title: a.title, verdict: a.verdict, reason: a.reason, ageDays: Math.round((Date.now() - a.createdAt.getTime()) / 86_400_000) }));
  return {
    openTotal: Number(dem?.n ?? 0),
    byVerdict,
    byKind: [...theoLoai.entries()]
      .map(([kind, counts]) => ({ kind, label: CS_KIND_LABEL[kind] ?? kind, total: Object.values(counts).reduce((a, b) => a + b, 0), counts }))
      .sort((a, b) => b.total - a.total),
    orderNotCreated: chuaTaoDon,
    samples,
  };
}

export type StaleApplyResult = {
  /** Số case MÁY SẼ đóng (chạy thử) hoặc ĐÃ đóng (chạy thật). Hai con số tách hẳn nhau. */
  planned: number;
  /** Số dòng THẬT SỰ ghi. Chạy thử luôn là 0 — không có ngoại lệ nào. */
  closed: number;
  byKind: { kind: CsKind; n: number }[];
  orderNotCreated: ReconcileResult;
};

/**
 * ═══════════ ĐÓNG MỀM, CHỈ NHỮNG CASE XÁC ĐỊNH ═══════════
 *
 * Chỉ `AUTO_RESOLVE` — tức là chứng từ nghiệp vụ nói rõ điều kiện không còn, VÀ chưa ai cầm case.
 * `NEEDS_REVIEW` và `RECLASSIFY` KHÔNG được đóng: cái đầu là việc của người, cái sau cần người
 * quyết chuyển bàn.
 *
 * `AUTO_RESOLVED` chứ không `DONE`: `DONE` là công của người, và đóng 40 case bằng `DONE` sẽ làm
 * bảng năng suất CSKH trông như 40 lần có người gọi khách.
 *
 * KHÔNG XOÁ GÌ. Case vẫn tra được, bằng chứng vẫn nguyên, `resolution` nói rõ vì sao.
 */
export async function applyStaleReconciliation(options: { dryRun?: boolean; actor?: string } = {}): Promise<StaleApplyResult> {
  const dryRun = options.dryRun !== false;
  const actor = options.actor ?? "job:cs-stale";
  const danhGia = (await assessOpenCases()).filter((a) => a.verdict === "AUTO_RESOLVE");
  const theoLoai = new Map<CsKind, number>();
  for (const a of danhGia) theoLoai.set(a.kind, (theoLoai.get(a.kind) ?? 0) + 1);
  const chuaTaoDon = await reconcileOrderNotCreated({ dryRun, actor });
  const theoLoaiRa = [...theoLoai.entries()].map(([kind, n]) => ({ kind, n }));
  if (dryRun || !danhGia.length) return { planned: danhGia.length, closed: 0, byKind: theoLoaiRa, orderNotCreated: chuaTaoDon };
  const db = await getDb();
  const now = new Date();
  /*
    GHI THEO TỪNG LÝ DO, KHÔNG MỘT CÂU CHUNG.

    Sáu tháng sau phải trả lời được "case này đóng vì cái gì" cho TỪNG case, chứ không phải "vì một
    lượt dọn hàng loạt". Số case mỗi lượt nhỏ (hàng chục), nên ghi từng dòng là chấp nhận được và
    đáng giá hơn một câu lệnh gọn mà mất lý do.
  */
  let closed = 0;
  for (const a of danhGia) {
    const r = await db
      .update(schema.csCases)
      .set({ status: "AUTO_RESOLVED", resolution: `CONDITION_GONE · ${a.reason} · ${actor}`, resolvedAt: now, updatedAt: now })
      .where(sql`${schema.csCases.id} = ${a.id} and ${schema.csCases.status} in ('OPEN','IN_PROGRESS')`)
      .returning({ id: schema.csCases.id });
    closed += r.length;
  }
  return { planned: danhGia.length, closed, byKind: theoLoaiRa, orderNotCreated: chuaTaoDon };
}
