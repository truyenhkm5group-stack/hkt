/**
 * ═══════════ RÚT QUAN SÁT LÝ DO HOÀN TỪ DỮ LIỆU ĐÃ CÓ ═══════════
 *
 * MẶC ĐỊNH CHẠY THỬ. `--apply` mới ghi. Chạy thử in ra ĐÚNG những gì bản ghi sẽ tạo, theo từng
 * nguồn, nên nó vừa là bản kiểm kê nguồn dữ liệu vừa là bản xem trước.
 *
 * ─── VÌ SAO KHÔNG NHÉT VÀO MIGRATION ───
 *
 * Một lượt backfill nằm trong migration thì nó chạy đúng một lần, im lặng, không ai xem trước được
 * và không chạy lại được. Ở đây nó là một lượt chạy riêng: xem trước → đối chiếu → mới ghi.
 *
 * ─── CHẠY LẠI BAO NHIÊU LẦN CŨNG ĐƯỢC ───
 *
 * Khoá chống trùng là NỘI DUNG (`dedupe_key` = kiện · nguồn · mốc · vân tay chữ), nên lượt thứ hai
 * không sinh thêm dòng nào. Đó là điều kiện để dám chạy lại sau khi bổ sung một nguồn mới.
 *
 * ─── KHÔNG SUY LÝ DO TỪ TRẠNG THÁI CHUNG ───
 *
 * Chỉ rút ra khi có CHỮ THẬT nói về lý do. "Kiện đang chuyển hoàn" là BƯỚC ĐI — không sinh quan
 * sát nào. Chữ có thật nhưng chưa xếp được vẫn được LƯU, và đếm vào nhóm "có chứng từ, chưa xếp
 * được": đó là việc phải làm, khác hẳn "chưa ai nói gì".
 *
 *   docker exec erp-app npx tsx --tsconfig tsconfig.json scripts/return-reason-backfill.ts
 *   docker exec erp-app npx tsx --tsconfig tsconfig.json scripts/return-reason-backfill.ts --apply
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { classifyRaw } from "@/lib/returns/reason-classify";
import { REASON_SOURCE_LABEL, type ReasonSource } from "@/lib/constants/return-reason-source";
import { RETURN_REASON_LABEL, type ReturnReason } from "@/lib/constants/return-reason";
import { dangGhiQuanSat, reasonDedupeKey } from "@/lib/returns/reason-observe";

const APPLY = process.argv.includes("--apply");
const so = (n: number) => n.toLocaleString("vi-VN");

type QuanSat = {
  shipmentId: string | null;
  orderId: string | null;
  source: ReasonSource;
  rawText: string;
  occurredAt: Date;
  sourceRef: string;
  actorEmail: string;
};

/*
  KHOÁ CHỐNG TRÙNG VÀ BỘ LỌC "CÓ PHẢI LÝ DO KHÔNG" DÙNG CHUNG VỚI ĐƯỜNG WEBHOOK
  (`lib/returns/reason-observe.ts`). Chép lại chúng ở đây là mở đường để hai đường dựng khoá theo
  hai cách, và khi ấy cùng một sự kiện nằm HAI dòng — mọi phép đếm độ phủ nói quá lên mà không ai
  thấy, vì hai dòng ấy trông hoàn toàn hợp lệ.
*/
const dedupeKey = reasonDedupeKey;
/*
  LUÔN TRUYỀN NGUỒN. Bộ lọc xử lý nguồn NGƯỜI khác hẳn nguồn máy: người gõ tay thì giữ tất (không
  ai gõ một bước đi vào ô ghi chú), còn chữ của ĐVVC phải có căn cứ mới giữ. Gọi thiếu nguồn thì
  mọi ghi chú của nhân viên bị chấm như chữ ĐVVC — và một câu như "khách bảo vải xù" sẽ bị CHẶN vì
  lý do ấy chỉ người mới kết luận được, tức là ta vứt đi đúng những quan sát giá trị nhất.
*/
const dangGhi = dangGhiQuanSat;

