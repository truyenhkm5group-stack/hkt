import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { syncProducts } from "@/lib/integrations/pancake/sync";
import { catchUpModelRegistry, REGISTRY_CATCHUP_ACTOR } from "@/lib/models/registry-job";
import { applyModelRegistryPlan, registerModelCore } from "@/lib/models/service";
import { runJob } from "@/lib/sync/jobs";

/**
 * ═══════════ SỔ MẪU TỰ BẮT KỊP SAU MỖI LƯỢT ĐỒNG BỘ SẢN PHẨM (Company OS · P1) ═══════════
 *
 * SỰ THẬT PRODUCTION (26/09/2026 09:20 UTC): 7 mẫu trong sổ, "chờ đăng ký 13" — 13 mã sản phẩm / thiết kế
 * mới từ lượt đồng bộ sổ DUY NHẤT (25/09 15:14) chưa bao giờ vào sổ, nên vô hình trên /models, buồng lái và
 * Model 360. Job `model-registry` không có lịch (đổi lịch là việc chủ shop duyệt), nên sổ chỉ đúng vào đúng
 * lúc có người nhớ bấm.
 *
 * Sửa: cuối mỗi lượt `pancake-products` chạy CHÍNH job `model-registry` (một dòng `sync_runs` riêng). Bài
 * này chạy đồng bộ sản phẩm THẬT qua `runJob` (fetch Pancake giả lập) và khoá sáu điều:
 *
 *  1. mã mới ⇒ mẫu mới, trạng thái vòng đời TRỐNG (`registered_by = SYNC`), sự kiện của MÁY;
 *  2. chạy lại ⇒ không mẫu mới, không sự kiện mới;
 *  3. mã mơ hồ không bao giờ tự nối (luật 35);
 *  4. trạng thái đã khai của mẫu cũ không bị chạm — kể cả mẫu vừa được nối sản phẩm;
 *  5. sổ mẫu hỏng KHÔNG làm hỏng đồng bộ sản phẩm — lỗi ghi ở chi tiết lượt sản phẩm VÀ ở dòng FAILED riêng;
 *  6. chạy chồng không đẻ mẫu trùng, và liên kết bị lượt khác nối trước là `raced`, không phải lỗi.
 *
 * Đứng CUỐI bộ kiểm thử: nó đổi `globalThis.fetch` và biến môi trường Pancake (khôi phục trong `finally`),
 * nhưng máy khách Pancake được nhớ đệm theo tiến trình — bài nào chạy SAU mà gọi Pancake sẽ gặp địa chỉ giả.
 */

const P = "p1cu-";
const HOST = "https://pancake.p1cu.test/api/v1";

type SanPhamTho = Record<string, unknown>;

function mauSanPham(): SanPhamTho {
  const fx = JSON.parse(readFileSync(path.join(process.cwd(), "tests/fixtures-pancake-products.json"), "utf8")) as { data: SanPhamTho[] };
  return fx.data[0];
}

function sanPham(goc: SanPhamTho, id: string, customId: string, name: string): SanPhamTho {
  const bienThe = (goc.variations as SanPhamTho[]).map((v, i) => ({ ...v, id: `${id}-v${i}`, product_id: id, display_id: `${id}-sku${i}`, barcode: `${id}-b${i}` }));
  return { ...goc, id, custom_id: customId, name, display_id: null, variations: bienThe };
}

