/**
 * NỀN TẢNG · PHASE 1.x — NHẤT QUÁN MODULE GIỮA TRANG TỔNG HỢP / CÔNG CỤ AI, CHẨN ĐOÁN, TỆP HAI TỔ CHỨC.
 *
 *  1. Tầng tổng hợp (phase-2-plan mục 3.3): `/`, `/cockpit`, `/data-quality` không hiện khối / liên kết
 *     của module tắt — MỘT hàm thuần (`lib/platform-ui/module-visibility.ts`). Tổ chức bật mọi module
 *     thấy ĐỦ như trước.
 *  2. Công cụ AI khai module nguồn; module tắt ⇒ không vào danh sách, gọi thẳng ⇒ `MODULE_DISABLED`.
 *  3. Chẩn đoán CLI (`platform:diagnostics`): chế độ CHỈ ĐỌC không migrate, không dọn, không tạo CSDL.
 *  4. Tệp / ảnh trong CSDL: HANDLER route thật trong phiên tổ chức B với id của A ⇒ 404, không một byte;
 *     phiên A ⇒ 200 đúng byte.
 *
 * Tự dọn: tổ chức mang tiền tố `ph-` (thư mục CSDL xoá trước khi cấp, dòng mặt phẳng điều khiển xoá khi xong).
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { eq, like } from "drizzle-orm";
import { SignJWT } from "jose";
import { getDb, getDbFor, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { GET as productionFileGET } from "@/app/api/production/files/[id]/route";
import { GET as creativeImageGET } from "@/app/api/creative/images/[id]/route";
import { GET as ideaImageGET } from "@/app/api/ideas/images/[id]/route";
import { allTools, TOOL_MODULE_DISABLED, ToolModuleDisabledError, toolAccess, toolsFor, type AiToolContext } from "@/lib/ai/tools/registry";
import { getCareCaseTool } from "@/lib/ai/tools/care";
import { searchCustomerTool } from "@/lib/ai/tools/erp";
import { setRequestPathSourceForTests, type SessionUser } from "@/lib/auth/session";
import { OWNER_DECISION_KINDS, OWNER_DECISION_KIND_SPEC, type OwnerDecisionItem } from "@/lib/constants/owner-decisions";
import { isModuleKey, MODULE_KEYS, moduleDef, moduleOfPath, moduleOfPermission, ORG_TEMPLATES, type ModuleKey } from "@/lib/constants/platform-modules";
import { env } from "@/lib/env";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { setSessionTokenSourceForTests, withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { DASHBOARD_BLOCKS, DATA_QUALITY_BLOCKS, dataQualityHrefVisible, hrefVisible, moduleOn, visibleBlocks, type AggregateBlock } from "@/lib/platform-ui/module-visibility";
import { getOwnerDecisionQueue, viewerKinds } from "@/lib/queries/owner-decisions";
import { getPlatformHealth, homeRowProblems, summarizeHealth, type PlatformHealth } from "@/lib/queries/platform-health";

const goc = path.resolve(__dirname, "..");
const FULL: string[] = [...MODULE_KEYS];
const WHOLESALE: string[] = [...ORG_TEMPLATES.wholesale.modules];

function nguoi(modules: string[] | undefined, over: Partial<SessionUser> = {}): SessionUser {
  return { id: "ph-user", email: "ph@local", name: "PH", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, ...(modules ? { modules } : {}), ...over };
}

/* ═════════════ 1 · TRANG TỔNG HỢP ═════════════ */

