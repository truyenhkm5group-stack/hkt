/**
 * MẺ CHẠY NGẦM VỚI MÔ HÌNH THẬT — đo khả năng HIỂU và DIỄN ĐẠT, không đo khả năng bịa.
 *
 *   npx tsx scripts/ai-shadow-batch.ts --page=<ID> --max=20 [--dry-run]
 *
 * ─── DÙNG LẠI DÂY CHUYỀN THẬT, KHÔNG DỰNG ĐƯỜNG SONG SONG ───
 *
 * Script này KHÔNG tự gọi mô hình. Nó xếp việc vào `ai_tasks` rồi gọi `drainSalesTasks()` — đúng
 * đường mà webhook và bộ lập lịch sẽ đi. Nhờ vậy cái đo được là dây chuyền THẬT: cùng bộ định
 * tuyến, cùng cổng công cụ, cùng chặn cứng, cùng cách ghi `ai_runs` / `ai_model_calls`.
 *
 * Một script tự gọi mô hình rồi tự chấm sẽ đo một thứ không ai chạy trong đời thật.
 *
 * ─── HAI CON SỐ PHẢI BẰNG 0, VÀ ĐƯỢC ĐỌC LẠI TỪ CSDL ───
 *
 * Số tin gửi khách và số đơn do máy tạo. Khẳng định suông không có giá trị; cuối lượt script ĐỌC
 * LẠI bảng để chứng minh.
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { ensureMigrated } from "@/db/migrate";
import { aiEnv, getAiSettings } from "@/lib/ai-workforce/config";
import { drainSalesTasks } from "@/lib/ai-workforce/agents/sales/pipeline";
import { defaultProviderName, getProvider } from "@/lib/ai-workforce/providers";
import { ensureAgents, getAgent } from "@/lib/ai-workforce/registry";
import { rowsOf } from "@/lib/sql-rows";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? "";
const num = (k: string, d: number) => (Number(arg(k)) > 0 ? Number(arg(k)) : d);

/** Che số điện thoại trước khi in — log Actions là CÔNG KHAI. */
function che(s: string): string {
  return s.replace(/\b(0|\+84)\d{8,10}\b/g, "[SĐT]").replace(/\s+/g, " ").trim();
}
const cat = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const pageId = arg("page");
  const max = Math.min(num("max", 20), 50); // TRẦN CỨNG 50 — mẻ nhỏ, đọc được bằng mắt.
  if (!pageId) { console.error("Thiếu --page"); process.exit(1); }

  await ensureMigrated();
  const db = await getDb();
  await ensureAgents(db);
  const settings = await getAiSettings();

  // ───── ① ĐANG CHẠY TRÊN GÌ ─────
  const ten = defaultProviderName();
  const nha = getProvider(ten);
  console.log(`\n① CẤU HÌNH`);
  console.log(`   nhà cung cấp : ${ten}${nha?.available() ? "" : "  ⛔ CHƯA ĐỦ CẤU HÌNH"}`);
  console.log(`   ECONOMY      : ${nha?.defaultModel("ECONOMY") || "—"}`);
  console.log(`   STRONG       : ${nha?.defaultModel("STRONG") || "—"}`);
  console.log(`   gọi mô hình  : ${settings.modelCallsEnabled ? "BẬT" : "TẮT"}`);
  console.log(`   gửi tin khách: ${aiEnv.hardLimits.allowCustomerSend ? "⛔ MỞ" : "✓ CẤM"} · tạo đơn: ${aiEnv.hardLimits.allowOrderCreate ? "⛔ MỞ" : "✓ CẤM"}`);
  const agent = await getAgent("sales", settings, db);
  console.log(`   nấc quyền hạn: ${agent?.mode ?? "—"}`);

  // ───── ② CHỌN HỘI THOẠI: PHẢI CÓ TIN KHÁCH THẬT ─────
  const ds = rowsOf<{ id: string; mid: string; text: string }>(
    await db.execute(sql`
      select c.id, m.id as mid, m.text
      from sales_conversations c
      join lateral (
        select id, text from sales_messages
        where conversation_id = c.id and from_page = false and btrim(text) <> ''
        order by sent_at desc nulls last limit 1
      ) m on true
      where c.page_id = ${pageId}
      order by c.updated_at desc
      limit ${max}
    `),
  );
  console.log(`\n② MẺ: ${ds.length} hội thoại có tin khách thật (trần ${max})`);
  if (!ds.length) { console.log("   Không có gì để chạy."); process.exit(0); }
  if (dryRun) { console.log("\n--dry-run: KHÔNG xếp việc, KHÔNG gọi mô hình."); process.exit(0); }

  /*
    ③ XẾP VIỆC RỒI CHẠY DÂY CHUYỀN THẬT — trừ khi chỉ đọc lại.

    `--report-only` tồn tại vì một lý do cụ thể: lượt đầu chạy xong 18/18 rồi chết ở CÂU SQL BÁO
    CÁO. Dữ liệu đã nằm trong CSDL, nhưng không có đường nào đọc lại nó — muốn xem kết quả thì
    phải chạy lại cả mẻ, tức trả tiền mô hình lần thứ hai cho một lỗi hiển thị. Tách phần đo khỏi
    phần chạy để chuyện đó không lặp lại.
  */
  const chiDoc = process.argv.includes("--report-only");
  if (!agent) { console.error("Chưa có bản nhân sự bán hàng"); process.exit(1); }
  if (chiDoc) {
    console.log("\n③ --report-only: KHÔNG xếp việc, KHÔNG gọi mô hình — chỉ đọc lại kết quả đã có.");
  } else {
  const lo = `shadow-${Date.now()}`;
  await db.insert(schema.aiTasks).values(
    ds.map((c) => ({
      agentId: agent.id,
      kind: "SALES_REPLY",
      subjectType: "sales_conversation",
      subjectId: c.id,
      status: "PENDING",
      payload: { messageId: c.mid, batch: lo },
      // Khoá chống trùng riêng cho mẻ này: không đụng việc do webhook sinh ra.
      dedupeKey: `${lo}:${c.id}`,
    })),
  );

  const t0 = Date.now();
  const kq = await drainSalesTasks(ds.length, db);
  const giay = Math.round((Date.now() - t0) / 100) / 10;
  console.log(`\n③ ĐÃ CHẠY ${kq.ran}/${ds.length} việc trong ${giay}s${kq.skipped ? ` (bỏ qua: ${kq.reason})` : ""}`);
  }

  // ───── ④ CÁC LƯỢT GỌI MÔ HÌNH ─────
  /*
    DANH SÁCH MÃ HỘI THOẠI CHO CÂU SQL.

    `= any(${ids})` KHÔNG chạy: drizzle bung một mảng JS thành tuple tham số ($1, $2, …), mà
    `any()` của Postgres cần một MẢNG. Dựng danh sách `in (...)` bằng `sql.join` là cách đúng —
    mỗi phần tử vẫn là một tham số riêng, nên không có chỗ nào nối chuỗi vào câu lệnh.
  */
  const ids = ds.map((c) => c.id);
  const dsSql = sql.join(ids.map((i) => sql`${i}`), sql`, `);
  const calls = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select mc.provider, mc.model, mc.tier,
             count(*)::int                                   as n,
             sum(mc.input_tokens)::int                        as tin,
             sum(mc.cached_input_tokens)::int                 as tdem,
             sum(mc.output_tokens)::int                       as tout,
             round(avg(mc.latency_ms))::int                   as tb,
             max(mc.latency_ms)::int                          as max_ms,
             count(*) filter (where mc.cost_vnd is null)::int  as chua_gia,
             coalesce(sum(mc.cost_vnd), 0)::bigint            as tien
      from ai_model_calls mc
      join ai_runs r on r.id = mc.run_id
      where r.subject_id in (${dsSql}) and mc.created_at >= now() - interval '2 hours'
      group by 1,2,3 order by 4 desc
    `),
  );
  console.log(`\n④ LƯỢT GỌI MÔ HÌNH`);
  if (!calls.length) console.log("   (không lượt nào — luật đã đủ, hoặc mô hình đang tắt)");
  for (const c of calls) {
    const chua = Number(c.chua_gia ?? 0);
    const tien = chua > 0 ? "CHƯA BIẾT (thiếu đơn giá)" : `${Number(c.tien ?? 0).toLocaleString("vi-VN")}đ`;
    console.log(`   ${String(c.provider)} · ${String(c.model)} · ${String(c.tier)} — ${c.n} lượt · token vào ${c.tin} (đệm ${c.tdem}) ra ${c.tout} · trễ tb ${c.tb} ms, max ${c.max_ms} ms · ${tien}`);
  }

  // ───── ⑤ KẾT QUẢ DÂY CHUYỀN ─────
  const runs = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select coalesce(nullif(r.status,''),'?') as status, coalesce(nullif(r.tier,''),'RULE') as tier, count(*)::int as n
      from ai_runs r where r.subject_id in (${dsSql}) and r.created_at >= now() - interval '2 hours'
      group by 1,2 order by 3 desc
    `),
  );
  console.log(`\n⑤ KẾT QUẢ LƯỢT CHẠY`);
  for (const r of runs) console.log(`   ${String(r.status).padEnd(12)} nấc ${String(r.tier).padEnd(8)} ${r.n}`);

  /*
    VÌ SAO MÁY KHÔNG TRẢ LỜI — đọc từ `ai_runs.decision`, không đoán.

    Một mẻ mà mọi hội thoại đều chuyển người là một mẻ không đo được gì. Nhưng "chuyển người" có
    nhiều lý do rất khác nhau: thiếu dữ liệu (việc của chủ shop), người đã vào (đúng, phải dừng),
    hay một luật quá tay (lỗi của tôi). Gộp chúng vào một con số là bỏ qua đúng thứ cần biết.
  */
  const lyDo = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select coalesce(nullif(r.decision->>'action',''),'?')        as hanh_dong,
             coalesce(nullif(r.decision->>'handoffReason',''),'—') as ly_do,
             coalesce(nullif(r.decision->>'reason',''),'')         as cau,
             coalesce(r.decision->>'missing','')                   as thieu,
             count(*)::int                                          as n
      from ai_runs r
      where r.subject_id in (${dsSql}) and r.created_at >= now() - interval '2 hours'
      group by 1,2,3,4 order by 5 desc limit 10
    `),
  );
  console.log(`\n⑤b VÌ SAO — đọc từ ai_runs.decision`);
  for (const l of lyDo) {
    console.log(`   ${l.n}× ${String(l.hanh_dong)} · ${String(l.ly_do)}${String(l.thieu) && String(l.thieu) !== "[]" ? ` · thiếu ${l.thieu}` : ""}`);
    if (l.cau) console.log(`        ${cat(String(l.cau), 150)}`);
  }

  // ───── ⑥ ĐỐI CHIẾU NGƯỜI ↔ MÁY ─────
  const cap = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select c.id, c.source_type, c.stage,
             m.text                                  as khach,
             (select text from sales_messages h
                where h.conversation_id = c.id and h.from_page = true and btrim(h.text) <> ''
                order by h.sent_at asc limit 1)      as nguoi,
             s.suggested_reply                       as may,
             s.action, s.production_action, s.confidence
      from sales_conversations c
      join lateral (
        select id, text from sales_messages
        where conversation_id = c.id and from_page = false and btrim(text) <> ''
        order by sent_at desc nulls last limit 1
      ) m on true
      left join lateral (
        select suggested_reply, action, production_action, confidence from sales_suggestions
        where conversation_id = c.id order by created_at desc limit 1
      ) s on true
      where c.id in (${dsSql})
      order by (s.suggested_reply is null), c.updated_at desc
      limit 12
    `),
  );
  console.log(`\n⑥ NGƯỜI ↔ MÁY (12 lượt đầu · SĐT đã che)`);
  for (const r of cap) {
    console.log(`\n   ── ${String(r.source_type || "?")} · ${String(r.stage || "?")} ──`);
    console.log(`   KHÁCH : ${cat(che(String(r.khach ?? "")), 160)}`);
    console.log(`   NGƯỜI : ${cat(che(String(r.nguoi ?? "(chưa trả lời)")), 160)}`);
    console.log(`   MÁY   : ${cat(che(String(r.may ?? "(không sinh gợi ý)")), 220)}`);
    console.log(`   →       ${String(r.action ?? "—")} · sản xuất ${String(r.production_action ?? "—")} · tin cậy ${r.confidence ?? "—"}`);
  }

  // ───── ⑦ HAI CON SỐ PHẢI BẰNG 0 ─────
  const [an] = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select
        -- GỢI Ý ĐÃ GỬI: cờ này CHỈ được bật khi cổng gửi tin chạy thật. Nó là bằng chứng trực
        -- tiếp nhất, và nó phải bằng 0.
        (select count(*) from sales_suggestions where sent = true)::int                 as goi_y_da_gui,
        -- VẾT CÔNG CỤ: đếm lượt gọi THÀNH CÔNG tới hai công cụ tạo/chốt đơn. KHÔNG đếm
        -- sales_messages.from_agent — cờ ấy là của Pancake, đánh dấu tin do NHÂN VIÊN THẬT gửi,
        -- nên đếm nó sẽ báo động giả mỗi lần một bạn sale trả lời khách.
        (select count(*) from ai_tool_calls
           where tool in ('order.create_draft','order.confirm') and outcome = 'OK')::int as goi_cong_cu_don,
        (select count(*) from sales_conversations where order_id is not null)::int      as da_tao_don
    `),
  );
  console.log(`\n⑦ AN TOÀN — đọc lại từ CSDL, không phải khẳng định suông`);
  const zero = (n: unknown) => (Number(n) === 0 ? "✓" : "⛔ PHẢI BẰNG 0");
  console.log(`   gợi ý đã gửi cho khách    : ${an.goi_y_da_gui}  ${zero(an.goi_y_da_gui)}`);
  console.log(`   lượt gọi công cụ lên đơn  : ${an.goi_cong_cu_don}  ${zero(an.goi_cong_cu_don)}`);
  console.log(`   hội thoại có đơn          : ${an.da_tao_don}  ${zero(an.da_tao_don)}`);
  console.log(`   chặn cứng lúc chạy        : gửi tin ${aiEnv.hardLimits.allowCustomerSend ? "⛔ MỞ" : "✓ CẤM"} · tạo đơn ${aiEnv.hardLimits.allowOrderCreate ? "⛔ MỞ" : "✓ CẤM"}`);
  process.exit(0);
}

main().catch((e) => { console.error(`✗ ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`); process.exit(1); });
