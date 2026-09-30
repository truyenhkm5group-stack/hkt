/**
 * ═══════════ CÔ LẬP MỨC TIẾN TRÌNH — HAI TỔ CHỨC THẬT TRONG MỘT TIẾN TRÌNH ═══════════
 *
 * Hợp đồng: docs/platform/shared-contracts.md mục 8, 9 · target-architecture P12/P13 · audit
 * ISO-01/02/03/04/05/07/08/12/15/16/18.
 *
 * SQL đã cô lập nhờ silo. Bài này đo lớp còn lại: đệm `memo`, bus realtime, credential môi trường,
 * cấu hình kênh cảnh báo, khoá job, hẹn giờ gộp cảnh báo, phân giải tổ chức của webhook và việc
 * sau phản hồi. Tổ chức thứ hai là một CSDL PGlite THẬT (mã `pi-…`, tự cấp bằng
 * `provisionOrganization`), không phải bản giả — tổ chức nhà là CSDL của bộ kiểm thử.
 *
 * Mọi lời "không gọi mạng" được CHỨNG MINH bằng `fetch` giả đếm lượt gọi, không phải suy ra từ việc
 * không thấy lỗi. Tự dọn: dòng tổ chức, đệm, hẹn giờ, `fetch` gốc — trong `finally`.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { getDbFor, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { loadAlertConfig } from "@/lib/alerts/config";
import { sendLark } from "@/lib/alerts/lark";
import { cancelAlertEvaluationsForTests, pendingAlertEvaluations, scheduleAlertEvaluation } from "@/lib/alerts/rules";
import { AnthropicProvider } from "@/lib/ai/provider";
import { clearMemo, memo, memoKeys, memoStoreKey } from "@/lib/cache";
import { FacebookAdsClient } from "@/lib/integrations/facebook/client";
import { PancakeClient } from "@/lib/integrations/pancake/client";
import { PancakePagesClient } from "@/lib/integrations/pancake/pages";
import { ViettelPostClient } from "@/lib/integrations/viettelpost/client";
import { bindOrganization } from "@/lib/platform/background";
import { OrgContextError, peekOrganization, withOrganization } from "@/lib/platform/context";
import { assertHomeCredentials, isConnectorUnavailable, peekIsNonHome } from "@/lib/platform/credentials";
import { getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { resolveWebhookOrganization, WEBHOOK_BINDINGS, type WebhookProvider, WebhookAuthError } from "@/lib/platform/webhooks";
import { eventVisibleTo, publish, subscribeOrganization, type OrganizationEvent } from "@/lib/realtime/bus";
import { HOME_CREDENTIAL_EXEMPT, HOME_CREDENTIAL_JOBS, JOB_DEFINITIONS, runJob, type JobSkipped } from "@/lib/sync/jobs";
import { isJobRunning, jobLockKey, runSyncJob } from "@/lib/sync/runner";

const B = "pi-beta";
const cho = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Chờ tới khi điều kiện đúng hoặc hết trần — thay cho ngủ một khoảng đoán mò. */
async function doiToi(dk: () => boolean, tranMs = 5_000): Promise<boolean> {
  const het = Date.now() + tranMs;
  while (Date.now() < het) {
    if (dk()) return true;
    await cho(5);
  }
  return dk();
}

/** Lời hứa treo quá trần ⇒ trả nhãn TREO thay vì làm treo cả bộ kiểm thử. */
async function hoacTreo<T>(p: Promise<T>, tranMs = 3_000): Promise<T | "TREO"> {
  return Promise.race([p, cho(tranMs).then(() => "TREO" as const)]);
}

function dirOf(code: string) {
  return organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, "");
}

async function laLoiChuaCauHinh(p: Promise<unknown>, nhan: string) {
  await assert.rejects(p, (e: unknown) => isConnectorUnavailable(e), `${nhan}: tổ chức khác nhà phải nhận CONNECTOR_NOT_CONFIGURED`);
}

