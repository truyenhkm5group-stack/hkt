import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { ALL_PERMISSIONS, DEFAULT_ROLE_PERMISSIONS, PERMISSION_LABEL } from "@/lib/auth/permissions";
import { ROLE_LABEL } from "@/lib/constants/roles";

/**
 * ───────── KIỂM SOÁT TRUY CẬP & TRÁCH NHIỆM ─────────
 *
 * Lỗ hổng thật đã tìm thấy khi rà soát: **năm đường xuất CSV chỉ hỏi "đã đăng nhập chưa"**, không
 * hỏi quyền. Một bạn kho hay CSKH — người không mở được trang Báo cáo lợi nhuận — vẫn tải được
 * nguyên file CSV doanh thu, giá vốn, lợi nhuận, và file đơn hàng kèm tên, số điện thoại, địa chỉ
 * khách, chỉ cần biết đường dẫn. Cùng kiểu đó: bấm đẩy lại vận đơn sang Viettel Post và bấm thử
 * kết nối API cũng chỉ cần "đã đăng nhập".
 *
 * Ma trận quyền đã ghi đúng từ đầu; chỗ sai là mã nguồn KHÔNG hỏi tới nó. Bài kiểm thử này bắt đúng
 * loại sai đó ở mức mã nguồn, vì nó không thể hiện ra trên giao diện: menu ẩn đi không có nghĩa là
 * đường dẫn bị khoá.
 */

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name === "route.ts") out.push(full.split(path.sep).join("/"));
  }
  return out;
}

/**
 * Đường công khai CÓ CHỦ ĐÍCH — mỗi mục phải nêu lý do.
 * Webhook không có phiên đăng nhập: chúng tự xác thực bằng bí mật trong URL / phong bì phản hồi.
 */