function testTangTongHop() {
  // Tổ chức bật mọi module (nhà) — MỌI khối hiện, như trước nền tảng.
  const bang: [string, Record<string, AggregateBlock>][] = [
    ["/", DASHBOARD_BLOCKS],
    ["/data-quality", DATA_QUALITY_BLOCKS],
  ];
  for (const [ten, blocks] of bang) {
    const full = visibleBlocks(nguoi(FULL), blocks);
    assert.deepEqual(Object.entries(full).filter(([, v]) => !v).map(([k]) => k), [], `${ten}: tổ chức bật mọi module phải thấy ĐỦ khối`);
    const legacy = visibleBlocks(nguoi(undefined), blocks);
    assert.ok(Object.values(legacy).every(Boolean), `${ten}: người dựng tay không mang modules ⇒ không lọc (hợp đồng như can())`);
    for (const [k, b] of Object.entries(blocks)) {
      assert.ok(b.modules.length > 0 && b.modules.every(isModuleKey), `${ten} · ${k}: module nguồn phải là khoá có trong sổ`);
      assert.ok(b.why.length >= 15, `${ten} · ${k}: khai vì sao`);
    }
  }

  // Tổ chức bán buôn: không Vận chuyển / Hàng hoàn / Quảng cáo / Pancake / Cần xử lý.
  const ws = nguoi(WHOLESALE);
  const dash = visibleBlocks(ws, DASHBOARD_BLOCKS);
  for (const k of ["pancakeSync", "fulfillment", "freshness", "carrierHolding", "adsRatios", "attention", "todayActions"] as const) assert.equal(dash[k], false, `bán buôn không thấy khối ${k}`);
  for (const k of ["bookedRevenue", "deliveredRevenue", "cashReceived", "estimatedProfit", "orderFlow", "channels", "topProducts", "dataIssues", "ownerDecisions"] as const) assert.equal(dash[k], true, `bán buôn vẫn thấy khối ${k}`);
  assert.equal(hrefVisible(ws, "/reports/returns?period=30d"), false, "thẻ ② vẫn hiện nhưng không bấm sang Hàng hoàn (module tắt)");
  assert.equal(hrefVisible(nguoi(FULL), "/reports/returns?period=30d"), true, "nhà: liên kết giữ nguyên");
  const dq = visibleBlocks(ws, DATA_QUALITY_BLOCKS);
  assert.deepEqual(
    Object.entries(dq).filter(([, v]) => !v).map(([k]) => k).sort(),
    ["adsCoverage", "pancake-declared", "return-not-received", "status-conflict", "unlinked-shipment", "vtp-low-cash"].sort(),
    "bán buôn: ẩn đúng các ô của Vận chuyển / Hàng hoàn / Quảng cáo / Pancake",
  );

  // Liên kết: tiền tố dài nhất, query bị bỏ, liên kết ngoài / tuyến công khai luôn hiện.
  assert.equal(hrefVisible(ws, "/inventory"), true);
  assert.equal(hrefVisible(ws, "/inventory/planning"), false, "/inventory/planning thuộc Sản xuất dù /inventory thuộc Kho");
  assert.equal(hrefVisible(ws, "/shipments?view=reconcile"), false);
  assert.equal(hrefVisible(ws, "/login"), true);
  assert.equal(hrefVisible(ws, "https://viettelpost.vn"), true);
  assert.equal(dataQualityHrefVisible(ws, "/data-quality?issue=return-not-received"), false, "ô của Hàng hoàn trên /data-quality — đường dẫn thuộc lõi nhưng danh sách thì không");
  assert.equal(dataQualityHrefVisible(ws, "/data-quality?period=30d&issue=missing-cogs"), true);
  assert.equal(dataQualityHrefVisible(ws, "/data-quality"), true);
  assert.equal(dataQualityHrefVisible(ws, "/cs?view=theo-khach"), false, "liên kết thường đi theo hrefVisible");
  // Mảng RỖNG khác hẳn vắng mặt: hỏng về phía HẸP.
  assert.equal(moduleOn(nguoi([]), "orders"), false);
  assert.equal(hrefVisible(nguoi([]), "/orders"), false);

  // Khai mà không nối vào trang là khai suông: mọi khối của `/` phải được trang đọc.
  const trang = readFileSync(path.join(goc, "app/(dashboard)/page.tsx"), "utf8");
  for (const k of Object.keys(DASHBOARD_BLOCKS)) assert.ok(trang.includes(`show.${k}`), `app/(dashboard)/page.tsx phải dùng show.${k}`);
  const dqTrang = readFileSync(path.join(goc, "app/(dashboard)/data-quality/page.tsx"), "utf8");
  assert.ok(dqTrang.includes("show.summary") && dqTrang.includes("show.adsCoverage") && dqTrang.includes(".filter(([key]) => show[key])"), "/data-quality phải đọc khối theo DATA_QUALITY_BLOCKS");
  // Danh sách con lọc theo liên kết của TỪNG dòng — cùng một hàm, không điều kiện riêng.
  const nguon: [string, string, string][] = [
    ["app/(dashboard)/data-quality/page.tsx", "show[issueParam as DqIssue]", "?issue= trỏ tới ô đang ẩn phải bị bỏ qua (không chạy truy vấn danh sách của module tắt)"],
    ["app/(dashboard)/data-quality/page.tsx", "allDqIssues.filter((i) => canOpen(i.href))", "sổ lỗ hổng lọc theo trang xử lý"],
    ["app/(dashboard)/business-brief.tsx", "all.risks.filter((r) => hrefVisible(viewer, r.href))", "rủi ro lọc theo liên kết"],
    ["app/(dashboard)/top-actions.tsx", "hrefVisible(viewer, c.href", "việc cần làm lọc theo liên kết"],
    ["app/(dashboard)/page.tsx", 'linkable={hrefVisible(user, "/reports/returns")}', "thẻ ② không bấm sang Hàng hoàn khi module tắt"],
  ];
  for (const [tep, can, vi] of nguon) assert.ok(readFileSync(path.join(goc, tep), "utf8").includes(can), `${tep}: ${vi}`);
}

