/**
 * ═══════════ DIỄN TẬP KHÔI PHỤC CẤU HÌNH MỘT TỔ CHỨC — TẦNG BLUEPRINT (Commercial readiness C) ═══════════
 *
 * Chạy (máy cục bộ, PGlite RIÊNG của lượt diễn tập — KHÔNG đọc .env, KHÔNG chạm CSDL nào khác):
 *   npx tsx --tsconfig tsconfig.json scripts/restore-drill-org-config.ts [--ma=dt-cauhinh] [--giu]
 *
 *   --ma=<mã>   mã tổ chức thử (mặc định `dt-cauhinh`; `^[a-z][a-z0-9-]{1,30}$`)
 *   --giu       giữ thư mục dữ liệu + tệp gói sau khi chạy (mặc định xoá hết)
 *
 * Ba tiến trình, vì MẤT CSDL phải là mất thật — một tiến trình còn giữ handle CSDL cũ thì "cấp lại cùng mã" chỉ mở lại
 * đúng CSDL cũ (`db/index.ts` đệm handle theo mã) và phép so thành vô nghĩa:
 *
 *   1. NGUỒN      cấp tổ chức thử → cài mẫu `service-business` → tuỳ biến tay (field trên đối tượng tuỳ biến lẫn hệ
 *                 thống, trang tay đã xuất bản, form sửa tay, luật tay, vai trò, module bật thêm, đổi nhãn trạng thái đơn) + một
 *                 bản ghi DỮ LIỆU + một khoá cài đặt mang BÍ MẬT (cả hai KHÔNG được đi theo gói) → đo PHẠM VI (bảng
 *                 cấu hình có dòng trong CSDL tổ chức, không thêm dòng nào ở CSDL nhà, CSDL tổ chức không mang mặt
 *                 phẳng điều khiển) → xuất blueprint ra TỆP.
 *   2. (điều phối) XOÁ thư mục CSDL của tổ chức — giả lập mất CSDL.
 *   3. KHÔI PHỤC  xoá cả dòng sổ tổ chức (mất trọn) → cấp lại CÙNG mã ở dạng trống → xuất tổ chức trống (phải KHÁC nguồn)
 *                 → đọc tệp → xem trước → cài (so `planHash`, cùng bộ cài của màn Mẫu) → xuất lại → so băm → xem trước
 *                 lại cùng tệp (phải 0 mục phải ghi) → quét rò.
 *
 * Điều phối đọc bằng chứng của hai bước rồi hỏi `judgeConfigRestoreDrill()` (lib/blueprints/restore-drill.ts). Thoát 0
 * khi ĐẠT, 1 khi KHÔNG ĐẠT, 2 khi dùng sai.
 *
 * GIỚI HẠN TRUNG THỰC: đây là khôi phục CẤU HÌNH — bản ghi, tệp đính kèm, người dùng, bí mật kết nối KHÔNG đi theo
 * blueprint (cố ý). Khôi phục DỮ LIỆU là bản dump CSDL (`scripts/erp-backup.sh restore-drill-org`, chạy trên VPS).
 * Lượt này chạy PGlite (WASM) chứ không Postgres thật; điều nó chứng minh là đường xuất → mất → cài lại, không phải
 * pg_dump. Xem docs/platform/backup-recovery.md mục 6–7.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RestoreEvidence, SourceEvidence } from "@/lib/blueprints/restore-drill";

const args = process.argv.slice(2);
const argVal = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const flag = (name: string) => args.includes(`--${name}`);

/** Tiền tố thư mục PGlite của lượt diễn tập — tiến trình con TỪ CHỐI chạy trên thư mục khác. */
const DRILL_DATA_PREFIX = "pglite-restore-drill-";
const CODE_PATTERN = /^[a-z][a-z0-9-]{1,30}$/;
const MAT_KHAU = "DienTapKhoiPhuc@2468";
/** Chuỗi nhận dạng: xuất hiện trong gói là RÒ. */
const BI_MAT = "bi-mat-ket-noi-dien-tap-9c8b7a6f";
const URL_BI_MAT = "https://open.larksuite.com/open-apis/bot/v2/hook/dien-tap-khoi-phuc-bi-mat";
const TIEU_DE_BAN_GHI = "HD-DIEN-TAP-RIENG-5566";
const GIA_TRI_BAN_GHI = "GIA-TRI-DIEN-TAP-XYZ-8877";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function docJson<T>(tep: string): T {
  return JSON.parse(readFileSync(tep, "utf8")) as T;
}

