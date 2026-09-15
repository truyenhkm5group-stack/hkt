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
import { moneyMentions } from "@/lib/ai-workforce/agents/sales/generate";
import {
  HANDOFF_CLASS_LABEL,
  HANDOFF_CLASS_OWNER,
  QUALITY_DIMENSIONS,
  advancesConversation,
  classifyHandoff,
  safetyFlags,
  SAFETY_FLAG_LABEL,
  type HandoffClass,
  type SafetyFlag,
} from "@/lib/constants/sales-quality";
import { HANDOFF_REASONS, type HandoffReason } from "@/lib/constants/sales-agent";

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
  console.log(`   MÁY tự gửi   : ${aiEnv.hardLimits.allowAutoSend ? "⛔ MỞ" : "✓ CẤM"} · NGƯỜI bấm gửi: ${aiEnv.hardLimits.allowHumanApprovedSend ? "MỞ (COPILOT)" : "✓ CẤM"} · tạo đơn: ${aiEnv.hardLimits.allowOrderCreate ? "⛔ MỞ" : "✓ CẤM"}`);
  const agent = await getAgent("sales", settings, db);
  console.log(`   nấc quyền hạn: ${agent?.mode ?? "—"}`);

  /*
    CỬA SỔ THỜI GIAN CỦA PHÉP ĐO — phải ôm ĐÚNG mẻ này, không ôm mẻ trước.

    Bản trước dùng cố định "2 giờ gần đây". Hai mẻ chạy cách nhau 47 phút thì báo cáo trộn cả hai,
    và lỗi đã sửa của mẻ cũ hiện lên như thể vẫn còn — tôi suýt kết luận bản sửa không ăn thua.
    Một phép đo trộn hai lần chạy thì tệ hơn không đo.
  */
  const batDau = new Date();
  const phut = Number(arg("since-minutes"));
  const tuKhi = Number.isFinite(phut) && phut > 0 ? new Date(Date.now() - phut * 60_000) : batDau;

  const chiDoc = process.argv.includes("--report-only");

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
  console.log(`   cửa sổ đo: từ ${tuKhi.toISOString()}${chiDoc ? "  (dùng --since-minutes=N để nới)" : ""}`);
  if (!ds.length) { console.log("   Không có gì để chạy."); process.exit(0); }
  if (dryRun) { console.log("\n--dry-run: KHÔNG xếp việc, KHÔNG gọi mô hình."); process.exit(0); }

  /*
    ③ XẾP VIỆC RỒI CHẠY DÂY CHUYỀN THẬT — trừ khi chỉ đọc lại.

    `--report-only` tồn tại vì một lý do cụ thể: lượt đầu chạy xong 18/18 rồi chết ở CÂU SQL BÁO
    CÁO. Dữ liệu đã nằm trong CSDL, nhưng không có đường nào đọc lại nó — muốn xem kết quả thì
    phải chạy lại cả mẻ, tức trả tiền mô hình lần thứ hai cho một lỗi hiển thị. Tách phần đo khỏi
    phần chạy để chuyện đó không lặp lại.
  */
  /*
    GỠ CỜ "NGƯỜI ĐÃ TIẾP QUẢN" TRƯỚC KHI ĐO LẠI — chỉ trên bản chạy thử, chỉ khi được yêu cầu.

    Cờ `human_takeover_at` do CHÍNH nhân sự AI đặt ở lượt nạp trước: nó kết luận chuyển người (vì
    lược đồ hỏng — xem 29d1b8c), và công cụ handoff ghi cờ VĨNH VIỄN. Lượt đo sau đó chạy lại trên
    đúng những hội thoại đã bị khoá, nên mọi câu trả lời đều là "chuyển người" và mẻ không đo được
    chất lượng gì.

    Đây KHÔNG phải xoá dữ liệu nghiệp vụ: bản chạy thử có CSDL riêng, và cờ này là kết luận của máy
    chứ không phải hành động của người. Nhưng vì nó vẫn là ghi đè, nó phải được GÕ RA TƯỜNG MINH —
    `--reset-takeover` — chứ không bao giờ chạy ngầm trong một lượt đo.
  */
  if (process.argv.includes("--reset-takeover")) {
    const go = await db.execute(sql`
      update sales_conversations
      set human_takeover_at = null, takeover_reason = '', stage = 'NEW_LEAD', updated_at = now()
      where page_id = ${pageId} and human_takeover_at is not null and takeover_by_user_id is null
      returning id
    `);
    console.log(`\n⓪ ĐÃ GỠ CỜ "người đã tiếp quản" trên ${rowsOf<unknown>(go).length} hội thoại (chỉ những cờ do MÁY đặt — dòng có takeover_by_user_id là người thật, giữ nguyên)`);
  }

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
      where r.subject_id in (${dsSql}) and mc.created_at >= ${tuKhi}
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
      from ai_runs r where r.subject_id in (${dsSql}) and r.created_at >= ${tuKhi}
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
      where r.subject_id in (${dsSql}) and r.created_at >= ${tuKhi}
      group by 1,2,3,4 order by 5 desc limit 10
    `),
  );
  console.log(`\n⑤b VÌ SAO — đọc từ ai_runs.decision`);
  for (const l of lyDo) {
    console.log(`   ${l.n}× ${String(l.hanh_dong)} · ${String(l.ly_do)}${String(l.thieu) && String(l.thieu) !== "[]" ? ` · thiếu ${l.thieu}` : ""}`);
    if (l.cau) console.log(`        ${cat(String(l.cau), 150)}`);
  }

  /*
    ⑤c VÌ SAO LEO NẤC — đây là con số quyết định hoá đơn.

    Leo từ ECONOMY lên STRONG chỉ có bốn nguyên nhân: lược đồ sai, tin cậy thấp, hết giờ, lỗi nhà
    cung cấp. Gộp chúng lại thì không biết phải sửa lời dặn, sửa ngưỡng, hay sửa trần thời gian.
  */
  const leo = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select coalesce(nullif(r.escalation_reason,''),'(không leo)') as ly_do, count(*)::int as n
      from ai_runs r
      where r.subject_id in (${dsSql}) and r.created_at >= ${tuKhi}
      group by 1 order by 2 desc
    `),
  );
  console.log(`\n⑤c LÝ DO LEO NẤC`);
  for (const l of leo) console.log(`   ${String(l.n).padStart(3)}× ${String(l.ly_do)}`);

  const loiGoi = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select mc.tier, coalesce(mc.ok::text,'?') as ok, coalesce(left(mc.error, 120),'') as loi, count(*)::int as n
      from ai_model_calls mc join ai_runs r on r.id = mc.run_id
      where r.subject_id in (${dsSql}) and mc.created_at >= ${tuKhi}
      group by 1,2,3 order by 4 desc limit 8
    `),
  );
  console.log(`\n⑤d LƯỢT GỌI HỎNG (nếu có)`);
  for (const l of loiGoi) console.log(`   ${String(l.n).padStart(3)}× ${String(l.tier)} ok=${String(l.ok)} ${String(l.loi) ? `· ${l.loi}` : ""}`);

  /*
    ⑤e PHÂN LOẠI CHUYỂN NGƯỜI — năm loại, năm người khác nhau phải đi làm.

    "Tỷ lệ chuyển người" gộp lại là một con số không sửa được gì. Khiếu nại chuyển người là ĐÚNG;
    chốt an toàn nổ là thứ ta trả tiền để có; thiếu bảng số đo là việc của chủ shop; mô hình chết
    là việc của người vận hành. Chỉ loại cuối — MÁY BÍ — mới đáng gọi là "AI chưa đủ tốt".
  */
  const chuyen = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select coalesce(nullif(r.decision->>'handoffReason',''),'') as ly_do, count(*)::int as n
      from ai_runs r where r.subject_id in (${dsSql}) and r.created_at >= ${tuKhi}
      group by 1
    `),
  );
  const theoLoai = new Map<HandoffClass, number>();
  let khongChuyen = 0;
  const lyDoLa: string[] = [];
  for (const c of chuyen) {
    const raw = String(c.ly_do ?? "");
    const n = Number(c.n ?? 0);
    if (!raw) { khongChuyen += n; continue; }
    if (!(HANDOFF_REASONS as readonly string[]).includes(raw)) { lyDoLa.push(`${raw} (${n})`); continue; }
    const loai = classifyHandoff(raw as HandoffReason);
    if (loai) theoLoai.set(loai, (theoLoai.get(loai) ?? 0) + n);
  }
  console.log(`\n⑤e PHÂN LOẠI CHUYỂN NGƯỜI`);
  console.log(`   ${String(khongChuyen).padStart(3)}× không chuyển người`);
  for (const [loai, n] of [...theoLoai.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(n).padStart(3)}× ${HANDOFF_CLASS_LABEL[loai]} → ${HANDOFF_CLASS_OWNER[loai]}`);
  }
  if (lyDoLa.length) console.log(`   ⛔ lý do KHÔNG có trong sổ đăng ký: ${lyDoLa.join(", ")}`);

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
      limit 4
    `),
  );
  console.log(`\n⑥ NGƯỜI ↔ MÁY (4 lượt · SĐT đã che)`);
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
  /*
    ⑦b SOÁT NỘI DUNG TỰ ĐỘNG — Ở GIẢ ĐỊNH CHẶT NHẤT.

    Mục ⑦ chứng minh máy KHÔNG GỬI gì. Mục này hỏi câu khác: NẾU đã gửi thì câu ấy có hứa thứ gì
    ERP không đứng ra bảo đảm được không.

    Hai điều phải nói thẳng về cách đo:

    · Sổ kho và bảng số đo của từng lượt KHÔNG được lưu lại trong `sales_suggestions`, nên soát lại
      sau không dựng lại được đúng bối cảnh lúc sinh câu. Thay vì đoán, ở đây lấy GIẢ ĐỊNH CHẶT
      NHẤT: coi như CHƯA BIẾT tồn và KHÔNG có bảng số đo. Cờ bật ở giả định này có thể là báo thừa;
      KHÔNG cờ nào bật thì là một kết quả mạnh, vì nó đúng với mọi bối cảnh.

    · Cờ "nói số tiền máy chủ không tính" KHÔNG đo lại ở đây: nó đã được chặn NGAY LÚC SINH bởi
      `guardGeneratedText`, và mỗi lần chặn để lại một dòng trong `ai_errors`. Đếm lại bằng một tập
      tiền dựng lại sau sẽ báo nhầm đúng phí ship — nên con số dưới đây đọc từ vết chặn thật.
  */
  /*
    MẪU SỐ PHẢI LÀ MẪU SỐ ĐÚNG.

    "Bao nhiêu câu có nêu giá" tính trên CẢ MẺ là một con số vô nghĩa: câu chuyển người không nêu
    giá là ĐÚNG, không phải một lần trượt. Câu hỏi thật là — trong những lượt khách THỰC SỰ HỎI
    GIÁ, bao nhiêu lượt nghe được một con số. Nên ý định của lượt đó phải đi kèm, đọc từ
    `ai_runs.understanding` chứ không đoán lại từ câu chữ.
  */
  const cauDaSinh = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select s.id, s.action, coalesce(s.suggested_reply,'') as cau,
             coalesce(r.understanding->>'intents','[]')      as y_dinh
      from sales_suggestions s
      left join ai_runs r on r.id = s.run_id
      where s.conversation_id in (${dsSql}) and s.created_at >= ${tuKhi} and btrim(s.suggested_reply) <> ''
    `),
  );
  const demCo = new Map<SafetyFlag, number>();
  const viDu = new Map<SafetyFlag, string>();
  let daydTiep = 0;
  let hoiGia = 0;
  let hoiGiaCoSo = 0;
  for (const r of cauDaSinh) {
    const cau = String(r.cau);
    const hoi = String(r.y_dinh ?? "").includes("PRICE_QUESTION");
    if (hoi) {
      hoiGia += 1;
      if (moneyMentions(cau).length) hoiGiaCoSo += 1;
    }
    const co = safetyFlags({ text: cau, allowedAmounts: [], mentionedAmounts: [], stockKnown: false, sizeChartAvailable: false });
    for (const c of co) {
      demCo.set(c, (demCo.get(c) ?? 0) + 1);
      if (!viDu.has(c)) viDu.set(c, cat(che(cau), 120));
    }
    if (advancesConversation(cau)) daydTiep += 1;
  }
  const [chan] = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select count(*)::int as n from ai_errors
      where scope = 'MODEL' and agent_key = 'sales' and message like 'Bỏ bản mô hình viết:%' and created_at >= ${tuKhi}
    `),
  );
  console.log(`\n⑦b SOÁT NỘI DUNG — ${cauDaSinh.length} câu, giả định chặt nhất (chưa biết tồn · không có bảng số đo)`);
  if (!demCo.size) console.log(`   không cờ nào bật ✓`);
  for (const [c, n] of [...demCo.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`   ⛔ ${n}× ${SAFETY_FLAG_LABEL[c]}`);
    console.log(`        ví dụ: ${viDu.get(c)}`);
  }
  console.log(`   bản mô hình viết bị chặn lúc sinh: ${Number(chan?.n ?? 0)} (đọc từ ai_errors, không phải dựng lại)`);

  /*
    ⑦c CHÍN CHIỀU CHẤM, VÀ AI CHẤM CHIỀU NÀO.

    In cả chiều máy KHÔNG chấm được là có chủ ý: một bảng chỉ liệt kê phần máy đo được sẽ khiến
    người đọc tưởng đó là toàn bộ chất lượng. Chiều của NGƯỜI để CHƯA CHẤM cho tới khi có người
    chấm ở /ai/review — không bao giờ in ra một con số máy tự cho mình.
  */
  const [daCham] = rowsOf<Record<string, unknown>>(
    await db.execute(sql`select count(*)::int as n from sales_review_labels where reviewed_at is not null`),
  );
  console.log(`\n⑦c CHÍN CHIỀU CHẤM — ${cauDaSinh.length} câu sinh ra, ${Number(daCham?.n ?? 0)} lượt đã có người chấm`);
  for (const d of QUALITY_DIMENSIONS) {
    let so = "CHƯA CHẤM (chờ người)";
    if (d.grader === "MACHINE") {
      if (d.key === "answered") so = hoiGia ? `${hoiGiaCoSo}/${hoiGia} lượt KHÁCH HỎI GIÁ nghe được một con số` : "không lượt nào hỏi giá (KHÔNG ÁP DỤNG)";
      else if (d.key === "advanced") so = `${daydTiep}/${cauDaSinh.length} câu có mời bước tiếp`;
      else if (d.key === "hallucination") so = demCo.size ? `⛔ ${[...demCo.values()].reduce((a, b) => a + b, 0)} cờ` : "0 cờ ✓";
      else if (d.key === "handoff") so = `${[...theoLoai.entries()].map(([k, n]) => `${HANDOFF_CLASS_LABEL[k]} ${n}`).join(" · ") || "không lượt nào"}`;
    }
    console.log(`   ${d.grader === "MACHINE" ? "MÁY  " : "NGƯỜI"} ${d.label.padEnd(44)} ${so}`);
  }

  console.log(`\n⑦ AN TOÀN — đọc lại từ CSDL, không phải khẳng định suông`);
  const zero = (n: unknown) => (Number(n) === 0 ? "✓" : "⛔ PHẢI BẰNG 0");
  console.log(`   gợi ý đã gửi cho khách    : ${an.goi_y_da_gui}  ${zero(an.goi_y_da_gui)}`);
  console.log(`   lượt gọi công cụ lên đơn  : ${an.goi_cong_cu_don}  ${zero(an.goi_cong_cu_don)}`);
  console.log(`   hội thoại có đơn          : ${an.da_tao_don}  ${zero(an.da_tao_don)}`);
  console.log(`   chặn cứng lúc chạy        : MÁY tự gửi ${aiEnv.hardLimits.allowAutoSend ? "⛔ MỞ" : "✓ CẤM"} · NGƯỜI bấm gửi ${aiEnv.hardLimits.allowHumanApprovedSend ? "MỞ (COPILOT)" : "✓ CẤM"} · tạo đơn ${aiEnv.hardLimits.allowOrderCreate ? "⛔ MỞ" : "✓ CẤM"}`);

  /*
    ⑧ MƯỜI HAI CA ĐẠI DIỆN — CHỌN ĐỂ PHỦ, KHÔNG CHỌN ĐỂ ĐẸP.

    In cuối cùng có chủ ý: log của GitHub bị cắt bớt khi dài, và phần bị cắt là phần ĐẦU. Thứ phải
    sống sót là thứ người đọc cần nhất.

    Máy KHÔNG tự dán nhãn tốt / tạm được / kém cho các ca này — đó là việc của người ở /ai/review,
    và một mô hình tự chấm chính nó sẽ chấm cao đúng những chỗ nó sai giống nhau. Việc của script
    là chọn ra một tập PHỦ ĐƯỢC không gian: mỗi hành động một ca, mỗi loại chuyển người một ca, ca
    có cờ an toàn, ca nguồn TEST, và ca máy thấy khó nhất (độ tin thấp nhất).
  */
  const ca = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      with lan_cuoi as (
        select distinct on (s.conversation_id)
               s.conversation_id, s.action, s.confidence, s.suggested_reply, s.created_at
        from sales_suggestions s
        where s.conversation_id in (${dsSql}) and s.created_at >= ${tuKhi}
        order by s.conversation_id, s.created_at desc
      )
      select c.id, c.source_type, c.stage,
             l.action, l.confidence, l.suggested_reply as may,
             coalesce(r.decision->>'handoffReason','') as ly_do,
             m.text as khach,
             (select text from sales_messages h
                where h.conversation_id = c.id and h.from_page = true and btrim(h.text) <> ''
                order by h.sent_at asc limit 1) as nguoi
      from sales_conversations c
      join lan_cuoi l on l.conversation_id = c.id
      join lateral (
        select text from sales_messages
        where conversation_id = c.id and from_page = false and btrim(text) <> ''
        order by sent_at desc nulls last limit 1
      ) m on true
      left join lateral (
        select decision from ai_runs
        where subject_id = c.id and subject_type = 'CONVERSATION' and created_at >= ${tuKhi}
        order by started_at desc limit 1
      ) r on true
      where c.id in (${dsSql})
    `),
  );

  const daChon = new Set<string>();
  const chon: { vi: string; r: Record<string, unknown> }[] = [];
  const them = (vi: string, r: Record<string, unknown> | undefined) => {
    if (!r || chon.length >= 12) return;
    const key = String(r.id);
    if (daChon.has(key)) return;
    daChon.add(key);
    chon.push({ vi, r });
  };
  // ① một ca cho MỖI hành động máy đã chọn — đây là chiều phủ quan trọng nhất.
  for (const hd of [...new Set(ca.map((r) => String(r.action ?? "")))].sort()) {
    them(`hành động ${hd}`, ca.find((r) => String(r.action ?? "") === hd));
  }
  // ② một ca cho MỖI loại chuyển người đã xảy ra.
  for (const r of ca) {
    const raw = String(r.ly_do ?? "");
    if (!raw || !(HANDOFF_REASONS as readonly string[]).includes(raw)) continue;
    const loai = classifyHandoff(raw as HandoffReason);
    if (loai) them(`chuyển người · ${HANDOFF_CLASS_LABEL[loai]} (${raw})`, r);
  }
  // ③ ca có cờ an toàn bật — nếu có, đây là ca đáng đọc nhất cả mẻ.
  for (const r of ca) {
    const co = safetyFlags({ text: String(r.may ?? ""), allowedAmounts: [], mentionedAmounts: [], stockKnown: false, sizeChartAvailable: false });
    if (co.length) them(`⛔ cờ an toàn: ${co.map((c) => SAFETY_FLAG_LABEL[c]).join(", ")}`, r);
  }
  // ④ nguồn TEST phải có mặt: nó chứng minh dữ kiện của mã WIN KHÔNG rò sang.
  them("nguồn TEST (kiểm rò dữ kiện)", ca.find((r) => String(r.source_type ?? "").toUpperCase().includes("TEST")));
  // ⑤ ca máy thấy KHÓ nhất.
  them("máy thấy khó nhất (độ tin thấp nhất)", [...ca].filter((r) => r.confidence !== null).sort((a, b) => Number(a.confidence) - Number(b.confidence))[0]);
  // ⑥ còn chỗ thì lấp bằng ca chưa chọn, để đủ 12.
  for (const r of ca) them("phủ thêm", r);

  console.log(`\n⑧ ${chon.length} CA ĐẠI DIỆN — chọn để PHỦ; nhãn tốt/tạm/kém là việc của người ở /ai/review`);
  for (const { vi, r } of chon) {
    console.log(`\n   ── ${vi} · ${String(r.source_type || "?")} · ${String(r.stage || "?")} ──`);
    console.log(`   KHÁCH : ${cat(che(String(r.khach ?? "")), 170)}`);
    console.log(`   NGƯỜI : ${cat(che(String(r.nguoi ?? "(chưa trả lời)")), 170)}`);
    console.log(`   MÁY   : ${cat(che(String(r.may ?? "(không sinh gợi ý)")), 240)}`);
    console.log(`   →       ${String(r.action ?? "—")}${String(r.ly_do) ? ` · chuyển người ${r.ly_do}` : ""} · tin cậy ${r.confidence ?? "—"}`);
  }
  process.exit(0);
}

main().catch((e) => { console.error(`✗ ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`); process.exit(1); });
