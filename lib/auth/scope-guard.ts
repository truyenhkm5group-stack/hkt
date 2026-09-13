/**
 * ═══════════ ÁP PHẠM VI DỮ LIỆU — Ở MÁY CHỦ, HỎNG THÌ ĐÓNG ═══════════
 *
 * Luật của `lib/constants/data-scope-policy.ts` được thi hành ở đây, và CHỈ ở đây.
 *
 * ─── BA KẾT QUẢ, KHÔNG CÓ KẾT QUẢ THỨ TƯ ───
 *
 *   ALL   — không thu hẹp. Người này thấy đủ mọi dòng mà QUYỀN của họ cho phép.
 *   ROWS  — có mệnh đề SQL thu hẹp thật. Kèm một câu giải thích in được cho người dùng.
 *   NONE  — TỪ CHỐI, kèm lý do và cách sửa.
 *
 * `NONE` là kết quả quan trọng nhất và là lý do tệp này tồn tại. Khi phạm vi của một người hẹp
 * hơn thứ dữ liệu biểu diễn được, chỉ có ba đường: cho xem hết (lỗ hổng im lặng — đúng trạng thái
 * hôm nay), trả rỗng lặng lẽ (người dùng không hiểu gì), hoặc từ chối và nói rõ. Chọn đường thứ ba.
 *
 * ─── VÌ SAO KHÔNG TRUYỀN NGƯỜI DÙNG QUA THAM SỐ ───
 *
 * Cách hiển nhiên là đổi chữ ký `listOrders(params, viewer)`. Nhược điểm chí mạng: **quên truyền
 * thì mặc định là xem được hết.** Một chỗ gọi mới, một nhánh mới, một lần sửa vội — và lỗ hổng
 * quay lại, im lặng như cũ.
 *
 * Nên danh tính lấy từ `getCurrentUser()`, vốn đã được `cache()` theo từng lượt dựng trang. Không
 * chỗ gọi nào truyền gì cả, nên không chỗ gọi nào quên được. Đổi lại là một phụ thuộc ngầm vào
 * ngữ cảnh yêu cầu — chấp nhận được, vì đó đúng là thứ `cache()` của React sinh ra để làm, và kho
 * mã này đã dựa vào nó cho chính `getCurrentUser`.
 *
 * ─── KHÔNG CÓ PHIÊN THÌ SAO ───
 *
 * Job nền và webhook chạy ngoài mọi phiên đăng nhập. Chúng KHÔNG đi qua tệp này: chúng gọi thẳng
 * `lib/queries/*` và `lib/work/*`. Nếu một ngày có lời gọi tới đây mà không có phiên, câu trả lời
 * là `NONE` — đóng, không phải mở. Xem `tests/scope-enforcement.test.ts`.
 */
import { sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { getCurrentUser, requirePermission, type SessionUser } from "@/lib/auth/session";
import { rowsOf } from "@/lib/sql-rows";
import { membershipOf } from "@/lib/org/membership";
import { SCOPE_RESOURCE_BY_KEY, hasRowOwnership, type OwnerLink, type ScopeResource } from "@/lib/constants/data-scope-policy";
import { ACCESS_SCOPE_LABEL } from "@/lib/constants/access-scope";

export type ScopeDecision =
  | { allow: "ALL"; explain: string }
  | { allow: "ROWS"; where: SQL; explain: string }
  | { allow: "NONE"; reason: string; fix: string };

/**
 * Tên bảng / cột chỉ được đến từ sổ đăng ký hằng số, nhưng vẫn kiểm lại trước khi ghép vào SQL.
 * Một hằng số hôm nay an toàn không có nghĩa là người sửa nó ngày mai cũng cẩn thận như vậy.
 */
const DINH_DANH = /^[a-z_][a-z0-9_]*$/;

function cot(table: string, column: string): SQL {
  if (!DINH_DANH.test(table) || !DINH_DANH.test(column)) {
    throw new Error(`Tên bảng/cột không hợp lệ trong sổ phạm vi: ${table}.${column}`);
  }
  return sql.raw(`"${table}"."${column}"`);
}

/** Mệnh đề khớp một cột với chính người đang xem. */
function khopNguoi(table: string, link: OwnerLink, user: SessionUser): SQL {
  const c = cot(table, link.column);
  if (link.by === "USER_ID") return sql`${c} = ${user.id}`;
  // Cột email: hạ chữ và cắt khoảng trắng cả hai vế — dữ liệu cũ của kho mã này không đồng nhất.
  return sql`lower(btrim(coalesce(${c}, ''))) = ${user.email.trim().toLowerCase()}`;
}

function nhanLienKet(link: OwnerLink) {
  return link.by === "USER_ID" ? "khoá tài khoản" : `email (cột \`${link.column}\`)`;
}

/**
 * Quyết định phạm vi cho một loại dữ liệu, theo người đang đăng nhập.
 *
 * `viewer` truyền vào được để kiểm thử gọi thẳng mà không cần dựng phiên; bỏ trống thì lấy người
 * đang đăng nhập. Không có ai ⇒ `NONE`.
 */
/**
 * Quyền nào của HÀNG ĐỢI CÔNG VIỆC mở ra việc của NGƯỜI KHÁC.
 *
 * `work:view` là hàng đợi cá nhân — lớp chiếu đã lọc bằng `isMine` trên khoá tài khoản, nên phạm
 * vi SELF / ASSIGNED tự thoả. Ba khoá dưới mở hàng đợi phòng, hàng đợi toàn shop và quyền giao
 * việc cho người khác: chúng chứa việc CHƯA GIAO CHO AI, và "việc chưa của ai" không thu hẹp được
 * theo người. Người phạm vi hẹp cầm một trong ba khoá này là một cấu hình mâu thuẫn — từ chối và
 * nói rõ, không cho xem cả phòng cũng không trả rỗng lặng lẽ.
 */
const WORK_CROSS_PERSON_PERMISSIONS: readonly string[] = ["work:department", "work:all", "work:assign"];

export async function decideScope(resourceKey: string, viewer?: SessionUser | null, permission?: string): Promise<ScopeDecision> {
  const res = SCOPE_RESOURCE_BY_KEY[resourceKey];
  if (!res) {
    return {
      allow: "NONE",
      reason: `Loại dữ liệu "${resourceKey}" chưa khai trong sổ phạm vi.`,
      fix: "Thêm nó vào `lib/constants/data-scope-policy.ts` — chưa khai thì mặc định là ĐÓNG, không phải mở.",
    };
  }

  /*
    ═══ HAI TÌNH HUỐNG "KHÔNG CÓ NGƯỜI DÙNG", HAI CÂU TRẢ LỜI NGƯỢC NHAU ═══

    · TRONG một yêu cầu HTTP mà không có phiên hợp lệ ⇒ `getCurrentUser()` trả `null`.
      Đây là người lạ, hoặc phiên hết hạn. Câu trả lời là ĐÓNG.

    · NGOÀI mọi yêu cầu — job nền, script, kiểm thử ⇒ `cookies()` của Next NÉM LỖI.
      Đây là hệ thống tự chạy, không có "người xem" nào để thu hẹp theo. Câu trả lời là MỞ,
      và nó an toàn vì đường này không nối ra Internet: job nền không phục vụ ai cả.

    Phân biệt được hai cái là điều kiện để luật vừa chặt vừa không làm chết job. Gộp chúng lại
    theo hướng "không có người dùng thì mở" sẽ biến một cookie hỏng thành toàn quyền.
    `tests/scope-enforcement.test.ts` khoá đúng chỗ này.
  */
  let user: SessionUser | null;
  if (viewer !== undefined) {
    user = viewer;
  } else {
    try {
      user = await getCurrentUser();
    } catch {
      return { allow: "ALL", explain: "Chạy ngoài mọi yêu cầu HTTP (job nền / script) — không có người xem để thu hẹp theo." };
    }
  }
  if (!user) {
    return {
      allow: "NONE",
      reason: "Không có phiên đăng nhập hợp lệ.",
      fix: "Phiên có thể đã hết hạn — đăng nhập lại.",
    };
  }

  // Quản trị viên không phải đối tượng của luật này — họ là người dựng ra nó.
  if (user.role === "ADMIN") return { allow: "ALL", explain: "Quản trị viên — không thu hẹp." };
  if (user.scope === "ALL") return { allow: "ALL", explain: "Phạm vi Toàn công ty — không thu hẹp." };

  /*
    HAI LOẠI DỮ LIỆU TỰ THU HẸP LẤY, và ở đây phải nói ra thay vì lọc chồng lên.

    · `PROJECTION` — hàng đợi công việc là phép chiếu trên mười một nguồn. Lớp chiếu đã lọc theo
      CHÍNH người đang xem (`isMine`) và theo phòng của họ. Thêm một mệnh đề SQL trên `work_items`
      ở đây sẽ lọc đúng một nguồn trong mười một và giấu mất mười nguồn kia.
    · `OWN_LINE` — bảng lương đã có quyền `payroll:view-own` khớp theo email/tên nhân sự từ trước.

    Trả `ALL` ở đây KHÔNG phải "không thu hẹp": nó là "chỗ khác thu hẹp, và đây là chỗ nào".
    `tests/scope-enforcement.test.ts` buộc mỗi loại dữ liệu phải chỉ đích danh nơi thi hành.
  */
  if (res.enforcement === "PROJECTION") {
    if ((user.scope === "SELF" || user.scope === "ASSIGNED") && permission && WORK_CROSS_PERSON_PERMISSIONS.includes(permission)) {
      return {
        allow: "NONE",
        reason: `${res.label}: phạm vi của ${user.name} là "${ACCESS_SCOPE_LABEL[user.scope]}", mà màn hình / thao tác này (\`${permission}\`) chứa việc CHƯA GIAO CHO AI và việc của người khác — không thu hẹp được theo người.`,
        fix: "Hàng đợi cá nhân (Công việc → Việc của tôi) vẫn mở bình thường. Nếu người này thật sự điều phối việc của phòng, nới phạm vi lên Cả phòng ban; nếu không, bỏ quyền hàng đợi phòng / giao việc của họ.",
      };
    }
    return { allow: "ALL", explain: `${res.label}: lớp phép chiếu của hàng đợi tự lọc theo người và theo phòng (\`lib/queries/work.ts\`).` };
  }
  if (res.enforcement === "OWN_LINE") {
    return { allow: "ALL", explain: `${res.label}: quyền \`payroll:view-own\` đã giới hạn về dòng của chính người xem.` };
  }

  const thanhVien = await membershipOf(user.id);
  const idPhong = thanhVien.map((m) => m.departmentId);
  const maPhong = thanhVien.map((m) => m.code as string);
  const phongLam = thanhVien.filter((m) => m.isLead);

  if (user.scope === "DEPARTMENT" || user.scope === "TEAM") {
    /*
      TEAM = nhóm mình PHỤ TRÁCH. Không làm trưởng phòng nào thì không phụ trách nhóm nào — và
      lúc đó TEAM phải rơi xuống mức hẹp hơn (việc được giao), không phải nới lên thành cả phòng.
    */
    const phongDung = user.scope === "TEAM" ? phongLam : thanhVien;
    if (user.scope === "TEAM" && phongDung.length === 0) return theoDong(res, user, "ASSIGNED");

    if (res.rowDepartmentColumn) {
      const ids = user.scope === "TEAM" ? phongLam.map((m) => m.departmentId) : idPhong;
      if (ids.length === 0) {
        return {
          allow: "NONE",
          reason: `${user.name} chưa thuộc phòng ban nào, mà phạm vi đang là "${ACCESS_SCOPE_LABEL[user.scope]}".`,
          fix: "Xếp người này vào một phòng ở trang Người dùng, hoặc nới phạm vi của họ.",
        };
      }
      const c = cot(res.table, res.rowDepartmentColumn);
      return {
        allow: "ROWS",
        where: sql`${c} in ${ids}`,
        explain: `Chỉ dòng thuộc ${ids.length} phòng của ${user.name}.`,
      };
    }

    // Không có cột phòng trên từng dòng ⇒ cả loại dữ liệu thuộc về MỘT phòng.
    const thuoc = user.scope === "TEAM" ? phongLam.some((m) => m.code === res.ownedBy) : maPhong.includes(res.ownedBy);
    if (thuoc) {
      return { allow: "ALL", explain: `${res.label} thuộc phòng ${res.ownedBy}, và ${user.name} ở trong phòng đó.` };
    }
    return {
      allow: "NONE",
      reason: `${res.label} là dữ liệu của phòng ${res.ownedBy}; ${user.name} không thuộc phòng đó và phạm vi đang là "${ACCESS_SCOPE_LABEL[user.scope]}".`,
      fix: `Xếp họ vào phòng ${res.ownedBy} nếu họ thật sự làm việc đó, hoặc nới phạm vi lên Toàn công ty nếu họ chỉ cần xem.`,
    };
  }

  return theoDong(res, user, user.scope === "SELF" ? "SELF" : "ASSIGNED");
}

/** Thu hẹp theo TỪNG DÒNG. Bảng không biết ai là chủ dòng ⇒ từ chối, không cho xem hết. */
function theoDong(res: ScopeResource, user: SessionUser, muc: "SELF" | "ASSIGNED"): ScopeDecision {
  if (!hasRowOwnership(res)) {
    return {
      allow: "NONE",
      reason: `${res.label} không thu hẹp được theo người: bảng \`${res.table}\` không có cột nào chỉ ra chủ của từng dòng.`,
      fix: res.noRowOwnerReason ?? "Cần thêm một cột người chịu trách nhiệm vào bảng này trước khi phạm vi hẹp có nghĩa.",
    };
  }

  /*
    SELF ưu tiên cột CHỦ; ASSIGNED ưu tiên cột ĐƯỢC GIAO. Thiếu cột ưu tiên thì dùng cột còn lại —
    và điều đó luôn an toàn, vì cả hai đều là "dòng có tên người này", chỉ khác vai trò.
  */
  const chinh = muc === "SELF" ? (res.rowOwner ?? res.rowAssignee) : (res.rowAssignee ?? res.rowOwner);
  if (!chinh) {
    return { allow: "NONE", reason: `${res.label}: thiếu cột người.`, fix: "Xem `lib/constants/data-scope-policy.ts`." };
  }

  const dieuKien =
    muc === "ASSIGNED" && res.rowAssignee && res.rowOwner
      ? sql`(${khopNguoi(res.table, res.rowAssignee, user)} or ${khopNguoi(res.table, res.rowOwner, user)})`
      : khopNguoi(res.table, chinh, user);

  const canhBao = chinh.by === "EMAIL" ? " Khớp theo email, nên dòng ghi bằng email cũ của họ sẽ không hiện." : "";
  return {
    allow: "ROWS",
    where: dieuKien,
    explain: `Chỉ dòng mang tên ${user.name} (${nhanLienKet(chinh)}).${canhBao}`,
  };
}

/** Gộp mệnh đề phạm vi vào mệnh đề `where` sẵn có. `NONE` phải được xử lý TRƯỚC khi gọi hàm này. */
export function andScope(where: SQL | undefined, decision: ScopeDecision): SQL | undefined {
  if (decision.allow !== "ROWS") return where;
  return where ? sql`(${where}) and (${decision.where})` : decision.where;
}

/**
 * MỘT DÒNG CỤ THỂ có nằm trong phạm vi không — dành cho THAO TÁC GHI.
 *
 * Đọc đã lọc bằng `andScope`, nhưng một Server Action nhận `id` từ client thì không đi qua danh
 * sách nào: người bị thu hẹp vẫn gõ được id của case người khác vào nút "Nhận việc". Nên trước khi
 * ghi, hỏi lại đúng câu mà danh sách đã hỏi — cùng mệnh đề, không viết lại.
 *
 * `ALL` ⇒ đúng; `NONE` ⇒ sai (không có dòng nào là của họ); `ROWS` ⇒ chạy mệnh đề trên chính dòng đó.
 */
export async function rowInScope(decision: ScopeDecision, table: string, idColumn: string, id: string): Promise<boolean> {
  if (decision.allow === "ALL") return true;
  if (decision.allow === "NONE") return false;
  const idCol = cot(table, idColumn); // kiểm tên bảng / cột trước khi ghép vào SQL thô
  const db = await getDb();
  const rows = rowsOf<{ ok: number }>(await db.execute(sql`select 1 as ok from ${sql.raw(`"${table}"`)} where ${idCol} = ${id} and (${decision.where}) limit 1`));
  return rows.length > 0;
}

/**
 * Cổng vào của một trang: kiểm QUYỀN trước, rồi tính PHẠM VI.
 *
 * Thứ tự đó không đổi được. Quyền trả lời "có được xem loại dữ liệu này không"; phạm vi trả lời
 * "xem được bao nhiêu dòng". Không có quyền thì phạm vi `ALL` cũng không thấy gì, nên hỏi ngược
 * lại là thừa và dễ lộ: một người không có quyền sẽ đọc được câu từ chối mô tả cấu trúc dữ liệu.
 */
export async function requireResource(
  resourceKey: string,
  /**
   * Khoá quyền CỦA CHÍNH TRANG ĐÓ, truyền tường minh.
   *
   * Không lấy từ sổ đăng ký: một loại dữ liệu trải trên nhiều tuyến với nhiều khoá khác nhau
   * (`/cod` dùng `cod:view`, `/bank` dùng `bank:view`, `/reports/cashflow` dùng `reports:cash`),
   * và nếu cổng này áp khoá "đại diện" của sổ thì mỗi tuyến sẽ âm thầm đổi quyền cần có — đúng
   * kiểu thoái lui quyền mà không ai nhận ra cho tới khi có người mất màn hình.
   */
  permission: Parameters<typeof requirePermission>[0],
): Promise<{ user: SessionUser; decision: ScopeDecision; resource: ScopeResource }> {
  const resource = SCOPE_RESOURCE_BY_KEY[resourceKey];
  if (!resource) throw new Error(`Loại dữ liệu "${resourceKey}" chưa khai trong lib/constants/data-scope-policy.ts`);
  const user = await requirePermission(permission);
  const decision = await decideScope(resourceKey, user, permission);
  return { user, decision, resource };
}