/* ═════════════ 1b · BUỒNG LÁI — LOẠI QUYẾT ĐỊNH THEO MODULE ═════════════ */

async function testBuongLai() {
  const coPhamVi = async () => true;
  const full = await viewerKinds(nguoi(FULL), coPhamVi);
  assert.deepEqual(full, [...OWNER_DECISION_KINDS], "nhà (ADMIN, mọi module): thấy MỌI loại quyết định như trước");
  const ws = await viewerKinds(nguoi(WHOLESALE), coPhamVi);
  for (const k of ws) assert.ok(hrefVisible(nguoi(WHOLESALE), OWNER_DECISION_KIND_SPEC[k].home), `${k}: màn hình chủ thuộc module tắt mà vẫn hiện`);
  assert.ok(!ws.includes("ADS_CUT"), "«Chiến dịch nên CẮT» (/ads) không lọt sang tổ chức không bật Marketing dù expenses:view là khoá dùng chung");
  assert.ok(!ws.includes("SAMPLE_REVIEW") && !ws.includes("MODEL_SCALE"), "loại của Sản xuất không hiện");
  assert.ok(ws.includes("INVENTORY_REORDER"), "loại của Mua hàng vẫn hiện");
  // Có Sản xuất mà không có Marketing: phạm vi quảng cáo được hỏi (vì «Đừng tăng ngân sách» ở /inventory/planning
  // cần nó), nên CHỈ cổng module mới giữ «Chiến dịch nên CẮT» (/ads) ở ngoài.
  const sxKhongQc = await viewerKinds(nguoi([...WHOLESALE, "production"]), coPhamVi);
  assert.ok(sxKhongQc.includes("SCALE_STOCK_RISK"), "loại của Sản xuất hiện khi Sản xuất bật");
  assert.ok(!sxKhongQc.includes("ADS_CUT"), "«Chiến dịch nên CẮT» không hiện khi Marketing tắt, kể cả khi phạm vi quảng cáo đã được hỏi");

  // Dòng có nút hành động dẫn tới module tắt ⇒ không hiện; nguồn của loại bị ẩn KHÔNG được đọc.
  const item = (sourceKey: string, href: string): OwnerDecisionItem => ({ kind: "INVENTORY_REORDER", sourceKey, what: sourceKey, why: "thử", data: [], impact: { amountVnd: null, basis: "thử" }, action: { label: "Mở", href }, modelId: null });
  let docNguonQuangCao = 0;
  const q = await getOwnerDecisionQueue({
    viewer: nguoi(WHOLESALE),
    scopeOk: coPhamVi,
    loaders: {
      INVENTORY: async () => ({ items: [item("ph-mo-duoc", "/inventory/decisions"), item("ph-san-xuat", "/inventory/planning/orders/ph-1")] }),
      ADS_CUT: async () => {
        docNguonQuangCao += 1;
        return { items: [] };
      },
      STOCK_FEEDBACK: async () => ({ items: [] }),
      PRODUCTION_LATE: async () => ({ items: [] }),
      APPROVALS: async () => ({ items: [] }),
    },
  });
  const keys = q.groups.flatMap((g) => g.items.map((i) => i.sourceKey));
  assert.deepEqual(keys, ["ph-mo-duoc"], "dòng mở trang Sản xuất (module tắt) bị lọc");
  assert.equal(docNguonQuangCao, 0, "nguồn của loại bị ẩn theo module KHÔNG được đọc");
}

