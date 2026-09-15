/**
 * ═══════════ BA CHIỀU CỦA QUYỀN TRUY CẬP — TÁCH HẲN NHAU ═══════════
 *
 * Trước bản này ERP chỉ có MỘT chiều: `users.role`. Mọi câu hỏi khác đều bị nhét vào nó, nên
 * không câu nào trả lời đúng:
 *
 *   "Chị Lan làm kế toán"      → đặt vai ACCOUNTANT   (đúng tình cờ)
 *   "Anh Hùng là trưởng kho"   → đặt vai MANAGER      (SAI: anh ấy thấy luôn sổ ngân hàng)
 *   "Em Mai chỉ xem đơn của em"→ không đặt được       (không có chiều nào nói "của em")
 *
 * Ba câu hỏi đó là BA CHIỀU, không suy ra lẫn nhau:
 *
 *   VAI TRÒ  (Role)     — ĐƯỢC LÀM GÌ.    Bó quyền. `users.role` + `access_roles`.
 *   CHỨC DANH(Position) — LÀM CHỨC GÌ.    Nhãn tổ chức. `positions`. KHÔNG SINH QUYỀN.
 *   PHẠM VI  (Scope)    — TRÊN DỮ LIỆU NÀO. `users.data_scope`. CHỈ THU HẸP, không mở rộng.
 *
 * ─── VÌ SAO CHỨC DANH KHÔNG ĐƯỢC SINH QUYỀN ───
 *
 * Cái bẫy cổ điển: đặt chức danh "Trưởng phòng kế toán" rồi code ở đâu đó đọc chuỗi đó và mở
 * quyền tài chính. Từ lúc ấy, ĐỔI TÊN CHỨC DANH LÀ LEO THANG QUYỀN — mà người đổi tên tưởng mình
 * chỉ đang sửa một cái nhãn hiển thị. `tests/access-model.test.ts` quét mã nguồn để không ai nối
 * được chức danh vào quyền.
 *
 * ─── VÌ SAO PHẠM VI CHỈ THU HẸP ───
 *
 * Nếu phạm vi vừa thu hẹp vừa mở rộng thì nó là chiều quyền thứ hai, và hai chiều quyền luôn
 * mâu thuẫn nhau vào một ngày nào đó. Ở đây: quyền quyết định CÓ ĐƯỢC XEM LOẠI DỮ LIỆU ẤY KHÔNG;
 * phạm vi quyết định XEM ĐƯỢC BAO NHIÊU DÒNG. Không có quyền thì phạm vi `ALL` cũng không thấy gì.
 */

/** Tệp này client-safe: không import DB, không import `lib/queries/*`. */

export const ACCESS_SCOPES = ["SELF", "ASSIGNED", "TEAM", "DEPARTMENT", "ALL"] as const;
export type AccessScope = (typeof ACCESS_SCOPES)[number];

/**
 * KHÔNG có phạm vi dạng chuỗi tự do. Một ô nhập "phạm vi" cho gõ tự do là một lỗ bảo mật: chuỗi
 * gõ sai không khớp luật nào, và code buộc phải chọn giữa "không khớp thì cấm hết" (khoá nhầm
 * người) hoặc "không khớp thì cho qua" (lộ dữ liệu). Danh sách đóng thì không có trường hợp thứ ba.
 */
export const ACCESS_SCOPE_LABEL: Record<AccessScope, string> = {
  SELF: "Chỉ của mình",
  ASSIGNED: "Việc được giao",
  TEAM: "Nhóm mình phụ trách",
  DEPARTMENT: "Cả phòng ban của mình",
  ALL: "Toàn công ty",
};

export const ACCESS_SCOPE_HINT: Record<AccessScope, string> = {
  SELF: "Chỉ những dòng nói về chính người này: việc họ tự tạo, lương của họ, ý tưởng của họ",
  ASSIGNED: "Như trên, cộng thêm mọi việc được giao đích danh cho họ",
  TEAM: "Như trên, cộng thêm người trong phòng mà họ làm trưởng phòng",
  DEPARTMENT: "Mọi dữ liệu thuộc các phòng ban họ là thành viên — kể cả việc chưa giao cho ai",
  ALL: "Không thu hẹp gì: thấy đủ mọi dòng mà quyền của họ cho phép",
};

/** Hẹp → rộng. Dùng để so sánh, không dùng để cộng dồn quyền. */
export const ACCESS_SCOPE_RANK: Record<AccessScope, number> = { SELF: 0, ASSIGNED: 1, TEAM: 2, DEPARTMENT: 3, ALL: 4 };

