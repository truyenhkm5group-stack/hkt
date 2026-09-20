import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { eq, like } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { LEDGER_LIVE_AT, agentRunExternalRef, classifyAgentRunLedger } from "@/lib/constants/agent-run-ledger";
import { __setGithubFetchForTests } from "@/lib/integrations/github/client";
import { reconcileAgentRunLedger } from "@/lib/tech/agent-run-reconcile";

/**
 * ═══════════ SỔ LƯỢT CHẠY AGENT MẤT DÒNG THÌ PHẢI NÓI RA ═══════════
 *
 * Cửa chép sổ mang `continue-on-error: true` — đúng, vì một lần ERP bận không được làm cả lượt
 * chạy agent trông như hỏng. Cái giá: một lượt chạy THÀNH CÔNG có thể không bao giờ về tới
 * production, và tới 21/09/2026 không có gì đỏ lên.
 *
 * ĐO THẬT hôm ấy: 12 lượt chạy trên GitHub, 6 dòng trong sổ. 4 lượt hỏng trước khi agent chạy
 * (không có dòng sổ là ĐÚNG), 6 lượt có đủ, và **2 lượt thành công đã mất bằng chứng**.
 *
 * Bài này khoá bốn tính chất:
 *
 *   1. Năm câu trả lời tách bạch — "hỏng nên không có sổ" KHÁC "có sổ mà mất".
 *   2. Mốc chia đôi di sản / đang-xảy-ra, và mốc ấy KHÔNG lấy từ chính dữ liệu.
 *   3. Không đọc được GitHub ⇒ CHƯA ĐO ĐƯỢC, tuyệt đối không phải "mất 0 dòng".
 *   4. Bộ này KHÔNG BAO GIỜ tự dựng lại dòng đã mất.
 */

const goc = path.resolve(__dirname, "..");

