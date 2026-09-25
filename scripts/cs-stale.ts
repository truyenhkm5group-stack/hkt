/**
 * ĐỐI CHIẾU HÀNG ĐỢI CSKH VỚI THỰC TẾ HIỆN TẠI.
 *
 *   npx tsx --tsconfig tsconfig.json scripts/cs-stale.ts            # CHẠY THỬ, không ghi gì
 *   npx tsx --tsconfig tsconfig.json scripts/cs-stale.ts --apply    # đóng mềm các case xác định
 *
 * MẶC ĐỊNH CHẠY THỬ. Đổi dữ liệu production phải là một quyết định tường minh, không phải tác dụng
 * phụ của việc chạy một lệnh xem thử.
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { CS_KIND_LABEL } from "@/lib/constants/cs";
import { RECONCILE_REASONS, RECONCILE_REASON_LABEL } from "@/lib/cs/reconcile-order-created";
import { applyStaleReconciliation, staleReport, STALE_VERDICTS, STALE_VERDICT_LABEL } from "@/lib/cs/stale";
import { rowsOf } from "@/lib/sql-rows";

/**
 * KÊNH TÓM TẮT CỦA THAO TÁC OPS. Qua workflow "Vận hành ERP trên VPS", kết quả của script này được
 * MÃ HOÁ (mẫu kiểm chứng là TIÊU ĐỀ case — mang tên khách, có loại mang cả SĐT); chỉ dòng mang tiền
 * tố dưới đây được in ra log công khai. Vì thế CHỈ bảng đếm đi qua đây — không bao giờ một mẫu.
 * Tiền tố viết lại tại chỗ (không import): ops lấy script từ `main` nhưng `lib/` từ ảnh đang chạy.
 */