const CO_Y_CONG_KHAI: Record<string, string> = {
  "app/api/health/route.ts": "health check cho Docker và giám sát — không trả dữ liệu kinh doanh",
  "app/api/webhooks/pancake/[secret]/[[...event]]/route.ts": "webhook Pancake, xác thực bằng bí mật trong đường dẫn",
  "app/api/webhooks/viettelpost/route.ts": "webhook Viettel Post, phải trả HTTP 200 trong 1 giây",
  "app/api/webhooks/vtp-statement/route.ts": "webhook bảng kê Viettel Post",
  "app/api/video-scale/public/[id]/route.ts": "link KÝ TÊN cho Facebook tải video quảng cáo (advideos file_url): HMAC AUTH_SECRET trên (tệp, hạn), hạn ≤ 2 giờ, chỉ bản hoàn chỉnh / ảnh bìa của video ĐÃ DUYỆT không phải dữ liệu thử — sai điều nào cũng 404",
  "app/api/webhooks/ghn-org/[token]/route.ts": "webhook trạng thái GHN của MỘT tổ chức khách (POS tự chủ): token «<mã tổ chức>.<chữ ký HMAC>» trong đường dẫn phân giải qua WEBHOOK_BINDINGS.GHN_ORG (URL_SECRET) — sai ⇒ 401, chưa bật Giao vận ⇒ 409, không rơi về nhà, không phiên đăng nhập",
  "app/api/webhooks/ghtk-org/[token]/route.ts": "webhook trạng thái GHTK của MỘT tổ chức khách (POS tự chủ): token «<mã tổ chức>.<chữ ký HMAC>» trong đường dẫn phân giải qua WEBHOOK_BINDINGS.GHTK_ORG (URL_SECRET) — sai ⇒ 401, chưa bật Giao vận ⇒ 409, không rơi về nhà, không phiên đăng nhập",
  "app/api/webhooks/viettelpost-org/[token]/route.ts": "webhook Viettel Post của MỘT tổ chức khách (F2): token «<mã tổ chức>.<chữ ký HMAC>» trong đường dẫn phân giải qua WEBHOOK_BINDINGS.VIETTELPOST_ORG (URL_SECRET) — sai ⇒ 401, chưa bật Giao vận ⇒ 409, không rơi về nhà, không phiên đăng nhập",
  "app/api/webhooks/pancake-org/[token]/[[...event]]/route.ts": "webhook Pancake POS của MỘT tổ chức khách (F1): token «<mã tổ chức>.<chữ ký HMAC>» trong đường dẫn phân giải qua WEBHOOK_BINDINGS.PANCAKE_POS_ORG (URL_SECRET) — sai ⇒ 401, kết nối chưa bật ⇒ 409, không rơi về nhà, không phiên đăng nhập",
  "app/api/webhooks/pancake/fanpage/[token]/route.ts": "webhook tin nhắn fanpage của MỘT tổ chức khách: token «<mã tổ chức>.<chữ ký HMAC>» trong đường dẫn phân giải qua WEBHOOK_BINDINGS.PANCAKE_FANPAGE (URL_SECRET) — sai ⇒ 401, không rơi về nhà, không phiên đăng nhập",
  "app/api/webhooks/zalo-oa/[token]/route.ts": "webhook tin nhắn Zalo OA của MỘT tổ chức khách: token «<mã tổ chức>.<chữ ký HMAC>» trong đường dẫn phân giải qua WEBHOOK_BINDINGS.ZALO_OA (URL_SECRET) — sai ⇒ 401, không rơi về nhà; gói tin kiểm thêm chữ ký X-ZEvent-Signature bằng OA Secret Key của shop",
  "app/api/ical/[token]/route.ts": "lịch .ics của MỘT phòng cho Airbnb / Booking / Agoda tự tải (module stays): token «<mã tổ chức>.<token phòng 24 byte ngẫu nhiên>» — sai / module tắt / phòng ngưng ⇒ cùng một 404; chỉ có ngày và chữ «Đã đặt» / «Khoá ngày», không tên / SĐT / tiền, không ghi gì",
  "app/api/webhooks/messenger/route.ts": "webhook Messenger trực tiếp (0207): POST xác thực bằng X-Hub-Signature-256 (HMAC app secret của nền tảng) trên thân gốc, tổ chức theo mã page qua WEBHOOK_BINDINGS.MESSENGER (PAGE_INDEX) — page chưa nối bị bỏ, không rơi về nhà; GET chỉ trả hub.challenge khi verify token khớp",
  "app/api/webhooks/sepay/route.ts": "webhook SePay, xác thực bằng HMAC-SHA256 trên byte gốc + chống phát lại 5 phút — không có phiên đăng nhập",
  "app/api/sync/[job]/route.ts": "gọi bằng x-cron-secret (bộ lập lịch) hoặc phiên có quyền sync:run",
  // Cố ý KHÔNG có đường phiên: danh sách khách của nền tảng không màn hình nghiệp vụ nào cần (tests/platform-jobs.test.ts khoá).
  "app/api/sync/organizations/route.ts": "CHỈ x-cron-secret (bộ lập lịch fan-out); trả đúng mã các tổ chức khác nhà đang hoạt động, không có đường phiên đăng nhập",
  /*
    Cửa máy-gọi-máy: máy GitHub Actions chép sổ lượt chạy agent về (phương án B — runner KHÔNG nối
    CSDL production). Nó CHỈ nhận `x-cron-secret` và CỐ Ý KHÔNG có đường phiên đăng nhập: thêm một
    lượt `can(user, ...)` vào đây là mở một cửa thứ hai cho người, trên một tuyến mà không người
    nào cần gọi. Phạm vi ghi hẹp hơn mọi tuyến khác trong bảng này — đúng một bảng
    (`tech_agent_runs`), chỉ TẠO không SỬA, không chạm một dòng dữ liệu nghiệp vụ nào — và hình
    dạng đó được khoá bằng quét mã nguồn ở `tests/agent-run-ingest.test.ts`.
  */
  "app/api/tech/agent-run/route.ts": "gọi bằng x-cron-secret từ GitHub Actions; không có đường phiên đăng nhập, hình dạng khoá ở tests/agent-run-ingest.test.ts",
  /*
    Cửa ĐỌC đối xứng với cửa ghi trên: máy chạy agent lấy đúng việc được giao. Cũng CHỈ nhận
    `x-cron-secret`, cũng không có đường phiên. Nó trả về đúng sáu trường và CHỈ việc được phép
    giao (dùng lại `canDispatchTask`), nên nó không rộng hơn cổng giao việc.
  */
  /*
    Bộ đếm lượt mở trang (`lib/constants/page-usage.ts`): ai đã mở được một trang thì lượt mở ấy là
    thật, nên chỉ cần PHIÊN (apiGuard() không tham số vẫn chặn chưa đăng nhập · tổ chức ngừng). Tuyến
    không đọc / không trả dữ liệu nghiệp vụ nào, không lưu đường dẫn thô và không ghi ai mở — đòi một
    khoá quyền ở đây chỉ làm mất lượt đếm của đúng những người ít quyền nhất.
  */
  "app/api/usage/visit/route.ts": "chỉ cần phiên: cộng +1 vào bộ đếm theo MỤC trang đã khai, không đọc/trả dữ liệu, không ghi ai mở",
  // Phase 10 · thương hiệu: logo hiện trên thanh đầu cho MỌI người của tổ chức, nên khoá quyền nào ở đây cũng làm vỡ
  // thanh đầu của người ít quyền nhất. Không nhận id / mã tổ chức: chỉ trả logo của CHÍNH tổ chức trong phiên.
  "app/api/branding/logo/route.ts": "chỉ cần phiên: logo của CHÍNH tổ chức trong phiên (thanh đầu của mọi người), không nhận id hay mã tổ chức",
  "app/api/tech/agent-task/route.ts": "gọi bằng x-cron-secret từ GitHub Actions; chỉ GET một việc theo mã, chỉ việc được phép giao, hình dạng khoá ở tests/agent-task-read.test.ts",
  // 0180 · Caddy on-demand TLS hỏi trước khi xin chứng chỉ cho `<slug>.<miền gốc>`: KHÔNG có phiên (Caddy gọi), chỉ trả
  // "ok"/"no" cho đúng tổ chức ĐÃ XUẤT BẢN — không đọc / trả dữ liệu nghiệp vụ nào (tests/self-service-journey.test.ts).
  "app/api/platform/domain-allowed/route.ts": "công khai cho Caddy on-demand TLS: chỉ trả 200/404 cho tên miền con của tổ chức đã xuất bản, không dữ liệu nào",
};

