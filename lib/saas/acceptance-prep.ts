/**
 * ═══════════ NGHIỆM THU — BƯỚC P «CHUẨN BỊ WORKSPACE THỬ» (`saas-acceptance --apply --prep`, docs/saas/ACCEPTANCE.md §3) ═══════════
 *
 * Bước D (chat web → AI → đơn) và E (chat công khai theo tên miền con) cần một lần chuẩn bị: sản phẩm mẫu + hàng trong kho + bot bật +
 * tên miền con đã xuất bản. Tới 08/10/2026 đó là việc NGƯỜI làm trên UI («ops không ghi hộ»). Ngày 09/10/2026 chủ shop quyết định
 * («Giao diện thế nào bạn cứ làm theo phương án tốt nhất») cho ops làm hộ — CHỈ cho workspace nghiệm thu của sổ khai. Tệp này là chỗ
 * DUY NHẤT ops nghiệm thu ghi vào bên trong workspace; lõi `lib/saas/acceptance.ts` vẫn không nhập một lõi ghi nào (allowlist ở
 * tests/saas-acceptance.test.ts), nó chỉ gọi `runAcceptancePrep`.
 *
 * ─── BA LÁ CHẮN, TRƯỚC MỌI LƯỢT GHI (cùng bộ với `createAcceptanceResetLink`) ───
 *  1. Lúc chạy: chỉ tiến trình ops (`acceptanceRuntimeRefusal` — máy chủ ứng dụng không mở được đường này).
 *  2. Sổ khai: mã phải là một mục của `ACCEPTANCE_WORKSPACES` — mục do SỔ trả, không nhận cấu hình từ người gọi.
 *  3. Sở hữu: workspace mang mã ấy phải do CHÍNH ops tạo (`acceptanceWorkspaceOwned` — job khoá cố định + tài khoản đúng sổ). Khách
 *     thật trùng mã (kho PUBLIC) ⇒ từ chối, không một dòng nào.
 *
 * ─── ĐỨNG TÊN AI ───
 * Tài khoản CHỦ của chính workspace thử (email trong sổ khai, tra qua chỉ mục danh tính như bước C) — KHÔNG phải người vận hành nền
 * tảng ghi vào tổ chức, KHÔNG phải một khách thật. Người dùng phiên dựng bằng ĐÚNG đường nhanh của `resolveCurrentUser` (vai trò +
 * mẫu quyền + ảnh chụp quyền + tổ chức + module); tài khoản đã bị thu hẹp phạm vi / gán vai trò tuỳ chỉnh ⇒ không dựng quyền thay bộ
 * tính quyền, mọi việc BỎ QUA (mọi nhánh lỗi rơi về phía HẸP — AGENTS 31).
 *
 * ─── MỖI VIỆC ĐI QUA ĐÚNG LÕI CỦA NÚT TRÊN UI ───
 *  · Sản phẩm mẫu: `createProductCore` (Sản phẩm → Tạo sản phẩm).
 *  · Phiếu nhập: `writeStockReceiptCore` — lõi của «Nhập hàng» (`createStockReceipt`) và của «tồn đầu» khi nhập sản phẩm từ tệp; định
 *    giá theo ĐÚNG chế độ giá nhập của tổ chức (giá báo MKT, hoặc khai tay — ở đây bỏ trống = CHƯA BIẾT giá, không bịa giá vốn —
 *    AGENTS 42). Tồn chỉ vào qua phiếu (AGENTS §3.10), khả dụng đo bằng ĐÚNG biểu thức của sổ kho (`availableStockExpr`).
 *  · Bot: `saveSalesChatbotConfig` (AI Sales → Lưu) với đúng hình đầu vào của form KHÁCH (`customerChatbotConfig` — không ô động cơ
 *    AI: nguồn AI / model là của người vận hành). AI theo gói chưa sẵn sàng ⇒ BỎ QUA kèm đúng phần thiếu; KHÔNG đổi cấu hình AI nền tảng.
 *  · Xuất bản: `setDomainSlug` + `publishOrganization` (/setup → Tên miền con → Xuất bản).
 *
 * IDEMPOTENT: có rồi ⇒ CÓ SẴN, không làm lại (SKU đã có ⇒ không tạo bản hai; khả dụng ≥ mức tối thiểu ⇒ không phiếu; thiếu ⇒ MỘT phiếu
 * đúng phần chênh; bot đã bật đủ công cụ + giờ mở ⇒ không lưu; đã xuất bản đúng tên miền ⇒ không bấm). KHÔNG gọi AI trả tiền.
 */
