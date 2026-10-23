/**
 * ═══════════ MIGRATION MÀ MÃ ĐANG CHẠY PHỤC VỤ ĐƯỢC KHI NÓ CHƯA ÁP — SỔ KHAI TƯỜNG MINH (chủ shop 12/10/2026) ═══════════
 *
 * Sự cố: migration 0245 quá trần 600 giây ở CSDL tổ chức `qa` (fanpage thật, 959 hội thoại, ~321 tin khách / 24 giờ) ⇒ mở CSDL tổ chức
 * ném lỗi ⇒ cả workspace SẬP từ 02:16. Chủ shop chọn «Serve with old schema»: phục hồi workspace NGAY bằng lược đồ hiện có — là biện pháp
 * TẠM, 0245 vẫn phải áp xong.
 *
 * Luật (db/index.ts::getOrgDb, `orgMigrationDegradeDecision`): một tổ chức được phục vụ ở trạng thái `DEGRADED_MIGRATION` CHỈ khi
 *  (1) lượt migrate hỏng vì HẾT GIỜ (statement timeout · lock timeout · bị huỷ · khoá migrate bận quá trần) — lỗi SQL thật vẫn ném như cũ;
 *  (2) MỌI migration còn thiếu của CSDL đó đều có trong sổ này — thiếu một mục ngoài sổ ⇒ ném như cũ.
 * Không nuốt lỗi migration chung chung: thêm một mục vào đây là KHẲNG ĐỊNH «mã đang chạy chạy đúng khi mục này CHƯA áp», và khẳng định
 * đó phải có bài kiểm thật (`proof`) dựng CSDL dừng NGAY TRƯỚC mục ấy rồi chạy các đường đọc / ghi chạm tới phần nó đổi.
 *
 * `addedColumns`: cột mà mục thêm vào. Mã KHÔNG được đọc / ghi chúng theo kiểu ngầm — drizzle `insert(bảng)` liệt kê MỌI cột của lược đồ
 * (cột không gán ghi `default`) và `select().from(bảng)` đọc MỌI cột theo tên ⇒ «column does not exist» trên lược đồ cũ. Đường đọc / ghi
 * hàng của bảng đó đi qua `compatTableColumns()` (lib/db/serve-compat-columns.ts), và bài kiểm quét mã nguồn chặn hai dạng ngầm kia.
 */

export type ServeCompatEntry = {
  /** Tag trong drizzle/meta/_journal.json. */
  tag: string;
  /** Vì sao mã đang chạy chạy đúng khi mục này CHƯA áp. */
  why: string;
  /** Bảng ⇒ cột (tên CSDL) mà mục thêm vào. */
  addedColumns: Readonly<Record<string, readonly string[]>>;
  /** Bài kiểm chứng minh. */
  proof: string;
};

