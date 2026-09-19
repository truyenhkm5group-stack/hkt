/**
 * CHI PHÍ NGỮ CẢNH — ĐANG GỬI BAO NHIÊU, VÀ GỬI ĐỦ LỊCH SỬ THÌ TỐN BAO NHIÊU. CHỈ ĐỌC.
 *
 *   npx tsx scripts/ai-staging-context-cost.ts [--days=7]
 *
 * ═══ KẾT QUẢ CÓ THỂ NGƯỢC VỚI CÂU HỎI ═══
 *
 * Câu hỏi thường gặp là "nén ngữ cảnh lại thì tiết kiệm bao nhiêu". Nhưng dây chuyền bán hàng
 * hiện KHÔNG gửi lịch sử hội thoại lần nào:
 *
 *   · bước `understand` gửi: lời dặn hệ thống + ĐÚNG tin nhắn hiện tại (cắt 2000 ký tự);
 *   · bước `generate`   gửi: lời dặn hệ thống + câu nháp + tin hiện tại (cắt 500 ký tự).
 *
 * Nghĩa là nó đã ở đầu NÉN NHẤT của thang, và phần "tiết kiệm được bao nhiêu" gần như bằng không.
 * Phép đo này in ra con số để khẳng định điều đó thay vì để người ta đi tối ưu một thứ đã tối ưu.
 *
 * Và nó in luôn chiều NGƯỢC LẠI — gửi đủ lịch sử thì tốn thêm bao nhiêu — vì đó mới là câu hỏi
 * còn mở: ngữ cảnh mỏng quá có thể là nguyên nhân của mất trạng thái giữa hai lượt.
 *
 * ═══ MỘT CON SỐ Ở ĐÂY LÀ ƯỚC TÍNH, VÀ ĐƯỢC GỌI ĐÚNG TÊN ═══
 *
 * Token của phần lịch sử CHƯA TỪNG được gửi đi nên không có số đo thật. Ước bằng ký tự ÷ 4 và in
 * kèm nhãn ƯỚC TÍNH. Con số đo được (token thật của lượt đã chạy) in riêng, không trộn.
 */
