/**
 * ═══════════ DIỄN TẬP KHÔI PHỤC MỘT TỔ CHỨC — POSTGRES THẬT, pg_dump THẬT (launch-gates C) ═══════════
 *
 * Chạy — CHỈ trên một máy Postgres DÙNG MỘT LẦN (service container của GitHub Actions, hoặc một cụm `initdb` tạm):
 *
 *   ERP_RESTORE_DRILL_EPHEMERAL=1 DATABASE_URL=postgres://erp:<mk>@localhost:5432/erp \
 *     [ERP_DRILL_PG_CONTAINER=<id container>] [ERP_DRILL_PG_BIN=<thư mục pg_dump>] \
 *     npx tsx --tsconfig tsconfig.json scripts/restore-drill-pg.ts [--ma=drill-ws] [--bao-cao=<tệp.json>] [--giu]
 *
 *   ERP_DRILL_PG_CONTAINER  có ⇒ createdb / pg_dump / pg_restore chạy BÊN TRONG container bằng `docker exec -i` — ĐÚNG
 *                           cách `erp-backup.sh` gọi `docker exec erp-db pg_dump …` trên VPS (và đúng phiên bản công
 *                           cụ của máy chủ). Không có ⇒ gọi công cụ trên máy (PATH hoặc ERP_DRILL_PG_BIN), PGHOST /
 *                           PGPORT / PGPASSWORD dẫn từ DATABASE_URL.
 *
 * Bảy bước, ba tiến trình ứng dụng tách rời (mất CSDL phải là mất thật — `db/index.ts` đệm handle theo mã tổ chức):
 *
 *   1. NGUỒN (tiến trình con)  migrate CSDL nhà → `provisionOrganization` (Postgres: CREATE DATABASE erp_org_drill_ws)
 *      → cài mẫu `wholesale` → tuỳ biến CÓ Ý NGHĨA qua đúng hàm dịch vụ của màn hình: đối tượng + field + giá trị + quan
 *      hệ một/nhiều + tệp, form / danh sách / trạng thái xuất bản, trang xuất bản + menu, luật BẬT + một lượt chạy + lời
 *      duyệt, vai trò + người dùng, module bật / tắt, thương hiệu, kết nối Lark + khoá AI mang bí mật (mã hoá bằng khoá
 *      GIẢ sinh trong bộ nhớ của lượt chạy) → xuất blueprint.
 *   2. ẢNH "TRƯỚC" (điều phối)  đếm + băm từng bảng `public` / `drizzle` + sequence của CSDL tổ chức; dòng mặt phẳng
 *      điều khiển của tổ chức ở CSDL nhà.
 *   3. SAO LƯU  `pg_dump -U erp -d erp_org_drill_ws -Fc` (đúng lệnh của erp-backup.sh) + `pg_restore --list` kiểm mục lục
 *      (đúng phép kiểm của script). Đo thời gian + kích thước.
 *   4. PHÁ  tạm ngừng tổ chức (SUSPENDED) → sửa / xoá dữ liệu → ảnh "đã phá" (phải KHÁC "trước") → DROP DATABASE.
 *   5. KHÔI PHỤC theo runbook docs/backup-restore.md mục 7: createdb tam_khoiphuc_drill_ws → pg_restore --no-owner
 *      --no-privileges → đối chiếu số dòng → đổi tên tạm ⇒ erp_org_drill_ws → mở lại (ACTIVE). Đo RTO.
 *   6. SO  ảnh "sau" = "trước" từng bảng; mặt phẳng điều khiển = trước; VÀ CHẠY THẬT (tiến trình con thứ hai, mã ứng
 *      dụng trong `withOrganization`): blueprint xuất lại cùng băm · đọc bản ghi + quan hệ + tệp · `resolvePage` 0 lỗi
 *      khối · `runWorkflows` không nhân đôi lượt đã chạy, bản ghi mới vẫn sinh lượt xin duyệt · CÙNG khoá giải đúng bí
 *      mật, khoá KHÁC bị từ chối (fail closed) · `verifyLogin` đăng nhập được, sai mật khẩu thì không.
 *   7. BÁO CÁO  dòng `[drill]` + tệp JSON (không bí mật, không dữ liệu) — `judgePgRestoreDrill` quyết; thoát 0 = ĐẠT,
 *      1 = KHÔNG ĐẠT, 2 = dùng sai / môi trường không phải máy tạm.
 *
 * HÀNG RÀO (lib/platform/restore-drill-pg.ts, có bài kiểm): mã tổ chức phải mang tiền tố `drill-`; DATABASE_URL phải
 * trỏ localhost, CSDL nhà `erp` CHƯA CÓ BẢNG NÀO và máy chưa có `erp_org_*` nào khác; phải khai ERP_RESTORE_DRILL_EPHEMERAL=1;
 * lệnh DROP chỉ nhận đúng hai tên của lượt. Không đọc `.env`. Chạy lại ⇒ một máy Postgres MỚI (service container mới).
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import {
  DEFAULT_DRILL_ORG_CODE,
  DRILL_EPHEMERAL_ACK_ENV,
  DRILL_ORG_CODE_PATTERN,
  assertDropAllowed,
  createdbArgs,
  diffSnapshots,
  drillNames,
  dumpArgs,
  judgeDrillEnvironment,
  judgePgRestoreDrill,
  listArgs,
  missingCoreTables,
  restoreArgs,
  type AppEvidence,
  type DbSnapshot,
  type DrillNames,
  type PgDrillEvidence,
} from "@/lib/platform/restore-drill-pg";

const args = process.argv.slice(2);
const argVal = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const flag = (name: string) => args.includes(`--${name}`);

const WORK_PREFIX = "restore-drill-pg-";
const MAT_KHAU_QT = "DienTapPg@2468";
const MAT_KHAU_NV = "NhanVienSi@1357";
const TEN_KHACH = "Đại lý Minh Phát (diễn tập)";
const TEN_THUONG_HIEU = "Phân phối Diễn Tập";
const TEP_PDF = Buffer.from("%PDF-1.4 hop dong dai ly dien tap khoi phuc\n%%EOF\n", "utf8");

const log = (s: string) => console.log(`[drill] ${s}`);
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

// ═══════════════════════════════ MÔI TRƯỜNG ═══════════════════════════════

type Target = { url: URL; host: string; database: string };

function target(): Target {
  const raw = (process.env.DATABASE_URL || "").trim();
  if (!/^postgres(ql)?:\/\//.test(raw)) {
    console.error("[drill] DATABASE_URL phải là chuỗi postgres:// tới máy Postgres TẠM (không đọc .env).");
    process.exit(2);
  }
  const url = new URL(raw);
  return { url, host: url.hostname, database: decodeURIComponent(url.pathname.replace(/^\//, "")) };
}

function urlFor(t: Target, database: string): string {
  const u = new URL(t.url.toString());
  u.pathname = `/${database}`;
  u.search = "";
  return u.toString();
}

async function withClient<T>(connectionString: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString });
  await c.connect();
  try {
    await c.query("set timezone = 'UTC'");
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Tiến trình con chỉ chạy dưới điều phối (thư mục làm việc + mã diễn tập + lời khẳng định máy tạm). */
function kiemMoiTruongCon(): { workDir: string; names: DrillNames } {
  const workDir = process.env.ERP_RESTORE_DRILL_PG_WORK ?? "";
  const code = process.env.ERP_RESTORE_DRILL_PG_CODE ?? "";
  const t = target();
  if (!workDir || !path.basename(workDir).startsWith(WORK_PREFIX) || !DRILL_ORG_CODE_PATTERN.test(code) || process.env[DRILL_EPHEMERAL_ACK_ENV] !== "1" || !["localhost", "127.0.0.1", "::1"].includes(t.host)) {
    console.error("[drill] Bước con chỉ chạy dưới điều phối của scripts/restore-drill-pg.ts — từ chối.");
    process.exit(2);
  }
  return { workDir, names: drillNames(code) };
}