export function isAccessScope(value: unknown): value is AccessScope {
  return typeof value === "string" && (ACCESS_SCOPES as readonly string[]).includes(value);
}

/**
 * Chuỗi lạ (dữ liệu cũ, gõ tay vào DB) → phạm vi HẸP NHẤT, không phải `ALL`.
 *
 * `users.data_scope` và `access_roles.default_scope` đều `NOT NULL DEFAULT 'ALL'` kèm `CHECK`, nên
 * nhánh dự phòng này chỉ chạy khi có dữ liệu hỏng. Mà dữ liệu hỏng thì phải rơi về phía HẸP HƠN
 * (AGENTS.md mục 31): một chuỗi lạ mở toàn công ty là đúng kiểu lỗ hổng im lặng mà không ai thấy.
 */
export function normalizeScope(value: unknown, fallback: AccessScope = "SELF"): AccessScope {
  return isAccessScope(value) ? value : fallback;
}

export function scopeAtLeast(scope: AccessScope, min: AccessScope) {
  return ACCESS_SCOPE_RANK[scope] >= ACCESS_SCOPE_RANK[min];
}

export const ACCESS_SCOPE_TONE: Record<AccessScope, string> = {
  SELF: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  ASSIGNED: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  TEAM: "bg-teal-50 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300",
  DEPARTMENT: "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300",
  ALL: "bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300",
};

/**
 * ═══════════ VÙNG NHẠY CẢM ═══════════
 *
 * Tiền, lương, nhân sự, cấu hình hệ thống. Yêu cầu của chủ shop: "Finance HR Management không
 * được lộ ngoài scope."
 *
 * Luật: quyền thuộc vùng nhạy cảm CHỈ CÓ HIỆU LỰC khi người đó hoặc có phạm vi `ALL`, hoặc là
 * thành viên phòng ban sở hữu vùng đó. Không có đường thứ ba.
 *
 * Vì sao gắn với phòng ban chứ không với vai trò: vai trò là bó quyền, ai cũng gán được cho ai.
 * Thành viên phòng Kế toán là một sự thật tổ chức có người chịu trách nhiệm xếp và có nhật ký
 * (`lib/org/membership.ts`). Muốn cho kế toán viên xem sổ ngân hàng thì xếp họ vào phòng Kế toán —
 * đúng việc phải làm — chứ không phải nới phạm vi của họ ra toàn công ty.
 *
 * MẶC ĐỊNH KHÔNG ĐỔI HÀNH VI: mọi tài khoản đang chạy có `data_scope = 'ALL'`, nên luật này chỉ
 * bắt đầu cắn khi chủ shop CHỦ ĐỘNG thu hẹp phạm vi của một người.
 */
export type SensitiveArea = {
  /** Mã phòng ban sở hữu vùng này (`lib/constants/departments.ts`). */
  department: string;
  label: string;
  reason: string;
  permissions: readonly string[];
};

export const SENSITIVE_AREAS: readonly SensitiveArea[] = [
  {
    department: "FINANCE",
    label: "Tài chính",
    reason: "Dòng tiền thật, sổ ngân hàng, đối soát COD và lợi nhuận tiền mặt",
    permissions: ["bank:view", "bank:write", "bank:accounts", "cod:write", "reports:cash", "reports:assumptions", "expenses:write"],
  },
  {
    department: "HR",
    label: "Nhân sự & lương",
    reason: "Lương và lợi nhuận cá nhân của người khác",
    permissions: ["payroll:view", "payroll:manage", "payroll:approve"],
  },
  {
    department: "MANAGEMENT",
    label: "Điều hành",
    reason: "Nhìn chéo phòng ban, chốt kỳ, đặt mục tiêu cho người khác",
    permissions: ["work:all", "review:manage", "okr:manage", "audit:view"],
  },
] as const;

export const SENSITIVE_BY_PERMISSION: Record<string, SensitiveArea> = Object.fromEntries(
  SENSITIVE_AREAS.flatMap((area) => area.permissions.map((p) => [p, area])),
);

/**
 * Quyền mà VAI TRÒ TUỲ CHỈNH không được cấp.
 *
 * `users:manage` là quyền tạo/sửa vai trò. Cho một vai trò tuỳ chỉnh cấp nó nghĩa là người không
 * phải quản trị có thể tự dựng một vai trò toàn quyền rồi gán cho chính mình — cái thang leo
 * thang kinh điển. Không vai trò hệ thống nào ngoài `ADMIN` có quyền này, nên chặn ở đây không
 * lấy đi của ai thứ gì.
 */
export const ROLE_BUILDER_FORBIDDEN: readonly string[] = ["users:manage"];