const rowsOf = <T,>(r: unknown): T[] => ((r as { rows?: T[] }).rows ?? (r as T[])) as T[];

async function main() {
  const db = await getDb();
  console.log(`── RÚT QUAN SÁT LÝ DO HOÀN ${APPLY ? "· GHI THẬT" : "· CHẠY THỬ (thêm --apply để ghi)"} ──\n`);

  /*
    TẬP KIỆN XÉT: chỉ vận đơn của đơn bán gốc mà kết quả KHÔNG phải giao thành công. Vận đơn chiều
    hoàn (`order_id is null`) không có lý do của riêng nó — nó LÀ hệ quả của một lý do ở kiện gốc.
  */
  /*
    ĐẾM DÒNG ĐANG CÓ — VÀ CHỊU ĐƯỢC VIỆC BẢNG CHƯA TỒN TẠI.

    Lượt CHẠY THỬ chính là bản KIỂM KÊ nguồn: nó trả lời "lý do hoàn lấy tự động được từ đâu, bao
    nhiêu ca" mà không ghi một dòng nào. Câu hỏi đó cần được trả lời TRƯỚC khi triển khai bảng, chứ
    không phải sau — nên thiếu bảng là `null` (CHƯA BIẾT), không phải 0, và không phải một lần sập.
  */
  let truoc: number | null = null;
  try {
    const trc = await db.execute(sql`select count(*)::int as n from return_reason_observations`);
    truoc = Number(rowsOf<{ n: number }>(trc)[0]?.n ?? 0);
  } catch {
    truoc = null;
  }
  const dem = (n: number | null) => (n === null ? "— (bảng chưa có)" : `${so(n)} dòng`);

  const gom: QuanSat[] = [];

  /* ───────────── 1 · CHỮ TRẠNG THÁI CỦA ĐVVC ───────────── */
  const ev = rowsOf<{ shipment_id: string; order_id: string | null; status_name: string; note: string; occurred_at: Date; id: string }>(
    await db.execute(sql`
      select e.id, e.shipment_id, s.order_id, coalesce(e.status_name,'') as status_name, coalesce(e.note,'') as note, e.occurred_at
        from shipment_events e
        join shipments s on s.id = e.shipment_id
       where s.order_id is not null
         and e.source in ('VTP_WEBHOOK','VTP_IMPORT','VTP_POLL','VTP_MANUAL_VERIFY','MANUAL')
         and (coalesce(e.status_name,'') <> '' or coalesce(e.note,'') <> '')`),
  );
  for (const e of ev) {
    for (const [txt, ref] of [[e.status_name, "status"], [e.note, "note"]] as const) {
      if (!dangGhi(txt, "CARRIER_TEXT")) continue;
      gom.push({ shipmentId: e.shipment_id, orderId: e.order_id, source: "CARRIER_TEXT", rawText: txt.trim(), occurredAt: new Date(e.occurred_at), sourceRef: `shipment_events:${e.id}:${ref}`, actorEmail: "" });
    }
  }

  /* ───────────── 2 · MÃ LÝ DO CÓ CẤU TRÚC CỦA ĐVVC ───────────── */
  const ma = rowsOf<{ id: string; order_id: string | null; code: number; at: Date }>(
    await db.execute(sql`
      select s.id, s.order_id, s.vtp_reason_code as code, coalesce(s.vtp_status_date, s.updated_at, s.created_at) as at
        from shipments s where s.vtp_reason_code is not null and s.order_id is not null`),
  );
  for (const m of ma) {
    gom.push({ shipmentId: m.id, orderId: m.order_id, source: "CARRIER_CODE", rawText: `Mã lý do ĐVVC ${m.code}`, occurredAt: new Date(m.at), sourceRef: `shipments:${m.id}:vtp_reason_code`, actorEmail: "" });
  }

  /* ───────────── 3 · GHI CHÚ CHĂM SÓC KIỆN ───────────── */
  const care = rowsOf<{ id: string; shipment_id: string; order_id: string | null; last_note: string; at: Date; by: string }>(
    await db.execute(sql`
      select c.id, c.shipment_id, c.order_id, coalesce(c.last_note,'') as last_note,
             coalesce(c.last_note_at, c.updated_at, c.created_at) as at, coalesce(c.last_note_by,'') as by
        from shipment_care c where coalesce(c.last_note,'') <> ''`),
  );
  for (const c of care) {
    if (!dangGhi(c.last_note, "CARE_NOTE")) continue;
    gom.push({ shipmentId: c.shipment_id, orderId: c.order_id, source: "CARE_NOTE", rawText: c.last_note.trim(), occurredAt: new Date(c.at), sourceRef: `shipment_care:${c.id}`, actorEmail: c.by });
  }

  /* ───────────── 4 · THAO TÁC CHĂM SÓC ───────────── */
  const act = rowsOf<{ id: string; shipment_id: string | null; order_id: string | null; note: string; at: Date; by: string }>(
    await db.execute(sql`
      select a.id, a.shipment_id, a.order_id, coalesce(a.note,'') as note, a.created_at as at, coalesce(a.actor_email,'') as by
        from care_actions a where coalesce(a.note,'') <> ''`),
  );
  for (const a of act) {
    if (!dangGhi(a.note, "CARE_NOTE") || (!a.shipment_id && !a.order_id)) continue;
    gom.push({ shipmentId: a.shipment_id, orderId: a.order_id, source: "CARE_NOTE", rawText: a.note.trim(), occurredAt: new Date(a.at), sourceRef: `care_actions:${a.id}`, actorEmail: a.by });
  }

  /* ───────────── 5 · PHIẾU KIỂM HÀNG HOÀN ───────────── */
  const insp = rowsOf<{ id: string; shipment_id: string | null; note: string; at: Date; by: string }>(
    await db.execute(sql`
      select i.id, i.shipment_id, coalesce(i.note,'') as note, coalesce(i.created_at, now()) as at, coalesce(i.inspected_by,'') as by
        from return_inspections i where coalesce(i.note,'') <> ''`),
  );
  for (const i of insp) {
    if (!dangGhi(i.note, "WAREHOUSE_INSPECTION") || !i.shipment_id) continue;
    gom.push({ shipmentId: i.shipment_id, orderId: null, source: "WAREHOUSE_INSPECTION", rawText: i.note.trim(), occurredAt: new Date(i.at), sourceRef: `return_inspections:${i.id}`, actorEmail: i.by });
  }

  /* ───────────── 6 · PHIẾU ĐỔI TRẢ PANCAKE ───────────── */
  const pk = rowsOf<{ id: string; order_id: string | null; status_name: string; at: Date }>(
    await db.execute(sql`
      select r.id, r.order_id, coalesce(r.status_name,'') as status_name, r.inserted_at as at
        from order_returns r where r.order_id is not null and coalesce(r.status_name,'') <> ''`),
  );
  for (const r of pk) {
    if (!dangGhi(r.status_name, "PANCAKE_RETURN")) continue;
    gom.push({ shipmentId: null, orderId: r.order_id, source: "PANCAKE_RETURN", rawText: r.status_name.trim(), occurredAt: new Date(r.at), sourceRef: `order_returns:${r.id}`, actorEmail: "" });
  }

  /* ───────────── 7 · NGƯỜI ĐÃ XÁC NHẬN (bảng kết luận có sẵn) ───────────── */
  const nguoi = rowsOf<{ id: string; shipment_id: string; reason: string; note: string; raw_reason: string; at: Date; by: string }>(
    await db.execute(sql`
      select x.id, x.shipment_id, x.reason, coalesce(x.note,'') as note, coalesce(x.raw_reason,'') as raw_reason,
             coalesce(x.updated_at, x.created_at) as at, coalesce(x.actor_email,'') as by
        from shipment_return_reasons x`),
  );
  for (const n of nguoi) {
    const txt = n.note.trim() || n.raw_reason.trim() || RETURN_REASON_LABEL[n.reason as ReturnReason] || n.reason;
    if (!txt) continue;
    gom.push({ shipmentId: n.shipment_id, orderId: null, source: "HUMAN_CONFIRMED", rawText: txt, occurredAt: new Date(n.at), sourceRef: `shipment_return_reasons:${n.id}`, actorEmail: n.by });
  }

  /* ───────────── THỐNG KÊ THEO NGUỒN ───────────── */
  const theoNguon = new Map<ReasonSource, { tong: number; xepDuoc: number; chan: number; lyDo: Map<ReturnReason, number> }>();
  const khoa = new Set<string>();
  const ghi: { q: QuanSat; key: string; reason: ReturnReason }[] = [];
  for (const q of gom) {
    const key = dedupeKey(q);
    if (khoa.has(key)) continue;
    khoa.add(key);
    const xep = classifyRaw(q.rawText, q.source);
    const t = theoNguon.get(q.source) ?? { tong: 0, xepDuoc: 0, chan: 0, lyDo: new Map() };
    t.tong += 1;
    if (xep.matched) {
      t.xepDuoc += 1;
      t.lyDo.set(xep.reason, (t.lyDo.get(xep.reason) ?? 0) + 1);
    }
    if (xep.blockedBySource) t.chan += 1;
    theoNguon.set(q.source, t);
    ghi.push({ q, key, reason: xep.reason });
  }

  console.log("nguồn                     | quan sát | xếp được | bị chặn | lý do nhiều nhất");
  console.log("--------------------------+----------+----------+---------+------------------");
  for (const [src, t] of [...theoNguon].sort((a, b) => b[1].tong - a[1].tong)) {
    const top = [...t.lyDo].sort((a, b) => b[1] - a[1])[0];
    console.log(
      `${REASON_SOURCE_LABEL[src].padEnd(25)} | ${so(t.tong).padStart(8)} | ${so(t.xepDuoc).padStart(8)} | ${so(t.chan).padStart(7)} | ${top ? `${RETURN_REASON_LABEL[top[0]]} (${so(top[1])})` : "—"}`,
    );
  }
  console.log(`${"TỔNG".padEnd(25)} | ${so(ghi.length).padStart(8)} | ${so(ghi.filter((g) => g.reason !== "UNKNOWN").length).padStart(8)} |`);

  if (!APPLY) {
    console.log(`\nCHẠY THỬ — chưa ghi gì. Bảng đang có ${dem(truoc)}. Thêm --apply để ghi ${so(ghi.length)} quan sát.`);
    process.exit(0);
  }

  /* ───────────── GHI THEO LÔ, CHỐNG TRÙNG BẰNG NỘI DUNG ───────────── */
  const LO = 500;
  let daGhi = 0;
  for (let i = 0; i < ghi.length; i += LO) {
    const lo = ghi.slice(i, i + LO);
    await db
      .insert(schema.returnReasonObservations)
      .values(
        lo.map((g) => ({
          shipmentId: g.q.shipmentId,
          orderId: g.q.orderId,
          source: g.q.source,
          rawText: g.q.rawText.slice(0, 2000),
          reasonAtWrite: g.reason,
          occurredAt: g.q.occurredAt,
          sourceRef: g.q.sourceRef,
          actorEmail: g.q.actorEmail.slice(0, 200),
          dedupeKey: g.key,
        })),
      )
      // Chạy lại KHÔNG sinh thêm dòng: khoá là nội dung, không phải số thứ tự.
      .onConflictDoNothing({ target: schema.returnReasonObservations.dedupeKey });
    daGhi += lo.length;
  }

  const sauR = await db.execute(sql`select count(*)::int as n from return_reason_observations`);
  const sau = Number(rowsOf<{ n: number }>(sauR)[0]?.n ?? 0);
  console.log(`\n✓ Đã ghi. Trước ${dem(truoc)} → sau ${so(sau)} dòng (thêm ${truoc === null ? "—" : so(sau - truoc)}; đã gửi ${so(daGhi)}, phần chênh là dòng đã có sẵn).`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