const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s}`);

/**
 * BẢN ĐỒ TRÁCH NHIỆM — mỗi case đang mở đứng ở đâu trong vòng đời kiện hàng.
 *
 * Câu hỏi "case này của Vận đơn hay của CSKH" trả lời bằng CHỨNG TỪ: đơn của case (gắn thẳng, hoặc
 * đơn sinh ra từ chính hội thoại) và lần gửi của đơn đó — lần đang chạy nếu có, không thì lần mới
 * nhất. Chỉ ĐẾM, không mẫu: tiêu đề case mang tên khách.
 */
async function banDoTrachNhiem() {
  const db = await getDb();
  const rows = rowsOf<{ kind: string; tinh_trang: string; n: number }>(
    await db.execute(sql`
      with don as (
        select c.kind,
               coalesce(c.order_id, (
                 select o2.id from orders o2
                  where coalesce(c.conversation_id, '') <> '' and o2.conversation_id = c.conversation_id
                    and o2.stage not in ('CANCELLED','DELETED')
                  order by o2.inserted_at desc limit 1)) as don_id
          from cs_cases c
         where c.status in ('OPEN','IN_PROGRESS')
      )
      select d.kind,
             case when d.don_id is null then 'CHƯA GẮN ĐƠN'
                  when k.id is null then 'CHƯA CÓ KIỆN · POS ' || coalesce(o.stage::text, '?')
                  when k.is_final then 'KIỆN ĐÃ CHỐT · ' || k.stage::text
                  else 'KIỆN ĐANG CHẠY · ' || k.stage::text end as tinh_trang,
             count(*)::int as n
        from don d
        left join orders o on o.id = d.don_id
        left join lateral (
          select s.id, s.stage, s.is_final from shipments s
           where s.order_id = d.don_id
           order by s.is_final asc, s.created_at desc limit 1
        ) k on true
       group by 1, 2
       order by 1, 3 desc`),
  );
  tomTat("═══ BẢN ĐỒ TRÁCH NHIỆM: loại case × tình trạng kiện (case đang mở) ═══");
  for (const r of rows) tomTat(`  ${String(r.n).padStart(5)}  ${(CS_KIND_LABEL[r.kind as keyof typeof CS_KIND_LABEL] ?? r.kind).padEnd(34)} ${r.tinh_trang}`);
}

/**
 * CASE ĐANG MỞ TRÊN KIỆN ĐÃ CHỐT — chúng hiện ở "Cần care" của trang Vận đơn từ 25/09/2026.
 *
 * Câu hỏi quyết định luật đóng: case mở TRƯỚC hay SAU mốc ĐVVC chốt kiện (phát xong / hoàn về)?
 * Mở trước ⇒ lời khách nói về một chuyến giao đã kết thúc. Mở sau ⇒ yêu cầu sau bán (khiếu nại, đổi,
 * trả) còn nguyên. Kèm "có người thật chạm chưa" vì máy không đóng hộ việc người đang cầm. Chỉ đếm.
 */
async function caseTrenKienDaChot() {
  const db = await getDb();
  const rows = rowsOf<{ kind: string; chang: string; moc: string; cham: string; n: number }>(
    await db.execute(sql`
      select c.kind,
             k.stage::text as chang,
             case when k.moc is null then 'KHÔNG CÓ MỐC' when c.created_at <= k.moc then 'MỞ TRƯỚC MỐC CHỐT' else 'MỞ SAU MỐC CHỐT' end as moc,
             case when (coalesce(c.assignee, '') <> '' and c.assignee <> 'Bot ERP') or c.assignee_user_id is not null
                    or exists (select 1 from cs_case_events e where e.case_id = c.id and e.actor_id is not null)
                  then 'CÓ NGƯỜI CHẠM' else 'CHƯA AI CHẠM' end as cham,
             count(*)::int as n
        from cs_cases c
        join lateral (
          select s.stage, coalesce(s.delivered_at, s.returned_at, s.vtp_status_date) as moc, s.is_final
            from shipments s
           where s.order_id = c.order_id
           order by s.is_final asc, s.created_at desc
           limit 1
        ) k on k.is_final
       where c.status in ('OPEN','IN_PROGRESS') and c.kind <> 'DELIVERY_FAILED'
       group by 1, 2, 3, 4
       order by 1, 2, 3, 4`),
  );
  tomTat("═══ CASE ĐANG MỞ TRÊN KIỆN ĐÃ CHỐT: loại × chặng cuối × mở trước/sau mốc chốt × người chạm ═══");
  for (const r of rows) tomTat(`  ${String(r.n).padStart(5)}  ${(CS_KIND_LABEL[r.kind as keyof typeof CS_KIND_LABEL] ?? r.kind).padEnd(34)} ${r.chang.padEnd(10)} ${r.moc.padEnd(18)} ${r.cham}`);
  if (!rows.length) tomTat("  (không có)");
}

async function main() {
  const apply = process.argv.includes("--apply");
  await banDoTrachNhiem();
  await caseTrenKienDaChot();
  const bc = await staleReport(20);
  console.log("");
  tomTat(`═══ HÀNG ĐỢI CSKH ĐANG MỞ: ${bc.openTotal} case ═══`);
  tomTat("KẾT LUẬN (không tính “chưa tạo đơn” — loại đó có máy riêng, xem dưới):");
  for (const v of STALE_VERDICTS) tomTat(`  ${v.padEnd(14)} ${String(bc.byVerdict[v]).padStart(5)}  ${STALE_VERDICT_LABEL[v]}`);

  tomTat("THEO LOẠI:");
  for (const k of bc.byKind) {
    const chiTiet = STALE_VERDICTS.filter((v) => k.counts[v]).map((v) => `${v}=${k.counts[v]}`).join(" · ");
    tomTat(`  ${String(k.total).padStart(5)}  ${(CS_KIND_LABEL[k.kind] ?? k.kind).padEnd(34)} ${chiTiet}`);
  }

  const o = bc.orderNotCreated;
  tomTat(`═══ "ĐỦ THÔNG TIN · CHƯA TẠO ĐƠN": ${o.openBefore} đang mở ═══`);
  for (const r of RECONCILE_REASONS) tomTat(`  ${String(o.closed[r]).padStart(5)}  ${r.padEnd(22)} ${RECONCILE_REASON_LABEL[r]}`);
  tomTat(`  ${String(o.humanTouched).padStart(5)}  ĐÃ CÓ NGƯỜI CHẠM        — máy KHÔNG đóng hộ, để người quyết`);
  tomTat(`  ${String(o.stillPending).padStart(5)}  CÒN TREO THẬT           — chưa có chứng cứ nào nói đơn đã tồn tại`);

  // MẪU = tiêu đề case (tên khách, có khi SĐT) ⇒ KHÔNG qua kênh tóm tắt: chỉ đọc được trong bản mã.
  console.log(`\n═══ MẪU ĐỂ KIỂM CHỨNG (${bc.samples.length} case máy sẽ đóng) ═══`);
  for (const s of bc.samples) console.log(`  ${s.id}  ${String(s.ageDays).padStart(3)}n  ${(CS_KIND_LABEL[s.kind] ?? s.kind).padEnd(24)} ${s.title.slice(0, 60)}\n        └─ ${s.reason}`);
  if (!bc.samples.length) console.log("  (không có case nào máy đóng được — hàng đợi đang phản ánh đúng thực tế)");

  if (!apply) {
    tomTat(`CHẠY THỬ — KHÔNG ghi một dòng nào. Thêm --apply để đóng mềm ${bc.byVerdict.AUTO_RESOLVE + o.closedTotal} case xác định.`);
    return;
  }
  const kq = await applyStaleReconciliation({ dryRun: false, actor: "ops:cs-stale" });
  tomTat(`═══ ĐÃ ÁP DỤNG ═══`);
  tomTat(`  ${kq.closed}/${kq.planned} case đóng mềm (AUTO_RESOLVED, có lý do từng case)`);
  for (const k of kq.byKind) tomTat(`    · ${CS_KIND_LABEL[k.kind] ?? k.kind}: ${k.n}`);
  tomTat(`  ${kq.orderNotCreated.closedTotal} case "chưa tạo đơn" đóng theo bốn bậc chứng cứ`);
  tomTat(`  CÒN LẠI: ${kq.orderNotCreated.stillPending} case "chưa tạo đơn" còn treo thật`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