/** Tiến trình con: chỉ chạy khi DATABASE_URL trỏ ĐÚNG thư mục PGlite của lượt diễn tập do điều phối đặt. */
function kiemMoiTruongCon(): { dataDir: string; workDir: string; code: string } {
  const dataDir = process.env.ERP_RESTORE_DRILL_DATA ?? "";
  const workDir = process.env.ERP_RESTORE_DRILL_WORK ?? "";
  const code = process.env.ERP_RESTORE_DRILL_CODE ?? "";
  if (!dataDir || !path.basename(dataDir).startsWith(DRILL_DATA_PREFIX) || process.env.DATABASE_URL !== `pglite://${dataDir}` || !workDir || !CODE_PATTERN.test(code)) {
    console.error("[diễn-tập] Bước con chỉ chạy dưới điều phối (PGlite riêng của lượt diễn tập) — từ chối.");
    process.exit(2);
  }
  return { dataDir, workDir, code };
}

// ═══════════════════════════════ ĐẾM DÒNG ═══════════════════════════════

type DbLike = { execute: (q: never) => Promise<unknown> };

async function demMot(db: DbLike, bang: string): Promise<number | null> {
  const { sql } = await import("drizzle-orm");
  try {
    // Tên bảng lấy từ hằng số trong mã (ORG_CONFIG_TABLES / CONTROL_PLANE_TABLES), không từ đầu vào — nội suy an toàn.
    const r = (await db.execute(sql.raw(`select count(*)::int as n from ${bang}`) as never)) as { rows?: Record<string, unknown>[] };
    const v = r.rows?.[0]?.n;
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

async function demNhieu<T extends string>(db: DbLike, bangs: readonly T[]): Promise<Record<T, number | null>> {
  const out = {} as Record<T, number | null>;
  for (const b of bangs) out[b] = await demMot(db, b);
  return out;
}

async function soBangPublic(db: DbLike): Promise<number> {
  return (await demMot(db, "information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'")) ?? -1;
}

// ═══════════════════════════════ DÙNG CHUNG CHO HAI BƯỚC ═══════════════════════════════

async function nap() {
  const [dbm, migrate, orgs, caps, provision, context, drill] = await Promise.all([
    import("@/db"),
    import("@/db/migrate"),
    import("@/lib/platform/organizations"),
    import("@/lib/platform/capabilities"),
    import("@/lib/platform/provision"),
    import("@/lib/platform/context"),
    import("@/lib/blueprints/restore-drill"),
  ]);
  const { eq } = await import("drizzle-orm");
  const { MODULE_KEYS } = await import("@/lib/constants/platform-modules");
  type SessionUser = import("@/lib/auth/session").SessionUser;

  /** Xoá tổ chức khỏi sổ (mặt phẳng điều khiển). Chỉ tổ chức thử của lượt này — mã đã qua CODE_PATTERN. */
  const xoaKhoiSo = async (code: string) => {
    const pdb = await dbm.getPlatformDb();
    const org = await pdb.query.platformOrganizations.findFirst({ where: eq(dbm.schema.platformOrganizations.code, code) });
    if (org) {
      if (org.isHome) throw new Error("Không bao giờ xoá tổ chức nhà.");
      await pdb.delete(dbm.schema.platformOrganizationModules).where(eq(dbm.schema.platformOrganizationModules.organizationId, org.id));
      await pdb.delete(dbm.schema.platformOrganizations).where(eq(dbm.schema.platformOrganizations.id, org.id));
    }
    orgs.invalidateOrganizations();
    caps.invalidateCapabilities();
    return Boolean(org);
  };

  const capToChuc = async (code: string) => {
    await provision.provisionOrganization({ code, name: `Tổ chức diễn tập ${code}`, modules: [], admin: { email: `admin@${code}.local`, name: `QT ${code}`, password: MAT_KHAU }, source: "SCRIPT", actor: null });
  };

  const quanTri = async (code: string): Promise<SessionUser> => {
    const db = await dbm.getDb();
    const row = await db.query.users.findFirst({ where: eq(dbm.schema.users.email, `admin@${code}.local`) });
    if (!row) throw new Error(`Thiếu quản trị của ${code}.`);
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      role: "ADMIN",
      permissions: [],
      scope: "ALL",
      departmentCodes: [],
      positionId: null,
      organization: { code, name: code, isHome: false },
      modules: [...(await caps.getEnabledModules(code))].filter((m) => (MODULE_KEYS as readonly string[]).includes(m)),
    };
  };

  return { dbm, migrate, context, drill, xoaKhoiSo, capToChuc, quanTri };
}

const soBanGhi = async (dbm: typeof import("@/db")) => (await demMot((await dbm.getDb()) as unknown as DbLike, "custom_records")) ?? -1;

// ═══════════════════════════════ BƯỚC 1 · NGUỒN ═══════════════════════════════

async function buocNguon() {
  const { workDir, code } = kiemMoiTruongCon();
  const { dbm, migrate, context, drill, xoaKhoiSo, capToChuc, quanTri } = await nap();
  const { SERVICE_BUSINESS_BLUEPRINT } = await import("@/lib/blueprints/templates/service-business");
  const { installBlueprint } = await import("@/lib/blueprints/install");
  const { exportFileName, exportOrgBlueprint } = await import("@/lib/blueprints/export");
  const { createCustomField } = await import("@/lib/metadata/fields");
  const { getFormDraft, publishForm, saveFormDraft } = await import("@/lib/metadata/forms");
  const { saveStatusOverrides } = await import("@/lib/metadata/statuses");
  const { createPage, publishPage } = await import("@/lib/pages/registry");
  const { saveRule } = await import("@/lib/workflow/rules");
  const { saveAccessRoleCore } = await import("@/lib/auth/access-roles");
  const { toggleOwnModule } = await import("@/lib/platform-ui/module-toggle");
  const { actorOf } = await import("@/lib/platform-ui/metadata-admin");
  const { createRecord } = await import("@/lib/objects/records");
  const { setSettingJson } = await import("@/lib/settings");
  type PageSchema = import("@/lib/pages/types").PageSchema;
  type FormSchema = import("@/lib/metadata/types").FormSchema;

  await migrate.ensureMigrated();
  const pdb = (await dbm.getPlatformDb()) as unknown as DbLike;
  const nhaTruoc = await demNhieu(pdb, drill.ORG_CONFIG_TABLES);
  const soTruoc = ((await demMot(pdb, "platform_organizations")) ?? 0) + ((await demMot(pdb, "platform_organization_modules")) ?? 0);

  await xoaKhoiSo(code);
  await capToChuc(code);
  console.log(`[diễn-tập] 1/3 NGUỒN: đã cấp tổ chức thử «${code}» (CSDL riêng).`);

  const ketQua = await context.withOrganization(code, async () => {
    let admin = await quanTri(code);
    const inst = await installBlueprint(SERVICE_BUSINESS_BLUEPRINT, admin);
    if (!inst.ok) throw new Error(`Cài mẫu service-business thất bại: ${JSON.stringify(inst.errors).slice(0, 400)}`);
    admin = await quanTri(code);
    const actor = actorOf(admin);
    const phai = (r: { ok: boolean } | object, viec: string) => {
      if ("ok" in r && r.ok === false) throw new Error(`${viec} thất bại: ${JSON.stringify(r).slice(0, 400)}`);
      if ("error" in r) throw new Error(`${viec} thất bại: ${JSON.stringify(r).slice(0, 400)}`);
    };

    // ── Tuỳ biến tay ──
    phai(await createCustomField("x_contract", { key: "ma_noi_bo", label: "Mã nội bộ", type: "text", validation: { maxLength: 40 }, filterable: true }, actor), "Field trên đối tượng tuỳ biến");
    phai(await createCustomField("customer", { key: "hang_khach", label: "Hạng khách", type: "select", filterable: true, options: [{ value: "vang", label: "Vàng" }, { value: "bac", label: "Bạc" }] }, actor), "Field trên đối tượng hệ thống");
    const trang: PageSchema = {
      version: 1,
      sections: [
        {
          key: "hop_dong",
          title: "Hợp đồng",
          blocks: [
            { id: "gioi_thieu", type: "text", span: 12, config: { heading: "Bảng hợp đồng", body: "Trang dựng tay trong lượt diễn tập khôi phục." } },
            { id: "bang_hd", type: "table", span: 12, title: "Hợp đồng", config: { source: "x_contract", columns: ["system:title", "custom:gia_tri", "custom:ma_noi_bo"], pageSize: 20, rowLink: true } },
          ],
        },
      ],
    };
    const tay = await createPage({ slug: "bang-hop-dong", name: "Bảng hợp đồng", moduleKey: "apps", nav: { enabled: true, label: "Bảng hợp đồng", zone: null, order: 20 }, draft: trang }, actor);
    phai(tay, "Tạo trang tay");
    if (!tay.ok) throw new Error("Tạo trang tay thất bại.");
    phai(await publishPage(tay.page.id, actor), "Xuất bản trang tay");
    phai(
      await saveRule(
        {
          key: "hop_dong_moi_bao",
          name: "Hợp đồng mới ⇒ báo nhóm",
          trigger: { kind: "event", event: "custom_record.created", objectKey: "x_contract" },
          conditions: { field: "custom:ma_noi_bo", op: "not_empty" },
          actions: [{ kind: "notify", message: "Có hợp đồng mới cần rà điều khoản." }],
        },
        actor,
      ),
      "Luật tay",
    );
    phai(await saveAccessRoleCore(admin, { id: "", code: "KE_TOAN_HD", name: "Kế toán hợp đồng", description: "Xem khách và hợp đồng", baseRole: "ACCOUNTANT", permissions: ["customers:view", "records:view"], defaultScope: "ALL", active: true }), "Vai trò tuỳ chỉnh");
    phai(await toggleOwnModule(admin, { moduleKey: "products", enabled: true, reason: "diễn tập khôi phục" }), "Bật module Sản phẩm");
    phai(await toggleOwnModule(admin, { moduleKey: "orders", enabled: true, reason: "diễn tập khôi phục" }), "Bật module Đơn hàng");
    phai(await saveStatusOverrides("order", "stage", [{ value: "NEW", label: "Đơn mới nhận", position: 0, active: true }], actor), "Đổi nhãn trạng thái đơn");
    // Form của mẫu sửa tay: hiện ô «Mã nội bộ» ở form tạo hợp đồng rồi xuất bản.
    const form = await getFormDraft("x_contract", "create");
    const coMa: FormSchema = { ...form, sections: form.sections.map((sec) => ({ ...sec, fields: sec.fields.map((f) => (f.ref === "custom:ma_noi_bo" ? { ...f, visible: true } : f)) })) };
    if (!coMa.sections.some((sec) => sec.fields.some((f) => f.ref === "custom:ma_noi_bo"))) coMa.sections[0].fields.push({ ref: "custom:ma_noi_bo", visible: true, readOnly: false, required: false });
    phai(await saveFormDraft("x_contract", "create", coMa, actor), "Sửa form tạo hợp đồng");
    phai(await publishForm("x_contract", "create", actor), "Xuất bản form tạo hợp đồng");

    // ── Dữ liệu + bí mật: KHÔNG được đi theo gói ──
    admin = await quanTri(code);
    phai(await createRecord("x_contract", { system: { title: TIEU_DE_BAN_GHI }, custom: { gia_tri: 987_654_321, ma_noi_bo: GIA_TRI_BAN_GHI } }, admin), "Tạo bản ghi dữ liệu");
    await setSettingJson("lark.webhookUrl", URL_BI_MAT);
    await setSettingJson("integrations.apiToken", { token: BI_MAT });

    // ── PHẠM VI: bảng cấu hình trong CSDL TỔ CHỨC; mặt phẳng điều khiển KHÔNG ở đây ──
    const odb = (await dbm.getDb()) as unknown as DbLike;
    const orgRows = await demNhieu(odb, drill.ORG_CONFIG_TABLES);
    const controlPlaneRowsInOrg = await demNhieu(odb, drill.CONTROL_PLANE_TABLES);
    const orgTableCount = await soBangPublic(odb);
    const customRecords = await soBanGhi(dbm);

    const ex = await exportOrgBlueprint();
    const text = JSON.stringify(ex.blueprint, null, 2);
    const tep = path.join(workDir, exportFileName(ex.blueprint));
    writeFileSync(tep, text);
    return { ex, text, tep, orgRows, controlPlaneRowsInOrg, orgTableCount, customRecords };
  });

  const nhaSau = await demNhieu(pdb, drill.ORG_CONFIG_TABLES);
  const soSau = ((await demMot(pdb, "platform_organizations")) ?? 0) + ((await demMot(pdb, "platform_organization_modules")) ?? 0);
  const homeDelta = {} as SourceEvidence["homeDelta"];
  for (const t of drill.ORG_CONFIG_TABLES) {
    const a = nhaTruoc[t];
    const b = nhaSau[t];
    homeDelta[t] = a === null || b === null ? null : b - a;
  }
  const ev: SourceEvidence = {
    orgCode: code,
    contentHash: ketQua.ex.contentHash,
    fileSha256: sha256(ketQua.text),
    fileBytes: Buffer.byteLength(ketQua.text, "utf8"),
    valid: ketQua.ex.validation.ok,
    counts: ketQua.ex.counts,
    omitted: ketQua.ex.omitted.length,
    lossy: ketQua.ex.lossy.length,
    customRecords: ketQua.customRecords,
    orgRows: ketQua.orgRows,
    homeDelta,
    controlPlaneRowsInOrg: ketQua.controlPlaneRowsInOrg,
    registryDeltaInHome: soSau - soTruoc,
    orgTableCount: ketQua.orgTableCount,
    homeTableCount: await soBangPublic(pdb),
  };
  writeFileSync(path.join(workDir, "nguon.json"), JSON.stringify({ ...ev, file: path.basename(ketQua.tep) }, null, 2));
  console.log(`[diễn-tập] 1/3 NGUỒN: đã xuất ${path.basename(ketQua.tep)} (${ev.fileBytes} byte, băm nội dung ${ev.contentHash}).`);
  process.exit(0);
}

// ═══════════════════════════════ BƯỚC 3 · KHÔI PHỤC ═══════════════════════════════

async function buocKhoiPhuc() {
  const { workDir, code } = kiemMoiTruongCon();
  const { dbm, migrate, context, drill, xoaKhoiSo, capToChuc, quanTri } = await nap();
  const { exportOrgBlueprint } = await import("@/lib/blueprints/export");
  const { installBlueprintFile, previewBlueprintFile } = await import("@/lib/blueprints/import-file");

  const nguon = docJson<SourceEvidence & { file: string }>(path.join(workDir, "nguon.json"));
  const text = readFileSync(path.join(workDir, nguon.file), "utf8");

  await migrate.ensureMigrated();
  const thuMucToChuc = dbm.organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, "");
  const orgDatabaseGone = !existsSync(thuMucToChuc);
  // Mất TRỌN: xoá cả dòng sổ — nếu không, module đang bật đến từ sổ cũ chứ không từ tệp, và phép so băm mù ở vế đó.
  await xoaKhoiSo(code);
  const pdb = await dbm.getPlatformDb();
  const { eq } = await import("drizzle-orm");
  const registryGone = !(await pdb.query.platformOrganizations.findFirst({ where: eq(dbm.schema.platformOrganizations.code, code) }));
  await capToChuc(code);
  console.log(`[diễn-tập] 3/3 KHÔI PHỤC: CSDL cũ ${orgDatabaseGone ? "đã mất" : "VẪN CÒN"} · đã cấp lại «${code}» ở dạng trống.`);

  const ev = await context.withOrganization(code, async (): Promise<RestoreEvidence> => {
    let admin = await quanTri(code);
    const empty = await exportOrgBlueprint();
    const customRecordsBefore = await soBanGhi(dbm);

    const pre = await previewBlueprintFile(admin, text);
    if (!pre.ok) throw new Error(`Tệp không qua kiểm: ${JSON.stringify(pre.errors).slice(0, 400)}`);
    const plan = pre.value.plan;
    const done = await installBlueprintFile(admin, text, { planHash: plan.planHash, resolutions: {} });
    admin = await quanTri(code);

    const ex = await exportOrgBlueprint();
    const again = await previewBlueprintFile(admin, text);
    const reinstallWrites = again.ok ? again.value.plan.counts.CREATE + again.value.plan.counts.UPDATE : -1;
    const forbidden = [BI_MAT, URL_BI_MAT, TIEU_DE_BAN_GHI, GIA_TRI_BAN_GHI, "987654321", MAT_KHAU, `admin@${code}.local`];
    return {
      orgCode: code,
      orgDatabaseGone,
      registryGone,
      fileSha256: sha256(text),
      emptyContentHash: empty.contentHash,
      customRecordsBefore,
      planOk: plan.ok,
      conflicts: plan.counts.CONFLICT,
      blocked: plan.steps.filter((s) => s.action === "BLOCKED").length,
      installOk: done.ok,
      installErrors: done.ok ? [] : done.errors.map((e) => `${e.path}: ${e.message}`),
      contentHash: ex.contentHash,
      valid: ex.validation.ok,
      counts: ex.counts,
      customRecordsAfter: await soBanGhi(dbm),
      reinstallWrites,
      leaks: drill.blueprintLeaks(ex.blueprint, forbidden),
    };
  });
  writeFileSync(path.join(workDir, "khoi-phuc.json"), JSON.stringify(ev, null, 2));
  console.log(`[diễn-tập] 3/3 KHÔI PHỤC: cài từ tệp ${ev.installOk ? "xong" : "THẤT BẠI"} · băm sau khôi phục ${ev.contentHash}.`);
  process.exit(0);
}