export async function testRegistryCatchUpAfterProductSync(db: Db) {
  const pm = schema.productModels;
  const U = `${P}u`;
  const nguoi = { id: U, label: "Người khai P1" };
  await db.insert(schema.users).values({ id: U, email: `${P}u@test.local`, name: "Người khai P1", passwordHash: "x" });

  // Mẫu đã KHAI (IDEA, đăng ký tay, chưa nối sản phẩm) — sản phẩm cùng mã xuất hiện ở lượt đồng bộ tới.
  const khai = await registerModelCore(db, { code: "P1CU-DECL", name: "Mẫu đã khai", actor: nguoi, source: "test:p1" });
  assert.ok("ok" in khai, `đăng ký tay phải được: ${"error" in khai ? khai.error : ""}`);
  const tuDo = await registerModelCore(db, { code: "P1CU-FREE", name: "Mẫu chưa có sản phẩm", actor: nguoi, source: "test:p1" });
  assert.ok("ok" in tuDo);

  const trangThaiTruoc = new Map((await db.select({ id: pm.id, s: pm.lifecycleState }).from(pm)).map((r) => [r.id, r.s]));

  const goc = mauSanPham();
  let dsSanPham: SanPhamTho[] = [
    sanPham(goc, `${P}new1`, "P1CU-NEW1", "Đầm P1 mới 1"),
    sanPham(goc, `${P}new2`, "p1cu-new2 ", "Áo P1 mới 2"),
    sanPham(goc, `${P}amb-a`, "P1CU-AMB", "Váy mơ hồ bản A"),
    sanPham(goc, `${P}amb-b`, "P1CU-AMB", "Váy mơ hồ bản B"),
    sanPham(goc, `${P}decl`, "P1CU-DECL", "Sản phẩm của mẫu đã khai"),
  ];

  const fetchTruoc = globalThis.fetch;
  const envTruoc = { key: process.env.PANCAKE_API_KEY, shop: process.env.PANCAKE_SHOP_ID, base: process.env.PANCAKE_BASE_URL };
  process.env.PANCAKE_API_KEY = "p1cu-khoa-gia";
  process.env.PANCAKE_SHOP_ID = "p1cu-shop";
  process.env.PANCAKE_BASE_URL = HOST;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    const duongDan = new URL(url).pathname;
    const than = duongDan.endsWith("/products/variations")
      ? { data: [], page_number: 1, total_pages: 1 }
      : duongDan.endsWith("/products")
        ? { data: dsSanPham, page_number: 1, total_pages: 1 }
        : null;
    if (!than) return new Response(JSON.stringify({ success: false, message: `ngoài kịch bản: ${duongDan}` }), { status: 404 });
    return new Response(JSON.stringify(than), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const mau = async (code: string) => (await db.select().from(pm).where(eq(pm.code, code)))[0];
  const demMau = async () => Number((await db.select({ n: sql<number>`count(*)` }).from(pm))[0].n);
  const demSuKien = async () => Number((await db.select({ n: sql<number>`count(*)` }).from(schema.domainEvents))[0].n);
  const dongSoMau = async (tu: Date) =>
    db
      .select()
      .from(schema.syncRuns)
      .where(and(eq(schema.syncRuns.job, "model-registry"), gte(schema.syncRuns.startedAt, tu)))
      .orderBy(desc(schema.syncRuns.startedAt));
  const dongSanPham = async (id: string) => (await db.select().from(schema.syncRuns).where(eq(schema.syncRuns.id, id)))[0];

  try {
    // ═══ 1 · đồng bộ sản phẩm thật (qua JOB_DEFINITIONS) ⇒ sổ bắt kịp ═══
    const mocLan1 = new Date(Date.now() - 1000);
    const lan1 = (await runJob("pancake-products", { trigger: "MANUAL", actor: `${P}test` })) as { run: { id: string; status: string } };
    const sp1 = await dongSanPham(lan1.run.id);
    assert.equal(sp1.status, "SUCCESS", `đồng bộ sản phẩm phải thành công: ${sp1.error ?? ""}`);
    assert.match(sp1.detail ?? "", /sổ mẫu: \+\d+ mẫu/, "chi tiết lượt sản phẩm phải nói sổ mẫu đã bắt kịp bao nhiêu");

    const soMau1 = await dongSoMau(mocLan1);
    assert.equal(soMau1.length, 1, "đúng MỘT dòng sync_runs riêng cho model-registry mỗi lượt sản phẩm");
    assert.equal(soMau1[0].status, "SUCCESS", `lượt sổ mẫu phải thành công: ${soMau1[0].error ?? ""}`);
    assert.equal(soMau1[0].actor, REGISTRY_CATCHUP_ACTOR, "người chạy lượt bắt kịp là tên JOB, không phải người bấm");
    assert.equal(soMau1[0].trigger, "MANUAL", "lượt bắt kịp mang đúng nguồn kích hoạt của lượt sản phẩm");
    assert.equal(soMau1[0].source, "ERP");

    for (const [code, spId] of [
      ["P1CU-NEW1", `${P}new1`],
      ["P1CU-NEW2", `${P}new2`],
    ] as const) {
      const m = await mau(code);
      assert.ok(m, `${code}: mã mới phải vào sổ ngay sau đồng bộ sản phẩm`);
      assert.equal(m.productId, spId);
      assert.equal(m.lifecycleState, null, `${code}: trạng thái vòng đời để TRỐNG — máy không khai hộ`);
      assert.equal(m.registeredBy, "SYNC");
      const ev = await db.select().from(schema.domainEvents).where(and(eq(schema.domainEvents.modelId, m.id), eq(schema.domainEvents.name, "model.registered")));
      assert.equal(ev.length, 1);
      assert.equal(ev[0].actorKind, "SYSTEM", "đăng ký theo luật là việc của MÁY");
      assert.equal(ev[0].correlationId, soMau1[0].id, "sự kiện nối về đúng lượt sync_runs của sổ mẫu");
    }
    assert.equal(await mau("P1CU-AMB"), undefined, "hai sản phẩm cùng mã ⇒ KHÔNG tự đăng ký / nối (luật 35)");
    const daNoiMoHo = await db.select({ id: pm.id }).from(pm).where(inArray(pm.productId, [`${P}amb-a`, `${P}amb-b`]));
    assert.equal(daNoiMoHo.length, 0, "không mẫu nào được nối vào sản phẩm của mã mơ hồ");

    const mDecl = await mau("P1CU-DECL");
    assert.equal(mDecl.productId, `${P}decl`, "mẫu đã có được NỐI phần sản phẩm còn trống");
    assert.equal(mDecl.lifecycleState, "IDEA", "…nhưng trạng thái đã khai giữ nguyên");
    for (const [id, s] of trangThaiTruoc) {
      const [sau] = await db.select({ s: pm.lifecycleState }).from(pm).where(eq(pm.id, id));
      assert.equal(sau?.s ?? null, s, `mẫu ${id}: lượt bắt kịp không được đổi trạng thái đã khai`);
    }

    // ═══ 2 · chạy lại ⇒ không gì mới ═══
    const [mauTruoc, suKienTruoc] = [await demMau(), await demSuKien()];
    const lan2 = (await runJob("pancake-products", { trigger: "CRON", actor: "scheduler" })) as { run: { id: string } };
    const sp2 = await dongSanPham(lan2.run.id);
    assert.equal(sp2.status, "SUCCESS");
    assert.match(sp2.detail ?? "", /sổ mẫu: \+0 mẫu · nối 0/, "chạy lại: không đăng ký, không nối thêm gì");
    assert.equal(await demMau(), mauTruoc, "chạy lại không đẻ mẫu mới");
    assert.equal(await demSuKien(), suKienTruoc, "chạy lại không đẻ sự kiện mới");

    // ═══ 3 · chạy chồng: hai lượt cùng lúc trên một mã mới ⇒ đúng một mẫu, không lỗi ═══
    await db.insert(schema.products).values({ id: `${P}new3`, name: "Đầm P1 mới 3", customId: "P1CU-NEW3" });
    const [a, b] = await Promise.all([catchUpModelRegistry({ trigger: "CRON" }), catchUpModelRegistry({ trigger: "MANUAL", actor: `${P}nut` })]);
    const chay = [a, b].filter((r) => r.kind === "RAN");
    assert.ok(chay.length >= 1, "ít nhất một lượt phải chạy");
    assert.ok(
      [a, b].every((r) => r.kind === "RAN" || r.kind === "SKIPPED_RUNNING"),
      `chạy chồng không được thành lỗi: ${JSON.stringify([a, b])}`,
    );
    assert.equal(
      chay.reduce((s, r) => s + (r.kind === "RAN" ? r.inserted : 0), 0),
      1,
      "hai lượt chồng nhau đăng ký mã mới đúng MỘT lần",
    );
    assert.equal(chay.reduce((s, r) => s + (r.kind === "RAN" ? r.failed : 0), 0), 0, "đụng khoá duy nhất khi chạy chồng không phải lỗi");
    assert.equal((await db.select({ id: pm.id }).from(pm).where(eq(pm.code, "P1CU-NEW3"))).length, 1, "không mẫu trùng");

    // ═══ 4 · kế hoạch lập từ ảnh chụp CŨ: sản phẩm đã thuộc mẫu khác ⇒ `raced`, không `failed` ═══
    const mFree = await mau("P1CU-FREE");
    const cu = await applyModelRegistryPlan(
      db,
      { toInsert: [], toLink: [{ modelId: mFree.id, code: "P1CU-FREE", productId: `${P}new1`, designConceptId: null, name: null }], ambiguous: [] },
      { triggeredBy: "test:p1-race" },
    );
    assert.deepEqual(cu.failed, [], "khoá duy nhất chặn lượt nối chồng là chuyện bình thường, không phải lỗi");
    assert.deepEqual(cu.raced, [{ code: "P1CU-FREE", kind: "product" }], "lượt nối bị lượt khác giành trước phải được nêu là raced");
    const mFreeSau = await mau("P1CU-FREE");
    assert.equal(mFreeSau.productId, null, "liên kết của mẫu kia giữ nguyên, mẫu này không bị nối nhầm");
    assert.equal(mFreeSau.lifecycleState, "IDEA");

    // ═══ 5 · sổ mẫu HỎNG ⇒ đồng bộ sản phẩm vẫn thành công, lỗi nằm ở hai chỗ nhìn thấy được ═══
    dsSanPham = [...dsSanPham, sanPham(goc, `${P}new4`, "P1CU-NEW4", "Đầm P1 mới 4")];
    const mocHong = new Date(Date.now() - 1000);
    await db.execute(sql`alter table product_models rename to product_models_p1cu_tam`);
    let hong: { run: { id: string } };
    try {
      hong = (await runJob("pancake-products", { trigger: "CRON", actor: "scheduler" })) as { run: { id: string } };
    } finally {
      await db.execute(sql`alter table product_models_p1cu_tam rename to product_models`);
    }
    const spHong = await dongSanPham(hong.run.id);
    assert.equal(spHong.status, "SUCCESS", `sổ mẫu hỏng KHÔNG được làm hỏng đồng bộ sản phẩm (được ${spHong.status})`);
    assert.equal(spHong.failed, 0, "lỗi của sổ mẫu không cộng vào số lỗi của job sản phẩm");
    assert.match(spHong.detail ?? "", /sổ mẫu: CHƯA bắt kịp/, "chi tiết lượt sản phẩm phải nói sổ mẫu chưa bắt kịp");
    assert.match(spHong.error ?? "", /Sổ mẫu chưa bắt kịp sau đồng bộ sản phẩm/, "câu lỗi phải nằm trong nhật ký của lượt sản phẩm");
    const [soMauHong] = await dongSoMau(mocHong);
    assert.equal(soMauHong?.status, "FAILED", "lượt sổ mẫu hỏng phải là một dòng FAILED riêng — /integrations và tech-incident-watch thấy nó");
    assert.ok((await db.select().from(schema.products).where(eq(schema.products.id, `${P}new4`))).length === 1, "sản phẩm vẫn được ghi");
    assert.equal(await mau("P1CU-NEW4"), undefined, "lượt hỏng không đăng ký được gì…");
    const vaLai = (await runJob("pancake-products", { trigger: "CRON", actor: "scheduler" })) as { run: { id: string } };
    assert.equal((await dongSanPham(vaLai.run.id)).status, "SUCCESS");
    assert.equal((await mau("P1CU-NEW4"))?.lifecycleState, null, "…và lượt sau tự bắt kịp phần đã lỡ");

    // ═══ 6 · bước nối NÉM ⇒ lớp tích hợp vẫn đóng lượt sản phẩm thành công ═══
    const nem = await syncProducts({
      trigger: "MANUAL",
      actor: `${P}test`,
      followUp: async () => {
        throw new Error("bước nối hỏng giả");
      },
    });
    const spNem = await dongSanPham(nem.run.id);
    assert.equal(spNem.status, "SUCCESS", "bước nối ném không được làm hỏng lượt sản phẩm");
    assert.match(spNem.error ?? "", /bước nối hỏng giả/, "nhưng câu lỗi phải để lại dấu");

    // Đồng bộ toàn bộ cũng cắm cùng bước nối — không có đường đồng bộ sản phẩm nào để sổ tụt lại.
    const nguonJobs = readFileSync(path.join(process.cwd(), "lib/sync/jobs.ts"), "utf8");
    assert.match(nguonJobs, /"pancake-products":[\s\S]*?syncProducts\(\{[^}]*followUp: modelRegistryFollowUp\(o\.trigger\)/, "pancake-products phải cắm modelRegistryFollowUp");
    assert.equal((nguonJobs.match(/syncPancakeAll\(\{[^}]*productsFollowUp: modelRegistryFollowUp\(o\.trigger\)/g) ?? []).length, 2, "pancake-all và all phải cắm cùng bước nối");

    console.log(
      "✓ Sổ mẫu tự bắt kịp sau đồng bộ sản phẩm: mã mới vào sổ với trạng thái TRỐNG · chạy lại 0 mẫu / 0 sự kiện · mã mơ hồ không nối · trạng thái đã khai giữ nguyên · chạy chồng 1 mẫu 0 lỗi · raced ≠ failed · sổ hỏng ⇒ sản phẩm vẫn SUCCESS + dòng FAILED riêng",
    );
  } finally {
    globalThis.fetch = fetchTruoc;
    for (const [k, v] of [
      ["PANCAKE_API_KEY", envTruoc.key],
      ["PANCAKE_SHOP_ID", envTruoc.shop],
      ["PANCAKE_BASE_URL", envTruoc.base],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
