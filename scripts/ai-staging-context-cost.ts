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

/**
 * TỶ LỆ KÝ TỰ / TOKEN — ĐO TỪ CHÍNH DỮ LIỆU, KHÔNG LẤY MỘT HẰNG SỐ NHỚ ĐƯỢC.
 *
 * Bản đầu dùng `ký tự ÷ 4`, con số quen thuộc cho tiếng Anh. Lượt chạy 19/09/2026 bác bỏ nó ngay
 * trong chính báo cáo của mình: lời dặn hệ thống 815 ký tự ước ra 204 token, trong khi TOÀN BỘ
 * đầu vào đo được của cùng bước ấy chỉ có 87 token. Một ước tính lớn hơn cả con số thật mà nó
 * đang ước là một ước tính sai, và tệ hơn, nó làm mọi phép nhân sau đó sai theo.
 *
 * Nên tỷ lệ nay ĐO từ lượt đã chạy: lấy tổng ký tự đã gửi chia tổng token đã đếm. Chưa đủ dữ liệu
 * để đo thì trả `null` và mọi ô ước tính in ra "—" — chưa biết, không phải một con số cho có.
 */
function tyLeKyTuTrenToken(tongKyTu: number, tongToken: number): number | null {
  if (tongToken <= 0 || tongKyTu <= 0) return null;
  return tongKyTu / tongToken;
}

function in3(n: number): string {
  return n.toLocaleString("vi-VN").replace(/\./g, " ");
}