export const MIGRATION_SERVE_COMPAT: readonly ServeCompatEntry[] = [
  {
    tag: "0245_sales_chat_last_inbound",
    why:
      "Chỉ THÊM hai cột lưu sẵn trên sales_chat_conversations + chỉ mục + hàm + trigger; không đổi / xoá cột nào mã đang đọc. Hộp thư tự " +
      "lùi về tính trực tiếp bằng `latestCustomerTurnUnhandledSql()` của #803 khi CSDL chưa có hai cột (`inboxUnreadMaterialized` hỏi " +
      "information_schema) — cùng định nghĩa, chỉ chậm hơn. Đường đọc / ghi hàng hội thoại dùng `compatTableColumns()` nên không nhắc tới " +
      "hai cột. Thiếu trigger ⇒ không ai ghi hai cột ⇒ không có giá trị cũ nào sai khi 0245 áp sau (nó tự dẫn xuất).",
    addedColumns: { sales_chat_conversations: ["turn_unhandled", "last_read_at"] },
    proof: "tests/migration-serve-compat.test.ts",
  },
  {
    tag: "0246_cogs_basis_marketer_price",
    why:
      "Chỉ NỚI hai ràng buộc CHECK (thêm căn cứ 'MARKETER_PRICE'), không thêm / đổi / xoá cột nào. Nơi ghi căn cứ ấy " +
      "(`rematerializeOutcomes`; ghi huỷ bỏ hàng hoàn — `unitCostEstimate` VÀ nhánh dùng giá chụp từ hàng đợi) hỏi " +
      "`constraintAllowsMarketerPrice()` trước: lược đồ cũ ⇒ không " +
      "ghi căn cứ mới, lùi về bậc thang chứng từ kho như trước 13/10/2026 — chạy đúng, chỉ chưa áp luật giá báo cho giá vốn GHI NHẬN. " +
      "Giá vốn sống (`ORDER_COGS`, `LINE_UNIT_COST`) không chạm ràng buộc nào nên vẫn theo giá báo. 0246 áp sau ⇒ lượt dựng lại kế tiếp tự đúng.",
    addedColumns: {},
    proof: "tests/cost-center.test.ts",
  },
  {
    tag: "0247_sales_chat_inbound_text_hash_idx",
    why:
      "Chỉ THÊM một chỉ mục hash (chữ chuẩn hoá của PAGE_REPLY) — không cột, không ràng buộc, không hàm. Mã không nhắc tên chỉ mục; " +
      "planner dùng nó khi có, quét như trước khi chưa có ⇒ cùng kết quả, chỉ chậm hơn. Ở `qa` chỉ mục được tạo TRƯỚC (ops " +
      "org-0245-index-preseed) nên 0247 không làm gì; ở tổ chức khác lượt hỏng vì khoá bận (55P03) được phục vụ tạm thay vì đứng 30 phút.",
    addedColumns: {},
    proof: "tests/migration-serve-compat.test.ts",
  },
  {
    tag: "0248_org_migration_status",
    why:
      "Chỉ TẠO một bảng mặt phẳng điều khiển mới (platform_org_migration_status) — không thêm / đổi / xoá cột của bảng nào mã đang đọc. " +
      "Bảng chỉ được đọc / ghi ở CSDL NHÀ (sổ trạng thái trong db/migrate.ts); bản ở CSDL tổ chức không đường nào chạm tới, kể cả bước " +
      "dọn `platform_*` — bước đó chỉ chạy SAU một lượt migrate thành công, tức là khi bảng đã có. CSDL tổ chức thiếu 0248 vì lượt migrate " +
      "hết giờ vẫn phục vụ được y như trước.",
    addedColumns: {},
    proof: "tests/org-migrate-isolation.test.ts",
  },
  {
    tag: "0249_product_marketer_assignments",
    why:
      "Chỉ TẠO hai bảng mới (product_marketer_assignments, product_bonus_terms) — không thêm / đổi / xoá cột của bảng nào mã đang đọc. " +
      "Hai đường đọc (`loadCodeBook`, `listCodeBook`) bắt lỗi bảng chưa có (42P01) và trả sổ RỖNG — đúng nghĩa: chưa áp 0249 thì chưa " +
      "ai được phân công, nên bảng lương chạy y như trước Payroll V2 (không khoản thưởng theo mã, không khoản chờ). Đường GHI phân công " +
      "báo lỗi CSDL cho tới khi 0249 áp — không ghi được thì không có gì sai để sửa sau.",
    addedColumns: {},
    proof: "tests/payroll-code-ledger.test.ts",
  },
  {
    tag: "0250_payroll_code_pending",
    why:
      "Chỉ NỚI ràng buộc trạng thái (thêm 'PENDING'), thêm CHECK «APPROVED phải có mốc duyệt» và đổi MẶC ĐỊNH cột status — không " +
      "thêm / đổi kiểu / xoá cột nào. Đường đọc (`loadCodeBook` chỉ lấy APPROVED, `listCodeBook` đọc mọi cột đã có từ 0249) chạy " +
      "y như cũ trên lược đồ 0249. Đường GHI phân công / điều khoản (chèn dòng PENDING) báo lỗi ràng buộc cho tới khi 0250 áp — " +
      "không ghi được thì không có gì sai để sửa sau, và không dòng nào được áp vào lương mà chưa duyệt.",
    addedColumns: {},
    proof: "tests/payroll-recon-center.test.ts",
  },
  {
    tag: "0251_platform_webhook_rejections",
    why:
      "Chỉ TẠO một bảng mới ở CSDL nhà (platform_webhook_rejections) — không thêm / đổi / xoá cột của bảng nào mã đang đọc. Đường " +
      "GHI (`noteWebhookRejection`) bắt mọi lỗi kể cả bảng chưa có và trả false — webhook không bao giờ trả lỗi vì sổ đếm; đường ĐỌC " +
      "(`webhookRejectionSummary`) trả null = CHƯA ĐO được, /platform in «chưa đo» chứ không in 0.",
    addedColumns: {},
    proof: "tests/messenger-webhook-rejections.test.ts",
  },
  {
    tag: "0252_ai_usage_workloads",
    why:
      "Chỉ NỚI ràng buộc CHECK của platform_ai_usage.workload — không thêm / đổi / xoá cột. Mã ghi một loại việc MỚI lên lược đồ chưa áp " +
      "mục này thì vi phạm ràng buộc cũ: `recordAiUsage` bắt ĐÚNG vi phạm của ràng buộc ấy (23514 + tên ràng buộc) và ghi lại dòng đó với " +
      "workload NULL — dòng tiền / hạn mức không mất, chỉ thiếu nhãn như trước bản này. Đường đọc không đổi.",
    addedColumns: {},
    proof: "tests/ai-usage-ledger-complete.test.ts",
  },
  {
    tag: "0253_ai_usage_cache_write",
    why:
      "Chỉ THÊM một cột phân tích (platform_ai_usage.cache_write_tokens) + CHECK của nó. Đường ghi DUY NHẤT của bảng (`recordAiUsage`) là " +
      "câu chèn LIỆT KÊ CỘT và chỉ thêm cột này khi information_schema báo đã có (đệm 60 giây) — CSDL nhà chưa áp 0253 vẫn ghi đủ mọi dòng " +
      "tiền / hạn mức, chỉ thiếu phần tách. Mọi đường đọc của bảng liệt kê cột, không đọc cột này.",
    addedColumns: { platform_ai_usage: ["cache_write_tokens"] },
    proof: "tests/ai-usage-ledger-complete.test.ts",
  },
  {
    tag: "0254_carryover_first_work_month",
    why:
      "Chỉ NỚI ràng buộc CHECK của marketer_profit_carryover.opening_source (thêm 'FIRST_WORK_MONTH') — không thêm / đổi / xoá cột. " +
      "Mọi đường ĐỌC chạy y như cũ (cột đã có, dòng cũ mang hai giá trị cũ). Đường GHI duy nhất (`calculatePayrollPeriodAs`) ghi kỳ lương " +
      "và dòng sổ lỗ trong CÙNG một giao dịch: kỳ có người ở tháng làm việc đầu tiên vi phạm ràng buộc cũ ⇒ cả giao dịch huỷ, kỳ KHÔNG " +
      "được tạo và không dòng sổ nào được ghi — chốt kỳ báo lỗi cho tới khi 0254 áp, không ghi nhầm căn cứ thành «chủ shop khai đích " +
      "danh». Kỳ không có ai ở tháng đầu ghi được như trước.",
    addedColumns: {},
    proof: "tests/payroll-carryover.test.ts",
  },
  {
    tag: "0255_ai_usage_sourcing_workload",
    why:
      "Chỉ NỚI ràng buộc CHECK của platform_ai_usage.workload (thêm 'sourcing') — không thêm / đổi / xoá cột, y khuôn 0252. Lượt AI của " +
      "bộ sinh từ khoá tìm hàng ghi lên lược đồ chưa áp mục này thì vi phạm ràng buộc cũ: `recordAiUsage` bắt ĐÚNG vi phạm ấy (23514 + tên " +
      "ràng buộc) và ghi lại dòng với workload NULL — dòng tiền / hạn mức không mất. Trần lượt / ngày của tìm hàng đếm theo FEATURE " +
      "'sourcing' (cột feature chỉ có CHECK hình dạng, 0176), không theo workload, nên trần vẫn đếm đúng khi nhãn lùi về NULL.",
    addedColumns: {},
    proof: "tests/ai-usage-ledger-complete.test.ts",
  },
  {
    tag: "0256_sourcing_offer_catalog",
    why:
      "Chỉ TẠO ba bảng mới ở CSDL tổ chức (sourcing_suppliers · sourcing_offers · sourcing_offer_snapshots) — không thêm / đổi / xoá " +
      "cột của bảng nào mã đang đọc. Mọi đường ĐỌC của kho mẫu (`lib/queries/sourcing.ts`) bắt lỗi bảng chưa có (42P01) và trả " +
      "`{ unavailable: true }` ⇒ /sourcing in «CSDL của tổ chức chưa áp 0256», không sập trang; mọi đường GHI " +
      "(`lib/actions/sourcing-offers.ts`) bắt cùng lỗi và trả câu lỗi đó, không ghi gì. Không đường nào khác chạm ba bảng này.",
    addedColumns: {},
    proof: "tests/sourcing-offers.test.ts",
  },
  {
    tag: "0257_sourcing_offer_weights",
    why:
      "Chỉ TẠO một bảng mới ở CSDL tổ chức (sourcing_offer_weights) — không thêm / đổi / xoá cột nào. Đường ĐỌC duy nhất " +
      "(`latestOfferWeights` trong lib/queries/sourcing.ts) là truy vấn RIÊNG bắt lỗi bảng chưa có (42P01) ⇒ mọi mẫu «chưa khai cân " +
      "nặng · CSDL chưa áp 0257», giá về VN in «—» kèm lý do, phần còn lại của kho mẫu chạy như cũ. Đường GHI duy nhất " +
      "(`addSourcingWeight`) bắt cùng lỗi và trả câu lỗi, không ghi gì.",
    addedColumns: {},
    proof: "tests/sourcing-landed-cost.test.ts",
  },
  {
    tag: "0258_sourcing_trials",
    why:
      "Chỉ TẠO hai bảng mới ở CSDL tổ chức (sourcing_shortlist · sourcing_trial_requests) — không thêm / đổi / xoá cột nào. Mọi " +
      "đường ĐỌC của hai bảng (`lib/queries/sourcing-trials.ts`) bắt lỗi bảng chưa có (42P01) ⇒ trang mẫu nguồn in «CSDL chưa áp " +
      "0258», kho mẫu / giá về chạy như cũ. Mọi đường GHI (`lib/sourcing/trial-service.ts`) kiểm bảng TRƯỚC khi cấp mã TEST- hay xin " +
      "duyệt, nên chưa áp thì trả câu lỗi và không để lại mẫu TEST- / yêu cầu duyệt mồ côi.",
    addedColumns: {},
    proof: "tests/sourcing-trials.test.ts",
  },
];