import "dotenv/config";
import { gte, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { understandSystemPrompt } from "@/lib/ai-workforce/agents/sales/understand";
import { generateSystemPrompt } from "@/lib/ai-workforce/agents/sales/generate";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? "";

/** Ước token từ ký tự. TIẾNG VIỆT CÓ DẤU tốn nhiều token hơn tiếng Anh, nên đây là ước THẤP. */
const uocToken = (soKyTu: number) => Math.round(soKyTu / 4);

function in3(n: number): string {
  return n.toLocaleString("vi-VN").replace(/\./g, " ");
}

async function main() {
  const days = Number(arg("days")) || 7;
  const tu = new Date(Date.now() - days * 86_400_000);
  const db = await getDb();

  console.log("═══ CHI PHÍ NGỮ CẢNH — CHỈ ĐỌC, KHÔNG GỌI MÔ HÌNH ═══");
  console.log(`   cửa sổ: ${days} ngày`);

  // ① LỜI DẶN HỆ THỐNG — đo được chính xác, ngay tại đây, không cần CSDL.
  const uKyTu = understandSystemPrompt().length;
  const gKyTu = generateSystemPrompt().length;
  console.log(`\n① LỜI DẶN HỆ THỐNG (đo trực tiếp)`);
  console.log(`   understand : ${in3(uKyTu)} ký tự  ≈ ${in3(uocToken(uKyTu))} token (ước)`);
  console.log(`   generate   : ${in3(gKyTu)} ký tự  ≈ ${in3(uocToken(gKyTu))} token (ước)`);

  // ② TOKEN THẬT ĐÃ GỬI — số ĐO ĐƯỢC, không ước.
  const thuc = await db
    .select({
      step: schema.aiModelCalls.step,
      calls: sql<number>`count(*)::int`,
      tbVao: sql<number>`round(avg(${schema.aiModelCalls.inputTokens}))::int`,
      tbRa: sql<number>`round(avg(${schema.aiModelCalls.outputTokens}))::int`,
      tbDem: sql<number>`round(avg(${schema.aiModelCalls.cachedInputTokens}))::int`,
      maxVao: sql<number>`max(${schema.aiModelCalls.inputTokens})::int`,
    })
    .from(schema.aiModelCalls)
    .where(gte(schema.aiModelCalls.createdAt, tu))
    .groupBy(schema.aiModelCalls.step);

  console.log(`\n② TOKEN THẬT ĐÃ GỬI (ĐO ĐƯỢC, không ước)`);
  if (!thuc.length) console.log("   (chưa có lượt gọi nào trong cửa sổ)");
  for (const r of thuc) {
    console.log(`   ${String(r.step).padEnd(14)} ${String(r.calls).padStart(4)} lượt · vào TB ${in3(r.tbVao)} (đỉnh ${in3(r.maxVao)}) · đệm TB ${in3(r.tbDem)} · ra TB ${in3(r.tbRa)}`);
  }

  // ③ NẾU GỬI ĐỦ LỊCH SỬ — ƯỚC TÍNH, và gọi đúng tên là ước tính.
  const lichSu = await db
    .select({
      tbKyTu: sql<number>`round(avg(t.tong))::int`,
      p95KyTu: sql<number>`round(percentile_cont(0.95) within group (order by t.tong))::int`,
      maxKyTu: sql<number>`max(t.tong)::int`,
      soHoiThoai: sql<number>`count(*)::int`,
      tbTin: sql<number>`round(avg(t.so_tin))::int`,
    })
    .from(
      sql`(
        select m.conversation_id, sum(length(m.text)) as tong, count(*) as so_tin
        from sales_messages m
        where m.sent_at > ${tu}
        group by m.conversation_id
      ) as t`,
    );

  const l = lichSu[0];
  console.log(`\n③ NẾU GỬI ĐỦ LỊCH SỬ HỘI THOẠI (ƯỚC TÍNH — chưa từng gửi nên không có số đo thật)`);
  if (!l || !l.soHoiThoai) {
    console.log("   (không có hội thoại nào trong cửa sổ)");
  } else {
    console.log(`   ${in3(l.soHoiThoai)} hội thoại · trung bình ${in3(l.tbTin)} tin/hội thoại`);
    console.log(`   lịch sử TB : ${in3(l.tbKyTu)} ký tự ≈ ${in3(uocToken(l.tbKyTu))} token (ước)`);
    console.log(`   p95        : ${in3(l.p95KyTu)} ký tự ≈ ${in3(uocToken(l.p95KyTu))} token (ước)`);
    console.log(`   dài nhất   : ${in3(l.maxKyTu)} ký tự ≈ ${in3(uocToken(l.maxKyTu))} token (ước)`);
  }

  // ④ KẾT LUẬN — nói thẳng chiều của kết quả.
  const vaoUnderstand = thuc.find((r) => r.step === "understand")?.tbVao ?? 0;
  console.log(`\n④ ĐỌC SỐ`);
  if (vaoUnderstand && l?.tbKyTu) {
    const uocDayDu = uocToken(l.tbKyTu) + uocToken(uKyTu);
    const lan = uocDayDu / Math.max(1, vaoUnderstand);
    console.log(`   Đang gửi ${in3(vaoUnderstand)} token/lượt. Gửi đủ lịch sử ước ${in3(uocDayDu)} token — gấp ~${lan.toFixed(1)}×.`);
  }
  console.log(`   Dây chuyền KHÔNG gửi lịch sử hội thoại lần nào: \`understand\` chỉ gửi tin hiện tại`);
  console.log(`   (cắt 2000 ký tự), \`generate\` gửi câu nháp + tin hiện tại (cắt 500 ký tự).`);
  console.log(`   ⇒ Phần "nén ngữ cảnh để tiết kiệm" gần như KHÔNG CÒN GÌ để nén.`);
  console.log(`   ⇒ Câu hỏi còn mở là chiều NGƯỢC LẠI: ngữ cảnh mỏng thế có phải nguyên nhân của`);
  console.log(`     mất trạng thái giữa hai lượt không. Đó là câu hỏi CHẤT LƯỢNG, phải có người chấm.`);
  process.exit(0);
}

main().catch((e) => { console.error(`✗ ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