/* ═════════════ 2 · CÔNG CỤ AI ═════════════ */

/** Tập module chắc chắn bật khi `key` bật (chính nó + đóng dưới phụ thuộc). */
function closure(key: ModuleKey): Set<string> {
  const out = new Set<string>([key]);
  const stack = [key];
  while (stack.length) {
    for (const d of moduleDef(stack.pop()!)?.dependsOn ?? []) {
      if (out.has(d)) continue;
      out.add(d);
      stack.push(d);
    }
  }
  return out;
}

async function testCongCuAi() {
  const tools = allTools();
  assert.ok(tools.length >= 20, `phải thấy các công cụ đã đăng ký — mới thấy ${tools.length}`);
  for (const t of tools) {
    assert.ok(isModuleKey(t.module), `${t.name}: module "${t.module}" không có trong sổ`);
    // Cổng module và cổng quyền không được nói hai điều: module của tool bật ⇒ module sở hữu quyền của nó cũng bật.
    const owner = moduleOfPermission(t.permission);
    assert.ok(owner === null || closure(t.module).has(owner), `${t.name}: quyền ${t.permission} thuộc «${owner}» nằm ngoài «${t.module}» và phụ thuộc của nó`);
  }

  const nha = nguoi(FULL);
  const truoc = tools.filter((t) => t.policy !== "forbidden").map((t) => t.name).sort();
  assert.deepEqual(toolsFor(nha).map((t) => t.name).sort(), truoc, "nhà (ADMIN, mọi module): danh sách công cụ y như trước");

  const ws = nguoi(WHOLESALE);
  const cho = toolsFor(ws).map((t) => t.name);
  for (const t of tools) if (!WHOLESALE.includes(t.module)) assert.ok(!cho.includes(t.name), `${t.name} (module ${t.module}) không được đưa cho model của tổ chức bán buôn`);
  assert.ok(cho.includes("search_customer"), "công cụ của module bật vẫn có");
  assert.ok(!cho.includes("get_care_case") && !cho.includes("get_inventory_risks"), "công cụ Vận chuyển / Sản xuất không có");
  assert.match(toolAccess(ws, getCareCaseTool).reason, new RegExp(`^${TOOL_MODULE_DISABLED}`), "UI nói đúng lý do");

  const ctx = (user: SessionUser): AiToolContext => ({ user, actor: { id: user.id, email: user.email, source: "AI" }, route: "/", entityType: "none", entityId: "", now: new Date() });
  // Gọi thẳng `run` (không qua danh sách) — cổng nằm ở chính run.
  await assert.rejects(
    () => getCareCaseTool.run(ctx(ws), { shipmentId: "ph-khong-co" } as never),
    (e: unknown) => e instanceof ToolModuleDisabledError && e.code === "MODULE_DISABLED" && e.module === "logistics",
    "module tắt ⇒ run từ chối MODULE_DISABLED trước khi chạm dữ liệu",
  );
  const r = await searchCustomerTool.run(ctx(nha), { query: "ph-khong-co-ai" });
  assert.ok(r && typeof r === "object" && "hits" in r, "module bật ⇒ run chạy bình thường");
}

/* ═════════════ 3 · CHẨN ĐOÁN ═════════════ */