/** Bộ cột phải tránh của MỘT bảng (tên CSDL) — hợp của mọi mục trong sổ. HÀM THUẦN. */
export function serveCompatAvoidColumns(table: string): ReadonlySet<string> {
  const out = new Set<string>();
  for (const e of MIGRATION_SERVE_COMPAT) for (const c of e.addedColumns[table] ?? []) out.add(c);
  return out;
}

/**
 * Lỗi migrate có phải HẾT GIỜ không (điều kiện 1). SQLSTATE 57014 = statement timeout / bị huỷ (`pg_cancel_backend`); 55P03 = lock
 * timeout; `OrgMigrateError` LOCK_BUSY = người khác giữ khoá migrate quá hạn; `OrgMigrateError` mang `timedOut` = lượt quá trần
 * (RUN_TIMEOUT), lượt của người điều phối khác còn đang chạy (HOLDER_RUNNING), hoặc lượt của người điều phối khác đã kết thúc vì HẾT GIỜ
 * (HOLDER_FAILED — cờ lấy từ trạng thái người đó ghi, db/migrate.ts::coordinateOrgMigration). drizzle bọc lỗi pg (`cause`) nên đọc cả
 * hai tầng. HÀM THUẦN.
 */
export function isMigrationTimeoutError(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    const o = e as { code?: unknown; phase?: unknown; name?: unknown; timedOut?: unknown };
    if (o.name === "OrgMigrateError" && (o.phase === "LOCK_BUSY" || o.timedOut === true)) return true;
    if (o.name === "OrgMigrateError") return false;
    if (o.code === "57014" || o.code === "55P03") return true;
  }
  return false;
}

