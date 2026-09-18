import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { canSend } from "@/lib/ai-workforce/agents/sales/outbound";
import { SAFEST_HARD_LIMITS, type AiSettings } from "@/lib/ai-workforce/config";
import { clampMode, MAX_ALLOWED_MODE, modeAtLeast } from "@/lib/constants/ai";
import {
  AUTOMATION_TEMPLATE_MIN_CONVERSATIONS,
  COPILOT_MEANINGFUL_EDIT_RATIO,
  COPILOT_QUEUE_RELEVANT_HOURS,
  COPILOT_PAGES_KEY,
  COPILOT_REJECT_REASONS,
  COPILOT_TERMINAL_ACTIONS,
  editDistance,
  isMeaningfulEdit,
} from "@/lib/constants/sales-copilot";
import { copilotKpi, copilotPageAllowed, copilotPages, copilotQueue, ingestStatus } from "@/lib/queries/sales-copilot";
import { LIVE_INGEST_MAX_BACKOFF, LIVE_INGEST_MAX_SECONDS, liveIngestHealth, nextDelaySeconds, windowHours } from "@/lib/constants/live-ingest";
import { getAgent } from "@/lib/ai-workforce/registry";
import { resolvePermissions } from "@/lib/auth/permissions";
import { setSettingJson } from "@/lib/settings";

/**
 * ───────────── NẤC TRỢ LÝ BÁN HÀNG: MÁY SOẠN, NGƯỜI BẤM GỬI ─────────────
 *
 * Câu hỏi mà khối này phải trả lời được, và trả lời bằng phép thử chứ bằng lời:
 *
 *   1. Có tổ hợp nào để MÁY tự gửi không?            → không, và chứng minh bằng cách quét đủ tổ hợp.
 *   2. Một job nền gọi được đường gửi của người không? → không, vì đường ấy đòi một khoá tài khoản
 *                                                       chỉ lấy được từ một phiên đăng nhập.
 *   3. Bấm hai lần có thành hai tin cho khách không?  → không, và chốt nằm ở CSDL.
 *   4. Page ngoài danh sách thí điểm gửi được không?  → không.
 *
 * Câu 2 phải kiểm ở MỨC MÃ NGUỒN: không có phiên đăng nhập trong bộ kiểm thử, nên cách duy nhất để
 * chứng minh "job nền không đi vào được" là chứng minh KHÔNG TỆP NÀO ngoài lớp Server Action truyền
 * một khoá tài khoản vào cổng gửi.
 */

const NEN: AiSettings = {
  enabled: true,
  modelCallsEnabled: false,
  ingestEnabled: true,
  maxRunsPerHour: 600,
  dailyCostCapVnd: 0,
  testConversationIds: [],
  modes: {},
  pricing: {},
  hardLimits: { allowAutoSend: false, allowHumanApprovedSend: true, allowOrderCreate: false },
  pricingVersion: "",
};

/*
  QUÉT ĐĨA, KHÔNG QUÉT CHỈ MỤC GIT.

  Tính chất cần chứng minh ở đây là về mã SẼ CHẠY, và mã sẽ chạy là mã trên đĩa — kể cả tệp vừa
  viết chưa commit. `tests/repo-integrity.test.ts` lo phần "mã đã vào kho không import tệp chưa vào
  kho", nên hai bài không chồng nhau: bài kia giữ tính nhất quán của kho, bài này giữ tính chất an
  toàn của đường gửi.
*/
function tepNguon(goc: string, ra: string[] = []): string[] {
  for (const e of readdirSync(goc, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const duong = `${goc}/${e.name}`;
    if (e.isDirectory()) tepNguon(duong, ra);
    else if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) ra.push(duong);
  }
  return ra;
}

function daVaoKho(): string[] {
  return [...tepNguon("lib"), ...tepNguon("app"), ...tepNguon("scripts")];
}