/** Bí mật GIẢ của lượt chạy — sinh ở điều phối, đi qua môi trường của tiến trình con, không bao giờ ghi ra đĩa / log. */
function biMat() {
  const lark = process.env.ERP_RESTORE_DRILL_PG_LARK ?? "";
  const ai = process.env.ERP_RESTORE_DRILL_PG_AI ?? "";
  if (!lark || !ai) throw new Error("Thiếu bí mật giả của lượt diễn tập.");
  return { larkUrl: `https://open.larksuite.com/open-apis/bot/v2/hook/${lark}`, larkSign: `ky-${lark}`, aiKey: `sk-ant-${ai}` };
}

// ═══════════════════════════════ DÙNG CHUNG CHO HAI BƯỚC CON ═══════════════════════════════

async function nap(code: string) {
  const [dbm, migrate, context, caps] = await Promise.all([import("@/db"), import("@/db/migrate"), import("@/lib/platform/context"), import("@/lib/platform/capabilities")]);
  const { eq } = await import("drizzle-orm");
  const { MODULE_KEYS } = await import("@/lib/constants/platform-modules");
  type SessionUser = import("@/lib/auth/session").SessionUser;

  const nguoi = async (email: string, role: SessionUser["role"]): Promise<SessionUser> => {
    const db = await dbm.getDb();
    const row = await db.query.users.findFirst({ where: eq(dbm.schema.users.email, email) });
    if (!row) throw new Error(`Thiếu tài khoản ${email}.`);
    caps.invalidateCapabilities();
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      role,
      permissions: [],
      scope: "ALL",
      departmentCodes: [],
      positionId: null,
      organization: { code, name: code, isHome: false },
      modules: [...(await caps.getEnabledModules(code))].filter((m) => (MODULE_KEYS as readonly string[]).includes(m)),
    };
  };
  const quanTri = () => nguoi(`admin@${code}.local`, "ADMIN");
  return { dbm, migrate, context, quanTri, eq };
}

type NguonOut = {
  ids: { hdLon: string; hdNho: string; dg1: string; dg2: string; customer: string; file: string };
  blueprintContentHash: string;
  pagesBefore: { slug: string; blocks: number; errors: string[] }[];
  runs: { waitingFirst: number; executedAfterApproval: number };
  roleUserEmail: string;
};

const TRANG = ["cong-no-khach-hang", "hop-dong-dai-ly"] as const;

async function phanGiaiTrang(user: import("@/lib/auth/session").SessionUser) {
  const { getPageBySlug } = await import("@/lib/pages/registry");
  const { resolvePage } = await import("@/lib/pages/data-sources");
  const out: { slug: string; blocks: number; errors: string[] }[] = [];
  for (const slug of TRANG) {
    const p = await getPageBySlug(slug);
    if (!p) {
      out.push({ slug, blocks: 0, errors: [`${slug}: trang không tồn tại / chưa xuất bản`] });
      continue;
    }
    const r = await resolvePage(p.schema, user, { searchParams: {}, period: "30d" }, slug);
    const blocks = r.sections.flatMap((s) => s.blocks);
    out.push({ slug, blocks: blocks.length, errors: blocks.filter((b) => !b.ok).map((b) => `${slug}/${b.block.id}: ${b.ok ? "" : `${b.issue.code} ${b.issue.message}`}`) });
  }
  return out;
}

function phai(r: unknown, viec: string): void {
  if (r && typeof r === "object") {
    if ("ok" in r && (r as { ok: unknown }).ok === false) throw new Error(`${viec} thất bại: ${JSON.stringify(r).slice(0, 500)}`);
    if ("error" in r) throw new Error(`${viec} thất bại: ${JSON.stringify(r).slice(0, 500)}`);
  }
}

function idOf(r: unknown, viec: string): string {
  phai(r, viec);
  const id = r && typeof r === "object" && "id" in r ? (r as { id: unknown }).id : null;
  if (typeof id !== "string") throw new Error(`${viec}: không có id.`);
  return id;
}

type FakeFetch = { calls: string[]; fetch: (url: string, init: RequestInit) => Promise<Response> };
function fetchGia(body: unknown): FakeFetch {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (url) => {
      calls.push(url);
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    },
  };
}

// ═══════════════════════════════ BƯỚC CON 1 · NGUỒN ═══════════════════════════════

