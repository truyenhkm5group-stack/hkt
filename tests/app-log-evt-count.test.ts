/**
 * ops `app-log-evt-count` — đếm dòng sự kiện JSON trong log erp-app, CHỈ ĐỌC (25/10/2026). Khoá: chỉ ba trường TÊN (evt · code · source)
 * được đọc, mọi trường khác bị bỏ · dòng không mốc không lọt vào cửa sổ · phủ log nói thật khi container khởi động lại giữa cửa sổ ·
 * arg soát · script không mở CSDL · log đi vào STDIN (không ra log công khai) · khai đủ, mã hoá, làn đọc nặng.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { evtLines, parseEvtArgs, parseLogLine, tallyEvents } from "@/scripts/app-log-evt-count";

export function testAppLogEvtCount() {
  const now = new Date("2026-10-26T03:05:00Z");
  const L = (at: string, json: string) => `${at} ${json}`;
  const drop = (at: string, extra = "") => L(at, `{"evt":"address_ask_dropped","code":"KNOWN_ADDRESS_REASKED"${extra},"conversation":"ab12cd34","dropped":1}`);

  assert.deepEqual(parseLogLine(drop("2026-10-25T07:00:00.123456789Z", ',"source":"COMMENT"')), { at: Date.parse("2026-10-25T07:00:00.123Z"), evt: "address_ask_dropped", code: "KNOWN_ADDRESS_REASKED", source: "COMMENT" });
  assert.equal(parseLogLine("2026-10-25T07:00:00Z GET /api/health 200"), null, "dòng không phải sự kiện");
  assert.equal(parseLogLine('2026-10-25T07:00:00Z {"evt":"có dấu cách và dữ liệu khách"}'), null, "evt không phải TÊN ⇒ bỏ");
  const odd = parseLogLine('2026-10-25T07:00:00Z {"evt":"x_y","code":"0961007201 Ngõ 3","source":"A"}');
  assert.deepEqual([odd?.code, odd?.source], [null, "A"], "trường không phải TÊN không bao giờ được đọc ra");
  assert.equal(parseLogLine('{"evt":"x_y"}')?.at, null, "thiếu mốc docker ⇒ at null");

  const args = parseEvtArgs(["--since=2026-10-25T06:13:48Z"], now);
  assert.ok(!("error" in args));
  const lines = [
    drop("2026-10-25T06:20:00Z", ',"source":"COMMENT"'),
    drop("2026-10-25T09:00:00Z", ',"source":"COMMENT"'),
    drop("2026-10-25T10:00:00Z"),
    drop("2026-10-25T05:00:00Z", ',"source":"COMMENT"'),
    '{"evt":"address_ask_dropped","code":"KNOWN_ADDRESS_REASKED","source":"COMMENT"}',
    L("2026-10-25T08:00:00Z", '{"evt":"other_evt"}'),
  ];
  const t = tallyEvents(lines, args);
  assert.deepEqual(Object.fromEntries(t.counts), { "address_ask_dropped · KNOWN_ADDRESS_REASKED · COMMENT": 2, "address_ask_dropped · KNOWN_ADDRESS_REASKED · —": 1, "other_evt · — · —": 1 }, "trước cửa sổ / không mốc không lọt vào cửa sổ");
  assert.equal(t.undated, 1);
  const out = evtLines(t, args);
  assert.match(out[0], /PHỦ đủ cửa sổ/, "dòng log đầu (05:00Z) sớm hơn cửa sổ ⇒ phủ đủ");
  assert.equal(out[1], "2 × address_ask_dropped · KNOWN_ADDRESS_REASKED · COMMENT", "xếp theo số giảm dần");
  assert.ok(!out.join("\n").includes("ab12cd34"), "mã hội thoại không bao giờ in");
  const late = evtLines(tallyEvents(lines.slice(1, 3), args), args);
  assert.match(late[0], /KHÔNG phủ đủ cửa sổ/, "log bắt đầu sau mốc hỏi (container khởi động lại) ⇒ nói thật");
  const only = tallyEvents(lines, { ...args, evt: "other_evt" });
  assert.deepEqual([...only.counts.keys()], ["other_evt · — · —"], "--evt lọc đúng tên");
  assert.deepEqual(evtLines(tallyEvents([], args), args).slice(1), ["0 dòng sự kiện khớp trong cửa sổ"]);

  assert.ok("error" in parseEvtArgs(["--hours=73"], now));
  assert.ok("error" in parseEvtArgs(["--hours=2", "--since=2026-10-25T06:00:00Z"], now));
  assert.ok("error" in parseEvtArgs(["--since=2026-10-20T00:00:00Z"], now), "quá 72 giờ (log chỉ lấy 72 giờ)");
  assert.ok("error" in parseEvtArgs(["--evt=a b"], now));
  const def = parseEvtArgs([], now);
  assert.ok(!("error" in def) && def.sinceMs === now.getTime() - 24 * 3_600_000 && def.evt === null, "mặc định 24 giờ, mọi evt");

  const src = readFileSync("scripts/app-log-evt-count.ts", "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(code, /@\/db|from "pg"|fetch\(/, "không mở CSDL, không gọi mạng");
  const ops = readFileSync(".github/workflows/ops-vps.yml", "utf8");
  assert.match(ops, /- app-log-evt-count\s+#/, "lựa chọn");
  assert.match(ops, /OPS_THAO_TAC_MA_HOA: "[^"]*\bapp-log-evt-count\b/, "kết quả MÃ HOÁ");
  assert.match(ops, /DOC_NANG="[^"]*\bapp-log-evt-count\b/, "làn đọc NẶNG (dựng npx tsx)");
  assert.match(ops, /docker logs -t --since 72h erp-app 2>&1 \| ma_hoa_ket_qua chay_voi_arg docker exec -i erp-app npx tsx --tsconfig tsconfig\.json scripts\/app-log-evt-count\.ts ;;/, "log đi vào STDIN, có mốc docker, không ra log công khai");
  console.log("✓ ops app-log-evt-count: chỉ đọc ba trường TÊN · dòng không mốc / trước cửa sổ không lọt · phủ log nói thật · arg soát · không mở CSDL · log vào STDIN, mã hoá");
}