function testChanDoanThuan() {
  assert.deepEqual(homeRowProblems([{ id: "x", code: "vnx", isHome: true }, { id: "y", code: "b", isHome: false }]), []);
  assert.equal(homeRowProblems([{ id: "x", code: "a", isHome: true }, { id: "y", code: "b", isHome: true }]).length, 1, "hai dòng nhà là vấn đề");
  assert.equal(homeRowProblems([{ id: "org-home", code: "home", isHome: true }]).length, 1, "chỉ có bản dựng sẵn ⇒ sổ không có dòng nhà");
  assert.equal(homeRowProblems([]).length, 1);

  const base: PlatformHealth = { checkedAt: "2026-09-27T00:00:00Z", migrationsExpected: 10, journalNote: null, registryProblems: [], organizations: [] };
  const org = { code: "x", name: "X", status: "ACTIVE" as const, isHome: false, templateKey: null, moduleDefault: "DISABLED" as const, enabledModules: 3, totalModules: 23, dependencyErrors: [], unknownModuleKeys: [], connected: true, connectNote: null, migrationsApplied: 10, migrationsExpected: 10, migrationsNote: null, platformTables: [{ table: "platform_audit_log", rows: 0 }], platformTablesNote: null, problems: [] };
  assert.equal(summarizeHealth({ ...base, organizations: [org] }).exitCode, 0, "đo đủ và sạch ⇒ 0");
  const chuaDo = summarizeHealth({ ...base, organizations: [{ ...org, connected: null, connectNote: "chưa đọc được", migrationsApplied: null }] });
  assert.equal(chuaDo.exitCode, 2, "không vấn đề nhưng còn chỗ chưa đo ⇒ 2, KHÔNG phải 0");
  assert.equal(chuaDo.rows[0].connection, "—", "chưa đo in —, không in ✓");
  assert.equal(summarizeHealth({ ...base, registryProblems: ["hai dòng nhà"], organizations: [org] }).exitCode, 1, "vấn đề mức sổ ⇒ 1");
  const ban = summarizeHealth({ ...base, organizations: [{ ...org, platformTables: [{ table: "platform_audit_log", rows: 2 }], problems: ["bảng có dòng"] }] });
  assert.equal(ban.exitCode, 1);
  assert.match(ban.rows[0].platformTables, /CÓ DÒNG: platform_audit_log=2/);
}

/* ═════════════ HAI TỔ CHỨC THẬT ═════════════ */

const A = "ph-alpha";
const B = "ph-beta";
const GHOST = "ph-ghost";
const MODULES: ModuleKey[] = ["customers", "products", "orders", "inventory", "production", "marketing"];

function dirOf(code: string) {
  return organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, "");
}

async function cleanupOrg(code: string) {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  invalidateOrganizations();
  invalidateCapabilities();
}

async function tokenOf(org: string, email: string): Promise<string> {
  const user = await withOrganization(org, async () => (await getDb()).query.users.findFirst({ where: eq(schema.users.email, email) }));
  assert.ok(user, `quản trị của ${org} có trong CSDL của ${org}`);
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email, name: "Quản trị", role: "ADMIN", org, lgn: now })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt(now)
    .setExpirationTime(now + 600)
    .sign(new TextEncoder().encode(env.authSecret));
}

async function asRequest<T>(token: string, reqPath: string, fn: () => Promise<T>): Promise<T> {
  setSessionTokenSourceForTests(async () => token);
  setRequestPathSourceForTests(() => reqPath);
  try {
    return await fn();
  } finally {
    setSessionTokenSourceForTests(null);
    setRequestPathSourceForTests(null);
  }
}

type Seeded = { fileId: string; fileBytes: Buffer; creativeId: string; creativeBytes: Buffer; ideaImageId: string; ideaBytes: Buffer };