async function buocNguon() {
  const { workDir, names } = kiemMoiTruongCon();
  const code = names.orgCode;
  const bm = biMat();
  const { dbm, migrate, context, quanTri, eq } = await nap(code);
  const { provisionOrganization } = await import("@/lib/platform/provision");
  const { WHOLESALE_BLUEPRINT } = await import("@/lib/blueprints/templates/wholesale");
  const { installBlueprint } = await import("@/lib/blueprints/install");
  const { exportOrgBlueprint } = await import("@/lib/blueprints/export");
  const { toggleOwnModule } = await import("@/lib/platform-ui/module-toggle");
  const { actorOf } = await import("@/lib/platform-ui/metadata-admin");
  const { createObject } = await import("@/lib/objects/objects");
  const { createRecord } = await import("@/lib/objects/records");
  const { createCustomField } = await import("@/lib/metadata/fields");
  const { saveCustomFile, saveCustomValues } = await import("@/lib/metadata/values");
  const { getFormDraft, publishForm, saveFormDraft } = await import("@/lib/metadata/forms");
  const { getListViewDraft, publishListView, saveListViewDraft } = await import("@/lib/metadata/lists");
  const { saveStatusOverrides } = await import("@/lib/metadata/statuses");
  const { createPage, publishPage } = await import("@/lib/pages/registry");
  const { saveRule, setRuleMode, setRuleStatus } = await import("@/lib/workflow/rules");
  const { runWorkflows } = await import("@/lib/workflow/engine");
  const { decideApprovalCore } = await import("@/lib/approvals/service");
  const { saveAccessRoleCore } = await import("@/lib/auth/access-roles");
  const { hashPassword } = await import("@/lib/auth/password");
  const { saveBrandingCore } = await import("@/lib/branding/service");
  const { saveConnection, setConnectionStatus, testOrgConnection } = await import("@/lib/connectors/service");
  type PageSchema = import("@/lib/pages/types").PageSchema;
  type FormSchema = import("@/lib/metadata/types").FormSchema;

  await migrate.ensureMigrated();
  await provisionOrganization({ code, name: `Tổ chức diễn tập ${code}`, modules: [], admin: { email: `admin@${code}.local`, name: `QT ${code}`, password: MAT_KHAU_QT }, source: "SCRIPT", actor: null });
  log(`1/7 NGUỒN: đã cấp tổ chức «${code}» — CSDL ${names.orgDatabase}`);

  const out = await context.withOrganization(code, async (): Promise<NguonOut> => {
    let admin = await quanTri();
    const inst = await installBlueprint(WHOLESALE_BLUEPRINT, admin);
    if (!inst.ok) throw new Error(`Cài mẫu wholesale thất bại: ${JSON.stringify(inst.errors).slice(0, 400)}`);
    admin = await quanTri();
    for (const [moduleKey, enabled] of [["apps", true], ["alerts", true], ["purchasing", false]] as const) {
      phai(await toggleOwnModule(admin, { moduleKey, enabled, reason: "diễn tập khôi phục Postgres" }), `${enabled ? "Bật" : "Tắt"} module ${moduleKey}`);
    }
    admin = await quanTri();
    const actor = actorOf(admin);

    // ── Đối tượng tuỳ biến + field (kể cả trên đối tượng hệ thống của mẫu) ──
    phai(await createObject(admin, { key: "x_diem_giao", label: "Điểm giao hàng", labelPlural: "Điểm giao hàng", icon: "box" }), "Đối tượng Điểm giao");
    phai(await createObject(admin, { key: "x_hop_dong_si", label: "Hợp đồng đại lý", labelPlural: "Hợp đồng đại lý", icon: "file-text", titleLabel: "Số hợp đồng" }), "Đối tượng Hợp đồng");
    const field = async (objectKey: string, input: Record<string, unknown>) => phai(await createCustomField(objectKey, input, actor), `Field ${objectKey}.${String(input.key)}`);
    await field("x_diem_giao", { key: "dia_chi", label: "Địa chỉ", type: "text" });
    await field("x_hop_dong_si", { key: "khach", label: "Đại lý", type: "relation", relationObject: "customer", filterable: true });
    await field("x_hop_dong_si", { key: "gia_tri", label: "Giá trị", type: "currency", required: true, filterable: true });
    await field("x_hop_dong_si", {
      key: "trang_thai",
      label: "Trạng thái",
      type: "status",
      filterable: true,
      options: [{ value: "nhap", label: "Nháp" }, { value: "hieu_luc", label: "Hiệu lực" }, { value: "het_han", label: "Hết hạn" }],
      transitions: { nhap: ["hieu_luc"], hieu_luc: ["het_han"] },
    });
    await field("x_hop_dong_si", { key: "diem_giao_chinh", label: "Điểm giao chính", type: "relation", relationObject: "x_diem_giao" });
    await field("x_hop_dong_si", { key: "cac_diem_giao", label: "Các điểm giao", type: "relation_many", relationObject: "x_diem_giao" });
    await field("x_hop_dong_si", { key: "tai_lieu", label: "Bản hợp đồng", type: "file" });

    // ── Form + danh sách + trạng thái XUẤT BẢN ──
    const form = await getFormDraft("x_hop_dong_si", "create");
    const coDiem: FormSchema = { ...form, sections: form.sections.map((sec) => ({ ...sec, fields: sec.fields.map((f) => (f.ref === "custom:diem_giao_chinh" ? { ...f, required: true } : f)) })) };
    phai(await saveFormDraft("x_hop_dong_si", "create", coDiem, actor), "Sửa form tạo hợp đồng");
    phai(await publishForm("x_hop_dong_si", "create", actor), "Xuất bản form tạo hợp đồng");
    const list = await getListViewDraft("x_hop_dong_si", "default");
    phai(await saveListViewDraft("x_hop_dong_si", "default", { ...list, columns: list.columns.map((c) => (c.ref === "custom:tai_lieu" ? { ...c, visible: false } : c)) }, actor), "Sửa danh sách hợp đồng");
    phai(await publishListView("x_hop_dong_si", "default", actor), "Xuất bản danh sách hợp đồng");
    phai(await saveStatusOverrides("order", "stage", [{ value: "NEW", label: "Đơn sỉ mới", position: 0, active: true }], actor), "Đổi nhãn trạng thái đơn");

    // ── Trang tay xuất bản + menu ──
    const trang: PageSchema = {
      version: 1,
      sections: [
        {
          key: "hop_dong",
          title: "Hợp đồng đại lý",
          blocks: [
            { id: "hd_dem", type: "kpi", span: 4, title: "Số hợp đồng", config: { aggregate: { objectKey: "x_hop_dong_si", fn: "count" } } },
            { id: "hd_tong", type: "kpi", span: 4, title: "Tổng giá trị", config: { aggregate: { objectKey: "x_hop_dong_si", fn: "sum", field: "custom:gia_tri" } } },
            { id: "gioi_thieu", type: "text", span: 4, config: { heading: "Hợp đồng đại lý", body: "Trang dựng tay trong lượt diễn tập khôi phục Postgres." } },
            { id: "bang_hd", type: "table", span: 12, title: "Hợp đồng", config: { source: "x_hop_dong_si", columns: ["system:title", "custom:khach", "custom:gia_tri", "custom:trang_thai"], pageSize: 20, rowLink: true } },
            { id: "kanban_hd", type: "kanban", span: 12, title: "Theo trạng thái", config: { objectKey: "x_hop_dong_si", statusField: "custom:trang_thai", cardFields: ["custom:gia_tri"], allowMove: true } },
          ],
        },
      ],
    };
    const tay = await createPage({ slug: "hop-dong-dai-ly", name: "Hợp đồng đại lý", moduleKey: "apps", nav: { enabled: true, label: "Hợp đồng đại lý", zone: null, order: 20 }, draft: trang }, actor);
    phai(tay, "Tạo trang tay");
    if (!tay.ok) throw new Error("Tạo trang tay thất bại.");
    phai(await publishPage(tay.page.id, actor), "Xuất bản trang tay");

    // ── Luật: hợp đồng ≥ 50 triệu ⇒ cửa DUYỆT ⇒ tạo việc; BẬT + LIVE ──
    const rule = await saveRule(
      {
        key: "hop_dong_lon_duyet",
        name: "Hợp đồng đại lý lớn ⇒ trưởng phòng duyệt ⇒ việc cho Kinh doanh",
        trigger: { kind: "event", event: "custom_record.created", objectKey: "x_hop_dong_si" },
        conditions: { all: [{ field: "custom:gia_tri", op: "gte", value: 50_000_000 }] },
        actions: [{ kind: "create_task", title: "Chuẩn bị hàng cho hợp đồng đại lý lớn", departmentCode: "SALES", priority: "HIGH", dueInHours: 48 }],
        gate: { kind: "approval", reason: "Trưởng phòng duyệt hợp đồng đại lý từ 50 triệu" },
      },
      actor,
    );
    phai(rule, "Luật duyệt hợp đồng");
    if (!rule.ok) throw new Error("Luật thất bại.");
    phai(await setRuleStatus(rule.rule.id, "ACTIVE", actor), "Bật luật");
    phai(await setRuleMode(rule.rule.id, "LIVE", actor), "Chạy thật luật");

    // ── Vai trò + người dùng gán vai trò ──
    phai(await saveAccessRoleCore(admin, { id: "", code: "KD_SI", name: "Kinh doanh sỉ", description: "Xem khách và hợp đồng đại lý", baseRole: "VIEWER", permissions: ["customers:view", "records:view"], defaultScope: "ALL", active: true }), "Vai trò tuỳ chỉnh");
    const db = await dbm.getDb();
    const [vaiTro] = await db.select().from(dbm.schema.accessRoles).where(eq(dbm.schema.accessRoles.code, "KD_SI"));
    if (!vaiTro) throw new Error("Không đọc lại được vai trò KD_SI.");
    const roleUserEmail = `nv.si@${code}.local`;
    await db.insert(dbm.schema.users).values({ email: roleUserEmail, name: "NV kinh doanh sỉ", passwordHash: await hashPassword(MAT_KHAU_NV), role: "VIEWER", accessRoleId: vaiTro.id, active: true });

    // ── Thương hiệu ──
    phai(await saveBrandingCore(admin, { displayName: TEN_THUONG_HIEU, accent: "teal" }), "Thương hiệu");

    // ── Kết nối mang bí mật: Lark (lưu → kiểm tra với máy chủ GIẢ → bật) + khoá AI của tổ chức ──
    phai(await saveConnection(admin, { connectorKey: "lark-webhook", secrets: { webhookUrl: bm.larkUrl, signSecret: bm.larkSign } }), "Lưu kết nối Lark");
    const larkOk = fetchGia({ code: 0 });
    phai(await testOrgConnection(admin, "lark-webhook", { tester: { fetch: larkOk.fetch } }), "Kiểm tra Lark");
    if (larkOk.calls[0] !== bm.larkUrl) throw new Error("Kiểm tra Lark không nhận đúng URL đã giải mã.");
    phai(await setConnectionStatus(admin, "lark-webhook", "ACTIVE"), "Bật Lark");
    phai(await saveConnection(admin, { connectorKey: "anthropic-byok", secrets: { apiKey: bm.aiKey } }), "Lưu khoá AI");
    phai(await testOrgConnection(admin, "anthropic-byok", { tester: { fetch: fetchGia({ data: [] }).fetch } }), "Kiểm tra khoá AI");
    phai(await setConnectionStatus(admin, "anthropic-byok", "ACTIVE"), "Bật khoá AI");

    // ── Dữ liệu: khách + giá trị field của mẫu, điểm giao, hợp đồng + quan hệ + tệp ──
    const [khach] = await db.insert(dbm.schema.customers).values({ name: TEN_KHACH, phones: ["0900000001"] }).returning({ id: dbm.schema.customers.id });
    phai(await saveCustomValues("customer", khach.id, { han_muc_cong_no: 500_000_000, so_ngay_no: 30 }, admin), "Giá trị field hạn mức");
    const dg1 = idOf(await createRecord("x_diem_giao", { system: { title: "Kho Bình Dương" }, custom: { dia_chi: "KCN Sóng Thần" } }, admin), "Điểm giao 1");
    const dg2 = idOf(await createRecord("x_diem_giao", { system: { title: "Cửa hàng Quận 5" }, custom: { dia_chi: "12 Trần Hưng Đạo" } }, admin), "Điểm giao 2");
    const hdLon = idOf(await createRecord("x_hop_dong_si", { system: { title: "HĐ-DL-001" }, custom: { khach: khach.id, gia_tri: 80_000_000, trang_thai: "nhap", diem_giao_chinh: dg1, cac_diem_giao: [dg1, dg2] } }, admin), "Hợp đồng lớn");
    const hdNho = idOf(await createRecord("x_hop_dong_si", { system: { title: "HĐ-DL-002" }, custom: { khach: khach.id, gia_tri: 5_000_000, diem_giao_chinh: dg2 } }, admin), "Hợp đồng nhỏ");
    const file = await saveCustomFile("x_hop_dong_si", hdLon, "tai_lieu", { filename: "hd-dl-001.pdf", mime: "application/pdf", data: TEP_PDF }, admin);
    phai(file, "Tệp hợp đồng");
    if (!file.ok) throw new Error("Tệp hợp đồng thất bại.");

    // ── Một lượt chạy + lời duyệt ──
    const w1 = await runWorkflows();
    const [req] = await db.select().from(dbm.schema.approvalRequests).where(eq(dbm.schema.approvalRequests.group, "WORKFLOW"));
    if (!req) throw new Error("Luật không sinh yêu cầu duyệt.");
    phai(await decideApprovalCore(db, { id: admin.id, email: admin.email, canDecide: true }, req.id, true, "Duyệt trong diễn tập"), "Duyệt");
    const w2 = await runWorkflows();
    // Dọn nốt sự kiện do chính lượt thực thi sinh ra — ảnh "trước" phải là trạng thái đã lắng.
    for (let i = 0; i < 3; i += 1) if ((await runWorkflows()).events === 0) break;

    const pagesBefore = await phanGiaiTrang(admin);
    const ex = await exportOrgBlueprint();
    return {
      ids: { hdLon, hdNho, dg1, dg2, customer: khach.id, file: file.file.id },
      blueprintContentHash: ex.contentHash,
      pagesBefore,
      runs: { waitingFirst: w1.waiting, executedAfterApproval: w2.executed },
      roleUserEmail,
    };
  });
  writeFileSync(path.join(workDir, "nguon.json"), JSON.stringify(out, null, 2));
  log(`1/7 NGUỒN: tuỳ biến xong · luật chờ duyệt ${out.runs.waitingFirst} → thực thi ${out.runs.executedAfterApproval} · blueprint ${out.blueprintContentHash}`);
  process.exit(0);
}