export async function testPlatformProcessIsolation() {
  const dir = dirOf(B);
  rmSync(dir, { recursive: true, force: true });
  const home = await getHomeOrganization();
  const goc = globalThis.fetch;
  let luotMang = 0;
  const fetchGia = (async () => {
    luotMang += 1;
    throw new Error("bài kiểm không gọi mạng thật");
  }) as unknown as typeof fetch;

  try {
    const prov = await provisionOrganization({ code: B, name: "Cô lập tiến trình (thử)", modules: [], source: "TEST", actor: null });
    assert.equal(prov.organization.isHome, false);

    /* ── 1 · memo: cùng khoá, hai tổ chức, hai giá trị; nhà giữ khoá cũ ── */
    const KHOA = "pi:probe";
    assert.equal(await memo(KHOA, 60_000, async () => "nha"), "nha");
    assert.equal(await withOrganization(B, () => memo(KHOA, 60_000, async () => "beta")), "beta", "tổ chức B không được nhận giá trị đệm của nhà");
    assert.equal(await withOrganization(B, () => memo(KHOA, 60_000, async () => "khac")), "beta", "lượt sau của B trúng đệm CỦA B");
    assert.equal(await memo(KHOA, 60_000, async () => "khac"), "nha", "lượt sau của nhà trúng đệm CỦA NHÀ");
    const khoa = memoKeys();
    assert.ok(khoa.includes(KHOA), "khoá của tổ chức nhà GIỮ NGUYÊN (bài kiểm giữ ấm so tập khoá)");
    assert.ok(khoa.includes(`org:${B}:${KHOA}`), "khoá của tổ chức khác mang tiền tố org:<mã>:");
    assert.equal(memoStoreKey({ code: home.code, isHome: true }, KHOA), KHOA);

    // Lượt tính ĐANG CHẠY của nhà không được dùng chung cho B (nhánh inflight).
    let mo!: () => void;
    const cong = new Promise<void>((r) => (mo = r));
    const KHOA2 = "pi:inflight";
    const pNha = memo(KHOA2, 60_000, async () => {
      await cong;
      return "nha";
    });
    await cho(20);
    let bTinh = false;
    const vB = await hoacTreo(
      withOrganization(B, () =>
        memo(KHOA2, 60_000, async () => {
          bTinh = true;
          return "beta";
        }),
      ),
    );
    assert.notEqual(vB, "TREO", "B đi nhờ lượt tính đang chạy của nhà (và treo theo nó)");
    assert.equal(vB, "beta");
    assert.ok(bTinh, "B phải tự tính");
    mo();
    assert.equal(await pNha, "nha");

    /* ── 2 · bus: sự kiện của B không tới người nghe của nhà, và ngược lại ── */
    assert.equal(eventVisibleTo("a", { org: "a" }), true);
    assert.equal(eventVisibleTo("a", { org: "b" }), false, "khác tổ chức ⇒ không chuyển");
    assert.equal(eventVisibleTo("a", {}), false, "thiếu dấu tổ chức ⇒ không chuyển (phía hẹp)");
    assert.equal(eventVisibleTo("a", { org: "" }), false);
    const nhaNghe: OrganizationEvent[] = [];
    const bNghe: OrganizationEvent[] = [];
    const boNha = subscribeOrganization(home.code, (e) => nhaNghe.push(e));
    const boB = subscribeOrganization(B, (e) => bNghe.push(e));
    try {
      await withOrganization(B, async () => publish({ type: "stock", variantId: "pi-b" }));
      await withOrganization(home.code, async () => publish({ type: "stock", variantId: "pi-nha" }));
      publish({ type: "stock", variantId: "pi-khong-ngu-canh" }); // không phiên, không ngữ cảnh ⇒ nhà (P4)
      await doiToi(() => nhaNghe.some((e) => e.type === "stock" && e.variantId === "pi-khong-ngu-canh"));
    } finally {
      boNha();
      boB();
    }
    const ma = (l: OrganizationEvent[]) => l.filter((e): e is OrganizationEvent & { type: "stock" } => e.type === "stock").map((e) => e.variantId);
    assert.deepEqual(ma(bNghe), ["pi-b"], "người nghe của B chỉ nhận sự kiện của B");
    assert.deepEqual(ma(nhaNghe).sort(), ["pi-khong-ngu-canh", "pi-nha"], "sự kiện phát trong ngữ cảnh B KHÔNG tới người nghe của nhà");
    assert.ok([...nhaNghe, ...bNghe].every((e) => typeof e.org === "string" && e.org.length > 0), "mọi sự kiện chuyển đi đều mang dấu tổ chức");

    /* ── 3 · credential môi trường: B bị chặn TRƯỚC khi một byte rời máy ── */
    globalThis.fetch = fetchGia;
    let anthropicMang = 0;
    const fetchAnthropic = (async () => {
      anthropicMang += 1;
      throw new Error("bài kiểm không gọi mạng thật");
    }) as unknown as typeof fetch;
    await withOrganization(B, async () => {
      assert.equal(peekIsNonHome(), true);
      await laLoiChuaCauHinh(assertHomeCredentials("pancake"), "assertHomeCredentials");
      await laLoiChuaCauHinh(new PancakeClient("khoa-gia", "shop-gia", "http://pancake.invalid").get("shops"), "Pancake POS get");
      await laLoiChuaCauHinh(new PancakeClient("khoa-gia", "shop-gia", "http://pancake.invalid").post("shops/x/orders", {}), "Pancake POS post");
      const pages = new PancakePagesClient("tok-gia", "http://pages.invalid");
      await laLoiChuaCauHinh(pages.listPages(), "Pancake Pages listPages");
      await laLoiChuaCauHinh(pages.pageToken("p1"), "Pancake Pages pageToken (nhánh từng nuốt lỗi rồi lùi về khoá người dùng)");
      await laLoiChuaCauHinh(pages.sendMessage("p1", "c1", "k1", "xin chào"), "Pancake Pages sendMessage");
      const vtp = new ViettelPostClient("http://vtp.invalid");
      assert.equal(vtp.configured, false, "job của tổ chức khác thấy Viettel Post là CHƯA cấu hình");
      await laLoiChuaCauHinh(vtp.getToken(), "Viettel Post getToken (không đọc/ghi integration_tokens)");
      await laLoiChuaCauHinh(vtp.debugCall("user/info"), "Viettel Post rawCall");
      await laLoiChuaCauHinh(new FacebookAdsClient("tok-gia", "123456789", "v21.0").listAdAccounts(), "Facebook");
      await laLoiChuaCauHinh(new AnthropicProvider("claude-thu", "low", 1_000, 0, fetchAnthropic).complete({ system: "x", messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }], tools: [] }), "AI provider");
      const lark = await sendLark("https://lark.invalid/hook", "", "thử", [[{ text: "x" }]]);
      assert.equal(lark.ok, false, "Lark: tổ chức khác nhà không gửi");
      assert.match(lark.error ?? "", /chưa được cấu hình/, "Lark trả lỗi theo hợp đồng { ok:false } và nói rõ vì sao");
    });
    assert.equal(luotMang, 0, "tổ chức khác nhà KHÔNG được có một lượt fetch nào");
    assert.equal(anthropicMang, 0, "AI provider không được gọi mạng");
    // Đối chứng: tổ chức nhà đi qua hàng rào và TỚI được mạng (fetch giả đếm đúng một lượt).
    await withOrganization(home.code, () => assertHomeCredentials("pancake"));
    const larkNha = await withOrganization(home.code, () => sendLark("https://lark.invalid/hook", "", "thử", [[{ text: "x" }]]));
    assert.equal(larkNha.ok, false);
    assert.equal(luotMang, 1, "tổ chức nhà vẫn gửi được như trước nền tảng — hàng rào không chặn nhầm");
    globalThis.fetch = goc;

    /* ── 4 · kênh cảnh báo: B không nhận fallback env của nhà ── */
    const envGia = (ten: string) => (ten === "LARK_WEBHOOK_URL" ? "https://lark.invalid/env-cua-nha" : ten === "TELEGRAM_BOT_TOKEN" ? "tok-env-cua-nha" : ten === "LARK_MANAGER_WEBHOOK_URL" ? "https://lark.invalid/quan-ly" : "");
    const cfgB = await withOrganization(B, () => loadAlertConfig({ readEnv: envGia }));
    assert.equal(cfgB.larkWebhookUrl, "", "tổ chức B chưa khai kênh ⇒ KHÔNG lùi về nhóm Lark của nhà");
    assert.equal(cfgB.telegramBotToken, "");
    assert.equal(cfgB.larkManagerWebhookUrl, "");
    const cfgNha = await withOrganization(home.code, () => loadAlertConfig({ readEnv: envGia }));
    assert.notEqual(cfgNha.larkWebhookUrl, "", "tổ chức nhà vẫn có kênh (từ settings hoặc lùi về env) như trước nền tảng");

    /* ── 5 · khoá job: B không bị khoá bởi job cùng tên đang chạy của nhà ── */
    let moJob!: () => void;
    const congJob = new Promise<void>((r) => (moJob = r));
    const JOB = "pi_lock";
    const pJobNha = runSyncJob({ source: "ERP", job: JOB, observeOnly: true }, async () => {
      await congJob;
      return "nha";
    });
    assert.ok(await doiToi(() => isJobRunning(`ERP:${JOB}`)), "khoá của tổ chức nhà giữ dạng cũ SOURCE:job");
    const rB = await hoacTreo(withOrganization(B, () => runSyncJob({ source: "ERP", job: JOB, observeOnly: true }, async () => "beta")));
    assert.notEqual(rB, "TREO");
    if (rB === "TREO") throw new Error("không tới được");
    assert.equal(rB.skippedBecauseRunning, undefined, "job của B KHÔNG bị bỏ qua vì nhà đang chạy job cùng tên");
    assert.equal(rB.result, "beta");
    assert.equal(isJobRunning(jobLockKey({ code: B, isHome: false }, "ERP", JOB)), false, "B chạy xong thì nhả khoá của B");
    const rNha2 = await runSyncJob({ source: "ERP", job: JOB, observeOnly: true }, async () => "lan-hai");
    assert.equal(rNha2.skippedBecauseRunning, true, "cùng tổ chức thì khoá vẫn giữ đúng như trước");
    moJob();
    assert.equal((await pJobNha).result, "nha");
    const bDb = await getDbFor(prov.organization);
    const dongB = await bDb.select().from(schema.syncRuns).where(eq(schema.syncRuns.job, JOB));
    assert.equal(dongB.length, 1, "lượt của B ghi sync_runs vào CSDL CỦA B");

    // Job cần credential môi trường: B bỏ qua với trạng thái rõ ràng, không ghi sync_runs, không ném.
    const bo = (await runJob("pancake-orders", { trigger: "CRON", actor: "pi-test", org: B })) as JobSkipped;
    assert.equal(bo.skipped, "CONNECTOR_NOT_CONFIGURED");
    assert.equal(bo.org, B);
    const dongPancake = await bDb.select().from(schema.syncRuns).where(and(eq(schema.syncRuns.source, "PANCAKE")));
    assert.equal(dongPancake.length, 0, "job bị bỏ qua không ghi rác vào sync_runs của B");
    await assert.rejects(() => runJob("pancake-orders", { trigger: "CRON", actor: "pi-test", org: "pi-khong-ton-tai" }), (e: unknown) => e instanceof OrgContextError, "mã tổ chức sai ⇒ ném, KHÔNG rơi về nhà");
    // Mọi job gọi nhà cung cấp ngoài đều đã khai là cần credential (hoặc khai miễn trừ kèm lý do).
    const NGOAI = new Set(["PANCAKE", "VIETTELPOST", "FACEBOOK", "SEPAY", "GITHUB"]);
    const chuaKhai = Object.entries(JOB_DEFINITIONS)
      .filter(([k, d]) => NGOAI.has(d.source) && !HOME_CREDENTIAL_JOBS[k] && !HOME_CREDENTIAL_EXEMPT[k])
      .map(([k]) => k);
    assert.deepEqual(chuaKhai, [], "job có nguồn ngoài phải khai vào HOME_CREDENTIAL_JOBS hoặc HOME_CREDENTIAL_EXEMPT");
    assert.deepEqual(Object.keys(HOME_CREDENTIAL_JOBS).filter((k) => !JOB_DEFINITIONS[k]), [], "HOME_CREDENTIAL_JOBS không được có job không tồn tại");

    /* ── 6 · hẹn giờ gộp cảnh báo: mỗi tổ chức một cái, lượt của nhà không nuốt lượt của B ── */
    cancelAlertEvaluationsForTests();
    await withOrganization(home.code, async () => scheduleAlertEvaluation());
    await withOrganization(B, async () => scheduleAlertEvaluation());
    const hen = pendingAlertEvaluations();
    assert.ok(hen.includes(home.code) && hen.includes(B), `webhook của B trong 20 giây sau webhook của nhà KHÔNG bị nuốt — đang hẹn: ${hen.join(", ")}`);
    cancelAlertEvaluationsForTests();

    /* ── 7 · webhook và việc sau phản hồi ── */
    for (const p of Object.keys(WEBHOOK_BINDINGS) as WebhookProvider[]) {
      if (WEBHOOK_BINDINGS[p].mode === "URL_SECRET") {
        // 0182 · token theo tổ chức: KHÔNG token ⇒ ném WebhookAuthError, không bao giờ rơi về nhà — ở MỌI ngữ cảnh đang chạy.
        await assert.rejects(resolveWebhookOrganization(p), WebhookAuthError, `webhook ${p} không token ⇒ từ chối, không về nhà`);
        await assert.rejects(withOrganization(B, () => resolveWebhookOrganization(p)), WebhookAuthError, `webhook ${p} không lấy ngữ cảnh đang chạy làm tổ chức`);
        continue;
      }
      assert.equal(await resolveWebhookOrganization(p), home.code, `Phase 1: webhook ${p} thuộc tổ chức nhà`);
      assert.equal(await withOrganization(B, () => resolveWebhookOrganization(p)), home.code, `webhook ${p} phân giải theo BẢNG KHAI, không theo ngữ cảnh đang chạy`);
    }
    const viecNen = await withOrganization(B, () => bindOrganization(async () => peekOrganization()?.code ?? null));
    assert.equal(peekOrganization(), null);
    assert.equal(await viecNen(), B, "việc sau phản hồi chạy ĐÚNG tổ chức đã chụp lúc gọi, dù ngữ cảnh gốc đã mất");
  } finally {
    globalThis.fetch = goc;
    cancelAlertEvaluationsForTests();
    clearMemo();
    const pdb = await getPlatformDb();
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.code, B));
    await pdb.delete(schema.syncRuns).where(eq(schema.syncRuns.job, "pi_lock"));
    invalidateOrganizations();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows giữ tệp của PGlite đang mở — lượt chạy sau xoá thư mục ở đầu bài.
    }
  }
  console.log("✓ Nền tảng · cô lập mức tiến trình: đệm, bus, credential, kênh cảnh báo, khoá job, hẹn giờ, webhook, việc nền — hai tổ chức không chạm nhau");
}