/** Tệp đính kèm topic + ảnh vòng mẫu + ảnh ý tưởng — đúng ba bảng mà ba route đọc. */
async function seedFiles(org: string): Promise<Seeded> {
  return withOrganization(org, async () => {
    const db = await getDb();
    const fileBytes = Buffer.from(`TEP-MAT-CUA-${org}-`.repeat(8));
    const creativeBytes = Buffer.from(`ANH-VONG-MAU-${org}`);
    const ideaBytes = Buffer.from(`ANH-Y-TUONG-${org}`);
    const [model] = await db.insert(schema.productModels).values({ code: `${org.toUpperCase()}-M1`, name: `Mẫu ${org}`, registeredBy: "USER" }).returning({ id: schema.productModels.id });
    const [topic] = await db.insert(schema.productionTopics).values({ modelId: model.id, title: `Topic ${org}`, evidenceSnapshot: { kind: "SNAPSHOT" } }).returning({ id: schema.productionTopics.id });
    const [file] = await db
      .insert(schema.productionTopicFiles)
      .values({ topicId: topic.id, kind: "IMAGE", fileName: `${org}.jpg`, contentType: "image/jpeg", bytes: fileBytes.length, chunkCount: 1, status: "READY", completedAt: new Date() })
      .returning({ id: schema.productionTopicFiles.id });
    await db.insert(schema.productionTopicFileChunks).values({ fileId: file.id, seq: 0, data: fileBytes });
    const [img] = await db.insert(schema.creativeImages).values({ sha256: `ph-${org}`, contentType: "image/png", bytes: creativeBytes.length, data: creativeBytes.toString("base64") }).returning({ id: schema.creativeImages.id });
    const [idea] = await db.insert(schema.marketingIdeas).values({ ideaDate: "2026-09-27", content: `Ý tưởng ${org}` }).returning({ id: schema.marketingIdeas.id });
    const [ideaImg] = await db.insert(schema.marketingIdeaImages).values({ ideaId: idea.id, contentType: "image/png", bytes: ideaBytes.length, data: ideaBytes.toString("base64") }).returning({ id: schema.marketingIdeaImages.id });
    return { fileId: file.id, fileBytes, creativeId: img.id, creativeBytes, ideaImageId: ideaImg.id, ideaBytes };
  });
}

async function body(res: Response): Promise<Buffer> {
  return Buffer.from(await res.arrayBuffer());
}

async function testTepHaiToChuc(tokenA: string, tokenB: string, a: Seeded, b: Seeded) {
  const routes = [
    { ten: "tệp topic sản xuất", reqPath: (id: string) => `/api/production/files/${id}`, handler: productionFileGET, idOf: (s: Seeded) => s.fileId, bytesOf: (s: Seeded) => s.fileBytes },
    { ten: "ảnh vòng mẫu", reqPath: (id: string) => `/api/creative/images/${id}`, handler: creativeImageGET, idOf: (s: Seeded) => s.creativeId, bytesOf: (s: Seeded) => s.creativeBytes },
    { ten: "ảnh ý tưởng", reqPath: (id: string) => `/api/ideas/images/${id}`, handler: ideaImageGET, idOf: (s: Seeded) => s.ideaImageId, bytesOf: (s: Seeded) => s.ideaBytes },
  ];
  for (const r of routes) {
    const id = r.idOf(a);
    const call = (token: string) => asRequest(token, r.reqPath(id), () => r.handler(new Request(`http://erp.local${r.reqPath(id)}`), { params: Promise.resolve({ id }) }));
    const cuaA = await call(tokenA);
    assert.equal(cuaA.status, 200, `${r.ten}: phiên A mở id của A ⇒ 200`);
    assert.ok((await body(cuaA)).equals(r.bytesOf(a)), `${r.ten}: phiên A nhận đúng byte của A`);
    const cuaB = await call(tokenB);
    assert.equal(cuaB.status, 404, `${r.ten}: phiên B mở id của A ⇒ 404`);
    const lo = await body(cuaB);
    assert.ok(!lo.includes(r.bytesOf(a)) && !lo.includes(r.bytesOf(b)), `${r.ten}: phản hồi 404 không mang byte nào của tệp`);
    assert.ok(!cuaB.headers.get("content-type")?.startsWith("image/"), `${r.ten}: 404 không khai kiểu ảnh`);
  }
}