// ═══════════════════════════════ BƯỚC CON 2 · CHẠY THẬT TỔ CHỨC ĐÃ KHÔI PHỤC ═══════════════════════════════

async function buocKhoiPhuc() {
  const { workDir, names } = kiemMoiTruongCon();
  const code = names.orgCode;
  const bm = biMat();
  const nguon = JSON.parse(readFileSync(path.join(workDir, "nguon.json"), "utf8")) as NguonOut;
  const { dbm, context, quanTri, eq } = await nap(code);
  const { exportOrgBlueprint } = await import("@/lib/blueprints/export");
  const { createRecord, getRecord, reverseRelations } = await import("@/lib/objects/records");
  const { getCustomValues, openCustomFile } = await import("@/lib/metadata/values");
  const { listNavPages } = await import("@/lib/pages/registry");
  const { runWorkflows } = await import("@/lib/workflow/engine");
  const { getBranding } = await import("@/lib/branding/service");
  const { openActiveConnection, testOrgConnection } = await import("@/lib/connectors/service");
  const { SECRETS_KEY_ENV, secretsKeyState } = await import("@/lib/connectors/secrets");
  const { verifyLogin } = await import("@/lib/auth/login");
  const { sql } = await import("drizzle-orm");

  const ket = await context.withOrganization(code, async (): Promise<{ blueprintAfter: string; app: AppEvidence }> => {
    // Blueprint TRƯỚC mọi thao tác ghi.
    const blueprintAfter = (await exportOrgBlueprint()).contentHash;
    const admin = await quanTri();
    const db = await dbm.getDb();

    // Bản ghi + quan hệ + tệp.
    const lon = await getRecord("x_hop_dong_si", nguon.ids.hdLon, admin);
    const nho = await getRecord("x_hop_dong_si", nguon.ids.hdNho, admin);
    const kv = await getCustomValues("customer", [nguon.ids.customer], admin);
    const recordsReadOk =
      lon.ok && nho.ok && lon.record.title === "HĐ-DL-001" && lon.record.values.gia_tri === 80_000_000 && lon.record.values.trang_thai === "nhap" && nho.record.values.gia_tri === 5_000_000 && kv.get(nguon.ids.customer)?.han_muc_cong_no === 500_000_000;
    const rev = await reverseRelations("x_diem_giao", nguon.ids.dg1, admin);
    const revKeys = rev.map((g) => `${g.fieldKey}:${g.records.map((r) => r.title).join(",")}`).sort();
    const relationsOk =
      lon.ok &&
      lon.relationLabels.khach?.[nguon.ids.customer] === TEN_KHACH &&
      lon.relationLabels.diem_giao_chinh?.[nguon.ids.dg1] === "Kho Bình Dương" &&
      lon.relationLabels.cac_diem_giao?.[nguon.ids.dg2] === "Cửa hàng Quận 5" &&
      JSON.stringify(revKeys) === JSON.stringify(["cac_diem_giao:HĐ-DL-001", "diem_giao_chinh:HĐ-DL-001"]);
    const f = await openCustomFile(nguon.ids.file, admin);
    const fileOk = f.ok && Buffer.compare(f.file.data, TEP_PDF) === 0;

    // Trang + menu.
    const pages = await phanGiaiTrang(admin);
    const navSlugs = (await listNavPages()).map((p) => p.slug).filter((s) => (TRANG as readonly string[]).includes(s)).sort();

    // Luật: chạy lại KHÔNG nhân đôi; bản ghi mới vẫn sinh lượt xin duyệt.
    const dem = async () => {
      const r = (await db.execute(sql`select (select count(*)::int from workflow_runs) as runs, (select count(*)::int from work_items where source_type = 'WORKFLOW_TASK') as tasks`)) as unknown as { rows: { runs: number; tasks: number }[] };
      return { runs: Number(r.rows[0]?.runs ?? -1), tasks: Number(r.rows[0]?.tasks ?? -1) };
    };
    const truoc = await dem();
    const rerun = await runWorkflows();
    const sau = await dem();
    const moi = await createRecord("x_hop_dong_si", { system: { title: "HĐ-DL-003" }, custom: { khach: nguon.ids.customer, gia_tri: 90_000_000, diem_giao_chinh: nguon.ids.dg2 } }, admin);
    phai(moi, "Hợp đồng mới sau khôi phục");
    const wNew = await runWorkflows();

    // Bí mật: CÙNG khoá (khoá của lượt chạy, trong môi trường) ⇒ đúng bản rõ; khoá KHÁC ⇒ từ chối, không gọi ra ngoài.
    const lark = fetchGia({ code: 0 });
    const larkTest = await testOrgConnection(admin, "lark-webhook", { tester: { fetch: lark.fetch } });
    const sameKeyLarkOk = "ok" in larkTest && lark.calls.length === 1 && lark.calls[0] === bm.larkUrl;
    const ai = await openActiveConnection("anthropic-byok");
    const sameKeyAiOk = ai.ok && ai.secrets.apiKey === bm.aiKey;
    const khoaKhac = randomBytes(48).toString("base64");
    const sai = secretsKeyState((n) => (n === SECRETS_KEY_ENV ? khoaKhac : undefined));
    const aiSai = await openActiveConnection("anthropic-byok", { keyState: sai });
    const larkSaiFetch = fetchGia({ code: 0 });
    const larkSai = await testOrgConnection(admin, "lark-webhook", { keyState: sai, tester: { fetch: larkSaiFetch.fetch } });

    const branding = await getBranding();
    const [vaiTro] = await db.select().from(dbm.schema.accessRoles).where(eq(dbm.schema.accessRoles.code, "KD_SI"));
    const nv = await db.query.users.findFirst({ where: eq(dbm.schema.users.email, nguon.roleUserEmail) });

    return {
      blueprintAfter,
      app: {
        recordsReadOk,
        relationsOk,
        fileOk,
        pagesResolved: pages.filter((p) => p.blocks > 0).length,
        blocks: pages.reduce((s, p) => s + p.blocks, 0),
        blockErrors: pages.flatMap((p) => p.errors),
        navSlugs,
        rerunExecuted: rerun.executed,
        runsBefore: truoc.runs,
        runsAfterRerun: sau.runs,
        tasksBefore: truoc.tasks,
        tasksAfterRerun: sau.tasks,
        newRecordWaiting: wNew.waiting,
        sameKeyLarkOk,
        sameKeyAiOk,
        wrongKeyLarkRejected: "error" in larkSai,
        wrongKeyAiRejected: !aiSai.ok,
        wrongKeyFetchCalls: larkSaiFetch.calls.length,
        loginAdminOk: false,
        loginRoleUserOk: false,
        loginWrongPasswordRejected: false,
        brandingOk: branding.displayName === TEN_THUONG_HIEU && branding.accent === "teal",
        roleOk: Boolean(vaiTro && nv && nv.accessRoleId === vaiTro.id),
      },
    };
  });

  // Đăng nhập đi qua ĐÚNG đường của trang /login (tra sổ tổ chức ở nhà, rồi tự vào ngữ cảnh tổ chức).
  const phat = async () => undefined;
  ket.app.loginAdminOk = (await verifyLogin({ email: `admin@${code}.local`, password: MAT_KHAU_QT, orgCode: code }, phat)).ok;
  ket.app.loginRoleUserOk = (await verifyLogin({ email: nguon.roleUserEmail, password: MAT_KHAU_NV, orgCode: code }, phat)).ok;
  ket.app.loginWrongPasswordRejected = !(await verifyLogin({ email: `admin@${code}.local`, password: `${MAT_KHAU_QT}-sai`, orgCode: code }, phat)).ok;

  writeFileSync(path.join(workDir, "khoi-phuc.json"), JSON.stringify(ket, null, 2));
  process.exit(0);
}

