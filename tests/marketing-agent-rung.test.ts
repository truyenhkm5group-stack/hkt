/**
 * MARKETING AGENT — một nấc «VÀO VIỆC» nữa (marketing-agent-rung, chủ shop duyệt 31/10/2026).
 *
 *  1. KHAI BÁO — nguồn `CREATIVE_APPROVAL` là phép chiếu (SOURCE), phòng MARKETING, chỉ nút MỞ (không duyệt / «xong» trên /work), có
 *     luật hạn + phòng; sổ department-ai: VÀO VIỆC kèm bằng chứng tệp thật, BÀN TAY vẫn PARTIAL (không khai khống).
 *  2. TỔ CHỨC THẬT (PGlite riêng `mkt-si`) — chỉ lượt vẽ còn ảnh `GENERATED` mới thành việc (bỏ lượt tải tay `UPLOAD`); duyệt hết ⇒
 *     việc rời hàng đợi; Mission Control đo người duyệt / bác ảnh AI theo `reviewed_at`, ảnh chưa xét đứng NGOÀI mẫu; chỉ số chính
 *     (đề xuất buồng lái) và nấc tự chủ không đổi; tổ chức nhà không thấy dữ liệu của tổ chức khác.
 */
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { eq, inArray } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { AGENTS } from "@/lib/constants/department-ai";
import { MC_MEASURES } from "@/lib/constants/mission-control";
import { WORK_ACTION } from "@/lib/constants/work-actions";
import { DEFAULT_OWNERSHIP_MAP } from "@/lib/constants/work-ownership";
import { DEFAULT_SLA_MAP, SOURCES_WITHOUT_SLA } from "@/lib/constants/work-sla";
import { ALERT_KINDS_OWNED_ELSEWHERE, WORK_SOURCE_SPEC } from "@/lib/constants/work-sources";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { computeMissionControlForTest } from "@/lib/queries/mission-control";
import { collectWorkItems, duplicateKeys } from "@/lib/queries/work-adapters";

const ORG = "mkt-si";
const DAY = 86_400_000;