/**
 * Câu lỗi GỐC của một lượt migrate: drizzle bọc lỗi pg thành «Failed query: <cả câu SQL>…» — cắt 300 ký tự là mất đúng phần nói lý do
 * (log production 12/10 chỉ còn «Failed query: -- Dẫn xuất TẤT ĐỊNH…»). Lấy lỗi SÂU NHẤT trong chuỗi `cause`, kèm SQLSTATE. HÀM THUẦN.
 */
export function migrationErrorText(error: unknown): string {
  // Lỗi của tầng điều phối (db/migrate.ts) đã tự mang câu gốc + người chạy trong message — lấy nguyên, không đào xuống lỗi pg bên trong
  // (đào xuống thì mất «lượt của ai, quá trần nào»).
  if ((error as { name?: unknown } | null)?.name === "OrgMigrateError" && error instanceof Error) return error.message.slice(0, 300);
  let deepest: unknown = error;
  for (let e: unknown = error, depth = 0; e && depth < 4; e = (e as { cause?: unknown }).cause, depth++) deepest = e;
  const code = (deepest as { code?: unknown })?.code;
  const msg = deepest instanceof Error ? deepest.message : String(deepest);
  return `${typeof code === "string" ? `[${code}] ` : ""}${msg}`.slice(0, 300);
}