// ═══════════════════════════════ ĐIỀU PHỐI ═══════════════════════════════

type Runner = { argv: (a: string[]) => string[]; env: NodeJS.ProcessEnv; mode: string };

/** createdb / pg_dump / pg_restore: trong container (như VPS) hoặc công cụ trên máy. KHÔNG qua shell (AGENTS.md mục 65). */
function runner(t: Target): Runner {
  const container = (process.env.ERP_DRILL_PG_CONTAINER || "").trim();
  if (container) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(container)) throw new Error("ERP_DRILL_PG_CONTAINER không hợp lệ.");
    return { argv: (a) => ["docker", "exec", "-i", container, ...a], env: { ...process.env }, mode: `docker exec -i ${container.slice(0, 12)}` };
  }
  const bin = (process.env.ERP_DRILL_PG_BIN || "").trim();
  const exe = (n: string) => (bin ? path.join(bin, process.platform === "win32" ? `${n}.exe` : n) : n);
  return {
    argv: ([n, ...rest]) => [exe(n), ...rest],
    env: { ...process.env, PGHOST: t.host, PGPORT: t.url.port || "5432", PGPASSWORD: decodeURIComponent(t.url.password || "") },
    mode: bin ? `công cụ trên máy (${bin})` : "công cụ trên máy (PATH)",
  };
}

