/**
 * ═══════════ ops `inbox-perf-probe` — HỘP THƯ KHÁCH: TẢI / CHUYỂN HỘI THOẠI ĐO TRÊN PRODUCTION, CHỈ ĐỌC (scripts/inbox-perf-probe.ts) ═══════════
 *
 *  · Thuần: soát arg nghiêm (mã 64 khi sai); p50 = trung vị, p95 = hạng gần nhất, rỗng ⇒ `null` (không 0); dòng công khai che tổ chức
 *    thành «org#i» (workspace nghiệm thu giữ mã), KHÔNG mang tên / SĐT / chữ tin / câu lỗi / mã tài khoản; dưới 3 quan sát ⇒ «mẫu nhỏ —
 *    chưa kết luận»; không PASS / FAIL — «chưa có đích»; dòng ≤ 300 ký tự, lượt ≤ 60 dòng.
 *  · Mã nguồn: không câu ghi; ERP_READ_ONLY + hỏi lại Postgres; gọi ĐÚNG các hàm mà page.tsx gọi (và page.tsx vẫn gọi chúng — trang đổi
 *    mà script không đổi thì bài này đỏ); ops-vps khai đủ bốn chỗ.
 *  · CSDL (PGlite): tổ chức THẬT `ipp-a` (tự cấp, tự dọn) có hội thoại ⇒ đo ra thời gian + số câu SQL; danh tính thu hẹp không GHI
 *    `staff_seen_at`; có tài khoản chỉ xem thật thì dùng nó.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { eq, isNotNull } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, releaseOrganizationDb, schema } from "@/db";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { fanpageVisitorKey } from "@/lib/sales-chatbot/fanpage";
import { inboxListQuery } from "@/lib/sales-chatbot/inbox-search-shared";
import {
  bindReadOnlyOrgHandle,
  collectInboxPerf,
  NO_TARGET_LABEL,
  parseProbeArgs,
  privateLinesOf,
  publicLabels,
  seriesStats,
  summarizeInboxPerf,
  SUMMARY_MAX_CHARS,
  SUMMARY_MAX_LINES,
  THIN_LABEL,
  type OrgPerf,
  type RenderSample,
  diagLine,
  fullShape,
  planRootOf,
  planStructure,
  exprSignature,
  planHotNodes,
  queryBlockOf,
  stateLine,
  shapeHash,
  topLine,
  topQueries,
  type CapturedQuery,
} from "@/scripts/inbox-perf-probe";

const NT = "cdt-nghiem-thu";
const TEN_KHACH = "Chị Hoa Bí Mật";
const SDT = "0912345678";
const CHU_TIN = "Còn size M không shop ơi";

const sample = (msv: number, extra: Partial<RenderSample> = {}): RenderSample => ({ ms: msv, listMs: msv / 2, threadMs: null, sqlMs: msv / 4, queries: 12, rows: 100, total: 1234, items: null, error: null, ...extra });

export function testInboxPerfProbePure() {
  // 1 · arg
  assert.deepEqual(parseProbeArgs([]), { ok: true, org: null, samples: 5, analyze: false });
  assert.deepEqual(parseProbeArgs(["--org=hslc", "--samples=12"]), { ok: true, org: "hslc", samples: 12, analyze: false });
  assert.deepEqual(parseProbeArgs(["--org=hslc --samples=3"]), { ok: true, org: "hslc", samples: 3, analyze: false }, "ô arg một chuỗi có khoảng trắng");
  assert.deepEqual(parseProbeArgs(["--org=hslc --samples=3 --analyze"]), { ok: true, org: "hslc", samples: 3, analyze: true }, "cờ --analyze");
  assert.equal(parseProbeArgs(["--analyze"]).ok, false, "--analyze cần --org");
  assert.equal(parseProbeArgs(["--org=hslc --analyze --analyze"]).ok, false, "--analyze chỉ một lần");
  for (const bad of [["--samples=0"], ["--samples=21"], ["--samples=abc"], ["--samples=5.5"], ["--org=HSLC"], ["--org=a"], ["--org=x;rm"], ["hslc"], ["--apply"], ["--org=a1", "--org=b2"], ["--samples=3", "--samples=4"], ["--org="]]) {
    assert.equal(parseProbeArgs(bad).ok, false, `arg sai phải bị từ chối: ${bad.join(" ")}`);
  }

  // 2 · thống kê
  assert.deepEqual(seriesStats([50, 10, 40, 20, 30]), { n: 5, p50: 30, p95: 50, max: 50 });
  assert.deepEqual(seriesStats([10, 20, 30, 40]), { n: 4, p50: 25, p95: 40, max: 40 }, "chẵn ⇒ trung bình hai phần tử giữa");
  assert.deepEqual(seriesStats([]), { n: 0, p50: null, p95: null, max: null }, "rỗng ⇒ null, không 0");
  assert.deepEqual(seriesStats([null, Number.NaN, Number.POSITIVE_INFINITY, 7]), { n: 1, p50: 7, p95: 7, max: 7 });
  const many = Array.from({ length: 40 }, (_, i) => i + 1);
  assert.equal(seriesStats(many).p95, 38, "hạng gần nhất: ⌈0,95·40⌉ = 38");

  // 3 · nhãn che
  assert.deepEqual([...publicLabels(["shop-a", NT, "shop-b"], [NT]).values()], ["org#1", NT, "org#2"]);

  // 4 · tóm tắt
  const okOrg = (code: string, conversations: number, extra: Partial<OrgPerf> = {}): OrgPerf => ({
    code,
    identity: { kind: "NARROWED", userId: "user-bi-mat-1", role: "VIEWER", fromRole: "ADMIN" },
    result: {
      ok: true,
      load: { cold: [100, 120, 110, 130, 90].map((x) => sample(x)), warm: [40, 50, 45, 55, 35].map((x) => sample(x)) },
      switchTo: {
        cold: Array.from({ length: conversations }, (_, i) => sample(200 + i * 10, { threadMs: 150 + i, items: 30 })),
        warm: Array.from({ length: conversations }, (_, i) => sample(80 + i, { threadMs: 60 + i, items: 30 })),
      },
      conversations,
    },
    ...extra,
  });
  const leaky: OrgPerf = { code: "shop-ro-ri", identity: null, result: { ok: false, error: `relation lỗi khi đọc ${TEN_KHACH} ${SDT} «${CHU_TIN}»` } };
  const badSample = okOrg("shop-loi-luot", 5);
  if (badSample.result.ok) badSample.result.switchTo.cold[1] = sample(999, { error: `loadInboxThread: ${TEN_KHACH} ${SDT}` });
  const r = summarizeInboxPerf([okOrg(NT, 5), okOrg("shop-it-hoi-thoai", 2), okOrg("shop-rong", 0), leaky, badSample], { samples: 5, acceptanceCodes: [NT] });
  const pub = r.publicLines.join("\n");
  assert.equal(r.verdict, "INCOMPLETE", "tổ chức hỏng / lượt hỏng ⇒ chưa trọn");
  assert.equal(r.failedSamples, 1);
  assert.match(r.publicLines[0], /^inbox-perf-probe: ĐO CHƯA TRỌN · 5 tổ chức · 5 lượt mỗi phép đo · 1 tổ chức hỏng · 1 lượt hỏng · đích: chưa có đích/);
  assert.ok(pub.includes(NO_TARGET_LABEL) && !/\b(PASS|FAIL)\b/.test(pub.replace("không PASS/FAIL", "")), "không phán quyết PASS / FAIL về hiệu năng");
  assert.match(pub, /cdt-nghiem-thu tải hộp thư \(ms\): nguội p50 110 · p95 130 · max 130 · ấm p50 45 · p95 55 · max 55 \(n=5\/5\) · listInbox nguội p50 55 · SQL nguội p50 28 ms \/ 12 câu · hàng 100\/1234/);
  assert.match(pub, /cdt-nghiem-thu chuyển hội thoại \(ms\): nguội p50 220 · p95 240 · max 240 · ấm p50 82 .*\(n=5\/5 trên 5 hội thoại\) · loadInboxThread nguội p50 152/);
  assert.ok(!/cdt-nghiem-thu chuyển hội thoại[^\n]*mẫu nhỏ/.test(pub), "5 hội thoại ⇒ không gắn nhãn mẫu nhỏ");
  assert.match(pub, new RegExp(`org#1 chuyển hội thoại \\(ms\\):[^\\n]*\\(n=2/2 trên 2 hội thoại\\)[^\\n]*${THIN_LABEL}`), "2 hội thoại ⇒ «mẫu nhỏ — chưa kết luận»");
  assert.match(pub, new RegExp(`org#2 chuyển hội thoại: 0 hội thoại — không đo được \\(${THIN_LABEL}\\)`));
  assert.match(pub, /org#3: ĐO HỎNG cả tổ chức \(câu lỗi trong phần mã hoá\)/);
  assert.match(pub, /org#4 danh tính: thu hẹp từ ADMIN \(bỏ ai_sales:reply · outreach:send\) · 1\/20 lượt HỎNG/);
  for (const secret of [TEN_KHACH, SDT, CHU_TIN, "shop-ro-ri", "shop-it-hoi-thoai", "shop-rong", "shop-loi-luot", "user-bi-mat-1", "relation"]) assert.ok(!pub.includes(secret), `dòng công khai không mang «${secret}»`);
  assert.ok(r.publicLines.every((l) => l.length <= SUMMARY_MAX_CHARS) && r.publicLines.length <= SUMMARY_MAX_LINES);
  const thinLoad = summarizeInboxPerf([{ ...okOrg("shop-x", 3), result: { ok: true, load: { cold: [sample(10), sample(20)], warm: [sample(5), sample(6)] }, switchTo: { cold: [], warm: [] }, conversations: 0 } }], { samples: 2, acceptanceCodes: [] });
  assert.match(thinLoad.publicLines.join("\n"), new RegExp(`org#1 tải hộp thư[^\\n]*${THIN_LABEL}`), "2 lượt tải ⇒ mẫu nhỏ");
  assert.equal(summarizeInboxPerf([], { samples: 5 }).verdict, "INCOMPLETE", "0 tổ chức ⇒ chưa trọn");
  const big = summarizeInboxPerf(Array.from({ length: 30 }, (_, i) => okOrg(`shop-${String(i).padStart(2, "0")}`, 5)), { samples: 5, acceptanceCodes: [] });
  assert.ok(big.publicLines.length <= SUMMARY_MAX_LINES, "lượt ≤ 60 dòng");
  // Phần mã hoá: mã thật + mã tài khoản (cho người vận hành), không nội dung hội thoại.
  const priv = privateLinesOf(okOrg(NT, 1), NT).join("\n");
  assert.match(priv, /cdt-nghiem-thu = cdt-nghiem-thu: danh tính NARROWED · tài khoản user-bi-mat-1 · vai trò đo VIEWER \(gốc ADMIN\)/);
  assert.match(privateLinesOf(leaky, "org#3")[0], /^org#3 = shop-ro-ri: ĐO HỎNG/);
  // 5 · CÂU CHẬM NHẤT (13/10/2026): khối theo cấu trúc câu, gộp theo hình dạng (bỏ tham số), trung vị qua các lượt.
  assert.equal(queryBlockOf('select count(*) filter (where x)::int from "sales_chat_conversations"'), "listInbox.đếm-thẻ");
  assert.equal(queryBlockOf('select "sales_chat_conversations"."id" from "sales_chat_conversations" order by "unread_flag" desc'), "listInbox.hàng");
  assert.equal(queryBlockOf('select p.page_id from (values ($1::text, $2::text)) as p(page_id, thread_id) left join lateral (select 1 from "sales_chat_inbound" i) l on true'), "listInbox.xem-trước-fanpage");
  assert.equal(queryBlockOf('select "customer_level", count(*)::int from "sales_chat_conversations" group by "sales_chat_conversations"."customer_level"'), "listInbox.đếm-level");
  assert.equal(queryBlockOf('select 1 from "orders" where x'), "khác:orders");
  assert.equal(shapeHash("select * from t where a = $1 and b = 'Lan'"), shapeHash("select *  from t where a = $2 and b = 'Hoa'"), "tham số / hằng chuỗi không đổi hình dạng");
  assert.ok(!fullShape(`select 1 where name = '${TEN_KHACH}'`).includes(TEN_KHACH), "hình dạng không mang hằng chuỗi");
  const q = (text: string, ms: number, rows = 1): CapturedQuery => ({ text, values: [TEN_KHACH], ms, rows });
  const COUNT = 'select count(*) filter (where a)::int from "sales_chat_conversations" where "channel" <> $1';
  const PREVIEW = 'select 1 from (values ($1::text)) as p(id) left join lateral (select 1 from "sales_chat_inbound" i) l on true';
  const top = topQueries(
    [
      [q(COUNT, 900), q(PREVIEW, 5), q(PREVIEW, 7)],
      [q(COUNT, 1100), q(PREVIEW, 6)],
      [q(COUNT, 1000), q(PREVIEW, 4), q(PREVIEW, 4), q(PREVIEW, 4)],
    ],
    5,
  );
  assert.equal(top[0].block, "listInbox.đếm-thẻ");
  assert.equal(top[0].ms, 1000, "trung vị tổng ms của hình dạng qua 3 lượt");
  assert.equal(top[0].maxOne, 1100);
  assert.equal(top[0].slowest.ms, 1100, "giữ lần chậm nhất để EXPLAIN");
  assert.equal(top[1].calls, 2, "trung vị số lần chạy mỗi lượt (2 · 1 · 3)");
  assert.equal(top[1].ms, 12);
  assert.deepEqual(topQueries([], 3), []);
  const tl = topLine("org#1", 0, top[0]);
  assert.match(tl, /^org#1 câu chậm #1 listInbox\.đếm-thẻ \[[0-9a-f]{8}\]: 1000 ms\/lượt · 1 lần\/lượt · lần chậm nhất 1100 ms · 1 dòng$/);
  assert.ok(!tl.includes(TEN_KHACH), "dòng công khai không mang tham số");
  // Kế hoạch: cấu trúc (nút · bảng · chỉ mục · ước tính) — KHÔNG điều kiện lọc / hằng số.
  const plan = planRootOf(
    JSON.stringify([
      {
        Plan: {
          "Node Type": "Aggregate",
          "Total Cost": 5123.4,
          "Plan Rows": 1,
          Plans: [
            { "Node Type": "Seq Scan", "Parent Relationship": "Outer", "Relation Name": "sales_chat_conversations", "Plan Rows": 3629, "Total Cost": 400, Filter: `(name = '${TEN_KHACH}')` },
            { "Node Type": "Index Scan", "Parent Relationship": "SubPlan", "Subplan Name": "SubPlan 1", "Relation Name": "sales_chat_inbound", "Index Name": "sales_chat_inbound_thread_created_idx", "Plan Rows": 1, "Total Cost": 8.1, "Index Cond": `(thread_id = '${SDT}')` },
          ],
        },
      },
    ]),
  );
  const st = planStructure(plan);
  assert.equal(st[0], "3 nút · 1 SubPlan/InitPlan · Seq Scan: sales_chat_conversations · cost gốc 5123");
  assert.match(st.join("\n"), /\[SubPlan 1\] Index Scan on sales_chat_inbound using sales_chat_inbound_thread_created_idx · ~1 dòng · cost 8/);
  assert.ok(!st.join("\n").includes(TEN_KHACH) && !st.join("\n").includes(SDT), "cấu trúc kế hoạch không mang hằng số của câu");
  assert.deepEqual(planStructure(null), ["kế hoạch: không đọc được"]);
  assert.equal(planRootOf("không phải json"), null);
  assert.ok(planStructure(plan, 2).length <= 3, "trần số dòng (+ một dòng «… còn N nút»)");
  assert.match(
    diagLine("org#1", { columns: 2, materialized: false, conversations: 3629, nullTurns: 0, migrationsApplied: 246, migrationsInRepo: 246, pgVersion: "16.4" }),
    /^org#1 chẩn đoán «chưa đọc» 0245: cột đủ 2\/2 · đường đọc TÍNH TRỰC TIẾP \(hàm #803 cho từng hội thoại\) · turn_unhandled NULL 0\/3629 · migration đã áp 246 \(sổ kho 246\) · PG 16\.4$/,
  );
  assert.match(diagLine("org#1", { columns: 0, materialized: null, conversations: null, nullTurns: null, migrationsApplied: null, migrationsInRepo: 246, pgVersion: null }), /cột THIẾU \(0\/2\) · đường đọc — · turn_unhandled NULL — /, "chưa đọc được ⇒ «—», không phải 0");
  // Cỡ state + kế hoạch có số THẬT (ANALYZE): nút không chạy lần nào được đếm riêng (nhánh coalesce cost cao mà không chạy).
  const sline = stateLine("org#1", { columns: 2, materialized: true, conversations: 10, nullTurns: 0, migrationsApplied: 1, migrationsInRepo: 1, pgVersion: "16", stateBytes: { avg: 61_440, p95: 102_400, max: 204_800 }, stateKeys: [{ key: "returning", avg: 51_200 }, { key: "bad key; drop", avg: 9 }, { key: "quote", avg: 2_048 }] });
  assert.equal(sline, "org#1 cột state hội thoại (sau nén): TB 60,0 KB · p95 100,0 KB · max 200,0 KB · nhánh lớn nhất (200 hội thoại mới nhất): returning ~50,0 KB · quote ~2,0 KB");
  assert.equal(stateLine("org#1", { columns: 2, materialized: true, conversations: 10, nullTurns: 0, migrationsApplied: 1, migrationsInRepo: 1, pgVersion: "16" }), null);
  const ran = planStructure(
    planRootOf([{ Plan: { "Node Type": "Aggregate", "Total Cost": 9, "Plan Rows": 1, "Actual Total Time": 5856.2, "Actual Loops": 1, "Actual Rows": 1, Plans: [{ "Node Type": "Index Scan", "Parent Relationship": "SubPlan", "Subplan Name": "SubPlan 8", "Relation Name": "sales_chat_inbound", "Plan Rows": 1, "Total Cost": 75529, "Actual Total Time": 0, "Actual Loops": 0, "Actual Rows": 0 }] } }]),
  );
  assert.match(ran[0], /THẬT 5856 ms · 1 nút KHÔNG chạy lần nào$/);
  assert.match(ran.join("\n"), /\[SubPlan 8\] Index Scan on sales_chat_inbound · ~1 dòng · cost 75529 · THẬT 0 ms \(0 vòng × 0 dòng\)/);
  // Nút nóng: thời gian TỰ THÂN (tổng − con), dấu hiệu biểu thức chỉ TÊN hàm / cột — không giá trị.
  const sig = exprSignature({ Filter: `((regexp_replace(c.customer_phone, '[^0-9]', '', 'g') = '${SDT}') AND ((c.state -> 'control'::text) ->> 'mode'::text) ~ '${TEN_KHACH}')`, Output: ["c.id", "(SubPlan 3)", "lower(c.state ->> 'x')"] });
  assert.equal(sig, "hàm lower×1,regexp_replace×1 · cột state×2,customer_phone×1,id×1 · regex×1 · json->×3 · SubPlan×1");
  assert.ok(!sig.includes(SDT) && !sig.includes(TEN_KHACH), "dấu hiệu không mang giá trị");
  const hot = planHotNodes(
    planRootOf([
      {
        Plan: {
          "Node Type": "Limit", "Actual Total Time": 8821, "Actual Loops": 1, "Actual Rows": 100,
          Plans: [
            { "Node Type": "Result", "Actual Total Time": 326, "Actual Loops": 1, "Actual Rows": 100, Plans: [{ "Node Type": "Seq Scan", "Relation Name": "sales_chat_conversations", "Actual Total Time": 300, "Actual Loops": 1, "Actual Rows": 3772, "Rows Removed by Filter": 12, Filter: "(c.channel <> 'TEST'::text)" }] },
            { "Node Type": "Index Scan", "Parent Relationship": "SubPlan", "Subplan Name": "SubPlan 7", "Relation Name": "sales_chat_inbound", "Index Name": "sales_chat_inbound_thread_created_idx", "Actual Total Time": 84, "Actual Loops": 100, "Actual Rows": 1, Filter: "(i.customer_name IS NOT NULL)" },
          ],
        },
      },
    ]),
    3,
  );
  assert.equal(hot[0], "8400 ms tự thân · [SubPlan 7] Index Scan on sales_chat_inbound using sales_chat_inbound_thread_created_idx · 100 vòng × 1 dòng · cột customer_name×1");
  assert.match(hot[1], /^300 ms tự thân · Seq Scan on sales_chat_conversations · 1 vòng × 3772 dòng · lọc bỏ 12 · cột channel×1$/);
  assert.match(hot[2], /^95 ms tự thân · Limit/, "Limit tự thân = 8821 − 326 − 8400");
  assert.deepEqual(planHotNodes(planRootOf([{ Plan: { "Node Type": "Limit", "Total Cost": 1 } }])), [], "không ANALYZE ⇒ không có nút nóng");
  // Tóm tắt in khối câu chậm + kế hoạch khi có.
  const withSlow = okOrg("shop-cham", 3);
  if (withSlow.result.ok) {
    withSlow.result.diag = { columns: 2, materialized: true, conversations: 10, nullTurns: 0, migrationsApplied: 1, migrationsInRepo: 1, pgVersion: "16" };
    withSlow.result.slow = { top, plans: [{ hash: top[0].hash, block: top[0].block, structure: st, detail: ["Filter: bí mật"] }] };
  }
  const sw = summarizeInboxPerf([withSlow], { samples: 5, acceptanceCodes: [] });
  const swPub = sw.publicLines.join("\n");
  assert.match(swPub, /org#1 chẩn đoán «chưa đọc» 0245: cột đủ 2\/2 · đường đọc LƯU SẴN/);
  assert.match(swPub, /org#1 câu chậm #1 listInbox\.đếm-thẻ/);
  assert.match(swPub, /org#1 kế hoạch \[[0-9a-f]{8}\] listInbox\.đếm-thẻ: 3 nút/);
  assert.ok(!swPub.includes("bí mật") && !swPub.includes(TEN_KHACH), "kế hoạch đủ điều kiện chỉ ở phần mã hoá");
  assert.match(privateLinesOf(withSlow, "org#1").join("\n"), /kế hoạch đủ \[[0-9a-f]{8}\] listInbox\.đếm-thẻ:\n {4}Filter: bí mật/);
  console.log("✓ inbox-perf-probe thuần: arg nghiêm · p50 trung vị / p95 hạng gần nhất / rỗng ⇒ null · che org#i · mẫu < 3 ⇒ chưa kết luận · chưa có đích · ≤ 300 ký tự / ≤ 60 dòng");
}

export function testInboxPerfProbeSource() {
  const src = readFileSync("scripts/inbox-perf-probe.ts", "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!/\b(insert|update|delete|truncate|alter|drop|create|upsert|grant)\b\s+(into|from|table|set|schema|index|[a-z_"]+\s+set)/i.test(code), "script không có câu SQL ghi nào");
  assert.ok(!/\.(insert|update|delete)\s*\(|onConflict|returning\s*\(/.test(code), "script không gọi lệnh ghi drizzle nào");
  const raw = [...code.matchAll(/sql`([^`]*)`/g)].map((m) => m[1].trim());
  assert.ok(raw.includes("show default_transaction_read_only"), "hỏi chế độ chỉ đọc");
  for (const r of raw) assert.match(r, /^(show|select) /, `câu SQL thô chỉ ĐỌC: ${r.slice(0, 60)}`);
  // EXPLAIN của câu chậm: mặc định KHÔNG ANALYZE (chỉ lập kế hoạch); ANALYZE CHỈ sau cờ --analyze (cần --org).
  assert.match(code, /export const EXPLAIN_RUN = "EXPLAIN \(ANALYZE, BUFFERS, VERBOSE, FORMAT JSON\)";/);
  assert.match(code, /explainPlan\(original, t\.slowest, Boolean\(opts\.analyze\)\)/, "ANALYZE chỉ khi cờ bật");
  assert.match(code, /analyze: args\.analyze/, "cờ đi từ arg đã soát");
  assert.match(code, /export const EXPLAIN_PLAN_ONLY = "EXPLAIN \(FORMAT JSON\)";/, "mặc định chỉ lập kế hoạch");
  assert.equal((code.match(/ANALYZE/g) ?? []).length, 1, "chữ ANALYZE chỉ ở MỘT hằng (EXPLAIN_RUN)");
  for (const w of ["sendStaffReplyCore", "claimConversationCore", "assignConversationCore", "releaseConversationCore", "handBackToAiCore", "suggestReplyCore", "addNoteCore", "setConversationLabelsCore", "runJob", "enqueue", "dispatch", "notify", "sendTelegram", "sendLark", "setSetting", "audit(", "migrate"]) {
    assert.ok(!code.includes(w), `script không ghi / không gửi: ${w}`);
  }
  assert.match(src, /if \(CHAY_THANG\) \{\n\s+process\.env\.ERP_READ_ONLY = "1";/);
  assert.match(code, /platformReadOnlyConfirmed\(\)/, "hỏi lại Postgres trước khi đọc");
  assert.match(code, /activeUserIdsWhoCan\("ai_sales:view"\)/, "danh tính lấy từ bộ tính quyền của phiên, không bịa");
  assert.match(code, /getDbForInspection\(org\)/, "CSDL tổ chức mở bằng handle chỉ đọc, không migrate");
  // Script gọi ĐÚNG các hàm của trang — và trang VẪN gọi chúng (trang đổi mà script không đổi ⇒ đỏ ở đây).
  const page = readFileSync("app/(dashboard)/ai/sales-chatbot/inbox/page.tsx", "utf8");
  for (const fn of ["listLabels()", "inboxPages()", "inboxThreadPayload(user, selected)", "assignableUsers(user)", "inboxAssignees(user)", "organizationLevelPack()", "listPageRoutes().catch(() => [])", "humanCooldownMinutes()", "manualOrderGate(user)"]) {
    assert.ok(page.includes(fn), `page.tsx còn gọi ${fn}`);
  }
  // Trang dựng tham số listInbox qua `inboxListQuery(state)` (P0 inbox-search-global 12/10/2026) — bộ khoá của nó ở trạng thái mặc
  // định phải ĐÚNG bộ script dựng (`DEFAULT_LIST_QUERY`), để script vẫn đo đúng lời gọi của trang.
  assert.match(page, /listInbox\(user, inboxListQuery\(state\)\)/, "page.tsx gọi listInbox qua inboxListQuery(state)");
  assert.deepEqual(
    inboxListQuery({ filter: "ALL", q: "", page: null, channel: null, handler: null, assignee: null, phone: null, level: null, period: null, from: null, to: null, label: null, limit: 100, selected: null }),
    { filter: "ALL", channel: null, q: "", label: null, page: null, phone: null, level: null, assignee: null, period: null, from: null, to: null, limit: 100, handler: null },
    "trạng thái mặc định của trang ⇒ đúng bộ khoá script dựng mặc định",
  );
  for (const fn of ["await listLabels();", "await inboxPages();", "await inboxThreadPayload(user, selected)", "listInbox(user, DEFAULT_LIST_QUERY)", "assignableUsers(user)", "inboxAssignees(user)", "organizationLevelPack()", "listPageRoutes().catch(() => [])", "humanCooldownMinutes()", "manualOrderGate(user)"]) {
    assert.ok(code.includes(fn), `script gọi ${fn} như trang`);
  }
  // CHUYỂN hội thoại (10/10/2026) = route chỉ đọc hội thoại — script đo ĐÚNG lời gọi của route, không dựng lại danh sách.
  const route = readFileSync("app/api/ai-sales/inbox-thread/route.ts", "utf8");
  assert.ok(route.includes("await inboxThreadPayload(user, id)") && code.includes("await inboxThreadPayload(user, id)"), "route và script cùng gọi inboxThreadPayload");
  assert.ok(!/listInbox/.test(route), "route chuyển hội thoại không chạy lại danh sách");
  assert.match(code, /switchTo\.cold\.push\(await switchConversationPath\(user, id\)\)/, "lượt CHUYỂN đo đường route");
  assert.ok(readFileSync("app/(dashboard)/ai/sales-chatbot/inbox/conversation-list.tsx", "utf8").includes("onClick={(e) => openConversationInPlace(e, href)}"), "bấm hàng đổi ?c= tại chỗ, không điều hướng dựng lại trang");
  assert.match(code, /filter: "ALL", channel: null, q: "", label: null, page: null, phone: null, level: null, assignee: null, period: null, from: null, to: null, limit: 100, handler: null/, "bộ lọc mặc định của trang");

  const ops = readFileSync(".github/workflows/ops-vps.yml", "utf8");
  assert.match(ops, /- inbox-perf-probe\s+#/, "ops-vps khai lựa chọn inbox-perf-probe");
  assert.match(ops, /OPS_THAO_TAC_MA_HOA: "[^"]*\binbox-perf-probe\b/, "kết quả inbox-perf-probe MÃ HOÁ");
  assert.match(ops, /DOC_NANG="[^"]*\binbox-perf-probe\b/, "inbox-perf-probe là thao tác ĐỌC nặng");
  assert.match(ops, /\n\s+inbox-perf-probe\)\n[\s\S]*?ma_hoa_ket_qua chay_voi_arg docker exec erp-app npx tsx --tsconfig tsconfig\.json scripts\/inbox-perf-probe\.ts ;;/, "nhánh case chạy đúng script qua ma_hoa_ket_qua");
  console.log("✓ inbox-perf-probe mã nguồn: không câu ghi · ERP_READ_ONLY + hỏi lại Postgres · handle chỉ đọc · gọi ĐÚNG hàm của page.tsx · ops-vps khai đủ bốn chỗ");
}

const ORG = "ipp-a";

async function cleanupOrg(code: string) {
  await releaseOrganizationDb(code);
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  await pdb.delete(schema.platformAuditLog).where(eq(schema.platformAuditLog.targetOrgCode, code));
  await pdb.delete(schema.platformAiUsage).where(eq(schema.platformAiUsage.orgCode, code));
  invalidateOrganizations();
  invalidateCapabilities();
  rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
}

/** CSDL (PGlite của bộ kiểm thử): tổ chức THẬT có hội thoại ⇒ đo ra số; danh tính chỉ xem không ghi gì. */
export async function testInboxPerfProbeDb() {
  // Bộ đếm câu chỉ gắn vào kết nối mở SAU khi cờ bật (db/index.ts::instrumentQueries) — bật TRƯỚC khi cấp tổ chức.
  const prevProbe = process.env.ERP_PERF_PROBE;
  process.env.ERP_PERF_PROBE = "1";
  await cleanupOrg(ORG);
  try {
    await provisionOrganization({ code: ORG, name: ORG, plan: "starter", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `admin@${ORG}.local`, name: "QT", password: "HopThuDo@12345" }, source: "TEST", actor: null });
    assert.ok((await getEnabledModules(ORG)).has("ai_sales"));
    const PAGE = "ipp-page";
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const c = schema.salesChatConversations;
      const t = schema.salesChatInbound;
      const now = Date.now();
      for (let i = 0; i < 4; i++) {
        const thread = `ipp-t${i}`;
        const at = new Date(now - (i + 1) * 60_000);
        await db.insert(c).values({ channel: "FANPAGE", status: "OPEN", visitorKey: fanpageVisitorKey(PAGE, thread), pageId: PAGE, threadId: thread, lastCustomerAt: at });
        await db.insert(t).values([
          { pageId: PAGE, threadId: thread, messageId: `cust-${thread}`, text: CHU_TIN, customerName: TEN_KHACH, status: "DONE", processedAt: at, createdAt: at },
          { pageId: PAGE, threadId: thread, messageId: `cust2-${thread}`, text: `SĐT em ${SDT}`, customerName: TEN_KHACH, status: "DONE", processedAt: at, createdAt: new Date(at.getTime() + 1000) },
        ]);
      }
      const [web] = await db.insert(c).values({ channel: "WEB", status: "OPEN" }).returning({ id: c.id });
      await db.insert(schema.salesChatMessages).values([
        { conversationId: web.id, seq: 1, role: "user", content: [{ type: "text", text: "Ship bao lâu?" }] },
        { conversationId: web.id, seq: 2, role: "assistant", content: [{ type: "text", text: "Dạ 2–3 ngày ạ." }] },
      ]);
      await db.insert(c).values({ channel: "TEST", status: "OPEN" });
    });

    const home = await getHomeOrganization();
    assert.equal(await bindReadOnlyOrgHandle({ code: home.code, isHome: true }), "HOME");
    assert.equal(await bindReadOnlyOrgHandle({ code: ORG, isHome: false }), "LIVE", "tiến trình đã mở CSDL tổ chức ⇒ dùng nguyên handle, không gắn đè");

    // 1 · Chỉ có quản trị (ADMIN) ⇒ THU HẸP về chỉ xem; đo 3 lượt, 3 hội thoại đầu danh sách.
    // PGlite của bộ kiểm thử không ép chỉ đọc (một tiến trình dùng chung) ⇒ thay đúng câu hỏi chế độ; mọi thứ khác là đường thật.
    const [r1] = await collectInboxPerf([ORG], 3, { orgReadOnly: async () => true });
    assert.ok(r1.result.ok, JSON.stringify(r1.result));
    assert.equal(r1.identity?.kind, "NARROWED");
    assert.equal(r1.identity?.fromRole, "ADMIN");
    assert.equal(r1.identity?.role, "VIEWER", "ADMIN qua mọi can() ⇒ phải hạ vai trò mới không gửi được");
    const res = r1.result;
    assert.equal(res.conversations, 3);
    for (const s of [...res.load.cold, ...res.load.warm]) {
      assert.equal(s.error, null, `lượt đo không hỏng: ${s.error}`);
      assert.ok(s.ms > 0 && s.listMs !== null && s.listMs > 0);
      assert.equal(s.rows, 5, "4 hội thoại page + 1 chat web; khung TEST không vào hộp thư");
      assert.equal(s.total, 5);
      assert.ok(s.sqlMs !== null && s.queries !== null && s.queries > 5, `SQL tách riêng được: ${s.queries} câu`);
    }
    // CHUYỂN hội thoại (10/10/2026) = route chỉ đọc hội thoại: KHÔNG chạy lại danh sách.
    for (const s of [...res.switchTo.cold, ...res.switchTo.warm]) {
      assert.equal(s.error, null, `lượt đo không hỏng: ${s.error}`);
      assert.ok(s.ms > 0 && s.listMs === null && s.rows === null, "lượt chuyển không dựng lại danh sách");
      assert.ok(s.sqlMs !== null && s.queries !== null && s.queries >= 1, `SQL tách riêng được: ${s.queries} câu`);
    }
    assert.equal(res.load.cold.length, 3);
    assert.equal(res.load.warm.length, 3);
    assert.ok(res.switchTo.cold.every((s) => s.threadMs !== null && s.items !== null && s.items >= 1), "lượt chuyển đo loadInboxThread và đọc được dòng thời gian");
    assert.ok(res.load.cold.every((s) => s.threadMs === null && s.items === null), "lượt tải không mở hội thoại");
    await withOrganization(ORG, async () => {
      const seen = await (await getDb()).select({ id: schema.salesChatConversations.id }).from(schema.salesChatConversations).where(isNotNull(schema.salesChatConversations.staffSeenAt));
      assert.equal(seen.length, 0, "danh tính chỉ xem KHÔNG ghi staff_seen_at — lượt đo không xoá dấu «chưa đọc» của shop");
    });
    // Câu chậm nhất + chẩn đoán 0245 + EXPLAIN (đường thật trên PGlite).
    const [rSlow] = await collectInboxPerf([ORG], 2, { orgReadOnly: async () => true }, { explain: true, analyze: true, top: 8 });
    assert.ok(rSlow.result.ok && rSlow.result.slow && rSlow.result.diag, JSON.stringify(rSlow.result).slice(0, 300));
    const slow = rSlow.result.slow;
    assert.ok(slow.top.some((t) => t.block === "listInbox.đếm-thẻ") && slow.top.some((t) => t.block === "listInbox.hàng"), `bắt được câu của listInbox: ${slow.top.map((t) => t.block).join(", ")}`);
    assert.equal(slow.plans.length, 2, "EXPLAIN hai hình dạng chậm nhất");
    assert.ok(slow.plans.every((p) => p.structure[0] !== "kế hoạch: không đọc được"), `EXPLAIN đọc được: ${JSON.stringify(slow.plans.map((p) => p.structure[0]))}`);
    assert.equal(rSlow.result.diag.columns, 2, "CSDL kiểm thử có đủ cột 0245");
    assert.ok(slow.plans.every((p) => / THẬT \d+ ms · \d+ nút KHÔNG chạy lần nào$/.test(p.structure[0])), `ANALYZE ra số thật: ${JSON.stringify(slow.plans.map((p) => p.structure[0]))}`);
    assert.ok(rSlow.result.diag.stateBytes && rSlow.result.diag.stateBytes.max !== null, "đọc được cỡ cột state");
    assert.ok(slow.plans.every((p) => (p.hot?.length ?? 0) > 0 && /ms tự thân · /.test(p.hot![0])), `ANALYZE ⇒ có nút nóng: ${JSON.stringify(slow.plans.map((p) => p.hot?.[0]))}`);
    assert.ok(rSlow.result.diag.conversations !== null && rSlow.result.diag.conversations >= 5);
    assert.ok(rSlow.result.load.cold.every((s) => s.captured === undefined), "chữ câu + tham số rời khỏi mẫu sau khi gộp");
    const rep3 = summarizeInboxPerf([rSlow], { samples: 2, acceptanceCodes: [], top: 8 });
    const pub3 = rep3.publicLines.join("\n");
    assert.match(pub3, /org#1 câu chậm #1 /);
    assert.match(pub3, /org#1 kế hoạch \[[0-9a-f]{8}\] /);
    for (const secret of [ORG, TEN_KHACH, SDT, CHU_TIN, r1.identity?.userId ?? "—", "ipp-t0", "ipp-page"]) assert.ok(!pub3.includes(secret), `công khai (câu chậm) không mang «${secret}»`);

    const rep = summarizeInboxPerf([r1], { samples: 3, acceptanceCodes: [] });
    assert.equal(rep.verdict, "MEASURED", rep.publicLines.join("\n"));
    const pub = rep.publicLines.join("\n");
    assert.match(pub, /org#1 tải hộp thư \(ms\): nguội p50 \d+/);
    assert.match(pub, /org#1 chuyển hội thoại \(ms\): nguội p50 \d+[^\n]*\(n=3\/3 trên 3 hội thoại\)/);
    for (const secret of [ORG, TEN_KHACH, SDT, CHU_TIN, r1.identity?.userId ?? "—"]) assert.ok(!pub.includes(secret), `công khai không mang «${secret}»`);

    // 2 · Có tài khoản CHỈ XEM thật ⇒ dùng nó, không thu hẹp ai.
    await withOrganization(ORG, async () => {
      await (await getDb()).insert(schema.users).values({ id: "ipp-xem", email: `xem@${ORG}.local`, name: "Chỉ xem", passwordHash: "x", role: "VIEWER", permissions: ["ai_sales:view"], active: true });
    });
    const [r2] = await collectInboxPerf([ORG], 1, { orgReadOnly: async () => true });
    assert.ok(r2.result.ok, JSON.stringify(r2.result));
    assert.deepEqual(r2.identity, { kind: "VIEW_ONLY_ACCOUNT", userId: "ipp-xem", role: "VIEWER", fromRole: "VIEWER" });
    assert.equal(r2.result.conversations, 1);
    assert.match(summarizeInboxPerf([r2], { samples: 1, acceptanceCodes: [] }).publicLines.join("\n"), new RegExp(THIN_LABEL), "1 lượt / 1 hội thoại ⇒ mẫu nhỏ");

    // 3 · CSDL không chỉ đọc ⇒ DỪNG trước mọi lượt đo; tổ chức lạ ⇒ hỏng có tên, không ném.
    const [r3] = await collectInboxPerf([ORG], 1, { orgReadOnly: async () => false });
    assert.ok(!r3.result.ok && r3.result.error.startsWith("DỪNG"), JSON.stringify(r3.result));
    const [r4] = await collectInboxPerf(["khong-co-to-chuc"], 1);
    assert.ok(!r4.result.ok && /Không có tổ chức/.test(r4.result.error));
  } finally {
    await cleanupOrg(ORG);
    if (prevProbe === undefined) delete process.env.ERP_PERF_PROBE;
    else process.env.ERP_PERF_PROBE = prevProbe;
  }
  console.log("✓ inbox-perf-probe CSDL: tổ chức thật đo ra ms + số câu SQL · thu hẹp ADMIN ⇒ VIEWER không ghi staff_seen_at · có tài khoản chỉ xem thì dùng nó · CSDL không chỉ đọc ⇒ DỪNG");
}

export async function testInboxPerfProbe() {
  testInboxPerfProbePure();
  testInboxPerfProbeSource();
  await testInboxPerfProbeDb();
}

if (/inbox-perf-probe\.test\.ts$/.test(process.argv[1] ?? "")) testInboxPerfProbe().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