export type DegradeDecision = { serve: true; missing: string[] } | { serve: false; missing: string[]; why: string };

/**
 * Quyết định phục vụ ở `DEGRADED_MIGRATION` (điều kiện 2). `missing` = tag còn thiếu của CSDL (sổ của mã đang chạy − đã áp). HÀM THUẦN.
 */
export function orgMigrationDegradeDecision(missing: readonly string[], compat: readonly ServeCompatEntry[] = MIGRATION_SERVE_COMPAT): DegradeDecision {
  const list = [...missing];
  if (!list.length) return { serve: false, missing: list, why: "không thiếu migration nào — lỗi không do lược đồ cũ, không có gì để phục vụ tạm" };
  const known = new Set(compat.map((e) => e.tag));
  const outside = list.filter((t) => !known.has(t));
  if (outside.length) return { serve: false, missing: list, why: `còn thiếu migration NGOÀI sổ tương thích: ${outside.join(", ")}` };
  return { serve: true, missing: list };
}

/** Tag còn thiếu: mục của sổ mà mốc `when` chưa có trong `drizzle.__drizzle_migrations.created_at`. HÀM THUẦN. */
export function missingMigrationTags(journal: readonly { tag: string; when: number }[], appliedWhen: Iterable<number>): string[] {
  const applied = new Set(appliedWhen);
  return journal.filter((e) => !applied.has(e.when)).map((e) => e.tag);
}
