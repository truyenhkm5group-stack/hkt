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
];

/** Bộ cột phải tránh của MỘT bảng (tên CSDL) — hợp của mọi mục trong sổ. HÀM THUẦN. */
export function serveCompatAvoidColumns(table: string): ReadonlySet<string> {
  const out = new Set<string>();
  for (const e of MIGRATION_SERVE_COMPAT) for (const c of e.addedColumns[table] ?? []) out.add(c);
  return out;
}

/**
 * Lỗi migrate có phải HẾT GIỜ không (điều kiện 1). SQLSTATE 57014 = statement timeout / bị huỷ (`pg_cancel_backend`); 55P03 = lock
 * timeout; `OrgMigrateError` LOCK_BUSY = chờ khoá migrate của chính tổ chức quá trần. drizzle bọc lỗi pg (`cause`) nên đọc cả hai tầng.
 * HÀM THUẦN.
 */
export function isMigrationTimeoutError(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    const o = e as { code?: unknown; phase?: unknown; name?: unknown };
    if (o.name === "OrgMigrateError" && o.phase === "LOCK_BUSY") return true;
    if (o.code === "57014" || o.code === "55P03") return true;
  }
  return false;
}

/**
 * Câu lỗi GỐC của một lượt migrate: drizzle bọc lỗi pg thành «Failed query: <cả câu SQL>…» — cắt 300 ký tự là mất đúng phần nói lý do
 * (log production 12/10 chỉ còn «Failed query: -- Dẫn xuất TẤT ĐỊNH…»). Lấy lỗi SÂU NHẤT trong chuỗi `cause`, kèm SQLSTATE. HÀM THUẦN.
 */
export function migrationErrorText(error: unknown): string {
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