import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { platformChatAi } from "@/lib/ai-builder/provider";
import { audit } from "@/lib/audit";
import { findIdentity } from "@/lib/auth/identities";
import { resolvePermissions } from "@/lib/auth/permissions";
import { can, loadPermissionSnapshots, loadRoleTemplates, type SessionUser } from "@/lib/auth/session";
import { connectionIsActive } from "@/lib/connectors/service";
import { normalizeScope } from "@/lib/constants/access-scope";
import type { Actor } from "@/lib/constants/actor";
import { ACCEPTANCE_ACTOR_LABEL, ACCEPTANCE_SAMPLE_PRODUCTS, acceptanceWorkspaceOf, type AcceptanceWorkspace, type PrepItemKey, type PrepItemResult, type PrepStatus } from "@/lib/constants/saas-acceptance";
import { todayVN, vnStartOfDay } from "@/lib/format";
import { writeStockReceiptCore } from "@/lib/inventory/receipt-create";
import { priceReceiptLines, receiptPricingModeFor } from "@/lib/inventory/receipt-pricing";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { findOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { publicationOf, publishOrganization, setDomainSlug } from "@/lib/platform/publish";
import { availableStockExpr, stockKnownExpr, variantReceiptsSubquery, variantSalesSubquery } from "@/lib/queries/stock";
import { createProductCore } from "@/lib/records/product-create";
import { acceptanceRuntimeRefusal, acceptanceWorkspaceOwned, ACCEPTANCE_NOT_OWNED_REFUSAL } from "@/lib/saas/acceptance-guard";
import { customerChatbotConfig } from "@/lib/saas/visibility";
import type { SalesChatbotConfig } from "@/lib/sales-chatbot/config";
import { loadSalesChatbotConfig } from "@/lib/sales-chatbot/engine";
import { saveSalesChatbotConfig } from "@/lib/sales-chatbot/settings";
import { stockReceiptSchema } from "@/lib/validation/stock";

/** Câu từ chối khi mã không phải một mục của sổ khai — không lặp lại mã đã gõ. */
export const ACCEPTANCE_PREP_REGISTRY_REFUSAL = "Chuẩn bị nghiệm thu chỉ chạy trên workspace có tên trong sổ khai (lib/constants/saas-acceptance-registry.ts).";

/** Ba công cụ bước D cần (tìm → lên nháp → chốt) — CÙNG danh sách `readE2ePrep` của lõi kiểm. */
export const ACCEPTANCE_PREP_REQUIRED_TOOLS = ["search_products", "create_draft_order", "confirm_order"] as const satisfies readonly SalesChatbotConfig["allowedTools"][number][];

export type AcceptancePrepReport = { refused: string } | { items: PrepItemResult[] };

const item = (key: PrepItemKey, status: PrepStatus, why: string): PrepItemResult => ({ key, status, why });

function firstLine(error: unknown): string {
  const s = error instanceof Error ? error.message : String(error);
  return (s.split("\n")[0] ?? "").slice(0, 300);
}

/** Giờ làm việc của bot luôn mở: tắt giờ làm việc, HOẶC 24/7 (giờ bắt đầu = giờ kết thúc, đủ bảy ngày — `withinBusinessHours`). */
function alwaysOpen(bh: SalesChatbotConfig["businessHours"]): boolean {
  return !bh.enabled || (bh.start === bh.end && new Set(bh.days).size === 7);
}

/**
 * Chạy bước P cho workspace `code` của sổ khai. Không bao giờ ném: mỗi việc tự bắt lỗi thành HỎNG. `refused` = một lá chắn từ chối —
 * KHÔNG có lượt ghi nào.
 */
export async function runAcceptancePrep(code: string, opts: { runId: string }): Promise<AcceptancePrepReport> {
  const runtime = acceptanceRuntimeRefusal();
  if (runtime) return { refused: runtime };
  const entry = acceptanceWorkspaceOf(code);
  if (!entry) return { refused: ACCEPTANCE_PREP_REGISTRY_REFUSAL };
  if (!(await acceptanceWorkspaceOwned(entry))) return { refused: ACCEPTANCE_NOT_OWNED_REFUSAL };
  invalidateOrganizations();
  const org = await findOrganization(entry.code);
  if (!org || org.isHome || org.status !== "ACTIVE") return { refused: `workspace nghiệm thu ${org ? `đang ${org.status}${org.isHome ? " · LÀ NHÀ" : ""}` : "không có"} — không chuẩn bị` };
  return withOrganization(entry.code, async () => {
    invalidateCapabilities(entry.code);
    const owner = await ownerSessionUser(entry);
    if ("error" in owner) return { items: (["PRODUCT", "STOCK", "BOT", "PUBLISH"] as const).map((k) => item(k, "SKIPPED", owner.error)) };
    const items: PrepItemResult[] = [];
    const guarded = async (key: PrepItemKey, fn: () => Promise<PrepItemResult>): Promise<PrepItemResult> => {
      try {
        return await fn();
      } catch (error) {
        return item(key, "FAILED", `lỗi không lường trước: ${firstLine(error)}`);
      }
    };
    let variantId: string | null = null;
    items.push(
      await guarded("PRODUCT", async () => {
        const r = await prepProduct(owner.user);
        variantId = r.variantId;
        return r.result;
      }),
    );
    const vid = variantId;
    items.push(vid ? await guarded("STOCK", () => prepStock(owner.user, vid, opts.runId)) : item("STOCK", "SKIPPED", "không có mẫu mã mẫu dùng được (xem dòng sản phẩm mẫu) — không lập phiếu"));
    items.push(await guarded("BOT", () => prepBot(owner.user, entry)));
    items.push(await guarded("PUBLISH", () => prepPublish(owner.user, entry)));
    return { items };
  });
}

/**
 * Người dùng phiên của tài khoản CHỦ workspace thử — đường nhanh của `resolveCurrentUser` (phạm vi ALL, không vai trò tuỳ chỉnh): vai trò
 * + quyền gõ tay + mẫu quyền của tổ chức + ảnh chụp quyền, tổ chức + module bật. Gọi TRONG `withOrganization`.
 */
export async function ownerSessionUser(entry: AcceptanceWorkspace): Promise<{ user: SessionUser } | { error: string }> {
  // Tài khoản chủ: tra qua chỉ mục danh tính (như bước C ký phiên), rồi đọc ĐÚNG dòng users của workspace thử.
  const userId = (await findIdentity("EMAIL", entry.ownerEmail)).find((h) => h.orgCode === entry.code)?.userId ?? null;
  if (!userId) return { error: "không có chỉ mục danh tính của tài khoản chủ workspace thử — chạy --apply (bước A / B1) trước" };
  const db = await getDb();
  const row = await db.query.users.findFirst({
    where: eq(schema.users.id, userId),
    columns: { id: true, email: true, name: true, role: true, active: true, permissions: true, accessRoleId: true, positionId: true, dataScope: true },
  });
  if (!row || row.email.trim().toLowerCase() !== entry.ownerEmail) return { error: "chỉ mục danh tính trỏ tới một tài khoản không phải chủ trong sổ khai — không đứng tên ai cả" };
  if (!row.active) return { error: "tài khoản chủ workspace thử đang KHOÁ — không đứng tên một tài khoản bị khoá" };
  const scope = normalizeScope(row.dataScope);
  if (scope !== "ALL" || row.accessRoleId) return { error: "tài khoản chủ đã bị thu hẹp phạm vi / gán vai trò tuỳ chỉnh — chuẩn bị không tự dựng quyền thay bộ tính quyền, làm tay theo ACCEPTANCE.md §3" };
  const [templates, snapshots, org, modules] = await Promise.all([loadRoleTemplates(), loadPermissionSnapshots(), findOrganization(entry.code), getEnabledModules(entry.code)]);
  return {
    user: {
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role,
      permissions: resolvePermissions(row.role, row.permissions, templates, snapshots[row.id] ?? null),
      scope,
      departmentCodes: [],
      positionId: row.positionId ?? null,
      organization: { code: entry.code, name: org?.name ?? entry.code, isHome: false, brand: org?.brand ?? null },
      modules: [...modules],
    },
  };
}

// ─────────────────────────── Sản phẩm mẫu ───────────────────────────

async function prepProduct(owner: SessionUser): Promise<{ result: PrepItemResult; variantId: string | null }> {
  const sample = ACCEPTANCE_SAMPLE_PRODUCTS[0];
  const db = await getDb();
  const pv = schema.productVariants;
  // So SKU như lõi tạo sản phẩm so trùng (không phân biệt hoa thường, bỏ khoảng trắng) — có rồi thì KHÔNG tạo bản hai.
  const rows = await db
    .select({ id: pv.id, price: pv.retailPrice, removed: pv.isRemoved, hidden: pv.isHidden })
    .from(pv)
    .where(sql`lower(btrim(${pv.sku})) = ${sample.sku.trim().toLowerCase()}`)
    .limit(5);
  if (rows.length) {
    const live = rows.filter((r) => !r.removed && !r.hidden);
    if (live.length !== 1) return { result: item("PRODUCT", "FAILED", live.length ? `có ${live.length} mẫu mã đang bán cùng SKU ${sample.sku} — gỡ bản thừa ở Sản phẩm (chuẩn bị không xoá)` : `SKU ${sample.sku} đã có nhưng mẫu mã đang ẩn / gỡ — bật lại ở Sản phẩm (chuẩn bị không sửa)`), variantId: null };
    if (live[0].price !== sample.priceVnd) return { result: item("PRODUCT", "FAILED", `SKU ${sample.sku} giá ${live[0].price.toLocaleString("vi-VN")} ₫, sổ khai ${sample.priceVnd.toLocaleString("vi-VN")} ₫ — sửa giá ở Sản phẩm (chuẩn bị không ghi đè dữ liệu đã có)`), variantId: null };
    return { result: item("PRODUCT", "ALREADY", `SKU ${sample.sku} có sẵn (mẫu mã ${live[0].id}) · giá ${sample.priceVnd.toLocaleString("vi-VN")} ₫ — không tạo thêm`), variantId: live[0].id };
  }
  // ĐÚNG lõi của «Sản phẩm → Tạo sản phẩm» (cổng module · không nguồn đồng bộ · quyền products:write · trùng SKU · nhật ký).
  const r = await createProductCore(owner, {
    name: sample.name,
    code: sample.sku,
    unit: "cái",
    retailPrice: sample.priceVnd,
    cost: null,
    variants: [{ sku: sample.sku, size: "", color: "", retailPrice: sample.priceVnd, cost: null, selling: true }],
  });
  if (!r.ok) return { result: item("PRODUCT", "FAILED", `lõi tạo sản phẩm từ chối (${r.code}): ${r.errors.map((e) => e.message).join(" · ").slice(0, 300)}`), variantId: null };
  const variantId = r.variantIds?.[0] ?? null;
  if (!variantId) return { result: item("PRODUCT", "FAILED", `sản phẩm ${r.id} tạo xong mà không có mẫu mã`), variantId: null };
  return { result: item("PRODUCT", "DONE", `tạo «${sample.name}» SKU ${sample.sku} · ${sample.priceVnd.toLocaleString("vi-VN")} ₫ · sản phẩm ${r.id} · mẫu mã ${variantId}`), variantId };
}

// ─────────────────────────── Phiếu nhập (tồn khả dụng ≥ mức tối thiểu) ───────────────────────────

/** Tồn khả dụng của MỘT mẫu mã bằng ĐÚNG biểu thức sổ kho (lib/queries/stock.ts — cùng chỗ bot đọc khi chốt đơn). */
async function availableOf(variantId: string): Promise<{ known: boolean; available: number }> {
  const db = await getDb();
  const pv = schema.productVariants;
  const sales = variantSalesSubquery(db, [variantId]);
  const receipts = variantReceiptsSubquery(db, [variantId]);
  const [row] = await db
    .select({ known: stockKnownExpr(receipts), available: availableStockExpr(sales, receipts) })
    .from(pv)
    .leftJoin(sales, eq(sales.variantId, pv.id))
    .leftJoin(receipts, eq(receipts.variantId, pv.id))
    .where(eq(pv.id, variantId));
  return { known: Boolean(row?.known), available: Number(row?.available ?? 0) };
}

async function prepStock(owner: SessionUser, variantId: string, runId: string): Promise<PrepItemResult> {
  const sample = ACCEPTANCE_SAMPLE_PRODUCTS[0];
  const before = await availableOf(variantId);
  if (before.known && before.available >= sample.minStock) return item("STOCK", "ALREADY", `tồn khả dụng ${sample.sku} = ${before.available} ≥ ${sample.minStock} — không lập phiếu`);
  const quantity = sample.minStock - (before.known ? Math.min(before.available, sample.minStock) : 0);
  if (!can(owner, "inventory:write")) return item("STOCK", "SKIPPED", "tài khoản chủ không có quyền nhập kho (inventory:write) — nhập hàng tay");
  const db = await getDb();
  const note = `${ACCEPTANCE_ACTOR_LABEL} ${runId} — bù tồn sản phẩm mẫu cho bước chat → đơn (docs/saas/ACCEPTANCE.md §3)`;
  const reference = `Nghiệm thu · ${runId}`.slice(0, 120);
  // CÙNG lược đồ với form «Nhập hàng» — đầu vào sai thì từ chối như form từ chối.
  const parsed = stockReceiptSchema.safeParse({ kind: "RECEIPT", receivedAt: todayVN(), reference, supplier: "", note, items: [{ variantId, quantity, unitCost: 0 }] });
  if (!parsed.success) return item("STOCK", "FAILED", `phiếu nhập sai lược đồ: ${parsed.error.issues[0]?.message ?? "không hợp lệ"}`);
  const receivedAt = vnStartOfDay(parsed.data.receivedAt);
  // Định giá theo ĐÚNG chế độ của tổ chức (như «Nhập hàng» + «tồn đầu»): giá báo MKT, hoặc khai tay — bỏ trống = CHƯA BIẾT (0), không bịa.
  const pricing = await receiptPricingModeFor(db, { isHome: false });
  const priced = pricing.mode === "MKT_QUOTE" ? await priceReceiptLines(db, [variantId], receivedAt) : null;
  const unitCost = priced ? (priced.price.get(variantId) ?? 0) : 0;
  const lines = [{ variantId, quantity, unitCost, shipmentId: null }];
  const actor: Actor = { id: owner.id, label: owner.name || owner.email };
  const ghi = await writeStockReceiptCore(db, {
    kind: "RECEIPT",
    receipt: { receivedAt, reference: parsed.data.reference, supplier: "", note: parsed.data.note, totalQuantity: quantity, totalCost: quantity * unitCost, createdBy: actor.label },
    lines,
    note: parsed.data.note,
    actor,
    approver: { id: owner.id, email: owner.email },
    gate: null,
  });
  if ("error" in ghi) return item("STOCK", "FAILED", `lõi ghi phiếu kho từ chối: ${ghi.error}`);
  await audit({
    userId: owner.id,
    userEmail: owner.email,
    action: "STOCK_RECEIPT_CREATE",
    entity: "STOCK_RECEIPT",
    entityId: ghi.receiptId,
    detail: { kind: "RECEIPT", reference, note, items: lines, totalQuantity: quantity, totalCost: quantity * unitCost, priceSource: pricing.mode === "MKT_QUOTE" ? "MARKETER_PRICE" : "MANUAL_ENTRY", priceModeSource: pricing.source, missingPrice: unitCost ? [] : [sample.sku], source: "SAAS_ACCEPTANCE_PREP" },
  });
  const after = await availableOf(variantId);
  return item("STOCK", "DONE", `phiếu nhập ${ghi.receiptId}: +${quantity} ${sample.sku} (trước ${before.known ? before.available : "chưa có phiếu nhập"}) ⇒ khả dụng ${after.available}${unitCost ? "" : " · đơn giá CHƯA BIẾT (0)"}`);
}

// ─────────────────────────── Bot ───────────────────────────

async function prepBot(owner: SessionUser, entry: AcceptanceWorkspace): Promise<PrepItemResult> {
  if (!(await getEnabledModules(entry.code)).has("ai_sales")) return item("BOT", "SKIPPED", "module AI bán hàng của workspace đang tắt — bật module là việc của người vận hành, chuẩn bị không đổi");
  const cfg = await loadSalesChatbotConfig();
  const missingTools = ACCEPTANCE_PREP_REQUIRED_TOOLS.filter((t) => !cfg.allowedTools.includes(t));
  if (cfg.enabled && !missingTools.length && alwaysOpen(cfg.businessHours)) return item("BOT", "ALREADY", "bot đang bật · đủ công cụ tìm / lên nháp / chốt · giờ làm việc luôn mở — không lưu lại");
  // ĐÚNG hình đầu vào của form KHÁCH (không ô động cơ AI) — lõi giữ nguồn AI / model đang lưu; chỉ đổi: bật, thêm công cụ thiếu, giờ luôn mở.
  const next = {
    ...customerChatbotConfig(cfg),
    enabled: true,
    allowedTools: [...cfg.allowedTools, ...missingTools],
    businessHours: alwaysOpen(cfg.businessHours) ? cfg.businessHours : { ...cfg.businessHours, enabled: false },
  };
  const r = await saveSalesChatbotConfig(owner, next);
  if (r.ok) return item("BOT", "DONE", `bật bot${missingTools.length ? ` · thêm công cụ ${missingTools.join(", ")}` : ""}${alwaysOpen(cfg.businessHours) ? "" : " · tắt giờ làm việc"} (nguồn AI giữ nguyên: ${cfg.connectorKey})`);
  if (!r.error.startsWith("Chưa bật được bot")) return item("BOT", "FAILED", `lõi lưu cấu hình bot từ chối: ${r.error}`);
  // Câu của lõi cho KHÁCH cố ý không kỹ thuật — phần MÃ HOÁ nói ĐÚNG chỗ thiếu cho người vận hành (không gọi AI, không đổi cấu hình AI).
  const why =
    cfg.connectorKey === "platform"
      ? await platformChatAi(entry.code).then((p) => (p.ok ? r.error : p.reason))
      : (await connectionIsActive(cfg.connectorKey))
        ? r.error
        : `khoá AI «${cfg.connectorKey}» của workspace chưa bật`;
  return item("BOT", "SKIPPED", `AI của bot chưa sẵn sàng: ${why} — người vận hành cấu hình «AI của workspace» ở /platform/org/${entry.code}; chuẩn bị KHÔNG đổi cấu hình AI nền tảng`);
}

// ─────────────────────────── Xuất bản tên miền con ───────────────────────────

async function prepPublish(owner: SessionUser, entry: AcceptanceWorkspace): Promise<PrepItemResult> {
  const pub = await publicationOf(entry.code);
  if (pub.state === "PUBLISHED") {
    return pub.slug === entry.domainSlug
      ? item("PUBLISH", "ALREADY", `đã xuất bản ở tên miền con ${pub.slug} — không bấm lại`)
      : item("PUBLISH", "FAILED", `đã xuất bản với tên miền con ${pub.slug ?? "—"}, sổ khai ${entry.domainSlug} — tên miền đã khoá sau xuất bản, chuẩn bị không đổi`);
  }
  // ĐÚNG hai lõi của /setup: chọn tên miền con (chỉ lúc NHÁP) → Xuất bản (kiểm lại toàn bộ danh sách chặn).
  const slug = await setDomainSlug(owner, entry.domainSlug);
  if (!slug.ok) return item("PUBLISH", "FAILED", `chọn tên miền con bị từ chối: ${slug.error}`);
  const done = await publishOrganization(owner);
  if (!done.ok) return item("PUBLISH", "FAILED", `xuất bản bị từ chối: ${done.error}`.slice(0, 500));
  return item("PUBLISH", "DONE", `tên miền con ${entry.domainSlug} · ${done.message}`);
}