function chay(r: Runner, a: string[], io: { stdinFile?: string; stdoutFile?: string } = {}): { code: number; stdout: string; stderr: string; ms: number } {
  const [cmd, ...rest] = r.argv(a);
  const t0 = Date.now();
  const fdIn = io.stdinFile ? openSync(io.stdinFile, "r") : "ignore";
  const fdOut = io.stdoutFile ? openSync(io.stdoutFile, "w") : "pipe";
  try {
    const p = spawnSync(cmd, rest, { env: r.env, stdio: [fdIn, fdOut, "pipe"], shell: false, timeout: 1_800_000, maxBuffer: 64 * 1024 * 1024 });
    const stderr = p.stderr ? p.stderr.toString("utf8") : "";
    if (p.error) return { code: 127, stdout: "", stderr: `${p.error.message}\n${stderr}`, ms: Date.now() - t0 };
    return { code: p.status ?? 1, stdout: p.stdout ? p.stdout.toString("utf8") : "", stderr, ms: Date.now() - t0 };
  } finally {
    if (typeof fdIn === "number") closeSync(fdIn);
    if (typeof fdOut === "number") closeSync(fdOut);
  }
}

function chayBuoc(buoc: "nguon" | "khoi-phuc", env: NodeJS.ProcessEnv): number {
  const cli = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  const r = spawnSync(process.execPath, [cli, "--tsconfig", "tsconfig.json", path.join("scripts", "restore-drill-pg.ts"), `--buoc=${buoc}`], { env, stdio: "inherit", shell: false, timeout: 1_800_000 });
  return r.status ?? 1;
}

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** Ảnh chụp một CSDL: mọi bảng `public` + `drizzle` (số dòng + md5 của các md5 dòng đã SẮP — không phụ thuộc thứ tự vật lý) + sequence. */
async function chup(c: Client): Promise<DbSnapshot> {
  const tables: DbSnapshot["tables"] = {};
  const ds = await c.query<{ s: string; t: string }>("select schemaname as s, tablename as t from pg_tables where schemaname in ('public', 'drizzle') order by 1, 2");
  for (const { s, t } of ds.rows) {
    const r = await c.query<{ n: string; h: string | null }>(`select count(*)::text as n, md5(coalesce(string_agg(h, '' order by h), '')) as h from (select md5(x::text) as h from ${ident(s)}.${ident(t)} x) q`);
    tables[`${s}.${t}`] = { rows: Number(r.rows[0]?.n ?? -1), hash: r.rows[0]?.h ?? "" };
  }
  const sequences: DbSnapshot["sequences"] = {};
  const sq = await c.query<{ n: string; v: string | null }>("select schemaname || '.' || sequencename as n, last_value::text as v from pg_sequences where schemaname in ('public', 'drizzle') order by 1");
  for (const { n, v } of sq.rows) sequences[n] = v;
  return { tables, sequences };
}

/** Dòng mặt phẳng điều khiển của tổ chức ở CSDL NHÀ — chỉ các cột ổn định (không mốc giờ). */
async function matPhang(c: Client, code: string): Promise<string> {
  const o = await c.query("select id, code, name, status, is_home, module_default, template_key, plan from platform_organizations where code = $1", [code]);
  const org = o.rows[0] as { id: string } | undefined;
  const m = org ? await c.query("select module_key, enabled from platform_organization_modules where organization_id = $1 order by module_key", [org.id]) : { rows: [] };
  return sha(JSON.stringify({ org: o.rows, modules: m.rows }));
}

async function coCsdl(c: Client, name: string): Promise<boolean> {
  return (await c.query("select 1 from pg_database where datname = $1", [name])).rowCount === 1;
}

async function xoaCsdl(c: Client, name: string, names: DrillNames): Promise<void> {
  assertDropAllowed(name, names);
  await c.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()", [name]);
  await c.query(`drop database if exists ${ident(name)}`);
}

