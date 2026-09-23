/**
 * PHÂN LOẠI LẠI NGƯỜI GỬI CHO TIN ĐÃ NẠP.
 *
 * Chủ shop cho biết 22/09/2026: cột "Nhân viên trả lời" thực chất là một bot. Đo lại thì toàn bộ
 * **4.749/4.749** tin phía shop mang nhãn `PAGE_HUMAN` đến từ ĐÚNG MỘT tên — `Hải An Fashion`,
 * tức tên fanpage — và số tin ERP nhận ra là máy lúc đó là **0**.
 *
 * Bản vá (`settings["ai.botSenderNames"]`) chỉ áp cho tin nạp MỚI: `ingestMessage` chống trùng
 * theo mã tin, nên tin cũ không bao giờ được đọc lại. Sau bản vá, phép đo ngày 23/09 cho thấy
 * `PAGE_BOT` = 192 (tin mới) trong khi `PAGE_HUMAN` vẫn đứng nguyên 4.749 (tin cũ).
 *
 * Hậu quả của việc để nguyên KHÔNG chỉ là một cột hiển thị sai:
 *   · hàng đợi trợ lý coi hội thoại là "shop đã đáp rồi" và GIẤU nó đi (`HUMAN_REPLY_SENDER_TYPES`);
 *   · `relinkHumanReplies` nối câu của máy vào lượt khách như thể một người đã trả lời;
 *   · mọi phép đo "thời gian phản hồi của người" đang nói về một cái máy.
 *
 * ─── DỊCH LẠI BẰNG CHÍNH BỘ PHÂN LOẠI CỦA ĐƯỜNG GHI ───
 *
 * Script gọi `classifySender()` — đúng hàm mà `ingestMessage` dùng — chứ không viết một luật thứ
 * hai bằng SQL. Hai bản luật sẽ trôi xa nhau, và bản chặt hơn sẽ thắng ở một nửa dữ liệu (luật 66
 * đã trả giá cho đúng chuyện này với bộ dịch trạng thái Viettel Post).
 *
 * ─── KHÔNG ĐỤNG TỚI TRẠNG THÁI HỘI THOẠI ───
 *
 * `human_takeover_at` KHÔNG được xoá ở đây. Nó do công cụ `conversation.handoff` của chính nhân
 * sự AI ghi, hoặc do một người bấm "tự nhận việc" — cả hai đều là quyết định CÓ THẬT, không phải
 * hệ quả của việc phân loại sai. Xoá nó là dựng lại một trạng thái chưa từng tồn tại (luật 35).
 *
 * Dùng:
 *   npx tsx scripts/ai-reclassify-senders.ts            # CHẠY THỬ, chỉ báo cáo
 *   npx tsx scripts/ai-reclassify-senders.ts --apply    # ghi thật
 */
import "dotenv/config";
import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { ensureMigrated } from "@/db/migrate";
import { classifySender, declaredBotNames } from "@/lib/ai-workforce/agents/sales/ingest";

type Row = {
  id: string;
  fromPage: boolean;
  fromName: string;
  text: string;
  senderType: string;
  customerName: string;
};

async function main() {
  const apply = process.argv.includes("--apply");
  await ensureMigrated();
  const db = await getDb();

  const botNames = await declaredBotNames();
  if (!botNames.length) {
    // Chạy mà chưa khai tên máy nào thì mọi tin sẽ giữ nguyên nhãn cũ — và người chạy sẽ tưởng
    // "không có gì để sửa". Dừng lại và nói rõ, thay vì báo một con số 0 vô nghĩa.
    console.error('✗ settings["ai.botSenderNames"] chưa khai tên máy nào — không có gì để phân loại lại.');
    console.error('  Khai trước: ops ai-staging-setting với arg: ai.botSenderNames \'{"names":["<tên>"]}\'');
    process.exit(1);
  }
  console.log(`Tên máy đã khai: ${botNames.join(" · ")}`);

  const truoc = await db.execute(sql`
    select sender_type, count(*)::int as n from sales_messages group by 1 order by 2 desc
  `);
  console.log("\nTRƯỚC:");
  console.table((truoc as unknown as { rows?: unknown[] }).rows ?? truoc);

  // Chỉ xét tin PHÍA SHOP: tin của khách không có gì để phân loại lại.
  const rows = (await db
    .select({
      id: schema.salesMessages.id,
      fromPage: schema.salesMessages.fromPage,
      fromName: schema.salesMessages.fromName,
      text: schema.salesMessages.text,
      senderType: schema.salesMessages.senderType,
      customerName: schema.salesConversations.customerName,
    })
    .from(schema.salesMessages)
    .innerJoin(schema.salesConversations, eq(schema.salesConversations.id, schema.salesMessages.conversationId))
    .where(eq(schema.salesMessages.fromPage, true))) as Row[];

  const doi: { id: string; tu: string; sang: string }[] = [];
  for (const r of rows) {
    const moi = classifySender({
      fromPage: true,
      fromName: r.fromName,
      text: r.text,
      customerName: r.customerName,
      botNames,
    });
    if (moi !== r.senderType) doi.push({ id: r.id, tu: r.senderType, sang: moi });
  }

  const gop = new Map<string, number>();
  for (const d of doi) gop.set(`${d.tu} → ${d.sang}`, (gop.get(`${d.tu} → ${d.sang}`) ?? 0) + 1);

  console.log(`\nSẼ ĐỔI: ${doi.length}/${rows.length} tin phía shop`);
  for (const [k, v] of [...gop].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);

  if (!doi.length) {
    console.log("\nKhông có gì để đổi.");
    return;
  }

  if (!apply) {
    console.log("\nCHẠY THỬ — chưa ghi gì. Thêm --apply để ghi thật.");
    return;
  }

  /*
    Ghi theo LÔ, không một câu UPDATE cho mỗi tin: 4.749 lượt đi về CSDL cho một việc chạy một
    lần là tự làm chậm mình mười lần mà không đổi kết quả.
  */
  const theoNhan = new Map<string, string[]>();
  for (const d of doi) theoNhan.set(d.sang, [...(theoNhan.get(d.sang) ?? []), d.id]);
  let daGhi = 0;
  for (const [nhan, ids] of theoNhan) {
    for (let i = 0; i < ids.length; i += 500) {
      const lo = ids.slice(i, i + 500);
      const res = await db.execute(sql`
        update sales_messages set sender_type = ${nhan}
        where id in (${sql.join(lo.map((x) => sql`${x}`), sql`, `)})
      `);
      daGhi += Number((res as unknown as { rowCount?: number }).rowCount ?? lo.length);
    }
  }

  const sau = await db.execute(sql`
    select sender_type, count(*)::int as n from sales_messages group by 1 order by 2 desc
  `);
  console.log(`\n✓ Đã đổi ${daGhi} tin.`);
  console.log("SAU:");
  console.table((sau as unknown as { rows?: unknown[] }).rows ?? sau);
  console.log(
    "\nKHÔNG đụng tới human_takeover_at: nó do công cụ handoff của nhân sự AI hoặc do người bấm tự nhận việc — quyết định có thật, không phải hệ quả của phân loại sai.",
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