export async function testSalesCopilot(db: Db) {
  // ═════════ 1. MỘT ĐƯỜNG GỬI, VÀ NÓ ĐÒI MỘT KHOÁ TÀI KHOẢN ═════════
  //
  // Quét MÃ ĐÃ VÀO KHO (không đọc đĩa): chỉ lớp Server Action được truyền `approvedByUserId` vào
  // cổng gửi. Một job nền không có phiên đăng nhập nên không có khoá — nhưng nếu một ngày ai đó
  // viết `approvedByUserId: "system"` trong một job, dòng dưới đây đỏ trước khi nó chạy lần nào.
  const tep = daVaoKho();
  const goiCong: string[] = [];
  const duyet: string[] = [];
  for (const f of tep) {
    const noiDung = readFileSync(f, "utf8");
    if (/\bsendSalesMessage\s*\(/.test(noiDung)) goiCong.push(f);
    if (/approvedByUserId\s*:/.test(noiDung)) duyet.push(f);
  }
  assert.deepEqual(goiCong.sort(), ["lib/actions/sales-copilot.ts", "lib/ai-workforce/agents/sales/outbound.ts"], "chỉ lớp Server Action được gọi cổng gửi (ngoài chính cổng)");
  // ĐÚNG MỘT TỆP trong toàn bộ kho mã đặt khoá người duyệt — và tệp ấy là một Server Action, tức
  // là chỉ chạy được từ một lượt bấm mang phiên đăng nhập. Đây là câu trả lời đầy đủ nhất có thể
  // cho "một job nền có gửi thay nhân viên được không".
  assert.deepEqual(duyet.sort(), ["lib/actions/sales-copilot.ts"], "chỉ lớp Server Action được đặt khoá người duyệt");

  // Và chính lớp ấy đòi phiên đăng nhập + quyền TRƯỚC khi chạm tới cổng gửi.
  const mãAction = readFileSync("lib/actions/sales-copilot.ts", "utf8");
  assert.ok(mãAction.startsWith('"use server"'), "phải là Server Action — không có URL nào gọi thẳng vào bằng một khoá API");
  assert.ok(mãAction.indexOf("requireUser()") < mãAction.indexOf("sendSalesMessage("), "phiên đăng nhập phải được đòi TRƯỚC khi gọi cổng gửi");
  assert.match(mãAction, /can\(user, "ai:send"\)/, "quyền gửi phải được kiểm, và là quyền RIÊNG chứ không phải ai:view");
  assert.match(mãAction, /modeAtLeast\(agent\.mode, "COPILOT"\)/, "nấc quyền hạn phải đọc lại từ CSDL");
  assert.match(mãAction, /copilotPageAllowed\(/, "page phải nằm trong danh sách thí điểm");

  // Lớp ĐỌC không được chứa một lệnh ghi nào.
  const mãQuery = readFileSync("lib/queries/sales-copilot.ts", "utf8");
  for (const cam of [".insert(", ".update(", ".delete("]) {
    assert.ok(!mãQuery.includes(cam), `lớp đọc hàng đợi không được chứa ${cam}`);
  }

  /*
    1A★. MỌI THAO TÁC ĐỀU PHẢI ĐI QUA CỔNG — kể cả thao tác viết thêm ngày mai.

    Mở `/ai/copilot` ra Internet bằng một tên miền thật đổi bản chất của bài kiểm này: trước đó
    chỉ ai vào được đường hầm SSH mới gọi tới được, nay bất kỳ ai cũng POST được vào một Server
    Action. Nên điều phải khoá không còn là "năm thao tác hiện có đã gọi cổng", mà là KHÔNG CÓ
    thao tác nào — hôm nay hay mai — bỏ qua được nó.

    Quét theo tên hàm xuất ra, nên một hàm mới thêm mà quên cổng sẽ đỏ ngay ở lần chạy đầu.
  */
  const maAction = readFileSync("lib/actions/sales-copilot.ts", "utf8");
  const thieuCong: string[] = [];
  for (const khop of maAction.matchAll(/export async function (\w+)\(/g)) {
    const ten = khop[1];
    const than = maAction.slice(khop.index ?? 0).split(/\nexport /)[0];
    // `cuaGui()` gọi `requireUser()` + `can(user, "ai:send")` + đọc lại nấc + danh sách trắng page.
    if (!/\bcuaGui\(/.test(than) && !/\brequireUser\(\)/.test(than)) thieuCong.push(ten);
  }
  assert.deepEqual(thieuCong, [], "mọi Server Action của hàng đợi trợ lý phải đi qua cuaGui() — không có ngoại lệ");

  // Và bốn cửa của `cuaGui` phải còn nguyên. Xoá một dòng ở đây là mở một lỗ không ai thấy.
  for (const [mau, y] of [
    [/requireUser\(\)/, "đòi phiên đăng nhập"],
    [/can\(user, "ai:send"\)/, "đòi quyền RIÊNG ai:send"],
    [/modeAtLeast\(agent\.mode, "COPILOT"\)/, "đọc lại nấc quyền hạn từ CSDL"],
    [/copilotPageAllowed\(/, "đòi page nằm trong danh sách thí điểm"],
  ] as const) {
    assert.match(maAction, mau, `cổng gửi phải ${y}`);
  }

  /*
    QUYỀN CỦA TỪNG TRANG — và hàng đợi KHÔNG cùng mức với hai trang kia.

    `/ai/review` và `/ai/fanpage` là màn hình QUAN SÁT: đọc lượt chạy, chấm tay, khai hồ sơ page.
    `ai:view` là đúng mức cho chúng, và trưởng nhóm có quyền ấy.

    `/ai/copilot` là màn hình LÀM VIỆC: nó bày hội thoại THẬT của khách đang chờ, và cả năm nút
    đều đòi `ai:send`. Để nó ở `ai:view` là cho một người không thao tác được gì đọc dữ liệu khách,
    rồi bắt họ nhìn một hàng đợi toàn nút bấm không nổi.
  */
  assert.match(readFileSync("app/(dashboard)/ai/copilot/page.tsx", "utf8"), /requirePermission\("ai:send"\)/, "hàng đợi trợ lý phải đòi ai:send, không phải ai:view");
  for (const trang of ["app/(dashboard)/ai/review/page.tsx", "app/(dashboard)/ai/fanpage/page.tsx"]) {
    assert.match(readFileSync(trang, "utf8"), /requirePermission\("ai:view"\)/, `${trang} phải đòi quyền ai:view`);
  }

  // Thanh bên phải nói CÙNG một mức với trang. Hai nơi lệch nhau thì hoặc hiện một mục bấm vào là
  // 403, hoặc giấu mất một mục người ta có quyền vào — cả hai đều là lỗi người dùng gặp thật.
  assert.match(readFileSync("components/app-sidebar.tsx", "utf8"), /href: "\/ai\/copilot".*permission: "ai:send"/, "mục thanh bên của hàng đợi phải cùng mức quyền với trang");

  /*
    QUYỀN THAO TÁC KHÔNG ĐƯỢC CẤP MẶC ĐỊNH CHO MỌI VAI.

    Mở ra Internet thì danh sách này là thứ quyết định ai chạm được vào hội thoại của khách. Kiểm
    từng vai một, không kiểm "có ít nhất một vai bị chặn".
  */
  for (const vai of ["VIEWER", "ACCOUNTANT", "WAREHOUSE", "MARKETING", "LEADER"] as const) {
    const q = resolvePermissions(vai, null);
    assert.ok(!q.includes("ai:send"), `${vai} KHÔNG được có quyền bấm gửi tin cho khách`);
  }
  for (const vai of ["CS", "ADMIN", "MANAGER"] as const) {
    assert.ok(resolvePermissions(vai, null).includes("ai:send"), `${vai} phải trực được hàng đợi trợ lý`);
  }

  // Và middleware KHÔNG được coi /ai là đường công khai. Mở tên miền ra Internet mà lọt dòng này
  // thì hội thoại thật của khách đọc được bằng một lượt tải trang.
  const maMw = readFileSync("middleware.ts", "utf8");
  // `[\s\S]` chứ không phải cờ `s`: đích biên dịch của kho mã này thấp hơn ES2018 và `tsc` từ chối
  // cờ ấy — `npm test` chạy qua tsx nên vẫn xanh, còn cổng typecheck thì đỏ. Hai nơi, một luật.
  const congKhai = maMw.match(/const PUBLIC_PREFIXES = \[([\s\S]*?)\]/)?.[1] ?? "";
  for (const cam of ["/ai", "/api/ai"]) {
    assert.ok(!congKhai.includes(`"${cam}`), `middleware KHÔNG được xếp ${cam} vào nhóm công khai`);
  }

  /*
    1B. DẤU HUYỀN NGƯỢC TRONG MỘT CHÚ THÍCH SQL LÀM ĐỨT CHUỖI MẪU TYPESCRIPT.

    Đã vấp BA LẦN trong cùng một phiên. `tsc` có bắt được, nhưng nó nói "',' expected" ở một dòng
    cách chỗ sai hàng chục dòng — không ai đọc thông báo ấy mà đoán ra nguyên nhân. Bài kiểm này
    nói thẳng tên lỗi, nên lần thứ tư mất năm giây thay vì năm phút.

    Luật nhận dạng hẹp và không báo nhầm: trong một tệp .ts, một dòng bắt đầu bằng `--` gần như
    chắc chắn là chú thích SQL nằm trong một chuỗi mẫu (TypeScript dùng `//`).

    LẦN THỨ TƯ, 16/09/2026 — và bài kiểm này KHÔNG bắt được. Chú thích gây lỗi là một khối kiểu
    xuyệc-sao nằm TRONG chuỗi mẫu SQL, không phải một dòng gạch-gạch. Một cái lưới chỉ quét một
    hình dạng thì hình dạng kia đi qua, nên phải quét CẢ HAI: trong một chuỗi mẫu SQL, mọi dòng
    chú thích — gạch-gạch hay thân của một khối — đều không được mang dấu huyền ngược.
  */
  const dinhDauHuyen: string[] = [];
  for (const f of tep) {
    if (!f.startsWith("lib/")) continue;
    readFileSync(f, "utf8")
      .split("\n")
      .forEach((dong, i) => {
        if (/^\s*--/.test(dong) && dong.includes("`")) dinhDauHuyen.push(`${f}:${i + 1}`);
      });
  }
  assert.deepEqual(dinhDauHuyen, [], "chú thích SQL không được chứa dấu huyền ngược — nó đóng chuỗi mẫu và làm hỏng cả truy vấn");

  // Và luật thứ hai cho hình dạng KHỐI. Quét theo DÒNG như trên thì báo nhầm mọi chú thích tài
  // liệu bình thường của TypeScript (kho mã này viết tên ký hiệu trong dấu huyền ngược khắp nơi),
  // nên phải tìm đúng CHỖ KẾT THÚC của từng chuỗi mẫu SQL rồi xem sau nó là gì.
  const gayGiua = tep.filter((f) => f.startsWith("lib/")).flatMap((f) => chuoiMauSqlDut(readFileSync(f, "utf8")).map((d) => `${f}:${d}`));
  assert.deepEqual(gayGiua, [], "một chuỗi mẫu SQL kết thúc giữa câu — gần như chắc chắn có dấu huyền ngược trong một chú thích khối bên trong nó");

  // BÀI KIỂM CỦA CHÍNH BÀI KIỂM. Một cái lưới chưa bao giờ bắt được gì thì không ai biết nó có
  // thủng hay không — nên đưa cho nó đúng đoạn mã đã làm hỏng truy vấn hôm nay.
  assert.deepEqual(chuoiMauSqlDut("const q = sql`select 1 from t`;\n"), [], "mã lành KHÔNG được bị báo");
  assert.deepEqual(chuoiMauSqlDut("const z = sql`0` as unknown as number;\n"), [], "sau dấu đóng là từ khoá `as` — vẫn là mã lành");
  assert.deepEqual(chuoiMauSqlDut("// bí danh gõ tay trong sql`` sẽ hỏng\n"), [], "một chú thích TypeScript nhắc tới SQL KHÔNG phải một truy vấn");
  assert.deepEqual(chuoiMauSqlDut("const q = sql`select 1\n  /* xem `HUMAN_REPLY` */\n  from t`;\n"), [2], "chú thích KHỐI mang dấu huyền ngược — đúng hình dạng đã gãy hôm nay");
  assert.deepEqual(chuoiMauSqlDut("const q = sql`select 1\n  -- xem `HUMAN_REPLY`\n  from t`;\n"), [2], "chú thích DÒNG mang dấu huyền ngược — hình dạng đã gãy ba lần trước");

  /*
    1C. BỘ NẠP TIN SỐNG ĐỌC ĐƯỢC, NHƯNG KHÔNG CÓ ĐƯỜNG NÀO TỚI CỔNG GỬI.

    Bốn việc, bốn mức rủi ro: ĐỌC · SOẠN · GỬI · TẠO ĐƠN. Hai việc đầu chạy nền được, hai việc sau
    thì không. Cách chứng minh KHÔNG phải là đọc lời hứa trong chú thích, mà là quét xem tệp chạy
    nền có nhắc tới cổng gửi hay không.
  */
  for (const f of ["lib/ai-workforce/live-ingest.ts", "scripts/ai-live-ingest.ts"]) {
    const ma = readFileSync(f, "utf8");
    assert.ok(!/sendSalesMessage|sendCopilotReply|approvedByUserId/.test(ma), `${f}: tiến trình nền KHÔNG được có đường tới cổng gửi`);
  }
  // Và chính nó tự từ chối khởi động nếu môi trường cho máy tự gửi — một lớp nữa, cố ý thừa.
  assert.match(readFileSync("scripts/ai-live-ingest.ts", "utf8"), /allowAutoSend[\s\S]{0,200}process\.exit\(1\)/, "bộ nạp phải tự dừng khi AI_ALLOW_AUTO_SEND bật");

  // NGHỈ DÀI DẦN KHI HỎNG — hàm thuần, và trần phải có thật.
  assert.equal(nextDelaySeconds(45, 0), 45, "chạy được thì giữ nhịp thường");
  assert.equal(nextDelaySeconds(45, 1), 45, "hỏng lần đầu chưa nhân đôi");
  assert.equal(nextDelaySeconds(45, 2), 90);
  assert.equal(nextDelaySeconds(45, 3), 180);
  // HAI cái trần, và cái nào chặn trước là tuỳ nhịp: hệ số nhân có trần 8×, và có thêm một trần
  // TUYỆT ĐỐI theo giây. Ở nhịp 45s thì 8× (360s) chặn trước; ở nhịp thưa thì trần giây chặn.
  // Chỉ kiểm một trong hai là để cái còn lại tự do trôi.
  assert.equal(nextDelaySeconds(45, 20), 45 * LIVE_INGEST_MAX_BACKOFF, "nghỉ dài dần phải có TRẦN, nếu không một lượt hỏng dài sẽ thành ngừng hẳn");
  assert.equal(nextDelaySeconds(120, 20), LIVE_INGEST_MAX_SECONDS, "nhịp thưa thì TRẦN THEO GIÂY chặn — 120×8 = 960s là bỏ rơi hàng đợi cả mười lăm phút");
  for (const n of [1, 2, 3, 5, 8, 13, 99]) assert.ok(nextDelaySeconds(60, n) <= LIVE_INGEST_MAX_SECONDS, `nghỉ ${n} lần hỏng vẫn phải dưới trần`);

  // CỬA SỔ ĐỌC — luôn chồng lấn, và lần đầu KHÔNG đọc cả lịch sử.
  const batDau = new Date("2026-09-16T10:00:00Z");
  assert.equal(windowHours(null, batDau), 2, "chưa có mốc thì đọc một cửa sổ NHỎ, không phải toàn bộ lịch sử");
  assert.equal(windowHours(new Date("2026-09-16T09:58:00Z"), batDau), 1, "vừa chạy xong vẫn hỏi lại ít nhất 1 giờ — chồng lấn để không lọt tin");
  assert.equal(windowHours(new Date("2026-09-16T04:00:00Z"), batDau), 7, "đứt 6 tiếng thì đọc bù 6 tiếng + chồng lấn");
  assert.equal(windowHours(new Date("2026-09-10T10:00:00Z"), batDau), 24, "đứt nhiều ngày vẫn có TRẦN 24 giờ");

  // SỨC KHOẺ — và thứ tự các nhánh: TẮT phải đứng trước LỖI.
  const luc = new Date("2026-09-16T10:00:00Z");
  assert.equal(liveIngestHealth({ enabled: false, lastOkAt: null, consecutiveErrors: 9, now: luc }), "OFF", "đang tắt thì báo TẮT, không báo LỖI — nếu không người vận hành đi tìm một sự cố không tồn tại");
  assert.equal(liveIngestHealth({ enabled: true, lastOkAt: null, consecutiveErrors: 3, now: luc }), "ERROR");
  assert.equal(liveIngestHealth({ enabled: true, lastOkAt: new Date("2026-09-16T09:59:30Z"), consecutiveErrors: 0, now: luc }), "LIVE");
  assert.equal(liveIngestHealth({ enabled: true, lastOkAt: new Date("2026-09-16T09:50:00Z"), consecutiveErrors: 0, now: luc }), "SLOW", "mười phút không có vòng nào chạy được là ĐỨT, không phải 'đang chậm một chút'");
  assert.equal(liveIngestHealth({ enabled: true, lastOkAt: new Date("2026-09-16T09:50:00Z"), consecutiveErrors: 2, now: luc }), "ERROR");

  /*
    1D. TRẦN NẤC QUYỀN HẠN VÀ ĐỢT THÍ ĐIỂM DÍNH VỚI NHAU — nói thẳng ra, đừng để ai phát hiện lại.

    16/09/2026: thao tác ops ghi `ai_agents.mode = 'COPILOT'`, psql đọc lại ra `COPILOT`, và đợt thí
    điểm được báo là SẴN SÀNG. Nhưng `effectiveMode()` kẹp nấc xuống `MAX_ALLOWED_MODE`, khi ấy là
    `SHADOW`, nên nút gửi tắt và KHÔNG một dòng nào nói vì sao. Con số trên màn hình và con số trong
    CSDL nói hai điều khác nhau suốt mấy ngày.

    Bài này không quyết định trần nên là gì — đó là việc của chủ shop. Nó chỉ bắt hai thứ phải KHỚP:
    trần dưới COPILOT thì nấc trợ lý KHÔNG thể bật, và ai đọc bài này biết ngay phải sửa ở đâu.
  */
  const tranChoPhepTroLy = modeAtLeast(MAX_ALLOWED_MODE, "COPILOT");
  assert.equal(
    modeAtLeast(clampMode("COPILOT"), "COPILOT"),
    tranChoPhepTroLy,
    `TRẦN ${MAX_ALLOWED_MODE} quyết định nấc trợ lý có bật được hay không — ghi 'COPILOT' vào ai_agents.mode KHÔNG đủ`,
  );
  // Dù trần có là gì, AUTO không bao giờ với tới được. Đây mới là câu phải luôn đúng.
  assert.ok(!modeAtLeast(clampMode("AUTO"), "AUTO"), "không đường nào qua clampMode ra được nấc AUTO — máy tự nhắn khách phải là thứ không cấu hình nào với tới");

  // ═════════ 2. QUYỀN GỬI TÁCH KHỎI QUYỀN XEM ═════════
  const cs = resolvePermissions("CS", null);
  assert.ok(cs.includes("ai:send"), "người trực chat (CS) phải bấm gửi được");
  for (const vai of ["VIEWER", "ACCOUNTANT", "WAREHOUSE", "MARKETING"] as const) {
    const q = resolvePermissions(vai, null);
    if (q.includes("ai:send")) assert.fail(`${vai} không được có quyền bấm gửi tin cho khách`);
  }

  // ═════════ 3. DANH SÁCH TRẮNG PAGE — RỖNG NGHĨA LÀ KHÔNG AI GỬI ĐƯỢC ═════════
  await setSettingJson(COPILOT_PAGES_KEY, [] as unknown as Record<string, unknown>);
  assert.deepEqual(await copilotPages(db), [], "chưa khai thì danh sách rỗng");
  assert.equal(await copilotPageAllowed("page-thi-diem", db), false, "rỗng ⇒ KHÔNG page nào gửi được (mặc định hẹp)");

  await db
    .insert(schema.settings)
    .values({ key: COPILOT_PAGES_KEY, value: JSON.stringify(["page-thi-diem"]) })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: JSON.stringify(["page-thi-diem"]) } });
  assert.equal(await copilotPageAllowed("page-thi-diem", db), true);
  assert.equal(await copilotPageAllowed("page-khac", db), false, "page khác KHÔNG được thí điểm lây sang");
  assert.equal(await copilotPageAllowed("", db), false, "page trống không bao giờ hợp lệ");

  // Cấu hình hỏng ⇒ rơi về phía HẸP HƠN, không phải mở toang.
  await db.update(schema.settings).set({ value: "{khong-phai-json" }).where(eq(schema.settings.key, COPILOT_PAGES_KEY));
  assert.deepEqual(await copilotPages(db), [], "cấu hình hỏng ⇒ không page nào gửi được");
  // Không page nào thí điểm ⇒ không có dòng tình trạng nào. Một dải trạng thái báo "ĐANG CHẠY"
  // cho một page không ai bật là lời trấn an sai chỗ.
  assert.deepEqual(await ingestStatus(db), [], "chưa khai page thì không có dòng tình trạng nạp tin nào");
  await db.update(schema.settings).set({ value: JSON.stringify(["page-thi-diem"]) }).where(eq(schema.settings.key, COPILOT_PAGES_KEY));

  // TÌNH TRẠNG BỘ NẠP ĐỌC ĐƯỢC KHÔNG CẦN LOG — và mặc định là TẮT, vì `AI_LIVE_INGEST_ENABLED`
  // vắng mặt. Trước đây câu trả lời "nó có chạy không" chỉ nằm trong `docker logs`.
  const tinhTrang = await ingestStatus(db);
  assert.equal(tinhTrang.length, 1, "mỗi page thí điểm một dòng tình trạng");
  assert.equal(tinhTrang[0].pageId, "page-thi-diem");
  assert.equal(tinhTrang[0].health, "OFF", "chưa bật công tắc ⇒ TẮT, không phải LỖI");
  assert.equal(tinhTrang[0].lastOkAt, null, "chưa vòng nào chạy ⇒ CHƯA BIẾT, không phải mốc 0");
  assert.equal(tinhTrang[0].messagesIngested, 0);

  // ═════════ 4. KHOẢNG CÁCH SỬA — HÀM THUẦN ═════════
  assert.equal(editDistance("abc", "abc"), 0);
  assert.equal(editDistance("", "abc"), 3);
  assert.equal(editDistance("Dạ 499k", "Dạ 499K"), 1);
  assert.equal(isMeaningfulEdit("Dạ mẫu này 499.000đ chị nhé ạ", "Dạ mẫu này 499.000đ chị nhé ạ."), false, "thêm một dấu chấm KHÔNG phải sửa đáng kể");
  assert.equal(isMeaningfulEdit("Dạ mẫu này 499.000đ chị nhé ạ", "Chị ơi mẫu này bên em 499k, chị lấy màu nào ạ?"), true, "viết lại nửa câu LÀ sửa đáng kể");
  assert.equal(isMeaningfulEdit("", "bất cứ gì"), true, "câu gốc rỗng thì mọi thứ gõ vào đều đáng kể");
  assert.ok(COPILOT_MEANINGFUL_EDIT_RATIO > 0 && COPILOT_MEANINGFUL_EDIT_RATIO < 1);

  // ═════════ 5. SỔ THAO TÁC: BẤM HAI LẦN KHÔNG THÀNH HAI TIN ═════════
  const nguoi = "u-copilot-sale";
  await db
    .insert(schema.users)
    .values({ id: nguoi, email: "sale-copilot@test.local", name: "Chị Hà", passwordHash: "x", role: "CS", active: true })
    .onConflictDoNothing();

  const convId = "conv-copilot-1";
  await db
    .insert(schema.salesConversations)
    .values({ id: convId, pageId: "page-thi-diem", externalId: "ext-copilot-1", pancakeCustomerId: "pc-1", customerName: "Chị Lan", stage: "SIZE_SELECTION", sourceType: "WIN" })
    .onConflictDoNothing();
  const goiY = "s-copilot-1";
  await db
    .insert(schema.salesSuggestions)
    .values({ id: goiY, conversationId: convId, suggestedReply: "Dạ Đầm Q004 giá 499.000 ₫, phí ship 25.000 ₫, tổng 524.000 ₫ ạ.", action: "ANSWER_QUESTION", productionAction: "NO_SEND" })
    .onConflictDoNothing();

  const ghi = (patch: Partial<typeof schema.salesCopilotActions.$inferInsert>) =>
    db.insert(schema.salesCopilotActions).values({
      conversationId: convId,
      suggestionId: goiY,
      pageId: "page-thi-diem",
      action: "SEND",
      suggestedText: "x",
      finalText: "x",
      sendStatus: "SENT",
      actorUserId: nguoi,
      actorName: "Chị Hà",
      ...patch,
    });

  await ghi({});
  await assert.rejects(ghi({}), "bấm Gửi lần thứ hai trên cùng câu gợi ý phải bị CSDL từ chối");
  await assert.rejects(ghi({ action: "EDIT_SEND" }), "gửi rồi thì không sửa-rồi-gửi lại được");
  await assert.rejects(ghi({ action: "REJECT", sendStatus: "NONE" }), "gửi rồi thì không từ chối được nữa");

  // Nhưng SOẠN LẠI và NHẬN VIỆC không phải việc kết thúc — chúng vẫn ghi được.
  await ghi({ action: "REGENERATE", sendStatus: "NONE", suggestionId: null });
  await ghi({ action: "TAKEOVER", sendStatus: "NONE", suggestionId: null });
  assert.deepEqual([...COPILOT_TERMINAL_ACTIONS].sort(), ["EDIT_SEND", "REJECT", "SEND"]);

  // Gửi HỎNG thì phải bấm lại được — mạng đứt không được biến thành một khách vĩnh viễn không được trả lời.
  const goiY2 = "s-copilot-2";
  await db.insert(schema.salesSuggestions).values({ id: goiY2, conversationId: convId, suggestedReply: "câu hai", action: "ANSWER_QUESTION" }).onConflictDoNothing();
  await ghi({ suggestionId: goiY2, sendStatus: "FAILED", sendError: "mạng đứt" });
  await ghi({ suggestionId: goiY2, sendStatus: "SENT" });
  const lanHai = await db.query.salesCopilotActions.findMany({ where: eq(schema.salesCopilotActions.suggestionId, goiY2) });
  assert.equal(lanHai.length, 2, "lượt hỏng không chặn lượt thử lại");

  // Danh sách ĐÓNG chặn ở CSDL, không chỉ ở lược đồ đầu vào.
  await assert.rejects(ghi({ suggestionId: null, action: "KHONG_CO_VIEC_NAY" }), "việc lạ phải bị CSDL từ chối");
  await assert.rejects(ghi({ suggestionId: null, action: "REGENERATE", sendStatus: "DA_GUI_ROI" }), "trạng thái gửi lạ phải bị CSDL từ chối");
  assert.equal(COPILOT_REJECT_REASONS.length, 11, "mười một lý do từ chối — thêm lý do thì phải thêm nhãn");

  // ═════════ 6. HÀNG ĐỢI: CÂU ĐÃ XỬ LÝ BIẾN MẤT, CÂU CŨ BỊ ĐÁNH DẤU ═════════
  const q = await copilotQueue({ pageIds: ["page-thi-diem"], db });
  assert.ok(!q.some((r) => r.suggestionId === goiY), "câu đã gửi không còn nằm trong hàng đợi");

  const convCu = "conv-copilot-cu";
  await db
    .insert(schema.salesConversations)
    .values({ id: convCu, pageId: "page-thi-diem", externalId: "ext-copilot-cu", pancakeCustomerId: "pc-2", customerName: "Chị Mai", stage: "SIZE_SELECTION", sourceType: "WIN" })
    .onConflictDoNothing();
  const lauRoi = new Date(Date.now() - 120 * 60_000);
  // Hội thoại phải có TIN KHÁCH THẬT thì mới là việc — tin này cũ hơn câu gợi ý, nên nó không làm
  // câu ấy "cũ vì có tin mới hơn"; cái cũ ở đây là cũ vì THỜI GIAN.
  await db
    .insert(schema.salesMessages)
    .values({
      id: "m-copilot-cu",
      conversationId: convCu,
      externalId: "ext-m-cu",
      direction: "IN",
      fromPage: false,
      senderType: "CUSTOMER",
      text: "mẫu này bao nhiêu shop",
      sentAt: new Date(Date.now() - 180 * 60_000),
    })
    .onConflictDoNothing();
  await db
    .insert(schema.salesSuggestions)
    .values({ id: "s-copilot-cu", conversationId: convCu, suggestedReply: "câu soạn từ hai tiếng trước", action: "ANSWER_QUESTION", createdAt: lauRoi })
    .onConflictDoNothing();
  const q2 = await copilotQueue({ pageIds: ["page-thi-diem"], db });
  const dongCu = q2.find((r) => r.conversationId === convCu);
  assert.ok(dongCu, "hội thoại chưa ai xử lý phải nằm trong hàng đợi");
  assert.ok(dongCu.stale, "câu soạn hai tiếng trước phải bị đánh dấu là cũ");
  assert.match(dongCu.stale, /phút/);

  // Khách nhắn thêm sau khi máy soạn ⇒ câu ấy trả lời một hội thoại không còn tồn tại.
  await db.insert(schema.salesMessages).values({
    id: "m-copilot-moi",
    conversationId: convCu,
    externalId: "ext-m-moi",
    direction: "IN",
    fromPage: false,
    senderType: "CUSTOMER",
    text: "chị đổi ý, lấy màu đen nhé",
    sentAt: new Date(),
  });
  const q3 = await copilotQueue({ pageIds: ["page-thi-diem"], db });
  assert.match(q3.find((r) => r.conversationId === convCu)!.stale!, /nhắn thêm/, "có tin khách mới hơn thì phải nói rõ là vì thế");

  // Page ngoài danh sách KHÔNG lọt vào hàng đợi.
  assert.deepEqual(await copilotQueue({ pageIds: [], db }), [], "không page nào ⇒ hàng đợi rỗng, không phải 'lấy hết'");

  // ═════════ 6B. NGƯỜI ĐANG CẦM VIỆC THÌ HỘI THOẠI RỜI HÀNG ĐỢI CỦA NGƯỜI KHÁC ═════════
  //
  // "Không spam nhân viên bằng gợi ý mới sau mỗi tin khi đang tiếp quản" — nhưng giấu hẳn thì
  // chính người đang cầm cũng mất nút TRẢ LẠI, và hội thoại kẹt ở trạng thái ấy vĩnh viễn.
  const nguoiKhac = "u-copilot-khac";
  await db
    .insert(schema.users)
    .values({ id: nguoiKhac, email: "sale2-copilot@test.local", name: "Chị Thu", passwordHash: "x", role: "CS", active: true })
    .onConflictDoNothing();
  await db
    .update(schema.salesConversations)
    .set({ humanTakeoverAt: new Date(), takeoverByUserId: nguoi })
    .where(eq(schema.salesConversations.id, convCu));

  const cuaNguoiKhac = await copilotQueue({ pageIds: ["page-thi-diem"], heldByUserId: nguoiKhac, db });
  assert.ok(!cuaNguoiKhac.some((r) => r.conversationId === convCu), "người KHÁC không thấy hội thoại đang có người cầm");
  const cuaChuViec = await copilotQueue({ pageIds: ["page-thi-diem"], heldByUserId: nguoi, db });
  assert.ok(cuaChuViec.some((r) => r.conversationId === convCu), "chính người đang cầm vẫn thấy, để còn trả lại được");
  await db.update(schema.salesConversations).set({ humanTakeoverAt: null, takeoverByUserId: null }).where(eq(schema.salesConversations.id, convCu));

  // Câu sinh ra CHỈ để chấm điểm không bao giờ vào hàng đợi — mời nhân viên gửi một câu mà chính
  // hệ thống đã quyết định không gửi là mâu thuẫn với lý do câu ấy tồn tại.
  const convCham = "conv-copilot-cham";
  await db
    .insert(schema.salesConversations)
    .values({ id: convCham, pageId: "page-thi-diem", externalId: "ext-cham", pancakeCustomerId: "pc-3", customerName: "Chị Tú", stage: "HUMAN_TAKEOVER", sourceType: "WIN" })
    .onConflictDoNothing();
  // Có tin khách thật, để hội thoại này bị loại vì ĐÚNG lý do đang kiểm (câu chỉ-để-chấm) chứ
  // không phải vì thiếu tin khách — một phép thử đúng vì lý do sai là một phép thử không có giá trị.
  await db
    .insert(schema.salesMessages)
    .values({ id: "m-cham", conversationId: convCham, externalId: "ext-m-cham", direction: "IN", fromPage: false, senderType: "CUSTOMER", text: "còn hàng không shop", sentAt: new Date() })
    .onConflictDoNothing();
  await db
    .insert(schema.salesSuggestions)
    .values({ id: "s-cham", conversationId: convCham, suggestedReply: "câu chỉ để chấm", action: "ANSWER_QUESTION", evaluationOnly: true })
    .onConflictDoNothing();
  assert.ok(!(await copilotQueue({ pageIds: ["page-thi-diem"], db })).some((r) => r.conversationId === convCham), "câu chỉ-để-chấm không vào hàng đợi");

  // Và câu RỖNG cũng không: một thẻ với ô soạn trống chỉ làm dài hàng đợi.
  const convRong = "conv-copilot-rong";
  await db
    .insert(schema.salesConversations)
    .values({ id: convRong, pageId: "page-thi-diem", externalId: "ext-rong", pancakeCustomerId: "pc-4", customerName: "Chị Vy", stage: "NEW_LEAD", sourceType: "WIN" })
    .onConflictDoNothing();
  await db
    .insert(schema.salesMessages)
    .values({ id: "m-rong", conversationId: convRong, externalId: "ext-m-rong", direction: "IN", fromPage: false, senderType: "CUSTOMER", text: "alo shop", sentAt: new Date() })
    .onConflictDoNothing();
  await db.insert(schema.salesSuggestions).values({ id: "s-rong", conversationId: convRong, suggestedReply: "   ", action: "NO_ACTION" }).onConflictDoNothing();
  assert.ok(!(await copilotQueue({ pageIds: ["page-thi-diem"], db })).some((r) => r.conversationId === convRong), "câu rỗng không vào hàng đợi");

  /*
    6B★. MỘT CÂU BOT KHÔNG PHẢI "ĐÃ CÓ NGƯỜI TRẢ LỜI".

    ĐO 16/09/2026 trên page thí điểm: 48/50 hội thoại bị tính là "shop đã đáp rồi", hàng đợi ra
    ĐÚNG 0, và màn hình báo "không có việc nào" một cách hoàn toàn tự tin. Truy vấn khi ấy nhận cả
    PAGE_BOT là câu trả lời, nên Botcake chào một câu là khách biến mất khỏi hàng đợi.

    Ba loại tin phía shop, ba kết quả — và chỉ MỘT loại được làm khách rời hàng đợi.
  */
  const dungBot = async (id: string, loai: "PAGE_BOT" | "PAGE_SYSTEM" | "PAGE_HUMAN") => {
    await db
      .insert(schema.salesConversations)
      .values({ id, pageId: "page-bot", externalId: `ext-${id}`, pancakeCustomerId: `pc-${id}`, customerName: id, stage: "NEW_LEAD", sourceType: "WIN" })
      .onConflictDoNothing();
    const luc = new Date(Date.now() - 600_000);
    await db
      .insert(schema.salesMessages)
      .values({ id: `mk-${id}`, conversationId: id, externalId: `emk-${id}`, direction: "IN", fromPage: false, senderType: "CUSTOMER", text: "còn hàng không shop", sentAt: luc })
      .onConflictDoNothing();
    await db
      .insert(schema.salesMessages)
      .values({ id: `ms-${id}`, conversationId: id, externalId: `ems-${id}`, direction: "OUT", fromPage: true, senderType: loai, text: "shop sẽ phản hồi sớm ạ", sentAt: new Date(luc.getTime() + 60_000) })
      .onConflictDoNothing();
    await db
      .insert(schema.salesSuggestions)
      .values({ id: `sb-${id}`, conversationId: id, suggestedReply: `gợi ý ${id}`, action: "ANSWER_QUESTION" })
      .onConflictDoNothing();
  };
  await dungBot("conv-bot", "PAGE_BOT");
  await dungBot("conv-he-thong", "PAGE_SYSTEM");
  await dungBot("conv-nguoi", "PAGE_HUMAN");
  const hangBot = await copilotQueue({ pageIds: ["page-bot"], db });
  const coTrongHang = (id: string) => hangBot.some((r) => r.conversationId === id);
  assert.ok(coTrongHang("conv-bot"), "câu BOT không được làm lượt khách biến mất — khách vẫn đang chờ một người");
  assert.ok(coTrongHang("conv-he-thong"), "thông báo nền tảng cũng không phải một người đã trả lời");
  assert.ok(!coTrongHang("conv-nguoi"), "câu NHÂN VIÊN thật thì mới hết việc");

  /*
    6B★★. CÂU MẪU LẶP QUA NHIỀU HỘI THOẠI KHÔNG PHẢI CÂU MỘT NGƯỜI VỪA GÕ.

    ĐO 16/09/2026: 339 tin mang nhãn PAGE_HUMAN trên page thí điểm, nhưng ĐÚNG MỘT tài khoản gửi
    tất cả, 71 tin gửi TRƯỚC tin đầu tiên của khách, và hai câu dài xuất hiện đúng một lần ở mỗi
    35 hội thoại khác nhau. Nhãn đặt lúc NẠP không thấy được điều đó — nó chỉ nhìn một tin.

    Ba hội thoại dưới đây nhận CÙNG một câu mẫu (đủ ngưỡng), hội thoại thứ tư nhận một câu riêng.
  */
  const cauMau = "dạ mẫu này hiện có 2 màu chị nhé, ưu đãi duy nhất hôm nay ạ";
  const dungMau = async (id: string, van: string) => {
    await db
      .insert(schema.salesConversations)
      .values({ id, pageId: "page-mau", externalId: `ext-${id}`, pancakeCustomerId: `pc-${id}`, customerName: id, stage: "NEW_LEAD", sourceType: "WIN" })
      .onConflictDoNothing();
    const luc = new Date(Date.now() - 900_000);
    await db
      .insert(schema.salesMessages)
      .values({ id: `mk-${id}`, conversationId: id, externalId: `emk-${id}`, direction: "IN", fromPage: false, senderType: "CUSTOMER", text: "cho em hỏi mẫu này", sentAt: luc })
      .onConflictDoNothing();
    await db
      .insert(schema.salesMessages)
      .values({ id: `mh-${id}`, conversationId: id, externalId: `emh-${id}`, direction: "OUT", fromPage: true, senderType: "PAGE_HUMAN", text: van, sentAt: new Date(luc.getTime() + 60_000) })
      .onConflictDoNothing();
    await db
      .insert(schema.salesSuggestions)
      .values({ id: `sm-${id}`, conversationId: id, suggestedReply: `gợi ý ${id}`, action: "ANSWER_QUESTION" })
      .onConflictDoNothing();
  };
  await dungMau("conv-mau-1", cauMau);
  await dungMau("conv-mau-2", cauMau);
  await dungMau("conv-mau-3", cauMau);
  await dungMau("conv-rieng", "dạ chị Lan ơi cái váy chị hỏi hôm qua về rồi ạ, em giữ size M nhé");
  const hangMau = await copilotQueue({ pageIds: ["page-mau"], db });
  const trongHangMau = (id: string) => hangMau.some((r) => r.conversationId === id);
  assert.equal(AUTOMATION_TEMPLATE_MIN_CONVERSATIONS, 3, "ngưỡng dùng trong bài kiểm phải là ngưỡng đang chạy");
  for (const id of ["conv-mau-1", "conv-mau-2", "conv-mau-3"]) {
    assert.ok(trongHangMau(id), `${id}: câu mẫu lặp ở 3 hội thoại KHÔNG được tính là nhân viên đã trả lời`);
  }
  assert.ok(!trongHangMau("conv-rieng"), "câu viết riêng cho một khách thì đúng là người đã trả lời — hết việc");

  /*
    6B★★★. MÁY XIN NGƯỜI VÀO ≠ NGƯỜI ĐÃ CẦM VIỆC.

    ĐO 18/09/2026 trên page thí điểm: 24 hội thoại có `human_takeover_at`, NGƯỜI tự nhận 0, máy xin
    người vào 24. Tức là mọi cuộc mà máy tự nhận "tôi không xử lý được" đều BIẾN MẤT khỏi đúng cái
    màn hình người trực mở ra. Và vì khoá người là NULL, mệnh đề "trừ việc của chính mình" không bao
    giờ khớp — chúng vô hình với TẤT CẢ mọi người, không riêng ai.

    Bốn hội thoại dưới đây khác nhau ĐÚNG ở cột quyết định, để bài kiểm chỉ nói về một điều.
  */
  const nguoiThat = await db.query.users.findFirst();
  assert.ok(nguoiThat, "cần một tài khoản thật để đóng vai người nhận việc");
  const dungGiao = async (id: string, opts: { may?: boolean; nguoiId?: string | null; lyDo?: string }) => {
    await db
      .insert(schema.salesConversations)
      .values({
        id,
        pageId: "page-giao",
        externalId: `ext-${id}`,
        pancakeCustomerId: `pc-${id}`,
        customerName: id,
        stage: "NEW_LEAD",
        sourceType: "WIN",
        humanTakeoverAt: opts.may || opts.nguoiId ? new Date(Date.now() - 300_000) : null,
        takeoverByUserId: opts.nguoiId ?? null,
        takeoverReason: opts.lyDo ?? "",
      })
      .onConflictDoNothing();
    const luc = new Date(Date.now() - 600_000);
    await db
      .insert(schema.salesMessages)
      .values({ id: `mg-${id}`, conversationId: id, externalId: `emg-${id}`, direction: "IN", fromPage: false, senderType: "CUSTOMER", text: "shop ơi tư vấn giúp em", sentAt: luc })
      .onConflictDoNothing();
    await db
      .insert(schema.salesSuggestions)
      .values({ id: `sg-${id}`, conversationId: id, suggestedReply: `gợi ý ${id}`, action: "ANSWER_QUESTION" })
      .onConflictDoNothing();
  };
  await dungGiao("conv-may-giao", { may: true, lyDo: "SIZE_DATA_MISSING" });
  await dungGiao("conv-nguoi-cam", { nguoiId: nguoiThat.id });
  await dungGiao("conv-thuong", {});

  const hangGiao = await copilotQueue({ pageIds: ["page-giao"], db });
  const trongHangGiao = (id: string) => hangGiao.some((r) => r.conversationId === id);
  assert.ok(trongHangGiao("conv-may-giao"), "MÁY xin người vào thì việc PHẢI còn trong hàng đợi — nó là việc cần người nhất");
  assert.ok(trongHangGiao("conv-thuong"), "hội thoại thường vẫn ở hàng đợi");
  assert.ok(!trongHangGiao("conv-nguoi-cam"), "NGƯỜI THẬT đã nhận thì rời hàng đợi CHUNG");

  // Cờ và lý do phải tới được màn hình, nếu không thẻ đỏ mà không nói vì sao.
  const theMay = hangGiao.find((r) => r.conversationId === "conv-may-giao");
  assert.equal(theMay?.machineHandoff, true, "thẻ phải mang cờ máy-xin-người-vào");
  assert.equal(theMay?.handoffRequestReason, "SIZE_DATA_MISSING", "lý do máy chuyển việc phải đọc được trên thẻ");
  assert.equal(hangGiao.find((r) => r.conversationId === "conv-thuong")?.machineHandoff, false, "hội thoại thường KHÔNG mang cờ ấy");

  // Và nó đứng ĐẦU: máy đã sàng một lượt rồi, nên nó không phải xếp hàng theo giờ như người khác.
  assert.equal(hangGiao[0]?.conversationId, "conv-may-giao", "việc máy kêu cứu phải nằm đầu hàng đợi");

  // Người đã cầm thì thấy lại được việc của CHÍNH MÌNH — để còn trả lại cho máy.
  const hangCuaNguoi = await copilotQueue({ pageIds: ["page-giao"], heldByUserId: nguoiThat.id, db });
  assert.ok(hangCuaNguoi.some((r) => r.conversationId === "conv-nguoi-cam"), "người đang cầm vẫn thấy việc của chính mình");

  // ═════════ 6C. HÀNG ĐỢI: AI CHỜ LÂU NHẤT ĐƯỢC TRẢ LỜI TRƯỚC ═════════
  //
  // Xếp hàng theo thứ tự đến, như mọi quầy phục vụ. Một người đợi bốn mươi phút gấp hơn một người
  // vừa nhắn hai phút, bất kể họ hỏi gì — Ý ĐỊNH chỉ phá hoà khi hai người chờ xấp xỉ bằng nhau.
  //
  // Và hội thoại NHÂN VIÊN ĐÃ ĐÁP sau lượt ấy thì rời hẳn hàng đợi, không phải xếp xuống cuối:
  // "xuống cuối" vẫn là một thẻ người trực phải đọc và bỏ qua.

  const nhanSu = await getAgent("sales", undefined, db);
  assert.ok(nhanSu, "phải có nhân sự bán hàng trong sổ đăng ký");

  const dungXep = async (id: string, tin: string, giay: number, daTraLoi: boolean, yDinh: string[]) => {
    await db
      .insert(schema.salesConversations)
      .values({ id, pageId: "page-xep", externalId: `ext-${id}`, pancakeCustomerId: `pc-${id}`, customerName: id, stage: "SIZE_SELECTION", sourceType: "WIN" })
      .onConflictDoNothing();
    const luc = new Date(Date.now() - giay * 1000);
    await db
      .insert(schema.salesMessages)
      .values({ id: `m-${id}`, conversationId: id, externalId: `em-${id}`, direction: "IN", fromPage: false, senderType: "CUSTOMER", text: tin, sentAt: luc })
      .onConflictDoNothing();
    if (daTraLoi) {
      await db
        .insert(schema.salesMessages)
        .values({ id: `mp-${id}`, conversationId: id, externalId: `emp-${id}`, direction: "OUT", fromPage: true, senderType: "PAGE_HUMAN", text: "dạ chị", sentAt: new Date(luc.getTime() + 1000) })
        .onConflictDoNothing();
    }
    await db
      .insert(schema.aiRuns)
      .values({ id: `r-${id}`, agentId: nhanSu.id, subjectType: "CONVERSATION", subjectId: id, status: "SUCCEEDED", understanding: { intents: yDinh, entities: {} } })
      .onConflictDoNothing();
    await db
      .insert(schema.salesSuggestions)
      .values({ id: `s-${id}`, conversationId: id, runId: `r-${id}`, suggestedReply: `gợi ý cho ${id}`, action: "ANSWER_QUESTION" })
      .onConflictDoNothing();
  };

  // Cố ý dựng NGƯỢC: hội thoại có ý định "đáng giá" nhất lại là hội thoại chờ lâu nhất, và hội
  // thoại mới nhất lại là hội thoại đã được trả lời. Xếp sai kiểu nào bài này cũng đỏ.
  await dungXep("z-da-tra-loi-muon", "em muốn mua", 10, true, ["PURCHASE_INTENT"]);
  await dungXep("z-khac-moi", "ok", 20, false, ["OTHER"]);
  await dungXep("z-ban-khoan", "đắt quá shop", 40, false, ["OBJECTION"]);
  await dungXep("z-hoi-gia", "bao nhiêu", 60, false, ["PRICE_QUESTION"]);
  await dungXep("z-muon-mua", "chị lấy một cái", 90, false, ["PURCHASE_INTENT"]);

  const xep = (await copilotQueue({ pageIds: ["page-xep"], db })).map((r) => r.conversationId);
  assert.deepEqual(xep, ["z-muon-mua", "z-hoi-gia", "z-ban-khoan", "z-khac-moi"], "chờ lâu nhất lên trước");
  assert.ok(!xep.includes("z-da-tra-loi-muon"), "nhân viên đã đáp sau lượt ấy ⇒ RỜI HẲN hàng đợi, không phải xếp xuống cuối");

  const hang = await copilotQueue({ pageIds: ["page-xep"], db });
  assert.ok(hang.every((r) => r.waitingForReply), "mọi dòng trong hàng đợi đều là khách đang chờ");
  assert.ok((hang[0].waitedMinutes ?? 0) >= (hang.at(-1)!.waitedMinutes ?? 0), "thời gian chờ giảm dần từ trên xuống");

  // Ý ĐỊNH phá hoà: chờ BẰNG NHAU thì phục vụ người sắp mua trước.
  const cungLuc = new Date(Date.now() - 300 * 1000);
  for (const [id, yDinh] of [
    ["z-hoa-khac", ["OTHER"]],
    ["z-hoa-mua", ["PURCHASE_INTENT"]],
  ] as const) {
    await db
      .insert(schema.salesConversations)
      .values({ id, pageId: "page-hoa", externalId: `ext-${id}`, pancakeCustomerId: `pc-${id}`, customerName: id, stage: "SIZE_SELECTION", sourceType: "WIN" })
      .onConflictDoNothing();
    await db
      .insert(schema.salesMessages)
      .values({ id: `m-${id}`, conversationId: id, externalId: `em-${id}`, direction: "IN", fromPage: false, senderType: "CUSTOMER", text: "x", sentAt: cungLuc })
      .onConflictDoNothing();
    await db
      .insert(schema.aiRuns)
      .values({ id: `r-${id}`, agentId: nhanSu.id, subjectType: "CONVERSATION", subjectId: id, status: "SUCCEEDED", understanding: { intents: [...yDinh], entities: {} } })
      .onConflictDoNothing();
    await db
      .insert(schema.salesSuggestions)
      .values({ id: `s-${id}`, conversationId: id, runId: `r-${id}`, suggestedReply: "gợi ý", action: "ANSWER_QUESTION" })
      .onConflictDoNothing();
  }
  assert.deepEqual(
    (await copilotQueue({ pageIds: ["page-hoa"], db })).map((r) => r.conversationId),
    ["z-hoa-mua", "z-hoa-khac"],
    "chờ bằng nhau thì ý định phá hoà: người sắp mua trước",
  );

  // QUÁ CŨ THÌ RỜI ĐI: không có mốc cắt thì tồn đọng vài ngày sẽ chôn người vừa nhắn xuống dưới.
  await dungXep("z-qua-cu", "hỏi từ đời nào", (COPILOT_QUEUE_RELEVANT_HOURS + 2) * 3600, false, ["PRICE_QUESTION"]);
  assert.ok(
    !(await copilotQueue({ pageIds: ["page-xep"], db })).some((r) => r.conversationId === "z-qua-cu"),
    `hội thoại cũ hơn ${COPILOT_QUEUE_RELEVANT_HOURS} giờ rời hàng đợi — "chờ lâu nhất" phải nghĩa là lâu nhất trong số CÒN ĐÁNG trả lời`,
  );

  // Thông báo nền tảng KHÔNG được kéo một hội thoại lên đầu: nó không phải một người đang chờ.
  await db
    .insert(schema.salesConversations)
    .values({ id: "z-thong-bao", pageId: "page-xep", externalId: "ext-tb", pancakeCustomerId: "pc-tb", customerName: "TB", stage: "NEW_LEAD", sourceType: "WIN" })
    .onConflictDoNothing();
  await db
    .insert(schema.salesMessages)
    .values({ id: "m-tb", conversationId: "z-thong-bao", externalId: "em-tb", direction: "IN", fromPage: false, senderType: "PAGE_SYSTEM", text: "Chị A đã trả lời một quảng cáo.", sentAt: new Date() })
    .onConflictDoNothing();
  await db.insert(schema.salesSuggestions).values({ id: "s-tb", conversationId: "z-thong-bao", suggestedReply: "chào chị", action: "ASK_PRODUCT" }).onConflictDoNothing();
  assert.ok(
    !(await copilotQueue({ pageIds: ["page-xep"], db })).some((r) => r.conversationId === "z-thong-bao"),
    "hội thoại chỉ có thông báo nền tảng KHÔNG vào hàng đợi — đó là một cái máy, không phải một người đang chờ",
  );

  // ═════════ 7. CHỈ SỐ: MẪU SỐ RỖNG LÀ CHƯA BIẾT, KHÔNG PHẢI 0% ═════════
  const kpi = await copilotKpi(7, db);
  assert.ok(kpi.actuallySent >= 2, "đếm được số tin THẬT SỰ đã ghi là đã gửi");
  assert.equal(kpi.failedSends, 1, "lượt gửi hỏng đếm riêng, không lẫn vào lượt thành công");
  assert.ok(kpi.acceptanceRate !== null, "đã có lượt quyết định thì tính được tỷ lệ dùng được");
  const trong = await copilotKpi(0, db);
  assert.equal(trong.acceptanceRate, null, "chưa lượt nào trong kỳ ⇒ CHƯA BIẾT, không phải 0%");
  assert.equal(trong.meaningfulEditRate, null);
  assert.equal(trong.medianReviewSeconds, null);

  // ═════════ 7B. LẦN GỬI ĐẦU TIÊN & HAI CON SỐ PHẢI BẰNG 0 ═════════
  //
  // "Chưa ai bấm gửi lần nào" là một trạng thái HỢP LỆ để bắt đầu thí điểm — nhưng phải in ra
  // được, chứ không để người đọc tưởng phép thử đầu-cuối đã chạy và đã đạt.
  const truoc = await copilotKpi(7, db);
  assert.equal(typeof truoc.firstHumanSend.pending, "boolean");
  assert.equal(truoc.duplicateSends, 0, "không lần gửi nào đọc lại thấy nhiều hơn một bản");

  // Ba trạng thái kiểm lại, và chúng KHÔNG được gộp: đạt · chưa kiểm được · sai.
  // Gộp "chưa kiểm được" với "sai" thì một lần mạng chập chờn trông y như một lần gửi trùng.
  const goiY3 = "s-copilot-3";
  await db.insert(schema.salesSuggestions).values({ id: goiY3, conversationId: convId, suggestedReply: "câu ba", action: "ANSWER_QUESTION" }).onConflictDoNothing();
  await ghi({ suggestionId: goiY3, verified: null, verifyNote: "chưa kiểm lại được: mạng hỏng" });
  const chuaKiem = await copilotKpi(7, db);
  assert.equal(chuaKiem.duplicateSends, 0, "CHƯA KIỂM ĐƯỢC không được đếm là gửi trùng");

  const goiY4 = "s-copilot-4";
  await db.insert(schema.salesSuggestions).values({ id: goiY4, conversationId: convId, suggestedReply: "câu bốn", action: "ANSWER_QUESTION" }).onConflictDoNothing();
  await ghi({ suggestionId: goiY4, verified: false, verifyNote: "⛔ TIN XUẤT HIỆN 2 LẦN" });
  assert.equal((await copilotKpi(7, db)).duplicateSends, 1, "đã kiểm và thấy sai thì PHẢI đếm");

  // Gửi TRONG LÚC hệ thống báo thiếu dữ liệu — quyền của nhân viên, nhưng phải để lại dấu.
  const goiY5 = "s-copilot-5";
  await db.insert(schema.salesSuggestions).values({ id: goiY5, conversationId: convId, suggestedReply: "câu năm", action: "ANSWER_QUESTION" }).onConflictDoNothing();
  await ghi({ suggestionId: goiY5, warnings: ["SIZE_DATA_MISSING"] });
  assert.ok((await copilotKpi(7, db)).sentWithWarnings >= 1, "gửi trong lúc thiếu dữ kiện phải đếm được");

  // Và lần gửi ĐẦU TIÊN là lần SỚM NHẤT, không phải lần vừa ghi.
  const sauCung = await copilotKpi(7, db);
  assert.equal(sauCung.firstHumanSend.pending, false, "đã có lượt gửi thì không còn là 'chờ lần gửi đầu'");
  assert.ok(sauCung.firstHumanSend.at, "phải biết lần đầu lúc nào");

  // ═════════ 8. VÀ NẤC AUTO VẪN ĐÓNG ═════════
  //
  // Khối 5 của `sales-agent.test.ts` quét đủ tổ hợp; ở đây chốt lại đúng câu mà chủ shop hỏi:
  // với cấu hình ĐANG CHẠY của giai đoạn thí điểm, có đường nào để máy tự gửi không.
  const base = { conversationExternalId: "ext-copilot-1", text: "Dạ em chào chị", humanTakeover: false };
  for (const mode of ["OFF", "SHADOW", "COPILOT", "AUTO"] as const) {
    assert.equal(canSend({ ...base, mode }, NEN).allowed, false, `cấu hình thí điểm: máy KHÔNG tự gửi được ở nấc ${mode}`);
  }
  assert.equal(canSend({ ...base, mode: "COPILOT", approvedByUserId: nguoi }, NEN).allowed, true, "nhưng nhân viên bấm gửi thì được");
  assert.equal(canSend({ ...base, mode: "COPILOT", approvedByUserId: nguoi }, { ...NEN, hardLimits: SAFEST_HARD_LIMITS }).allowed, false, "và chặn cứng vẫn đè lên tất cả");

  console.log(
    `✓ Nấc trợ lý bán hàng: một đường gửi duy nhất đòi khoá tài khoản (quét ${tep.length} tệp đã vào kho) · quyền gửi tách khỏi quyền xem · danh sách trắng page rỗng ⇒ không ai gửi được · bấm hai lần bị CSDL chặn, gửi hỏng vẫn thử lại được · câu cũ / có tin mới hơn bị đánh dấu · máy KHÔNG tự gửi ở cả 4 nấc`,
  );
}

/**
 * CHUỖI MẪU SQL CÓ DẤU HUYỀN NGƯỢC TRONG MỘT CHÚ THÍCH — trả về số dòng của mỗi chỗ. HÀM THUẦN.
 *
 * Điều kiện báo lỗi phải CHÍNH XÁC, không phỏng đoán. Bản nháp đầu đoán theo "sau dấu đóng là chữ
 * thì chắc gãy" và báo nhầm ngay hai chỗ lành: `sql` + `0` + `as unknown as number` (sau dấu đóng
 * là từ khoá `as`), và một chú thích TypeScript có nhắc tới hai dấu huyền ngược. Một cái lưới báo
 * nhầm là một cái lưới sẽ bị tắt.
 *
 * Nên điều kiện là đúng cái đã xảy ra: đi từ chỗ mở một chuỗi mẫu SQL, theo dõi ô nội suy VÀ trạng
 * thái chú thích BÊN TRONG chuỗi; nếu dấu huyền ngược đóng lại nằm TRONG một chú thích thì nó
 * không phải chỗ kết thúc mà người viết định — nó là chỗ chuỗi bị cắt ngang.
 */
export function chuoiMauSqlDut(ma: string): number[] {
  const ra: number[] = [];
  const mo = /\bsql\s*`/g;
  let khop: RegExpExecArray | null;
  while ((khop = mo.exec(ma)) !== null) {
    // Bỏ qua chỗ mở nằm trong một chú thích TypeScript dòng đơn — nó chỉ là văn xuôi nhắc tới SQL.
    const dauDong = ma.lastIndexOf("\n", khop.index) + 1;
    if (ma.slice(dauDong, khop.index).includes("//")) {
      mo.lastIndex = khop.index + khop[0].length;
      continue;
    }
    let i = khop.index + khop[0].length;
    let sau = 0; // độ sâu ô nội suy ${ … }
    let chuThichDong = false;
    let chuThichKhoi = false;
    for (; i < ma.length; i += 1) {
      const c = ma[i];
      if (c === "\\") {
        i += 1;
        continue;
      }
      if (c === "\n") {
        chuThichDong = false;
        continue;
      }
      if (!chuThichKhoi && !chuThichDong && c === "-" && ma[i + 1] === "-") chuThichDong = true;
      if (!chuThichDong && !chuThichKhoi && c === "/" && ma[i + 1] === "*") chuThichKhoi = true;
      if (chuThichKhoi && c === "*" && ma[i + 1] === "/") {
        chuThichKhoi = false;
        i += 1;
        continue;
      }
      if (!chuThichDong && !chuThichKhoi) {
        if (c === "$" && ma[i + 1] === "{") {
          sau += 1;
          i += 1;
          continue;
        }
        if (c === "}" && sau > 0) {
          sau -= 1;
          continue;
        }
      }
      if (c === "`" && sau === 0) break;
    }
    if (i >= ma.length) break;
    // Dấu đóng NẰM TRONG một chú thích ⇒ chuỗi mẫu bị cắt ngang ở đây.
    if (chuThichDong || chuThichKhoi) ra.push(ma.slice(0, i).split("\n").length);
    mo.lastIndex = i + 1;
  }
  return ra;
}