async function dieuPhoi() {
  const code = argVal("ma") ?? DEFAULT_DRILL_ORG_CODE;
  let names: DrillNames;
  try {
    names = drillNames(code);
  } catch (e) {
    console.error(`[drill] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
  const t = target();
  const homeUrl = urlFor(t, t.database);
  const orgUrl = urlFor(t, names.orgDatabase);
  const tempUrl = urlFor(t, names.tempDatabase);

  // ── Hàng rào môi trường: TRƯỚC khi ghi một byte nào ──
  const moiTruong = await withClient(homeUrl, async (c) => ({
    version: String((await c.query("show server_version")).rows[0]?.server_version ?? "?"),
    publicTablesBefore: Number((await c.query("select count(*)::int as n from information_schema.tables where table_schema = 'public'")).rows[0]?.n ?? -1),
    orgDatabases: (await c.query("select datname from pg_database where datname like 'erp\\_org\\_%'")).rows.map((r: { datname: string }) => r.datname),
  }));
  const tuChoi = judgeDrillEnvironment({ host: t.host, database: t.database, ack: process.env[DRILL_EPHEMERAL_ACK_ENV], publicTablesBefore: moiTruong.publicTablesBefore, orgDatabases: moiTruong.orgDatabases }, names);
  if (tuChoi.length > 0) {
    for (const l of tuChoi) console.error(`[drill] TỪ CHỐI: ${l}`);
    process.exit(2);
  }
  const r = runner(t);
  const dumpVersion = chay(r, ["pg_dump", "--version"]);
  if (dumpVersion.code !== 0) {
    console.error(`[drill] Không chạy được pg_dump (${r.mode}): ${dumpVersion.stderr.slice(0, 300)}`);
    process.exit(2);
  }

  const workDir = path.join("data", `${WORK_PREFIX}${process.pid}`);
  const giu = flag("giu");
  const baoCao = argVal("bao-cao") ?? path.join("data", "restore-drill-pg-report.json");
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  mkdirSync(path.dirname(baoCao), { recursive: true });

  // Khoá GIẢ của lượt chạy: chỉ sống trong bộ nhớ của điều phối + môi trường của hai tiến trình con.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PLATFORM_SECRETS_KEY: randomBytes(48).toString("base64"),
    ERP_RESTORE_DRILL_PG_WORK: workDir,
    ERP_RESTORE_DRILL_PG_CODE: code,
    ERP_RESTORE_DRILL_PG_LARK: `dt-${randomBytes(12).toString("hex")}`,
    ERP_RESTORE_DRILL_PG_AI: `dien-tap-${randomBytes(18).toString("hex")}`,
  };
  delete env.ERP_READ_ONLY;
  for (const k of Object.keys(env)) if (k.startsWith("ORG_DATABASE_URL__")) delete env[k];

  const t0 = Date.now();
  let ma = 1;
  const ev: PgDrillEvidence = {
    names,
    before: { tables: {}, sequences: {} },
    broken: { tables: {}, sequences: {} },
    droppedGone: false,
    after: { tables: {}, sequences: {} },
    controlPlaneBefore: "",
    controlPlaneAfter: "",
    blueprintBefore: "",
    blueprintAfter: "",
    dump: { exitCode: -1, bytes: 0, ms: 0, tocMissing: [] },
    restore: { createdbExit: -1, restoreExit: -1, restoreErrors: -1, renamedTo: "", ms: 0 },
    app: null,
  };
  let nguon: NguonOut | null = null;
  let rtoMs: number | null = null;
  let loi: string | null = null;
  try {
    log(`Diễn tập khôi phục tổ chức «${code}» trên Postgres ${moiTruong.version} · ${dumpVersion.stdout.trim()} · công cụ: ${r.mode}`);
    if (chayBuoc("nguon", env) !== 0) throw new Error("Bước NGUỒN thất bại (xem log phía trên).");
    nguon = JSON.parse(readFileSync(path.join(workDir, "nguon.json"), "utf8")) as NguonOut;
    ev.blueprintBefore = nguon.blueprintContentHash;

    // ── 2 · ẢNH "TRƯỚC" ──
    ev.before = await withClient(orgUrl, chup);
    ev.controlPlaneBefore = await withClient(homeUrl, (c) => matPhang(c, code));
    const soBang = Object.keys(ev.before.tables).length;
    const soDong = Object.values(ev.before.tables).reduce((s, x) => s + x.rows, 0);
    log(`2/7 ẢNH TRƯỚC: ${soBang} bảng · ${soDong} dòng · ${Object.keys(ev.before.sequences).length} sequence`);

    // ── 3 · SAO LƯU — đúng lệnh của erp-backup.sh ──
    const dump = path.join(workDir, `${names.orgDatabase}-dien-tap.dump`);
    const d = chay(r, dumpArgs(names.orgDatabase), { stdoutFile: dump });
    ev.dump = { exitCode: d.code, bytes: existsSync(dump) ? statSync(dump).size : 0, ms: d.ms, tocMissing: [] };
    if (d.code !== 0) throw new Error(`pg_dump thoát ${d.code}: ${d.stderr.slice(0, 300)}`);
    const toc = chay(r, listArgs(), { stdinFile: dump });
    ev.dump.tocMissing = toc.code === 0 ? missingCoreTables(toc.stdout) : ["(pg_restore --list không đọc được bản dump)"];
    log(`3/7 SAO LƯU: ${dumpArgs(names.orgDatabase).join(" ")} → ${ev.dump.bytes} byte trong ${ev.dump.ms} ms · mục lục ${ev.dump.tocMissing.length ? `THIẾU ${ev.dump.tocMissing.join(", ")}` : "đủ bảng lõi"}`);

    // ── 4 · PHÁ ── (runbook bước 0: tạm ngừng tổ chức trước)
    await withClient(homeUrl, (c) => c.query("update platform_organizations set status = 'SUSPENDED' where code = $1 and not is_home", [code]));
    await withClient(orgUrl, async (c) => {
      await c.query("delete from custom_values");
      await c.query("update custom_records set title = title || ' (hỏng)'");
      await c.query("delete from org_connections");
      await c.query("update users set name = 'đã bị sửa'");
      ev.broken = await chup(c);
    });
    await withClient(homeUrl, async (c) => {
      await xoaCsdl(c, names.orgDatabase, names);
      ev.droppedGone = !(await coCsdl(c, names.orgDatabase));
    });
    log(`4/7 PHÁ: SUSPENDED · ${diffSnapshots(ev.before, ev.broken).length} bảng lệch so với trước · DROP DATABASE ${names.orgDatabase} ⇒ ${ev.droppedGone ? "đã mất" : "VẪN CÒN"}`);

    // ── 5 · KHÔI PHỤC — runbook docs/backup-restore.md mục 7 ──
    const tR = Date.now();
    await withClient(homeUrl, async (c) => {
      if (await coCsdl(c, names.tempDatabase)) await xoaCsdl(c, names.tempDatabase, names);
    });
    const cd = chay(r, createdbArgs(names.tempDatabase));
    ev.restore.createdbExit = cd.code;
    if (cd.code !== 0) throw new Error(`createdb thoát ${cd.code}: ${cd.stderr.slice(0, 300)}`);
    const pr = chay(r, restoreArgs(names.tempDatabase), { stdinFile: dump });
    ev.restore.restoreExit = pr.code;
    ev.restore.restoreErrors = pr.stderr.split("\n").filter((l) => /error/i.test(l)).length;
    if (pr.code !== 0) throw new Error(`pg_restore thoát ${pr.code} — runbook: DỪNG. ${pr.stderr.split("\n").slice(0, 5).join(" | ")}`);
    const doiChieu = await withClient(tempUrl, async (c) => (await c.query("select (select count(*) from users)::int as u, (select count(*) from settings)::int as s, (select count(*) from drizzle.__drizzle_migrations)::int as m")).rows[0] as { u: number; s: number; m: number });
    await withClient(homeUrl, async (c) => {
      // Runbook bước 3: bản cũ đổi tên hong_<mã>_<mốc> — ở đây bản cũ ĐÃ bị DROP (kịch bản mất CSDL), nên chỉ còn đổi tên tạm.
      if (await coCsdl(c, names.orgDatabase)) throw new Error(`${names.orgDatabase} lại xuất hiện trước khi đổi tên — dừng, không ghi đè.`);
      assertDropAllowed(names.tempDatabase, names);
      await c.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()", [names.tempDatabase]);
      await c.query(`alter database ${ident(names.tempDatabase)} rename to ${ident(names.orgDatabase)}`);
      ev.restore.renamedTo = (await coCsdl(c, names.orgDatabase)) && !(await coCsdl(c, names.tempDatabase)) ? names.orgDatabase : "";
    });
    ev.restore.ms = Date.now() - tR;
    log(`5/7 KHÔI PHỤC: ${createdbArgs(names.tempDatabase).join(" ")} · ${restoreArgs(names.tempDatabase).join(" ")} < bản.dump · đối chiếu users ${doiChieu.u} / settings ${doiChieu.s} / migration ${doiChieu.m} · đổi tên ⇒ ${ev.restore.renamedTo || "HỎNG"} · ${ev.restore.ms} ms`);

    // ── 6 · SO + CHẠY THẬT ── (ảnh "sau" TRƯỚC khi mã ứng dụng chạm vào; rồi runbook bước 4: mở lại tổ chức)
    ev.after = await withClient(orgUrl, chup);
    await withClient(homeUrl, (c) => c.query("update platform_organizations set status = 'ACTIVE' where code = $1 and not is_home", [code]));
    ev.controlPlaneAfter = await withClient(homeUrl, (c) => matPhang(c, code));
    if (chayBuoc("khoi-phuc", env) !== 0) throw new Error("Bước CHẠY THẬT thất bại (xem log phía trên).");
    const kp = JSON.parse(readFileSync(path.join(workDir, "khoi-phuc.json"), "utf8")) as { blueprintAfter: string; app: AppEvidence };
    ev.blueprintAfter = kp.blueprintAfter;
    ev.app = kp.app;
    rtoMs = Date.now() - tR;
    log(`6/7 SO + CHẠY THẬT: xong · RTO (createdb → tổ chức chạy được, đã kiểm) ${rtoMs} ms`);
  } catch (e) {
    loi = e instanceof Error ? e.message : String(e);
    console.error(`[drill] ${loi}`);
  }

  // ── 7 · BÁO CÁO ──
  const v = judgePgRestoreDrill(ev);
  if (loi) v.failures.unshift(loi);
  const ok = v.ok && !loi;
  const lech = diffSnapshots(ev.before, ev.after);
  const a = ev.app;
  const dong = (ten: string, gt: string) => log(`  ${ten.padEnd(36)} ${gt}`);
  console.log("");
  log("══════ BÁO CÁO DIỄN TẬP KHÔI PHỤC TỔ CHỨC — POSTGRES THẬT ══════");
  dong("Tổ chức · CSDL · CSDL tạm", `${code} · ${names.orgDatabase} · ${names.tempDatabase}`);
  dong("Postgres · công cụ", `${moiTruong.version} · ${r.mode}`);
  dong("Bảng / dòng trong ảnh trước", `${Object.keys(ev.before.tables).length} bảng · ${Object.values(ev.before.tables).reduce((s, x) => s + x.rows, 0)} dòng`);
  dong("Bản dump", `${ev.dump.bytes} byte · ${ev.dump.ms} ms · mục lục ${ev.dump.tocMissing.length ? "THIẾU" : "đủ"}`);
  dong("Bản đã phá khác bản gốc", `${diffSnapshots(ev.before, ev.broken).length} chỗ · CSDL sau DROP ${ev.droppedGone ? "đã mất" : "VẪN CÒN"}`);
  dong("Khôi phục (createdb → đổi tên)", `${ev.restore.ms} ms · pg_restore thoát ${ev.restore.restoreExit}, ${ev.restore.restoreErrors} dòng lỗi`);
  dong("RTO tới khi chạy được (đã kiểm)", rtoMs === null ? "—" : `${rtoMs} ms`);
  dong("Sau khôi phục so với trước", lech.length === 0 ? "BẰNG NHAU từng bảng + sequence" : `${lech.length} chỗ lệch`);
  dong("Mặt phẳng điều khiển", ev.controlPlaneBefore && ev.controlPlaneBefore === ev.controlPlaneAfter ? "bằng nhau" : "KHÁC");
  dong("Blueprint trước → sau", `${ev.blueprintBefore || "—"} → ${ev.blueprintAfter || "—"}`);
  if (a) {
    dong("Bản ghi · quan hệ · tệp", `${a.recordsReadOk ? "đúng" : "SAI"} · ${a.relationsOk ? "đúng" : "SAI"} · ${a.fileOk ? "đúng" : "SAI"}`);
    dong("Trang · khối · lỗi khối · menu", `${a.pagesResolved} · ${a.blocks} · ${a.blockErrors.length} · ${a.navSlugs.join(", ")}`);
    dong("Luật chạy lại (thực thi · lượt · việc)", `${a.rerunExecuted} · ${a.runsBefore}→${a.runsAfterRerun} · ${a.tasksBefore}→${a.tasksAfterRerun} · bản ghi mới xin duyệt ${a.newRecordWaiting}`);
    dong("Bí mật: cùng khoá · khoá khác", `${a.sameKeyLarkOk && a.sameKeyAiOk ? "giải đúng" : "SAI"} · ${a.wrongKeyLarkRejected && a.wrongKeyAiRejected && a.wrongKeyFetchCalls === 0 ? "từ chối (fail closed)" : "KHÔNG TỪ CHỐI"}`);
    dong("Đăng nhập: quản trị · vai trò · sai MK", `${a.loginAdminOk ? "được" : "KHÔNG"} · ${a.loginRoleUserOk ? "được" : "KHÔNG"} · ${a.loginWrongPasswordRejected ? "bị từ chối" : "LỌT"}`);
  }
  dong("Tổng thời gian", `${Math.round((Date.now() - t0) / 1000)} giây`);
  if (ok) log("KẾT QUẢ: ĐẠT — tổ chức khôi phục từ pg_dump bằng từng bảng với bản gốc và CHẠY ĐƯỢC qua mã ứng dụng.");
  else {
    log("KẾT QUẢ: KHÔNG ĐẠT");
    for (const x of v.failures) log(`  ✗ ${x}`);
  }

  // Tệp JSON: số, tên bảng, băm, thời gian — KHÔNG bí mật, KHÔNG dữ liệu dòng.
  const report = {
    schema: 1,
    kind: "restore-drill-pg",
    result: ok ? "OK" : "FAILED",
    finishedAt: new Date().toISOString(),
    orgCode: code,
    orgDatabase: names.orgDatabase,
    tempDatabase: names.tempDatabase,
    postgres: moiTruong.version,
    pgDump: dumpVersion.stdout.trim(),
    tools: r.mode.replace(/docker exec -i \S+/, "docker exec -i <container>"),
    commands: { dump: dumpArgs(names.orgDatabase), list: listArgs(), createdb: createdbArgs(names.tempDatabase), restore: restoreArgs(names.tempDatabase) },
    dump: ev.dump,
    restore: ev.restore,
    rtoMs,
    totalMs: Date.now() - t0,
    tables: Object.fromEntries(Object.entries(ev.before.tables).map(([k, x]) => [k, { rows: x.rows, restoredRows: ev.after.tables[k]?.rows ?? null, equal: ev.after.tables[k]?.hash === x.hash }])),
    brokenDiffs: diffSnapshots(ev.before, ev.broken).length,
    restoredDiffs: lech,
    controlPlaneEqual: Boolean(ev.controlPlaneBefore) && ev.controlPlaneBefore === ev.controlPlaneAfter,
    blueprint: { before: ev.blueprintBefore, after: ev.blueprintAfter },
    seed: nguon ? { pagesBefore: nguon.pagesBefore, runs: nguon.runs } : null,
    app: a,
    failures: v.failures,
  };
  writeFileSync(baoCao, JSON.stringify(report, null, 2));
  log(`Báo cáo JSON: ${baoCao}`);
  const tomTat = process.env.GITHUB_STEP_SUMMARY;
  if (tomTat) {
    try {
      appendFileSync(
        tomTat,
        [
          `## Diễn tập khôi phục tổ chức — ${ok ? "ĐẠT" : "KHÔNG ĐẠT"}`,
          "",
          `| Mục | Kết quả |`,
          `|---|---|`,
          `| Postgres | ${moiTruong.version} |`,
          `| Bảng so sánh | ${Object.keys(ev.before.tables).length} (lệch sau khôi phục: ${lech.length}) |`,
          `| Bản dump | ${ev.dump.bytes} byte · ${ev.dump.ms} ms |`,
          `| Khôi phục (createdb → đổi tên) | ${ev.restore.ms} ms |`,
          `| RTO tới khi chạy được | ${rtoMs ?? "—"} ms |`,
          ...v.failures.map((x) => `| ✗ | ${x.replace(/\|/g, "/")} |`),
          "",
        ].join("\n"),
      );
    } catch {
      // Tóm tắt của Actions chỉ là tiện ích — không đổi kết luận.
    }
  }
  if (!giu) rmSync(workDir, { recursive: true, force: true });
  else log(`--giu: giữ ${workDir}`);
  ma = ok ? 0 : 1;
  process.exit(ma);
}

const buoc = argVal("buoc");
const chayViec = buoc === "nguon" ? buocNguon : buoc === "khoi-phuc" ? buocKhoiPhuc : buoc === undefined ? dieuPhoi : null;
if (!chayViec) {
  console.error("Dùng: scripts/restore-drill-pg.ts [--ma=drill-<x>] [--bao-cao=<tệp.json>] [--giu]");
  process.exit(2);
}
chayViec().catch((error) => {
  console.error(error);
  process.exit(1);
});