async function main() {
  const days = Number(arg("days")) || 7;
  const tu = new Date(Date.now() - days * 86_400_000);
  const db = await getDb();

  console.log("═══ CHI PHÍ NGỮ CẢNH — CHỈ ĐỌC, KHÔNG GỌI MÔ HÌNH ═══");
  console.log(`   cửa sổ: ${days} ngày`);

  // ① LỜI DẶN HỆ THỐNG — ĐẾM KÝ TỰ, chính xác, không cần CSDL. Chưa quy ra token ở đây: tỷ lệ
  //    quy đổi phải ĐO từ dữ liệu thật ở bước ③, không lấy một hằng số nhớ được.
  const uKyTu = understandSystemPrompt().length;
  const gKyTu = generateSystemPrompt().length;
  console.log(`\n① LỜI DẶN HỆ THỐNG (đếm ký tự, chính xác)`);
  console.log(`   understand : ${in3(uKyTu)} ký tự`);
  console.log(`   generate   : ${in3(gKyTu)} ký tự`);

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

  /*
    ③′ HIỆU CHUẨN TỶ LỆ QUY ĐỔI TỪ CHÍNH LƯỢT ĐÃ CHẠY.

    Bước `understand` gửi ĐÚNG: lời dặn hệ thống + tin của khách. Cả hai đều đếm được ký tự, và
    token đầu vào thì đã đo được — nên tỷ lệ ký tự/token của chính dây chuyền này tính ra được,
    thay vì mượn một con số của ngôn ngữ khác.
  */
  const kyTuTin = await db
    .select({ tb: sql<number>`round(avg(length(m.text)))::int` })
    .from(sql`sales_messages m`)
    .where(sql`m.sent_at > ${tu} and m.direction = 'IN' and btrim(m.text) <> ''`);
  const tbKyTuTin = kyTuTin[0]?.tb ?? 0;
  const u = thuc.find((r) => r.step === "understand");
  const tyLe = u && u.calls > 0 ? tyLeKyTuTrenToken((uKyTu + tbKyTuTin) * u.calls, u.tbVao * u.calls) : null;
  console.log(`\n③ HIỆU CHUẨN (đo từ chính lượt đã chạy, không mượn hằng số)`);
  if (tyLe === null) {
    console.log(`   chưa đủ dữ liệu để đo tỷ lệ ký tự/token ⇒ mọi ô ước tính dưới đây in "—"`);
  } else {
    console.log(`   ${in3(uKyTu)} ký tự lời dặn + ${in3(tbKyTuTin)} ký tự tin khách = ${in3(uKyTu + tbKyTuTin)} ký tự`);
    console.log(`   ứng với ${in3(u!.tbVao)} token đo được ⇒ ~${tyLe.toFixed(1)} ký tự / token`);
    if (tyLe > 6) {
      console.log(`   ⚠ tỷ lệ cao bất thường. Hai cách giải thích, và phải nói ra cả hai:`);
      console.log(`     · nhà cung cấp đếm token theo cách khác cách ta đoán; hoặc`);
      console.log(`     · lời dặn hệ thống KHÔNG đi trọn vẹn vào mỗi lượt như tệp này giả định.`);
      console.log(`     Chưa phân định được thì mọi con số ước tính dưới đây đọc như DẤU HIỆU, không như phép đo.`);
    }
  }
  const uocToken = (soKyTu: number): number | null => (tyLe === null ? null : Math.round(soKyTu / tyLe));
  const inUoc = (soKyTu: number): string => {
    const t = uocToken(soKyTu);
    return t === null ? "—" : `${in3(t)} token (ước)`;
  };

  const l = lichSu[0];
  console.log(`\n③″ NẾU GỬI ĐỦ LỊCH SỬ HỘI THOẠI (ƯỚC TÍNH — chưa từng gửi nên không có số đo thật)`);
  if (!l || !l.soHoiThoai) {
    console.log("   (không có hội thoại nào trong cửa sổ)");
  } else {
    console.log(`   ${in3(l.soHoiThoai)} hội thoại · trung bình ${in3(l.tbTin)} tin/hội thoại`);
    console.log(`   lịch sử TB : ${in3(l.tbKyTu)} ký tự ≈ ${inUoc(l.tbKyTu)}`);
    console.log(`   p95        : ${in3(l.p95KyTu)} ký tự ≈ ${inUoc(l.p95KyTu)}`);
    console.log(`   dài nhất   : ${in3(l.maxKyTu)} ký tự ≈ ${inUoc(l.maxKyTu)}`);
  }

  // ④ KẾT LUẬN — nói thẳng chiều của kết quả.
  const vaoUnderstand = thuc.find((r) => r.step === "understand")?.tbVao ?? 0;
  console.log(`\n④ ĐỌC SỐ`);
  const uocLichSu = l?.tbKyTu ? uocToken(l.tbKyTu + uKyTu) : null;
  if (vaoUnderstand && uocLichSu !== null) {
    const lan = uocLichSu / Math.max(1, vaoUnderstand);
    console.log(`   Đang gửi ${in3(vaoUnderstand)} token/lượt (ĐO ĐƯỢC). Gửi đủ lịch sử ước ${in3(uocLichSu)} token — gấp ~${lan.toFixed(1)}× (ƯỚC).`);
  } else if (vaoUnderstand) {
    console.log(`   Đang gửi ${in3(vaoUnderstand)} token/lượt (ĐO ĐƯỢC). Phần "gửi đủ lịch sử" CHƯA ƯỚC ĐƯỢC.`);
  }
  console.log(`   Dây chuyền KHÔNG gửi lịch sử hội thoại lần nào: \`understand\` chỉ gửi tin hiện tại`);
  console.log(`   (cắt 2000 ký tự), \`generate\` gửi câu nháp + tin hiện tại (cắt 500 ký tự).`);
  console.log(`   ⇒ Phần "nén ngữ cảnh để tiết kiệm" gần như KHÔNG CÒN GÌ để nén.`);
  console.log(`   ⇒ Câu hỏi còn mở là chiều NGƯỢC LẠI: ngữ cảnh mỏng thế có phải nguyên nhân của`);
  console.log(`     mất trạng thái giữa hai lượt không. Đó là câu hỏi CHẤT LƯỢNG, phải có người chấm.`);
  process.exit(0);
}

main().catch((e) => { console.error(`✗ ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