// ═══════════════════════════════ ĐIỀU PHỐI ═══════════════════════════════

function chayBuoc(buoc: "nguon" | "khoi-phuc", env: NodeJS.ProcessEnv): number {
  // Gọi thẳng tsx bằng process.execPath, KHÔNG qua shell (AGENTS.md mục 65).
  const cli = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  const r = spawnSync(process.execPath, [cli, "--tsconfig", "tsconfig.json", path.join("scripts", "restore-drill-org-config.ts"), `--buoc=${buoc}`], { env, stdio: "inherit", shell: false, timeout: 900_000 });
  return r.status ?? 1;
}

async function dieuPhoi() {
  const code = argVal("ma") ?? "dt-cauhinh";
  if (!CODE_PATTERN.test(code)) {
    console.error(`[diễn-tập] Mã tổ chức «${code}» không hợp lệ (chữ thường, số, gạch ngang; 2–31 ký tự, bắt đầu bằng chữ).`);
    process.exit(2);
  }
  const giu = flag("giu");
  const dataDir = path.join("data", `${DRILL_DATA_PREFIX}${process.pid}`);
  const orgDir = `${dataDir}-org-${code}`;
  const workDir = path.join("data", `restore-drill-work-${process.pid}`);
  const don = () => {
    for (const d of [dataDir, orgDir, workDir]) rmSync(d, { recursive: true, force: true });
  };
  don();
  mkdirSync(workDir, { recursive: true });
  // KHÔNG đọc .env: một .env trỏ production không được biến lượt diễn tập thành một tổ chức mới trên production.
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: `pglite://${dataDir}`, ERP_RESTORE_DRILL_DATA: dataDir, ERP_RESTORE_DRILL_WORK: workDir, ERP_RESTORE_DRILL_CODE: code };
  delete env.ERP_READ_ONLY;
  for (const k of Object.keys(env)) if (k.startsWith("ORG_DATABASE_URL__")) delete env[k];

  const t0 = Date.now();
  let ma = 1;
  try {
    console.log(`[diễn-tập] Diễn tập khôi phục CẤU HÌNH tổ chức «${code}» — PGlite riêng ${dataDir}`);
    if (chayBuoc("nguon", env) !== 0) throw new Error("Bước NGUỒN thất bại (xem log phía trên).");
    // ── 2 · MẤT CSDL: xoá thư mục PGlite của tổ chức (không tiến trình nào đang mở nó) ──
    const coTruoc = existsSync(orgDir);
    rmSync(orgDir, { recursive: true, force: true });
    console.log(`[diễn-tập] 2/3 MẤT: ${coTruoc ? "đã xoá" : "KHÔNG THẤY"} CSDL tổ chức ${orgDir}.`);
    if (chayBuoc("khoi-phuc", env) !== 0) throw new Error("Bước KHÔI PHỤC thất bại (xem log phía trên).");

    const { judgeConfigRestoreDrill } = await import("@/lib/blueprints/restore-drill");
    const nguon = docJson<SourceEvidence & { file: string }>(path.join(workDir, "nguon.json"));
    const kp = docJson<RestoreEvidence>(path.join(workDir, "khoi-phuc.json"));
    const v = judgeConfigRestoreDrill(nguon, kp);
    const dong = (ten: string, gt: string) => console.log(`  ${ten.padEnd(34)} ${gt}`);
    console.log("\n══════ BÁO CÁO DIỄN TẬP KHÔI PHỤC CẤU HÌNH ══════");
    dong("Tổ chức thử", code);
    dong("Tệp gói", `${nguon.file} · ${nguon.fileBytes} byte · sha256 ${nguon.fileSha256.slice(0, 16)}…`);
    dong("Mục trong gói", Object.entries(nguon.counts).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(" · "));
    dong("Không đi theo / thiếu một phần", `${nguon.omitted} / ${nguon.lossy}`);
    dong("Băm nội dung — NGUỒN", nguon.contentHash);
    dong("Băm nội dung — tổ chức TRỐNG", kp.emptyContentHash);
    dong("Băm nội dung — SAU KHÔI PHỤC", `${kp.contentHash} ${kp.contentHash === nguon.contentHash ? "(= nguồn)" : "(≠ NGUỒN)"}`);
    dong("Kế hoạch cài", `hợp lệ ${kp.planOk ? "có" : "KHÔNG"} · xung đột ${kp.conflicts} · bị chặn ${kp.blocked}`);
    dong("Cài lại cùng tệp", `${kp.reinstallWrites} mục phải ghi`);
    dong("Bản ghi dữ liệu nguồn → sau", `${nguon.customRecords} → ${kp.customRecordsAfter} (blueprint KHÔNG mang dữ liệu — đúng thiết kế)`);
    dong("Rò bí mật / email / id", kp.leaks.length ? kp.leaks.join(" · ") : "không");
    dong("Bảng cấu hình trong CSDL tổ chức", nguon.orgRows ? Object.entries(nguon.orgRows).filter(([, n]) => (n ?? 0) > 0).map(([k, n]) => `${k} ${n}`).join(" · ") : "—");
    dong("Dòng THÊM ở CSDL nhà (cùng bảng)", String(Object.values(nguon.homeDelta).reduce<number>((s, n) => s + (n ?? 0), 0)));
    dong("Mặt phẳng điều khiển trong CSDL tổ chức", String(Object.values(nguon.controlPlaneRowsInOrg).reduce<number>((s, n) => s + (n ?? 0), 0)));
    dong("Sổ tổ chức + module ở CSDL nhà", `+${nguon.registryDeltaInHome} dòng`);
    dong("Số bảng public: tổ chức / nhà", `${nguon.orgTableCount} / ${nguon.homeTableCount}`);
    dong("Thời gian", `${Math.round((Date.now() - t0) / 1000)} giây`);
    if (v.ok) {
      console.log("\nKẾT QUẢ: ĐẠT — cấu hình khôi phục từ tệp vào tổ chức trống cùng mã khớp băm với nguồn.");
      ma = 0;
    } else {
      console.log("\nKẾT QUẢ: KHÔNG ĐẠT");
      for (const f of v.failures) console.log(`  ✗ ${f}`);
    }
  } catch (error) {
    console.error(`[diễn-tập] ${error instanceof Error ? error.message : String(error)}`);
    console.log("\nKẾT QUẢ: KHÔNG ĐẠT");
  } finally {
    if (giu) console.log(`[diễn-tập] --giu: giữ ${dataDir}, ${orgDir}, ${workDir}`);
    else don();
  }
  process.exit(ma);
}

const buoc = argVal("buoc");
const chay = buoc === "nguon" ? buocNguon : buoc === "khoi-phuc" ? buocKhoiPhuc : buoc === undefined ? dieuPhoi : null;
if (!chay) {
  console.error("Dùng: scripts/restore-drill-org-config.ts [--ma=<mã>] [--giu]");
  process.exit(2);
}
chay().catch((error) => {
  console.error(error);
  process.exit(1);
});