async function cleanupOrg() {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, ORG) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  invalidateOrganizations();
  invalidateCapabilities();
  rmSync(organizationDatabaseUrl({ code: ORG, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
}

function testDeclarations() {
  const spec = WORK_SOURCE_SPEC.CREATIVE_APPROVAL;
  assert.deepEqual([spec.statusAuthority, spec.department, spec.businessEntity], ["SOURCE", "MARKETING", "CREATIVE"], "phép chiếu của phòng Marketing");
  assert.ok(spec.actions.every((a) => WORK_ACTION[a].mode === "LINK"), "chỉ nút MỞ — không duyệt / «xong» trên /work (luật 19)");
  assert.ok(!SOURCES_WITHOUT_SLA.includes("CREATIVE_APPROVAL") && "CREATIVE_APPROVAL" in DEFAULT_SLA_MAP, "có luật hạn (cố ý bỏ trống giờ, kèm lý do)");
  assert.equal(DEFAULT_OWNERSHIP_MAP.CREATIVE_APPROVAL?.department, "MARKETING");
  assert.ok(!(ALERT_KINDS_OWNED_ELSEWHERE as string[]).some((k) => /CREATIVE/.test(k)), "không cảnh báo nào trùng độ mịn");

  const mk = AGENTS.MARKETING;
  assert.equal(mk.autonomy, "COPILOT", "không mở AUTO");
  assert.equal(mk.rungs.DISPATCH.status, "BUILT");
  assert.ok(mk.rungs.DISPATCH.what.includes("CREATIVE_APPROVAL"));
  for (const f of mk.rungs.DISPATCH.evidence) assert.ok(existsSync(f), `bằng chứng ${f} phải là tệp thật`);
  assert.equal(mk.rungs.ACT.status, "PARTIAL", "BÀN TAY chỉ lên khi production có lượt ghi Facebook thật — không khai khống");
  assert.equal(MC_MEASURES.MARKETING.review.kind, "OWNER_DECISIONS", "chỉ số chính (tốt nghiệp) vẫn là phản ứng với đề xuất buồng lái");
  assert.deepEqual(MC_MEASURES.MARKETING.extraReviews?.map((x) => x.kind), ["AI_IMAGES"]);
  assert.equal(MC_MEASURES.MARKETING.outcome.kind, "NONE", "tiền sau khi làm theo: chưa đo được, không số gần đúng");
}

export async function testMarketingAgentRung() {
  testDeclarations();
  await cleanupOrg();
  await provisionOrganization({ code: ORG, name: "Shop thử Marketing AI", plan: "standard", modules: ["customers", "products", "orders"], admin: { email: `admin@${ORG}.local`, name: "QT MKT", password: "MktRung@12345" }, source: "TEST", actor: null });
  const genIds: string[] = [];
  try {
    const now = new Date();
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const [img] = await db.insert(schema.creativeImages).values({ sha256: "mkt-test-sha" }).returning({ id: schema.creativeImages.id });
      const gen = (kind: string) => ({ kind, requested: 2, model: kind === "UPLOAD" ? "MANUAL" : "gpt-image-1", size: "1024x1024", quality: "low", idea: `thử ${kind}` });
      const [mock, design, upload] = await db.insert(schema.creativeManualGens).values([gen("MOCKUP"), gen("DESIGN"), gen("UPLOAD")]).returning({ id: schema.creativeManualGens.id });
      genIds.push(mock.id, design.id, upload.id);
      const im = (genId: string, seq: number, status: string, reviewedAgoDays: number | null) => ({
        genId,
        seq,
        genes: {},
        status,
        imageId: img.id,
        drawnAt: new Date(now.getTime() - 60 * 60_000),
        reviewedAt: reviewedAgoDays === null ? null : new Date(now.getTime() - reviewedAgoDays * DAY),
      });
      await db.insert(schema.creativeManualGenImages).values([
        im(mock.id, 1, "GENERATED", null),
        im(mock.id, 2, "GENERATED", null),
        im(mock.id, 3, "APPROVED", 0),
        im(mock.id, 4, "REJECTED", 0),
        im(design.id, 1, "APPROVED", 20),
        // Lượt TẢI TAY: ảnh người tải lên — không phải ảnh AI, không vào việc lẫn chỉ số.
        im(upload.id, 1, "GENERATED", null),
        im(upload.id, 2, "APPROVED", 0),
      ]);

      // ── Nguồn việc: chỉ lượt vẽ AI còn ảnh chờ duyệt ──
      const first = await collectWorkItems({ now, sources: ["CREATIVE_APPROVAL"] });
      assert.deepEqual(first.failed, []);
      assert.deepEqual(duplicateKeys(first.items), []);
      assert.deepEqual(first.items.map((i) => i.businessEntityId), [mock.id], "lượt DESIGN đã duyệt hết, lượt UPLOAD là ảnh tay ⇒ không thành việc");
      const item = first.items[0];
      assert.deepEqual([item.department, item.statusAuthority, item.sourceUrl], ["MARKETING", "SOURCE", "/marketing/creatives?tab=duyet"]);
      assert.ok(item.actions.includes("OPEN_SOURCE") && !item.actions.includes("WORK_STATUS"), `chỉ MỞ + lớp ghi chú chung, không có nút đổi trạng thái: ${item.actions.join(",")}`);
      assert.ok(item.title.startsWith("2 ảnh AI chờ duyệt"), item.title);

      // ── Mission Control: người duyệt / bác ảnh AI theo `reviewed_at`; ảnh chưa xét đứng ngoài mẫu ──
      const mc = await computeMissionControlForTest(now);
      const mk = mc.zones.find((z) => z.zone === "MARKETING")!;
      assert.equal(mk.extra.length, 1);
      assert.deepEqual(mk.extra[0].windows[7], { correct: 1, rejected: 1, sample: 2, pending: 2 }, "7 ngày: 1 duyệt · 1 bác; 2 ảnh chưa xét KHÔNG vào mẫu; ảnh tải tay không tính");
      assert.deepEqual(mk.extra[0].windows[30], { correct: 2, rejected: 1, sample: 3, pending: 2 }, "30 ngày: thêm ảnh duyệt 20 ngày trước");
      assert.equal(mk.autonomy, "COPILOT", "đo thêm không đổi nấc tự chủ");
      assert.equal(mk.outcome, null, "tiền sau khi làm theo: chưa đo được");
      assert.equal(mk.verdict.kind, "NO_RULE");

      // ── Duyệt hết ở miền ⇒ việc rời hàng đợi, không cần nút «xong» ──
      await db.update(schema.creativeManualGenImages).set({ status: "APPROVED", reviewedAt: now }).where(eq(schema.creativeManualGenImages.genId, mock.id));
      const after = await collectWorkItems({ now, sources: ["CREATIVE_APPROVAL"] });
      assert.deepEqual(after.items, [], "người duyệt ở «② Duyệt ảnh» ⇒ việc tự rời hàng đợi");
    });

    // ── Cách ly: CSDL nhà không có lượt vẽ của `mkt-si` ──
    const home = await getDb();
    const leaked = await home.select({ id: schema.creativeManualGens.id }).from(schema.creativeManualGens).where(inArray(schema.creativeManualGens.id, genIds));
    assert.equal(leaked.length, 0);
    const homeItems = await collectWorkItems({ sources: ["CREATIVE_APPROVAL"] });
    assert.ok(!homeItems.items.some((i) => genIds.includes(i.businessEntityId)), "hàng đợi của tổ chức nhà không có việc của tổ chức khác");
  } finally {
    await cleanupOrg();
  }
  console.log("✓ Marketing agent: nguồn CREATIVE_APPROVAL là phép chiếu (MARKETING, chỉ nút MỞ) · chỉ lượt vẽ AI còn ảnh chờ duyệt · duyệt hết ⇒ rời hàng đợi · Mission Control đo duyệt / bác ảnh AI, ảnh chưa xét ngoài mẫu · BÀN TAY vẫn PARTIAL · cách ly tổ chức");
}