function boChuThich(ma: string): string {
  return ma.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/* ═════════════ 1 · LUẬT THUẦN ═════════════ */

export function testLedgerPure() {
  const truoc = new Date(LEDGER_LIVE_AT.getTime() - 60_000);
  const sau = new Date(LEDGER_LIVE_AT.getTime() + 60_000);

  assert.equal(classifyAgentRunLedger({ conclusion: "success", createdAt: sau, coDongSo: true }).code, "CO_SO");

  /*
    ───────── HỎNG KHÁC MẤT ─────────

    4/12 lượt đo được hỏng ở bước kiểm khoá AI: agent chưa chạy vòng nào. Gọi đó là "mất sổ" là
    biến một lần thiếu credit thành một lỗi hạ tầng, và đẩy người đọc đi sửa nhầm chỗ.
  */
  for (const kt of ["failure", "cancelled", "timed_out", "startup_failure"]) {
    assert.equal(classifyAgentRunLedger({ conclusion: kt, createdAt: sau, coDongSo: false }).code, "KHONG_CHAY", `“${kt}” không phải mất sổ`);
  }

  /*
    ───────── ĐANG CHẠY KHÔNG PHẢI KHÔNG THÀNH CÔNG ─────────

    `conclusion` của lượt đang chạy là `null`. Xếp nó vào nhóm hỏng thì mỗi lần ai đó bấm chạy
    agent, phép đo lại báo thêm một lượt "không chạy" rồi tự khỏi sau mười phút — một cảnh báo tự
    khỏi là một cảnh báo không ai đọc lần thứ hai.
  */
  assert.equal(classifyAgentRunLedger({ conclusion: null, createdAt: sau, coDongSo: false }).code, "CHUA_XONG");

  // ───────── Mốc chia đôi ─────────
  assert.equal(classifyAgentRunLedger({ conclusion: "success", createdAt: truoc, coDongSo: false }).code, "MAT_DI_SAN");
  assert.equal(classifyAgentRunLedger({ conclusion: "success", createdAt: sau, coDongSo: false }).code, "MAT_DANG_XAY_RA");
  /* Đúng mốc KHÔNG phải trước mốc: cửa đã hoạt động tại thời điểm ấy. */
  assert.equal(classifyAgentRunLedger({ conclusion: "success", createdAt: new Date(LEDGER_LIVE_AT), coDongSo: false }).code, "MAT_DANG_XAY_RA");

  /*
    ───────── CÓ SỔ THÌ THÔI, DÙ WORKFLOW HỎNG ─────────

    Một lượt chạy mà agent làm xong rồi cổng đỏ vẫn để lại dòng sổ (trạng thái FAILED) — và
    workflow khi ấy cũng `failure`. Nếu phép kiểm hỏng đứng trước phép kiểm có-sổ thì dòng ấy bị
    đếm nhầm vào nhóm "agent chưa chạy", và con số "có sổ" tụt xuống mà không ai hiểu vì sao.
  */
  assert.equal(classifyAgentRunLedger({ conclusion: "failure", createdAt: sau, coDongSo: true }).code, "CO_SO");

  // ───────── Khoá đối chiếu dựng đúng như cửa chép sổ dựng ─────────
  assert.equal(agentRunExternalRef("github", 35528323249, "07"), agentRunExternalRef("github", "35528323249", 7), "“07” và “7” là CÙNG một lượt chạy lại");
}

/* ═════════════ 2 · ĐỐI CHIẾU THẬT, QUA CSDL VÀ MỘT GITHUB GIẢ ═════════════ */

const REF_CO = agentRunExternalRef("github", 900000001, 1);

function githubGia(runs: unknown[]) {
  __setGithubFetchForTests((async (url: string | URL | Request) => {
    if (String(url).includes("/runs?")) return new Response(JSON.stringify({ workflow_runs: runs }), { status: 200 });
    return new Response(JSON.stringify({ name: "Agent", state: "active" }), { status: 200 });
  }) as typeof fetch);
}

function luot(id: number, conclusion: string | null, createdAt: Date) {
  return {
    id,
    run_number: id % 1000,
    run_attempt: 1,
    status: conclusion ? "completed" : "in_progress",
    conclusion,
    head_sha: "a".repeat(40),
    head_branch: "main",
    event: "workflow_dispatch",
    html_url: `https://github.com/x/y/actions/runs/${id}`,
    created_at: createdAt.toISOString(),
  };
}

export async function testLedgerReconcile() {
  const db = await getDb();
  const truoc = new Date(LEDGER_LIVE_AT.getTime() - 3_600_000);
  const sau = new Date(LEDGER_LIVE_AT.getTime() + 3_600_000);

  const agent = await db.query.techAgents.findFirst({ columns: { id: true, key: true } });
  await db.insert(schema.techAgentRuns).values({
    agentId: agent?.id ?? null,
    agentKey: agent?.key ?? "documentation",
    status: "SUCCEEDED",
    // `tech_agent_runs_ended_check`: trạng thái kết thúc PHẢI có mốc kết thúc — sổ không cho một
    // lượt chạy vừa "xong" vừa "chưa xong". Mốc này chỉ để dòng hợp lệ; không phép so nào đọc nó.
    endedAt: new Date(),
    externalRef: REF_CO,
    branch: "ai/documentation/TEST-LEDGER",
  });

  githubGia([
    luot(900000001, "success", sau), // có sổ
    luot(900000002, "success", sau), // MẤT — đang xảy ra
    luot(900000003, "success", truoc), // mất — di sản
    luot(900000004, "failure", sau), // hỏng trước khi agent chạy
    luot(900000005, null, sau), // chưa xong
  ]);
  const r = await reconcileAgentRunLedger({ limit: 10 });
  __setGithubFetchForTests(null);

  assert.equal(r.xet, 5);
  assert.deepEqual(r.dem, { CO_SO: 1, CHUA_XONG: 1, KHONG_CHAY: 1, MAT_DI_SAN: 1, MAT_DANG_XAY_RA: 1 });
  assert.equal(r.matDangXayRa.length, 1);
  assert.ok(r.matDangXayRa[0].ref.includes("900000002"), "phải chỉ đích danh lượt chạy đã mất, không chỉ đếm");
  assert.ok(r.matDangXayRa[0].url.includes("/actions/runs/900000002"), "kèm đường dẫn để người mở xem được ngay");

  /*
    ───────── KHÔNG BAO GIỜ TỰ DỰNG LẠI DÒNG ĐÃ MẤT ─────────

    Sổ phải còn NGUYÊN số dòng như trước lượt đối chiếu. GitHub biết lượt chạy ấy đã xảy ra, nhưng
    KHÔNG biết agent sửa tệp nào hay cổng nào xanh — một dòng dựng từ đó chỉ TRÔNG như có bằng
    chứng (AGENTS.md mục 8.8 và 35).
  */
  const conLai = await db.$count(schema.techAgentRuns, like(schema.techAgentRuns.externalRef, "github:9000000%"));
  assert.equal(conLai, 1, "đối chiếu KHÔNG được đẻ thêm dòng sổ nào — nó đếm và nói ra, không vá");

  /*
    ───────── KHÔNG ĐỌC ĐƯỢC ⇒ CHƯA ĐO ĐƯỢC ─────────

    "Xét 0 lượt, mất 0 dòng" trông y hệt một kết quả lành. Đây là chỗ một phép đo hỏng có thể
    khiến người đọc yên tâm hơn cả khi nó chạy đúng.
  */
  __setGithubFetchForTests((async () => new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 })) as typeof fetch);
  const hong = await reconcileAgentRunLedger({ limit: 10 });
  __setGithubFetchForTests(null);
  assert.equal(hong.xet, null, "không đọc được GitHub thì số lượt xét là CHƯA BIẾT, không phải 0");
  assert.ok(hong.khongDoDuoc, "và phải nói ra vì sao");
  assert.equal(hong.dem.MAT_DANG_XAY_RA, 0);
  assert.equal(hong.matDangXayRa.length, 0, "không đo được thì cũng không được liệt kê lượt mất nào");
}