async function testChanDoanThat() {
  const pdb = await getPlatformDb();
  // Tổ chức có trong sổ mà KHÔNG có CSDL — chế độ chỉ đọc phải báo, và KHÔNG được tạo thư mục.
  rmSync(dirOf(GHOST), { recursive: true, force: true });
  await pdb.insert(schema.platformOrganizations).values({ code: GHOST, name: "Tổ chức ma", status: "ACTIVE", isHome: false, moduleDefault: "DISABLED" });
  invalidateOrganizations();
  try {
    // Một dòng lọt vào bản sao mặt phẳng điều khiển của A: chế độ chỉ đọc phải THẤY nó (không dọn trước khi đếm).
    const orgA = { code: A, isHome: false };
    const odb = await getDbFor(orgA);
    await odb.insert(schema.platformAuditLog).values({ targetOrgCode: A, action: "FLAG_SET", subject: "ph-probe", source: "TEST" });
    const health = await getPlatformHealth({ mode: "READ_ONLY" });
    assert.deepEqual(health.registryProblems, [], "sổ tổ chức của bộ kiểm thử có đúng một dòng nhà");
    const ghost = health.organizations.find((o) => o.code === GHOST);
    assert.ok(ghost);
    assert.equal(ghost.connected, false, "tổ chức không có CSDL ⇒ KHÔNG mở được");
    assert.match(ghost.problems.join(" "), /không tồn tại/);
    assert.equal(existsSync(dirOf(GHOST)), false, "chẩn đoán chỉ đọc KHÔNG tạo CSDL cho tổ chức ma");
    const a = health.organizations.find((o) => o.code === A);
    assert.ok(a);
    assert.equal(a.connected, true);
    assert.equal(a.migrationsApplied, a.migrationsExpected, "migration x/y đủ");
    assert.ok(a.problems.some((p) => p.includes("platform_audit_log")), "dòng lọt vào platform_audit_log của A bị phát hiện, không bị dọn mất");
    const s = summarizeHealth(health);
    assert.equal(s.exitCode, 1, "có vấn đề ⇒ mã thoát 1");
    assert.ok(s.rows.some((r) => r.code === A && r.platformTables.startsWith("CÓ DÒNG")));
    await odb.delete(schema.platformAuditLog).where(eq(schema.platformAuditLog.subject, "ph-probe"));
    const again = (await getPlatformHealth({ mode: "READ_ONLY" })).organizations.find((o) => o.code === A);
    assert.deepEqual(again?.problems, [], "dọn xong ⇒ A sạch");
  } finally {
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.code, GHOST));
    invalidateOrganizations();
  }
}

export async function testPlatformHardening() {
  testTangTongHop();
  await testBuongLai();
  await testCongCuAi();
  testChanDoanThuan();

  for (const code of [A, B]) {
    await cleanupOrg(code);
    rmSync(dirOf(code), { recursive: true, force: true });
  }
  let failure: unknown = null;
  try {
    await provisionOrganization({ code: A, name: "Tổ chức PH-A", modules: MODULES, admin: { email: `admin@${A}.local`, name: "QT A", password: "PhAlpha@12345" }, source: "TEST", actor: null });
    await provisionOrganization({ code: B, name: "Tổ chức PH-B", modules: MODULES, admin: { email: `admin@${B}.local`, name: "QT B", password: "PhBeta@12345" }, source: "TEST", actor: null });
    const a = await seedFiles(A);
    const b = await seedFiles(B);
    await testTepHaiToChuc(await tokenOf(A, `admin@${A}.local`), await tokenOf(B, `admin@${B}.local`), a, b);
    await testChanDoanThat();
  } catch (error) {
    failure = error;
  }
  try {
    setSessionTokenSourceForTests(null);
    setRequestPathSourceForTests(null);
    const pdb = await getPlatformDb();
    await pdb.delete(schema.platformOrganizations).where(like(schema.platformOrganizations.code, `${GHOST}%`));
    for (const code of [A, B]) await cleanupOrg(code);
  } catch (cleanupError) {
    if (!failure) throw cleanupError;
    console.error("[platform-hardening] dọn dẹp cũng lỗi (lỗi chính ở dưới):", cleanupError);
  }
  if (failure) throw failure;
  assert.equal(moduleOfPath("/api/production/files/x"), "production", "tiền đề: route tệp thuộc Sản xuất");
  console.log("✓ Nền tảng · 1.x: trang tổng hợp / buồng lái / công cụ AI theo module (nhà thấy đủ như trước) · chẩn đoán chỉ đọc không migrate, không dọn, không tạo CSDL · tệp & ảnh: phiên B mở id của A ⇒ 404 không một byte, phiên A ⇒ 200");
}