export function testAccessControl() {
  const routes = walk("app/api");
  assert.ok(routes.length >= 15, `phải quét được toàn bộ route, mới thấy ${routes.length}`);

  let daKhoa = 0;
  for (const file of routes) {
    if (CO_Y_CONG_KHAI[file]) continue;
    const src = readFileSync(file, "utf8");
    /*
      "Đã đăng nhập" KHÔNG phải kiểm soát truy cập: mọi nhân viên đều đăng nhập được.

      Dạng thứ ba là MÁY TÍNH PHẠM VI (`lib/auth/payroll-scope.ts`): nó suy ra phạm vi TỪ khoá
      quyền rồi mới quyết, nên nó là một lượt hỏi quyền đầy đủ chứ không phải một lối vòng. Đòi
      ĐỦ HAI THỨ — tính phạm vi VÀ có câu chặn dựa trên phạm vi ấy — vì một tuyến tính ra phạm vi
      rồi không dùng nó thì vẫn đang mở toang.

      Dạng thứ tư là QUYỀN THEO ĐỐI TƯỢNG (`lib/production/topic-access.ts`, chủ shop 27/09/2026): topic
      riêng chỉ người mở + người được tag + ADMIN xem được, nên câu hỏi không còn là "có khoá quyền không"
      mà là "có được xem CHÍNH topic này không" — máy tính ấy hỏi khoá quyền qua `can()` bên trong. Cũng
      đòi ĐỦ HAI THỨ: tính quyền của topic VÀ câu chặn dựa trên `.view` của nó.

      Dạng thứ năm là TỆP CỦA FIELD TUỲ BIẾN (`lib/metadata/values.ts::openCustomFile`, Phase 3.1): tệp thuộc một
      bản ghi của BẤT KỲ đối tượng nào trong sổ, nên khoá quyền chỉ biết được SAU khi đọc dòng tệp — nó hỏi
      `can()` bằng khoá xem của đối tượng (`OBJECT_RECORD_PERMISSIONS`) và `viewPermission` của field. Cũng đòi ĐỦ
      HAI THỨ: gọi máy tính ấy với người của phiên VÀ câu chặn dựa trên `.ok` của nó.
    */
    const coQuyen =
      /can\(\s*user\s*,\s*"[a-z0-9:_-]+"\s*\)/.test(src) ||
      /requirePermission\(\s*"[a-z0-9:_-]+"\s*\)/.test(src) ||
      (/resolvePayrollScope\(\s*user\s*\)/.test(src) && /can(?:Open|SeeAll)Payroll\(/.test(src)) ||
      (/loadTopicAccess\(.*, user\)/.test(src) && /if \(!acc\?\.view\)/.test(src)) ||
      (/openCustomFile\(\s*id\s*,\s*user\s*\)/.test(src) && /if \(!r\.ok\)/.test(src));
    assert.ok(
      coQuyen,
      `${file}: chỉ kiểm tra phiên đăng nhập là chưa đủ — phải hỏi đúng quyền của module. Menu ẩn không khoá được đường dẫn.`,
    );
    daKhoa += 1;
  }

  // Mọi khoá quyền được dùng trong mã phải TỒN TẠI trong ma trận. Gõ sai một chữ thì lệnh kiểm tra
  // luôn trả về "không có quyền" và không ai hiểu vì sao — một lỗi im lặng đúng nghĩa.
  const nguon = [...walk("app/api"), ...tsFiles("app"), ...tsFiles("lib"), ...tsFiles("components")];
  const dungKhoa = new Set<string>();
  for (const file of nguon) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/(?:requirePermission|hasPermission|can)\(\s*(?:user,\s*|subject,\s*)?"([a-z0-9:_-]+)"/g)) dungKhoa.add(m[1]);
    for (const m of src.matchAll(/permission:\s*"([a-z0-9:_-]+)"/g)) dungKhoa.add(m[1]);
  }
  const la = [...dungKhoa].filter((k) => !(ALL_PERMISSIONS as string[]).includes(k));
  assert.deepEqual(la, [], `khoá quyền không có trong ma trận (gõ sai thì luôn bị từ chối, im lặng): ${la.join(", ")}`);

  // Mọi khoá trong ma trận phải có nhãn tiếng Việt — trang phân quyền hiện khoá thô thì không ai
  // dám bấm.
  for (const key of ALL_PERMISSIONS) {
    assert.ok(PERMISSION_LABEL[key]?.length > 3, `khoá quyền ${key} chưa có nhãn tiếng Việt`);
  }

  // Mọi vai trò phải có mẫu quyền, và không vai trò nào cầm khoá lạ.
  for (const role of Object.keys(ROLE_LABEL) as (keyof typeof ROLE_LABEL)[]) {
    const perms = DEFAULT_ROLE_PERMISSIONS[role];
    assert.ok(Array.isArray(perms), `vai trò ${role} chưa có mẫu quyền`);
    const laCuaVaiTro = perms.filter((p) => !(ALL_PERMISSIONS as string[]).includes(p));
    assert.deepEqual(laCuaVaiTro, [], `vai trò ${role} cầm khoá không tồn tại: ${laCuaVaiTro.join(", ")}`);
  }
  // Chỉ quản trị viên được toàn quyền. Một vai trò khác vô tình bằng ADMIN là mất kiểm soát mà
  // không ai nhận ra.
  for (const role of Object.keys(DEFAULT_ROLE_PERMISSIONS) as (keyof typeof DEFAULT_ROLE_PERMISSIONS)[]) {
    if (role === "ADMIN") continue;
    assert.ok(
      DEFAULT_ROLE_PERMISSIONS[role].length < ALL_PERMISSIONS.length,
      `vai trò ${role} đang có đủ mọi quyền như quản trị viên — nếu cố ý thì phải đổi vai trò, không phải mở hết khoá`,
    );
  }

  // ───────── Ghi dữ liệu thì phải có người chịu trách nhiệm ─────────
  // Mỗi file hành động có phép ghi drizzle phải vừa kiểm quyền vừa ghi nhật ký. Thiếu nhật ký thì
  // sau này không ai trả lời được "ai sửa con số này".
  // Đăng nhập là ngoại lệ duy nhất và hiển nhiên: chưa có phiên thì không có quyền nào để hỏi.
  // Nó vẫn PHẢI ghi nhật ký — biết ai đăng nhập lúc nào là một phần của trách nhiệm.
  const KHONG_CAN_QUYEN: Record<string, string> = {
    "lib/actions/auth.ts": "đăng nhập / đăng xuất — chạy khi người dùng chưa có phiên",
  };
  const actions = readdirSync("lib/actions").filter((f) => f.endsWith(".ts"));
  let coGhi = 0;
  for (const name of actions) {
    const file = `lib/actions/${name}`;
    const src = readFileSync(file, "utf8");
    if (!/\.(insert|update|delete)\s*\(/.test(src)) continue;
    coGhi += 1;
    if (!KHONG_CAN_QUYEN[file]) {
      assert.ok(/requirePermission\(|requireUser\(/.test(src), `${file}: có phép ghi nhưng không kiểm quyền`);
    }
    assert.ok(/\baudit\(/.test(src), `${file}: có phép ghi nhưng không ghi nhật ký — mất dấu vết ai đã sửa`);
  }
  assert.ok(coGhi >= 10, `phải quét được các file hành động có ghi dữ liệu, mới thấy ${coGhi}`);

  console.log(
    `✓ Kiểm soát truy cập: ${daKhoa} route đòi đúng quyền (không route nào chỉ hỏi "đã đăng nhập") · ${CO_Y_CONG_KHAI ? Object.keys(CO_Y_CONG_KHAI).length : 0} đường công khai có lý do · ${dungKhoa.size} khoá dùng trong mã đều có trong ma trận · ${coGhi} file hành động ghi dữ liệu đều kiểm quyền và ghi nhật ký`,
  );
}

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) tsFiles(full, out);
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(full.split(path.sep).join("/"));
  }
  return out;
}