export async function cleanupLedgerFixtures() {
  const db = await getDb();
  await db.delete(schema.techAgentRuns).where(eq(schema.techAgentRuns.externalRef, REF_CO));
}

/* ═════════════ 3 · QUÉT MÃ NGUỒN ═════════════ */

export function testLedgerGuards() {
  const luat = boChuThich(readFileSync(path.join(goc, "lib/constants/agent-run-ledger.ts"), "utf8"));
  const bo = boChuThich(readFileSync(path.join(goc, "lib/tech/agent-run-reconcile.ts"), "utf8"));

  /*
    ───────── MỐC KHÔNG ĐƯỢC LẤY TỪ CHÍNH DỮ LIỆU ─────────

    Lấy `min(started_at)` của sổ làm mốc thì mọi lượt mất trong TƯƠNG LAI cũng tự thành "di sản"
    khi nó là lượt sớm nhất chưa có sổ — một phép đo tự chứng minh mình đúng, và nhóm "đang xảy
    ra" sẽ vĩnh viễn bằng 0.
  */
  assert.ok(/LEDGER_LIVE_AT = new Date\("20\d\d-/.test(luat), "mốc phải là một hằng số khai tường minh");
  assert.ok(!/min\(|startedAt|started_at/.test(luat), "mốc KHÔNG được suy ra từ dữ liệu của chính sổ");

  /*
    ───────── BỘ ĐỐI CHIẾU CHỈ ĐỌC ─────────

    Một đường ghi ở đây là đường dựng lại bằng chứng đã mất. Nó phải không tồn tại, chứ không phải
    tồn tại và được dặn là đừng dùng.
  */
  for (const cam of ["db.insert", "db.update", "db.delete", "startTechAgentRun", "ingestAgentRun"]) {
    assert.ok(!bo.includes(cam), `bộ đối chiếu KHÔNG được gọi \`${cam}\` — nó đếm và nói ra, không vá`);
  }

  /*
    ───────── NĂM CÂU TRẢ LỜI ĐỀU PHẢI CÓ CHỖ DÙNG ─────────

    Một mã được khai mà không nhánh nào sinh ra nó là một mã chết — và người đọc bảng đếm sẽ tin
    rằng tình huống ấy chưa bao giờ xảy ra, trong khi sự thật là nó chưa bao giờ được phân loại.
  */
  for (const ma of ["CO_SO", "CHUA_XONG", "KHONG_CHAY", "MAT_DI_SAN", "MAT_DANG_XAY_RA"]) {
    assert.ok(luat.includes(`code: "${ma}"`) || luat.includes(`"${ma}",`), `mã ${ma} phải được một nhánh thật trả về`);
  }

  /*
    ───────── TÊN WORKFLOW KHAI MỘT LẦN ─────────

    Đường GHI (dispatch) và đường ĐỌC (đối chiếu) phải trỏ vào CÙNG một workflow. Gõ lại chuỗi
    `agent-run.yml` ở đường đọc là mở chỗ để hai bên nói về hai thứ khác nhau — và khi ấy phép đối
    chiếu so sổ với một workflow không sinh ra nó.
  */
  const client = boChuThich(readFileSync(path.join(goc, "lib/integrations/github/client.ts"), "utf8"));
  assert.ok(client.includes("DISPATCHABLE_WORKFLOWS"), "đường đọc phải lấy tên workflow từ sổ đã khai");
  assert.ok(!client.includes('"agent-run.yml"'), "và KHÔNG được gõ lại tên workflow ở đường đọc");

  /*
    ───────── JOB PHẢI CÓ TRONG LỊCH ─────────

    Một job khai ở sổ mà không có trong lịch thì nó chỉ chạy khi có người bấm — tức là đúng lúc
    người ta đã nghi ngờ rồi. Bộ canh chỉ có giá trị khi nó chạy lúc chưa ai nghi gì.
  */
  const lich = readFileSync(path.join(goc, "scripts/scheduler.mjs"), "utf8");
  assert.ok(/job: "agent-run-reconcile"/.test(lich), "job đối chiếu phải nằm trong lịch của scheduler");
}
