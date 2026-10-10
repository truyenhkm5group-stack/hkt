/**
 * ═══════════ MÁY QUÉT CÔ LẬP MỨC TIẾN TRÌNH (đa tổ chức) ═══════════
 *
 * Hợp đồng: docs/platform/tenant-readiness-audit.md mục 3 (mẫu S1–S16) · target-architecture P12/P13.
 *
 * SQL đã cô lập nhờ silo (mỗi tổ chức một CSDL). Rò rỉ còn lại nằm ở TRẠNG THÁI MỨC TIẾN TRÌNH:
 * đệm, bus, credential môi trường, khoá job, việc sau phản hồi. Bài kiểm hành vi
 * (`platform-process-isolation.test.ts`) chứng minh hàng rào HÔM NAY đứng vững; bài này chặn người
 * viết SAU dựng lại đúng lỗ ấy ở một chỗ mới: một kết nối CSDL thứ hai, một holder `globalThis` mới
 * chứa dữ liệu nghiệp vụ, một `after(` không mang tổ chức, một client mới gọi mạng bằng khoá của
 * tổ chức nhà mà không chặn.
 *
 * Quét mã ĐÃ VÀO KHO (`git ls-files`), bỏ chú thích trước khi dò (bẫy chú thích đã cắn năm lần ở các
 * bộ quét khác trong kho). Mỗi miễn trừ KÈM LÝ DO; miễn trừ không còn khớp gì cũng là đỏ — danh sách
 * không được mục thành một bãi rác. Thuần: không CSDL, không mạng.
 *
 * Chạy riêng: npx tsx --tsconfig tsconfig.json tests/platform-isolation-static.test.ts
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const goc = path.resolve(__dirname, "..");

function boChuThich(ma: string): string {
  return ma.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Đường dẫn chuẩn hoá `/` — luật 65: khoá tra cứu phải khớp trên cả Windows lẫn Linux. */
function chuan(p: string): string {
  return p.split(path.sep).join("/").split("\\").join("/");
}

let tepCache: string[] | null = null;
function tepTrongKho(): string[] {
  if (tepCache) return tepCache;
  tepCache = execSync("git ls-files", { cwd: goc, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\n")
    .map((l) => chuan(l.trim()))
    .filter(Boolean);
  return tepCache;
}

const DUOI_MA = /\.(ts|tsx|mjs|js|cjs)$/;
const maCache = new Map<string, string>();
function ma(tep: string): string {
  let m = maCache.get(tep);
  if (m === undefined) {
    m = boChuThich(readFileSync(path.join(goc, tep), "utf8"));
    maCache.set(tep, m);
  }
  return m;
}

function tepMa(tienTo: readonly string[]): string[] {
  return tepTrongKho().filter((t) => DUOI_MA.test(t) && tienTo.some((p) => t === p || t.startsWith(p)));
}

function laClientComponent(tep: string): boolean {
  return /^\s*["']use client["']/.test(readFileSync(path.join(goc, tep), "utf8"));
}

/** Miễn trừ không còn khớp gì là đỏ — danh sách phải nói về mã đang có, không về mã đã xoá. */
function khongMienTruMoCoi(ten: string, mienTru: Record<string, string>, daDung: Set<string>) {
  const moCoi = Object.keys(mienTru).filter((k) => !daDung.has(k));
  assert.deepEqual(moCoi, [], `${ten}: miễn trừ không còn khớp mã nào — xoá khỏi danh sách`);
  for (const [k, lyDo] of Object.entries(mienTru)) assert.ok(lyDo.trim().length >= 20, `${ten}: miễn trừ "${k}" phải kèm lý do đọc được`);
}

/* ═════════════ S1 · KHÔNG CÓ KẾT NỐI CSDL THỨ HAI ═════════════ */

const KET_NOI_CSDL = [/new\s+(?:pg\.)?Pool\s*\(/, /new\s+PGlite\s*\(/, /from\s+["']pg["']/, /import\(\s*["']pg["']\s*\)/, /new\s+Client\s*\(/];
const KET_NOI_DUOC_PHEP: Record<string, string> = {
  "db/index.ts": "Chỗ DUY NHẤT mở kết nối: `getDb()` định tuyến theo tổ chức, bể theo tổ chức nằm trên `globalThis`.",
  "db/migrate.ts": "Chỉ `import type { Pool }` để nhận bể của chính `db/index.ts` khi áp migration — không mở kết nối.",
  "scripts/restore-drill-pg.ts": "Script DIỄN TẬP KHÔI PHỤC chạy tay / trên CI với Postgres TẠM (hàng rào môi trường: ERP_RESTORE_DRILL_EPHEMERAL=1 + localhost + CSDL nhà rỗng + không erp_org_* nào khác): cần một Client quản trị để CREATE / DROP / đổi tên CSDL tạm của lượt diễn tập và băm từng bảng — việc mà getDb() (định tuyến theo tổ chức) không làm được; dữ liệu tổ chức vẫn ghi qua dịch vụ trong withOrganization.",
  "scripts/perf-probe.ts": "Script ĐO của người vận hành, chạy tay trên máy chủ với CSDL nhà; không nằm trong đường chạy của ứng dụng (ISO-24 còn mở).",
};

export function testKhongKetNoiCsdlThuHai() {
  const pham: string[] = [];
  const daDung = new Set<string>();
  for (const tep of tepMa(["lib/", "app/", "db/", "scripts/", "chatbot/", "middleware.ts", "instrumentation"])) {
    const m = ma(tep);
    if (!KET_NOI_CSDL.some((re) => re.test(m))) continue;
    if (KET_NOI_DUOC_PHEP[tep]) {
      daDung.add(tep);
      continue;
    }
    pham.push(tep);
  }
  assert.deepEqual(pham, [], "mở kết nối CSDL ngoài db/index.ts là vòng qua định tuyến theo tổ chức — một câu truy vấn đi vào CSDL nhà bất kể ngữ cảnh (S1 · ISO-17)");
  khongMienTruMoCoi("S1", KET_NOI_DUOC_PHEP, daDung);

  // S2 · chuỗi kết nối và handle chỉ được đọc ở chỗ định tuyến.
  const phamS2 = tepMa(["lib/", "app/", "db/", "middleware.ts"]).filter((t) => t !== "db/index.ts" && /process\.env\.DATABASE_URL|\bdatabaseUrl\(\)|__erpDb\b/.test(ma(t)));
  assert.deepEqual(phamS2, [], "đọc DATABASE_URL / databaseUrl() / __erpDb ngoài db/index.ts là tự chọn CSDL, bỏ qua tổ chức (S2)");
}

/* ═════════════ S4 · MỖI HOLDER `globalThis` ĐỀU ĐÃ KHAI ═════════════ */

type LoaiHolder = "THEO_TO_CHUC" | "NEN_TANG";
/**
 * `<tệp>::<tên>` → loại + lý do. THEO_TO_CHUC = đã khoá theo mã tổ chức; NEN_TANG = trạng thái của
 * nền tảng, không chứa dữ liệu nghiệp vụ của tổ chức nào.
 */
const HOLDER_DA_KHAI: Record<string, { loai: LoaiHolder; lyDo: string }> = {
  "db/index.ts::__erpDb": { loai: "NEN_TANG", lyDo: "Handle/bể CSDL — nhà là một handle, tổ chức khác nằm trong `orgs: Map<mã, …>`; không chứa dòng dữ liệu nào." },
  "db/migrate.ts::__erpMigrated": { loai: "NEN_TANG", lyDo: "Lời hứa migration của CSDL nhà lúc khởi động; CSDL tổ chức khác migrate khi mở handle." },
  "lib/cache.ts::__erpMemo": { loai: "THEO_TO_CHUC", lyDo: "Khoá đệm của tổ chức khác nhà mang tiền tố `org:<mã>:` do chính `memo()` thêm (ISO-01)." },
  "lib/cache.ts::__erpJobNen": { loai: "NEN_TANG", lyDo: "Bộ đếm 'đang trong job nền' chỉ đổi xoá cứng/mềm của đệm — sai lệch tệ nhất là một lượt đánh dấu cũ (ISO-26, chấp nhận)." },
  "lib/realtime/bus.ts::erpBus": { loai: "THEO_TO_CHUC", lyDo: "Sự kiện đóng dấu `org`; SSE chỉ nghe qua `subscribeOrganization` (ISO-08)." },
  "lib/sync/runner.ts::__erpSyncJobLocks": { loai: "THEO_TO_CHUC", lyDo: "Khoá job `jobLockKey(tổ chức, nguồn, job)` (ISO-12)." },
  "lib/alerts/rules.ts::__erpAlertsTimers": { loai: "THEO_TO_CHUC", lyDo: "Hẹn giờ gộp cảnh báo một cái mỗi tổ chức, callback bọc withOrganization (ISO-15)." },
  "lib/alerts/owner-decision-digest.ts::__erpOwnerDigestFullAtByOrg": { loai: "THEO_TO_CHUC", lyDo: "Nhịp đọc lại theo mã tổ chức (ISO-18)." },
  "lib/alerts/stock-shortage-digest.ts::__erpShortageDigestAtByOrg": { loai: "THEO_TO_CHUC", lyDo: "Nhịp tự động theo mã tổ chức (ISO-18)." },
  "lib/alerts/stock-wait-log.ts::__erpStockWaitLogAtByOrg": { loai: "THEO_TO_CHUC", lyDo: "Nhịp ghi sổ chờ hàng theo mã tổ chức (ISO-18)." },
  "lib/cs/failed-delivery.ts::__erpFailedDeliveryRunningByOrg": { loai: "THEO_TO_CHUC", lyDo: "Khoá 'đang chạy' theo mã tổ chức (ISO-18)." },
  "lib/cs/phone-verify.ts::__erpPhoneVerifyRunningByOrg": { loai: "THEO_TO_CHUC", lyDo: "Khoá 'đang chạy' theo mã tổ chức (ISO-18)." },
  "lib/video-scale/pipeline.ts::__erpVideoScaleDrainByOrg": { loai: "THEO_TO_CHUC", lyDo: "Khoá 'vòng after() đang chạy hàng đợi video' theo mã tổ chức — chỉ chặn chạy trùng trong một tổ chức; việc vẫn cầm bằng CSDL." },
  "lib/metadata/read-scope.ts::__erpMetadataReadScope": { loai: "THEO_TO_CHUC", lyDo: "AsyncLocalStorage của MỘT lượt dựng trang; ô đệm bên trong khoá theo handle CSDL của tổ chức (`getDb()`), mất khi lượt xong." },
  "lib/perf/probe.ts::__erpProbe": { loai: "NEN_TANG", lyDo: "AsyncLocalStorage của phép đo — phạm vi một lượt gọi, không vượt request." },
  "lib/perf/registry.ts::__erpPerf": { loai: "NEN_TANG", lyDo: "Sổ đo hiệu năng (tên báo cáo, thời gian) — chỉ tổ chức nhà đọc được qua /api/perf (ISO-25)." },
  "lib/platform/context.ts::__erpOrgCtx": { loai: "NEN_TANG", lyDo: "Chính ngữ cảnh tổ chức (AsyncLocalStorage)." },
  "lib/platform/peek.ts::__erpOrgCtx": { loai: "NEN_TANG", lyDo: "CHỈ ĐỌC đúng holder ngữ cảnh của context.ts (không dựng holder mới) — cho getter đồng bộ ở tầng thấp như lib/env.ts." },
  "lib/platform/organizations.ts::__erpOrgs": { loai: "NEN_TANG", lyDo: "Sổ tổ chức của mặt phẳng điều khiển (CSDL nhà), đệm 10 giây." },
  "lib/billing/standing.ts::__erpSubscriptions": { loai: "NEN_TANG", lyDo: "Sổ thuê bao của mặt phẳng điều khiển (CSDL nhà), khoá theo MÃ tổ chức, đệm 10 giây — chỉ ngày trả tới + ân hạn, không dữ liệu nghiệp vụ." },
  "lib/ai-usage/control.ts::__erpAiControl": { loai: "THEO_TO_CHUC", lyDo: "Đệm ≤ 10 giây của công tắc AI toàn nền tảng (một giá trị) + công tắc / ghi đè hạn mức AI của TỪNG tổ chức (Map khoá theo mã tổ chức, CSDL nhà) — không chứa prompt, khoá hay dữ liệu nghiệp vụ; lượt ghi xoá đệm ngay." },
  "lib/onboarding/signup-mode.ts::__erpSignupSetting": { loai: "NEN_TANG", lyDo: "Đệm ≤ 10 giây của MỘT cài đặt nền tảng (chế độ đăng ký /start, CSDL nhà) — không thuộc tổ chức nào, không chứa dữ liệu nghiệp vụ; lượt ghi xoá đệm ngay." },
  "lib/sales-chatbot/public-chat-limits.ts::__erpPublicChatLimits": { loai: "THEO_TO_CHUC", lyDo: "Xô trần tần suất của chat công khai: MỌI khoá mang mã tổ chức của host (`<chiều>:<việc>:<mã tổ chức>:…`), giá trị chỉ là một mốc thời gian — không dữ liệu nghiệp vụ, không ghi CSDL; có trần số khoá." },
  "lib/platform/org-flags.ts::__erpOrgFlags": { loai: "THEO_TO_CHUC", lyDo: "Đệm 5 giây của cờ nền tảng theo tổ chức (công tắc khẩn `workflows.paused`), KHOÁ theo mã tổ chức + khoá cờ; lượt ghi xoá đệm." },
  "lib/platform/capabilities.ts::__erpCapabilities": { loai: "THEO_TO_CHUC", lyDo: "Đệm 5 giây của dòng cấu hình module, KHOÁ theo mã tổ chức (`Map<mã, dòng>`); ghi cấu hình xoá đúng khoá của tổ chức đó." },
};

export function testHolderGlobalDaKhai() {
  const thay = new Set<string>();
  const pham: string[] = [];
  for (const tep of tepMa(["lib/", "app/", "db/", "middleware.ts", "instrumentation"])) {
    for (const khop of ma(tep).matchAll(/globalThis\s+as\s+(?:unknown\s+as\s+)?\{([^\n]*)/g)) {
      for (const ten of khop[1].matchAll(/(\w+)\?\s*:/g)) {
        const khoa = `${tep}::${ten[1]}`;
        thay.add(khoa);
        if (!HOLDER_DA_KHAI[khoa]) pham.push(khoa);
      }
    }
    // Dạng gán thẳng lên globalThis cũng là một holder — phải đi qua khai báo có kiểu ở trên.
    if (/\(\s*globalThis\s+as\s+any\s*\)|globalThis\s*\[\s*["']/.test(ma(tep))) pham.push(`${tep}::<globalThis không khai kiểu>`);
  }
  assert.deepEqual(pham, [], "holder `globalThis` mới phải khai vào HOLDER_DA_KHAI: đã khoá theo tổ chức, hay là trạng thái nền tảng không chứa dữ liệu nghiệp vụ (S4 · P13)");
  const moCoi = Object.keys(HOLDER_DA_KHAI).filter((k) => !thay.has(k));
  assert.deepEqual(moCoi, [], "HOLDER_DA_KHAI có mục không còn trong mã — xoá khỏi danh sách");
  for (const [k, v] of Object.entries(HOLDER_DA_KHAI)) assert.ok(v.lyDo.length >= 20, `holder ${k} phải kèm lý do`);
}

/* ═════════════ S5 · CLIENT TÍCH HỢP SINGLETON — CHỈ NHỮNG CÁI ĐÃ KHAI ═════════════ */

/**
 * Token giữ trong bộ nhớ — chỉ hai chỗ, đều đã khai. Client (Pancake POS, Pancake Pages, Viettel
 * Post, Facebook) KHÔNG còn là biến `cached` cho cả tiến trình: getter đi qua `perOrganizationClients`
 * (R-04, xem khối kiểm ngay dưới).
 */
const SINGLETON_DA_KHAI: Record<string, string> = {
  "lib/integrations/viettelpost/client.ts": "Token đăng nhập nằm TRONG instance; instance chia ngăn theo tổ chức (perOrganizationClients) và rawCall + getToken chặn TRƯỚC khi đọc/ghi integration_tokens (ISO-04 · R-04).",
  "lib/integrations/github/agent-identity.ts": "Token cài đặt GitHub App của NGƯỜI VẬN HÀNH nền tảng; installationToken() chặn bằng assertHomeCredentials TRƯỚC khi trả cả token đang đệm (R-04).",
};

/** Getter client dùng credential môi trường — mỗi cái phải chia ngăn theo tổ chức. */
const GETTER_CLIENT_THEO_TO_CHUC = [
  "lib/integrations/pancake/client.ts",
  "lib/integrations/pancake/pages.ts",
  "lib/integrations/viettelpost/client.ts",
  "lib/integrations/facebook/client.ts",
] as const;

export function testSingletonTichHopDaKhai() {
  const pham: string[] = [];
  const daDung = new Set<string>();
  const getterMoi: string[] = [];
  for (const tep of tepMa(["lib/integrations/"])) {
    const m = ma(tep);
    // R-04: một biến `cached` giữ CLIENT cho cả tiến trình là cách tổ chức gọi trước thắng — cấm hẳn.
    if (/^let\s+cached\s*:\s*[A-Z]\w*Client\b/m.test(m)) pham.push(`${tep} (let cached: …Client — dùng perOrganizationClients)`);
    if (/export\s+function\s+get\w*Client\s*\(/.test(m) && !(GETTER_CLIENT_THEO_TO_CHUC as readonly string[]).includes(tep)) getterMoi.push(tep);
    if (!/^let\s+cached\b|^let\s+\w*[Tt]oken\b|private\s+token\s*:/m.test(m)) continue;
    if (SINGLETON_DA_KHAI[tep]) {
      daDung.add(tep);
      assert.ok(m.includes("assertHomeCredentials("), `${tep}: singleton giữ credential môi trường thì mọi lối gọi mạng phải chặn bằng assertHomeCredentials`);
      continue;
    }
    pham.push(tep);
  }
  assert.deepEqual(pham, [], "client tích hợp singleton / token mức module mới: credential đóng băng lúc dựng lần đầu, tổ chức gọi trước thắng (S5 · ISO-04)");
  khongMienTruMoCoi("S5", SINGLETON_DA_KHAI, daDung);
  assert.deepEqual(getterMoi, [], "getter client tích hợp mới phải khai vào GETTER_CLIENT_THEO_TO_CHUC và chia ngăn theo tổ chức (R-04)");
  for (const tep of GETTER_CLIENT_THEO_TO_CHUC) {
    assert.ok(/perOrganizationClients\s*(<[^>]*>)?\s*\(/.test(ma(tep)), `${tep}: getter client phải giữ Map theo tổ chức qua perOrganizationClients (R-04)`);
  }
}

/* ═════════════ S9 · MỌI `after(` MANG TỔ CHỨC ═════════════ */

export function testAfterMangToChuc() {
  const pham: string[] = [];
  let dem = 0;
  for (const tep of tepMa(["lib/", "app/"])) {
    const m = ma(tep);
    for (const k of m.matchAll(/(^|[^.\w$])after\(/g)) {
      dem += 1;
      const sau = m.slice((k.index ?? 0) + k[0].length, (k.index ?? 0) + k[0].length + 60);
      if (!/^\s*await\s+bindOrganization\(/.test(sau)) pham.push(`${tep}: after(${sau.split("\n")[0].slice(0, 40)}`);
    }
  }
  assert.deepEqual(pham, [], "mọi `after(` phải đi qua `await bindOrganization(…)` — việc sau phản hồi không được dựa vào lan truyền ngữ cảnh ngầm, mất ngữ cảnh là rơi về CSDL nhà (S9 · ISO-16)");
  assert.ok(dem >= 5, `phải thấy các lời gọi after() đã biết (webhook, gửi tin hàng loạt, gen ảnh) — mới thấy ${dem}: bộ dò có thể đã mù`);
}

/* ═════════════ MÓC KIỂM THỬ PHIÊN KHÔNG ĐƯỢC VÀO MÃ SẢN PHẨM ═════════════ */

export function testMocPhienChiTrongKiemThu() {
  const pham = tepTrongKho()
    .filter((t) => DUOI_MA.test(t) && !t.startsWith("tests/") && t !== "lib/platform/context.ts")
    .filter((t) => ma(t).includes("setSessionTokenSourceForTests"));
  assert.deepEqual(pham, [], "setSessionTokenSourceForTests giả lập phiên của BẤT KỲ tổ chức nào — chỉ bộ kiểm thử được gọi");
}

/* ═════════════ S11 · WEBHOOK PHÂN GIẢI TỔ CHỨC TƯỜNG MINH ═════════════ */

export function testWebhookBocToChuc() {
  const routes = tepTrongKho().filter((t) => t.startsWith("app/api/webhooks/") && /\/route\.tsx?$/.test(t));
  assert.ok(routes.length >= 4, `phải thấy các route webhook đã biết — mới thấy ${routes.length}`);
  const pham = routes.filter((t) => !(ma(t).includes("withOrganization(") && ma(t).includes("resolveWebhookOrganization(")));
  assert.deepEqual(pham, [], "route webhook phải phân giải tổ chức qua resolveWebhookOrganization (khai trong WEBHOOK_BINDINGS) rồi bọc withOrganization — không ngầm định CSDL mặc định (S11 · ISO-07)");
}

/* ═════════════ S6' · MỌI LỐI GỌI MẠNG PHÍA MÁY CHỦ CHẶN CREDENTIAL CỦA NHÀ ═════════════ */

/** Client BẮT BUỘC có lời chặn — kể cả khi bộ dò mẫu gọi mạng bên dưới lỡ không nhận ra chúng. */
const CLIENT_BAT_BUOC = [
  "lib/integrations/pancake/client.ts",
  "lib/integrations/pancake/pages.ts",
  "lib/integrations/viettelpost/client.ts",
  "lib/integrations/facebook/client.ts",
  "lib/integrations/facebook/ads-write.ts",
  "lib/integrations/bank/sepay-api.ts",
  "lib/integrations/openai/images.ts",
  "lib/integrations/openai/batch.ts",
  "lib/integrations/github/client.ts",
  "lib/integrations/github/dispatch.ts",
  "lib/integrations/github/agent-identity.ts",
  "lib/integrations/chatbot/client.ts",
  "lib/ai/provider.ts",
  "lib/ai/providers/openai.ts",
  "lib/creative/caption.ts",
  "lib/creative/vision.ts",
  "lib/creative/dna.ts",
  "lib/alerts/lark.ts",
  "lib/alerts/telegram.ts",
] as const;

/** Tệp máy chủ gọi mạng mà KHÔNG dùng credential môi trường — lý do bắt buộc. */
const GOI_MANG_KHONG_CREDENTIAL: Record<string, string> = {
  "lib/integrations/http.ts": "Bộ gửi chung `fetchJson` — không giữ khoá nào; mỗi client gọi nó đã tự chặn ở phương thức gửi của mình.",
  "lib/push/web-push.ts": "Thông báo đẩy tới máy chủ đẩy của trình duyệt (endpoint đã kiểm thuộc Google / Mozilla / Apple / Microsoft). Chỉ gửi nội dung đã mã hoá + chữ ký VAPID dẫn xuất một chiều từ AUTH_SECRET của NỀN TẢNG (không phải khoá tích hợp của nhà); không token / cookie nào đi ra.",
  "lib/net/public-url.ts": "Tải MỘT trang công khai do quản trị tổ chức gõ (nhập sản phẩm từ website) — không gửi khoá / token / cookie nào, chỉ GET địa chỉ đã kiểm không phải mạng nội bộ.",
  "lib/sales-chatbot/history.ts": "«Đồng bộ lịch sử hộp thư»: ĐỌC danh sách hội thoại + tin qua pages.fm bằng page access token của CHÍNH tổ chức (org_connections, giải mã trong ngữ cảnh tổ chức) — không có credential môi trường nào của nhà.",
  "lib/sales-chatbot/playbook.ts": "«Học từ hội thoại cũ»: ĐỌC lịch sử tin nhắn qua pages.fm bằng page access token của CHÍNH tổ chức (org_connections, giải mã trong ngữ cảnh tổ chức) — không có credential môi trường nào của nhà.",
  "lib/marketing/meta-capi.ts": "Gửi sự kiện Purchase của đơn chốt vào dataset Meta bằng token System User của CHÍNH tổ chức (kết nối «meta-capi-org» ở org_connections, giải mã trong ngữ cảnh tổ chức); tổ chức nhà bị bỏ qua ngay ở đầu job — không có credential môi trường nào của nhà.",
  "lib/sales-chatbot/fanpage.ts": "Trả lời tin fanpage qua pages.fm bằng page access token của CHÍNH tổ chức (org_connections, giải mã trong ngữ cảnh tổ chức) — không có credential môi trường nào của nhà.",
  "lib/sales-chatbot/messenger.ts":
    "Messenger trực tiếp (0207): Send API bằng page token của CHÍNH tổ chức (org_connections, giải mã trong ngữ cảnh tổ chức). App secret là của app NỀN TẢNG (FACEBOOK_LOGIN_APP_SECRET — cùng app đăng nhập), chỉ dùng ký appsecret_proof cho token của tổ chức; không có khoá / token nào của tổ chức nhà.",
  "lib/sales-chatbot/order-sync.ts": "Ghi đơn từ hội thoại: page Pancake ĐỌC tin qua pages.fm bằng page access token của CHÍNH tổ chức; page nối thẳng Meta đọc sổ tin của ERP và nhắn xác nhận qua Send API bằng token page của CHÍNH tổ chức (org_connections / org_channel_pages, giải mã trong ngữ cảnh tổ chức) — không có credential môi trường nào của nhà; AI đi qua provider BYOK của tổ chức.",
  "lib/sales-chatbot/messenger-history.ts": "Nhập hội thoại gần đây của page nối thẳng Meta: ĐỌC Conversations API bằng page token của CHÍNH tổ chức (org_channel_pages / org_connections, giải mã trong ngữ cảnh tổ chức). App secret là của app NỀN TẢNG, chỉ ký appsecret_proof cho token của tổ chức; không có khoá / token nào của tổ chức nhà.",
  "lib/landing/sheet.ts": "CSV công khai của Google Sheet, URL đọc từ `settings` của CHÍNH tổ chức đang chạy — không có credential môi trường.",
  "lib/actions/workshop-ledger.ts": "Link Google Sheet công khai do người dùng dán vào form — không có credential môi trường.",
  "lib/creative/import.ts": "Tải ảnh từ một URL công khai (http/https) — không gắn khoá nào vào request.",
  "lib/ai-builder/providers.ts":
    "Provider AI BYOK của AI Builder (Phase 8): khoá là `apiKey` TƯỜNG MINH do lib/connectors/service.ts giải mã từ org_connections của CHÍNH tổ chức đang chạy; `authToken` / `organization` / `project` đặt null và `baseURL` là hằng, nên không biến môi trường nào của tổ chức nhà lọt vào. Đường của tổ chức nhà đi qua `getAiProvider` (lib/ai/provider.ts — đã gọi assertHomeCredentials). Nhánh AI do NỀN TẢNG trả tiền (mặc định tắt) cũng dựng provider này với khoá TƯỜNG MINH `PLATFORM_AI_API_KEY` (lib/ai-usage/platform-ai.ts — từ chối khi trùng khoá của nhà), không bao giờ `ANTHROPIC_API_KEY`.",
  "lib/ai-usage/platform-model-probe.ts":
    "Kiểm tra khả dụng model của AI DÙNG CHUNG (06/10/2026, docs/platform/ai-model-control.md): khoá là `apiKey` TƯỜNG MINH lấy từ `platformAiConfig()` — tức `PLATFORM_AI_API_KEY` của NỀN TẢNG, bị từ chối khi trùng mọi khoá của nhà (ANTHROPIC_* · OPENAI_API_KEY · GEMINI_API_KEY); tệp không đọc biến môi trường nào. Đích hằng generativelanguage.googleapis.com, khoá chỉ trong tiêu đề x-goog-api-key, không theo chuyển hướng, một lời gọi 1 chữ, câu lỗi đã che khoá.",
  "lib/messaging/providers.ts":
    "Gửi tin nhóm (0180) bằng bí mật của CHÍNH tổ chức ngữ cảnh qua `openActiveConnection` (AAD gắn tổ chức) — không đọc biến môi trường nào; chỉ hai loại đích cố định (webhook Custom Bot của Lark · api.telegram.org), không theo chuyển hướng; hộp thử không gọi mạng.",
  "lib/integrations/zalo/oa.ts":
    "Zalo OA (kênh chat của chatbot bán hàng · kênh ZALO): App Secret / refresh token / access token là tham số TƯỜNG MINH do lib/connectors/service.ts giải mã từ org_connections của CHÍNH tổ chức đang chạy (kết nối «zalo-oa», app Zalo của shop) — client không đọc biến môi trường nào, nhà không có khoá Zalo OA.",
  "lib/integrations/google-places/client.ts":
    "Google Places API (New) cho Săn khách sỉ (0197): khoá là `apiKey` TƯỜNG MINH do lib/connectors/service.ts giải mã từ org_connections của CHÍNH tổ chức đang chạy (kết nối «google-places») — client không đọc biến môi trường nào; đích cố định places.googleapis.com, khoá đi trong tiêu đề, không theo chuyển hướng.",
  "lib/creative/byok-image.ts":
    "Máy vẽ ảnh quảng cáo của Thư viện Media cho TỔ CHỨC KHÁCH (04/10/2026): khoá là `apiKey` TƯỜNG MINH do lib/connectors/service.ts giải mã từ org_connections của CHÍNH tổ chức đang chạy («openai-byok» / «gemini-byok», mở ở lib/creative/org-ai.ts) — không đọc biến môi trường nào; mỗi lời gửi gọi `assertConnectionOwner` (khoá của A không gửi được trong ngữ cảnh B) và `assertPixelSafe`; đích cố định api.openai.com / generativelanguage.googleapis.com, khoá chỉ trong tiêu đề, không theo chuyển hướng. Đường của tổ chức nhà vẫn là `editImage` (lib/integrations/openai/images.ts — đã gọi assertHomeCredentials).",
  "lib/connectors/testers.ts":
    "Kiểm tra kết nối THEO TỔ CHỨC (Phase 9): bí mật do lib/connectors/service.ts giải mã từ org_connections của CHÍNH tổ chức đang chạy — không đọc biến môi trường chứa khoá nào (riêng «meta-ads-org» đọc phiên bản Graph API công khai của nền tảng); đích là các máy chủ cố định trong mã (Lark · api.telegram.org · Zalo · pages.fm · Anthropic/OpenAI/Gemini · graph.facebook.com · partner.viettelpost.vn · online-gateway.ghn.vn), không theo chuyển hướng.",
  "lib/integrations/ghn/client.ts":
    "Tạo / huỷ / in vận đơn GHN + đọc danh mục tỉnh / xã bằng token của CHÍNH tổ chức (kết nối «ghn-carrier», token do lib/connectors/service.ts giải mã từ org_connections trong ngữ cảnh tổ chức) — không đọc biến môi trường nào của nhà; chặn bằng assertConnectionOwner TRƯỚC mỗi lượt gửi, đích hằng số online-gateway.ghn.vn, không theo chuyển hướng, không giữ token.",
  "lib/integrations/ghtk/client.ts":
    "Tạo / tính phí / huỷ / tải nhãn PDF vận đơn GHTK bằng token của CHÍNH tổ chức (kết nối «ghtk-carrier», token do lib/connectors/service.ts giải mã từ org_connections trong ngữ cảnh tổ chức) — không đọc biến môi trường nào của nhà; chặn bằng assertConnectionOwner TRƯỚC mỗi lượt gửi, đích hằng số services.giaohangtietkiem.vn, không theo chuyển hướng, không giữ token.",
  "lib/integrations/viettelpost/carrier-org.ts":
    "Tạo / huỷ / in vận đơn Viettel Post bằng tài khoản của CHÍNH tổ chức (kết nối «viettelpost-carrier», mật khẩu do lib/connectors/service.ts giải mã từ org_connections trong ngữ cảnh tổ chức) — không đọc biến môi trường nào của nhà; chặn bằng assertConnectionOwner TRƯỚC mỗi lượt gửi, đích hằng số partner.viettelpost.vn, không theo chuyển hướng, không giữ token.",
  "lib/saas/acceptance.ts":
    "Ops nghiệm thu `saas-acceptance` (người vận hành chạy qua ops-vps, trong container app như smoke): GET trang chat CÔNG KHAI `https://<slug>.<PLATFORM_BASE_DOMAIN>/chat` của workspace THỬ trong sổ khai lib/constants/saas-acceptance.ts — không gửi khoá / token / cookie nào (đúng một khách lạ mở trang), đích dựng từ sổ khai + miền gốc của nền tảng, không theo chuyển hướng. Lượt mở trang vỏ đi node:http tới chính ứng dụng (127.0.0.1) với phiên của TÀI KHOẢN THỬ, không phải khoá tích hợp nào.",
};

const GOI_MANG = [/(^|[^.\w$])fetch\(/, /\bfetchJson\(/, /new\s+(?:Anthropic|OpenAI)\s*\(/, /\?\?\s*fetch\b/];

export function testLoiGoiMangChanCredential() {
  for (const tep of CLIENT_BAT_BUOC) assert.ok(ma(tep).includes("assertHomeCredentials("), `${tep}: client dùng credential môi trường phải gọi assertHomeCredentials ở lối gọi mạng (P12 · ISO-03/04/05)`);
  const pham: string[] = [];
  const daDung = new Set<string>();
  for (const tep of tepMa(["lib/", "app/"])) {
    if (!/\.tsx?$/.test(tep) || laClientComponent(tep)) continue; // trình duyệt gọi API của chính ERP — cookie phiên mang tổ chức
    const m = ma(tep);
    if (!GOI_MANG.some((re) => re.test(m))) continue;
    if (m.includes("assertHomeCredentials(")) continue;
    if (GOI_MANG_KHONG_CREDENTIAL[tep]) {
      daDung.add(tep);
      continue;
    }
    pham.push(tep);
  }
  assert.deepEqual(pham, [], "tệp máy chủ gọi mạng phải chặn credential của nhà (assertHomeCredentials) hoặc khai vào GOI_MANG_KHONG_CREDENTIAL kèm lý do vì sao nó không dùng khoá môi trường");
  khongMienTruMoCoi("S6", GOI_MANG_KHONG_CREDENTIAL, daDung);
}

/* ═════════════ S7 · BUS: KHÔNG NGHE KÊNH THÔ, KHÔNG TỰ ĐÓNG DẤU TỔ CHỨC ═════════════ */

/** Đối số của lời gọi bắt đầu ngay sau `(` — cân ngoặc, bỏ qua chuỗi. Đủ cho mã TypeScript thường. */
function doiSoCuaLoiGoi(m: string, mo: number): string[] {
  const out: string[] = [];
  let sau = 0;
  let cur = "";
  let i = mo;
  while (i < m.length) {
    const c = m[i];
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < m.length && m[j] !== c) j += m[j] === "\\" ? 2 : 1;
      cur += m.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") sau += 1;
    if (c === ")" || c === "]" || c === "}") {
      if (sau === 0) {
        out.push(cur.trim());
        return out;
      }
      sau -= 1;
    }
    if (c === "," && sau === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
    i += 1;
  }
  return out;
}

export function testBusKhongRoToChuc() {
  const phamNghe: string[] = [];
  const phamDau: string[] = [];
  for (const tep of tepMa(["lib/", "app/"])) {
    if (tep === "lib/realtime/bus.ts") continue;
    const m = ma(tep);
    if (/import\s*\{[^}]*\bsubscribe\b[^}]*\}\s*from\s*["']@\/lib\/realtime\/bus["']/.test(m)) phamNghe.push(tep);
    if (tep === "lib/cache.ts") continue;
    for (const k of m.matchAll(/(^|[^.\w$])publish\(/g)) {
      const args = doiSoCuaLoiGoi(m, (k.index ?? 0) + k[0].length).filter(Boolean);
      if (args.length > 1) phamDau.push(`${tep}: publish(…, ${args[1].slice(0, 30)})`);
    }
  }
  assert.deepEqual(phamNghe, [], "mã sản phẩm nghe kênh THÔ của bus (mọi tổ chức) — dùng subscribeOrganization(mã) (S7 · ISO-08)");
  assert.deepEqual(phamDau, [], "chỉ lib/cache.ts được tự đóng dấu tổ chức cho sự kiện (đối số thứ hai của publish) — nơi khác để bus đọc từ ngữ cảnh");
  // Tự kiểm bộ tách đối số: không tin được nó thì luật trên mù.
  assert.deepEqual(doiSoCuaLoiGoi('{ type: "sync", job: `memo:${a}` }, org.code)', 0), ['{ type: "sync", job: `memo:${a}` }', "org.code"]);
  assert.deepEqual(doiSoCuaLoiGoi('{ type: "care", shipmentId: f(a, b) })', 0), ['{ type: "care", shipmentId: f(a, b) }']);
}

/* ═════════════ S8 · TIỀN TỐ TỔ CHỨC CHỈ DO memo() TỰ THÊM ═════════════ */

export function testKhongGiaTienToDem() {
  const pham = tepMa(["lib/", "app/"]).filter((t) => /\bmemo\(\s*["'`]org:/.test(ma(t)));
  assert.deepEqual(pham, [], "khoá memo tự viết tiền tố `org:` là giả khoá của tổ chức khác — tiền tố chỉ do memo() thêm (S8)");
}

/* ═════════════ S14 · MIGRATION ÁP ĐƯỢC LÊN CSDL TỔ CHỨC TRẮNG ═════════════ */

export function testMigrationKhongCanQuyenCum() {
  const re = /CREATE\s+(?:EXTENSION|ROLE|DATABASE|PUBLICATION|SUBSCRIPTION|EVENT\s+TRIGGER)|ALTER\s+(?:SYSTEM|ROLE|DATABASE)|GRANT\s+[^;]*\s+TO\s+/i;
  const sql = tepTrongKho().filter((t) => t.startsWith("drizzle/") && t.endsWith(".sql"));
  assert.ok(sql.length > 100, `phải thấy bộ migration — mới thấy ${sql.length} tệp`);
  const pham = sql.filter((t) => re.test(readFileSync(path.join(goc, t), "utf8").replace(/--.*$/gm, "")));
  assert.deepEqual(pham, [], "migration cần quyền cấp CỤM thì không áp được lên CSDL tổ chức mới (S14)");
}

/* ═════════════ S16 · KHÔNG THÊM ID TÀI KHOẢN NGOÀI LÀM MẶC ĐỊNH ═════════════ */

const MAC_DINH_ID_DA_KHAI: Record<string, string> = {
  FACEBOOK_BUSINESS_ID:
    "BM của VNX — giữ để không đổi hành vi tổ chức nhà (ISO-23 còn mở có chủ ý). Mọi lời gọi Graph chặn bằng assertHomeCredentials nên tổ chức khác không tới được giá trị này.",
};

export function testKhongIdNgoaiLamMacDinh() {
  const env = ma("lib/env.ts");
  const thay = [...env.matchAll(/read\(\s*"([A-Z_]+)"\s*,\s*"\d{9,}"\s*\)/g)].map((k) => k[1]);
  const pham = thay.filter((ten) => !MAC_DINH_ID_DA_KHAI[ten]);
  assert.deepEqual(pham, [], "giá trị mặc định là ID tài khoản ngoài: tổ chức quên khai sẽ dùng tài khoản của tổ chức nhà (S16 · ISO-23)");
  khongMienTruMoCoi("S16", MAC_DINH_ID_DA_KHAI, new Set(thay));
}

/* ═════════════ S17 · CSDL CHỈ ĐỊNH TƯỜNG MINH CHỈ Ở MÃ NỀN TẢNG ═════════════ */

/**
 * `getPlatformDb` (luôn CSDL nhà), `getDbFor` / `getDbForInspection` (CSDL của một tổ chức chỉ định)
 * VÒNG QUA ngữ cảnh tổ chức — mã nghiệp vụ gọi chúng là đọc/ghi CSDL của ai đó khác với người đang
 * đăng nhập. Chỉ những chỗ sau được gọi; khoá kết thúc bằng `/` là cả thư mục.
 */
const CSDL_CHI_DINH_DUOC_PHEP: Record<string, string> = {
  "lib/platform/": "Mã nền tảng: sổ tổ chức, cấu hình module, nhật ký nền tảng, cấp tổ chức — mặt phẳng điều khiển nằm ở CSDL nhà theo định nghĩa.",
  "db/": "Chỗ định nghĩa ba hàm, và lượt migrate CSDL nhà lúc khởi động (`ensureMigrated`).",
  "lib/sales-chatbot/messenger.ts": "Chỉ mục page Messenger ⇒ tổ chức (`platform_messenger_pages`, 0207): Meta gửi mọi page về MỘT URL nên webhook phải tra được page thuộc tổ chức nào TRƯỚC khi vào ngữ cảnh tổ chức. Bảng control plane ở CSDL nhà theo định nghĩa; chỉ là chỉ mục — token page mã hoá ở CSDL tổ chức, mọi lượt khác đi qua getDb().",
  "lib/auth/identities.ts": "Chỉ mục danh tính TOÀN NỀN TẢNG (`platform_identities`, 0193): email / SĐT / Google / Facebook ⇒ (tổ chức, tài khoản) để đăng nhập ở trang chung không cần mã tổ chức. Bảng control plane ở CSDL nhà theo định nghĩa; chỉ là chỉ mục — mật khẩu, quyền, khoá vẫn đọc ở CSDL tổ chức qua withOrganization.",
  "lib/queries/platform-health.ts": "Máy quét sức khoẻ nền tảng: mở CSDL TỪNG tổ chức để đếm migration và bảng platform_* — việc của nó là nhìn sang mọi tổ chức.",
  "lib/queries/platform-org-diagnostics.ts": "Chẩn đoán MỘT tổ chức cho người vận hành nền tảng (/platform/org/<mã>, Phase 11 · H4): mở CSDL của tổ chức được chọn để ĐẾM (chỉ SELECT), kiểm platformOperatorDenial trước mọi truy vấn.",
  "app/api/health/route.ts": "Tuyến sức khoẻ công khai của lượt deploy: đọc mặt phẳng điều khiển (cờ + số đếm, không mã tổ chức nào) — không có phiên để đi qua ngữ cảnh.",
  "lib/onboarding/": "Tự phục vụ (Phase 10): mã mời, lượt đăng ký, trạng thái dựng tổ chức — mặt phẳng điều khiển (CSDL nhà); dữ liệu của tổ chức mới chỉ chạm qua provisionOrganization + withOrganization.",
  "scripts/org-offboard.ts": "Ops `org-offboard` (người vận hành nền tảng chạy qua ops-vps, quyết định chủ shop 08/10/2026): XOÁ một workspace TỰ ĐĂNG KÝ — đọc mặt phẳng điều khiển (getPlatformDb: kiểm chỉ đọc khi chạy thử, pg_stat_archiver cho mốc PITR); mọi lượt đếm / ghi đi qua lõi lib/platform/offboard.ts (CSDL tổ chức mở bằng getDbForInspection — máy chủ ép chỉ đọc), gỡ webhook Meta đọc token page qua getDbForInspection + pageTokensForOffboard (tổ chức có thể đã đình chỉ — không qua ngữ cảnh), không ghi CSDL tổ chức; kết quả MÃ HOÁ (tests/org-offboard.test.ts).",
  "scripts/org-summary.ts": "Ops `org-summary` (người vận hành nền tảng chạy qua ops-vps): mở CSDL của MỘT tổ chức được chọn bằng getDbForInspection (máy chủ ép chỉ đọc, không migrate) để ĐẾM — không đọc cột mang dữ liệu người hay bí mật kết nối (tests/org-summary.test.ts).",
  "scripts/inbox-perf-probe.ts": "Ops `inbox-perf-probe` (người vận hành nền tảng chạy qua ops-vps): mở CSDL của từng tổ chức được đo bằng getDbForInspection (máy chủ ép chỉ đọc, không migrate, không dọn platform_*) rồi gắn làm handle của tổ chức cho RIÊNG tiến trình đo, để các hàm của Hộp thư (gọi getDb() trong withOrganization) chạy được dưới ERP_READ_ONLY=1 — chỉ bấm giờ, kết quả MÃ HOÁ (tests/inbox-perf-probe.test.ts).",
  "scripts/org-order-audit.ts": "Ops `org-order-audit` (người vận hành nền tảng chạy qua ops-vps): mở CSDL của MỘT tổ chức được chọn bằng getDbForInspection (máy chủ ép chỉ đọc, không migrate) để đối chiếu hội thoại có SĐT với đơn ERP của một ngày — kết quả MÃ HOÁ (tests/org-order-audit.test.ts).",
  "scripts/inbox-read-audit.ts": "Ops `inbox-read-audit` (người vận hành nền tảng chạy qua ops-vps): mở CSDL của MỘT tổ chức được chọn bằng getDbForInspection (máy chủ ép chỉ đọc, không migrate) để đo bất biến «chưa đọc ⇒ có tin khách sau con trỏ» của hộp thư — chỉ mốc + số đếm, kết quả MÃ HOÁ (tests/inbox-read-v3.test.ts).",
  "scripts/inbox-avatar-audit.ts": "Ops `inbox-avatar-audit` (người vận hành nền tảng chạy qua ops-vps): mở CSDL của MỘT tổ chức được chọn bằng getDbForInspection (máy chủ ép chỉ đọc, không migrate) để đếm trạng thái ảnh đại diện / link Facebook / dạng fb_id của hộp thư — chỉ số đếm, kết quả MÃ HOÁ (tests/inbox-avatar-profile.test.ts).",
  "scripts/org-ai-cutover.ts": "Ops `org-ai-cutover` (người vận hành nền tảng chạy qua ops-vps): mở CSDL của MỘT tổ chức được chọn bằng getDbForInspection (máy chủ ép chỉ đọc) để đọc động cơ AI của bot + kết nối AI (giải bí mật CHỈ để tính vân tay trong RAM), và sổ AI ở CSDL nền tảng (getPlatformDb) — ghi CHỈ qua hai lõi khi có --apply: đổi động cơ qua lõi /platform/org (saveChatbotEngineAsOperator trong withOrganization), và với --credit đặt đúng MỘT ô credit qua lõi hẹp setOrgAiLimitAsOperator (lib/ai-usage/control.ts — cùng đường ghi + nhật ký với màn hình, nguồn SCRIPT); script không tự ghi bảng nào của mặt phẳng điều khiển; kết quả MÃ HOÁ (tests/org-ai-cutover.test.ts).",
  "scripts/org-catalog.ts": "Ops `org-catalog` (người vận hành nền tảng chạy qua ops-vps): mở CSDL của MỘT tổ chức được chọn bằng getDbForInspection (máy chủ ép chỉ đọc, không migrate) để đọc danh mục · bảng giá sỉ · câu mẫu · công tắc bot — CHỈ ĐỌC, không một câu ghi; kết quả MÃ HOÁ vì mang giá và chữ câu mẫu của shop (tests/org-catalog.test.ts).",
  "scripts/verify-migrations.ts": "Bước KIỂM của lượt deploy (install-vps.sh, chạy trong container app): mở CSDL nhà + CSDL của MỌI tổ chức khách ACTIVE theo sổ tổ chức để migrate và đối chiếu sổ migration (scale-plan.md việc B) — việc của nền tảng, chỉ đọc bảng __drizzle_migrations, không đọc dữ liệu nghiệp vụ nào.",
  "scripts/platform-load-probe.ts": "Script ĐO TẢI chạy tay (Phase 11 · H2), không nằm trong đường chạy của ứng dụng: cấp rồi GỠ năm tổ chức thử `lprobe-*` của chính nó ở mặt phẳng điều khiển (CSDL nhà); dữ liệu của tổ chức chỉ chạm qua provisionOrganization + withOrganization + getDb().",
  "scripts/platform-secrets-verify.ts": "Script KIỂM KHOÁ BÍ MẬT của người vận hành (ops platform-secrets-verify, launch-gates A.5), chạy tay trong container: đọc/ghi đúng một dòng settings canary ở CSDL nhà qua getPlatformDb; không mở CSDL tổ chức nào, không chạm org_connections; không nằm trong đường chạy của ứng dụng, không in bản rõ.",
  "scripts/restore-drill-org-config.ts": "Script DIỄN TẬP KHÔI PHỤC tầng cấu hình chạy tay / trong bài kiểm (sẵn sàng thương mại C), không nằm trong đường chạy của ứng dụng: trên PGlite RIÊNG của chính nó (không đọc .env), cấp một tổ chức thử, xoá rồi cấp lại dòng sổ ở mặt phẳng điều khiển; dữ liệu của tổ chức chỉ chạm qua provisionOrganization + withOrganization + getDb().",
  "lib/entitlements/": "Gói + hạn mức (Phase 10): đọc bảng platform_plans ở CSDL nhà; bộ đếm mức dùng vẫn đi getDb() của tổ chức ngữ cảnh.",
  "lib/billing/": "Thu phí thuê bao (0187): platform_subscriptions / platform_invoices / platform_billing_payments / platform_plans ở mặt phẳng điều khiển, và sổ ngân hàng CỦA TỔ CHỨC NHÀ (nơi tiền thuê bao về) — đọc bằng getPlatformDb() vì tiền về tài khoản của nền tảng, không phải của tổ chức ngữ cảnh; không đọc dữ liệu nghiệp vụ của tổ chức khách nào.",
  "lib/pricing/": "Nền móng giá & thu phí (0222): platform_plans.commercial / platform_org_pricing / platform_settings (ngưỡng Margin Guard, giá đơn vị AI ghi đè) / platform_ai_usage ở mặt phẳng điều khiển (CSDL nhà); số dùng trong CSDL tổ chức đọc qua lib/platform/usage-meter.ts — tệp ở đây không tự mở CSDL tổ chức nào.",
  // Khai TRƯỚC khoá thư mục `lib/saas/` (phép dò lấy khoá khớp ĐẦU TIÊN): tệp này là ngoại lệ DUY NHẤT của thư mục được mở CSDL tổ chức.
  "lib/saas/security-acceptance.ts": "Ops `security-acceptance` · S3 (LAUNCH_GATE §3, Integration Lead duyệt 09/10/2026): mở CSDL của TỪNG tổ chức CHỈ ĐỌC bằng getDbForInspection (máy chủ ép chỉ đọc, không migrate, không dọn bảng platform_*) chỉ để gọi secretsAtRestCells của lib/connectors/service.ts — phán phong bì bản mã, không giải mã, không byte nào ra ngoài; getPlatformDb đọc conversation_id của workspace nghiệm thu từ platform_ai_usage cho S1 (tests/security-acceptance.test.ts).",
  "lib/saas/": "SaaS Control Plane (0224, docs/saas/README.md): tài khoản · thuê bao sản phẩm · sổ dùng · sổ chi phí · bảng kê · job cấp phát ở mặt phẳng điều khiển (CSDL nhà) — CHỈ getPlatformDb. Không tự mở CSDL tổ chức nào (cấp workspace đi qua provisionOrganization + withOrganization; module đi qua setOrganizationModule); ngoại lệ duy nhất là lib/saas/security-acceptance.ts khai riêng ở trên — testCsdlChiDinhChiONenTang chặn getDbFor / getDbForInspection ở mọi tệp khác của thư mục.",
  "lib/ai-usage/": "Sổ dùng AI + hạn mức AI + công tắc AI (pilot readiness 3): bảng platform_ai_usage / platform_plans / platform_settings / platform_organizations ở mặt phẳng điều khiển (CSDL nhà); mọi dòng khoá theo org_code do MÁY CHỦ lấy từ ngữ cảnh — không đọc dữ liệu nghiệp vụ của tổ chức nào.",
};

export function testCsdlChiDinhChiONenTang() {
  const pham: string[] = [];
  const daDung = new Set<string>();
  let dem = 0;
  for (const tep of tepMa(["lib/", "app/", "db/", "scripts/", "components/", "chatbot/", "middleware.ts", "instrumentation"])) {
    if (!/\b(?:getPlatformDb|getDbFor|getDbForInspection)\b/.test(ma(tep))) continue;
    dem += 1;
    const khoa = Object.keys(CSDL_CHI_DINH_DUOC_PHEP).find((k) => (k.endsWith("/") ? tep.startsWith(k) : tep === k));
    // Khoá thư mục `lib/saas/` chỉ phủ getPlatformDb (mặt phẳng điều khiển) — mở CSDL tổ chức phải là một tệp khai RIÊNG kèm lý do.
    if (khoa === "lib/saas/" && /\b(?:getDbFor|getDbForInspection)\b/.test(ma(tep))) {
      pham.push(`${tep} (mở CSDL tổ chức dưới khoá thư mục lib/saas/ — khai riêng tệp kèm lý do)`);
      continue;
    }
    if (khoa) {
      daDung.add(khoa);
      continue;
    }
    pham.push(tep);
  }
  assert.deepEqual(pham, [], "getPlatformDb / getDbFor / getDbForInspection ngoài mã nền tảng là chọn CSDL bỏ qua tổ chức của phiên — mã nghiệp vụ gọi getDb() (S17). Khai vào CSDL_CHI_DINH_DUOC_PHEP kèm lý do nếu thật sự là việc của nền tảng");
  assert.ok(dem >= 5, `phải thấy các lời gọi đã biết (sổ tổ chức, năng lực, cấp tổ chức, sức khoẻ) — mới thấy ${dem}: bộ dò có thể đã mù`);
  khongMienTruMoCoi("S17", CSDL_CHI_DINH_DUOC_PHEP, daDung);
}

/* ═════════════ S18 · ROUTE API DÙNG PHIÊN PHẢI QUA apiGuard ═════════════ */

/**
 * Route dựng trên `getCurrentUser()` chỉ nói được "Chưa đăng nhập": module tắt ⇒ 401 thay vì 403
 * `MODULE_DISABLED`, tổ chức đình chỉ ⇒ 401 thay vì 403 `ORG_INACTIVE` (risk-register R-18). Route
 * mới dùng phiên phải đi qua `apiGuard`; ngoại lệ khai ở đây kèm lý do.
 */
const ROUTE_PHIEN_MIEN_TRU: Record<string, string> = {
  "app/api/perf/route.ts": "Dùng requirePermission (chuyển hướng) + chỉ tổ chức nhà (sổ đo của NỀN TẢNG); cổng đường dẫn trong resolveCurrentUser vẫn chặn — đổi sang apiGuard là đổi phản hồi của công cụ vận hành.",
  "app/api/export/payroll/route.ts":
    "Bài quét cửa vào của LƯƠNG (payroll-production-readiness mục 9) đòi requireUser()/getCurrentUser() đứng đầu mọi cửa lương; chuyển sang apiGuard là sửa kỳ vọng của bài kiểm miền lương — việc riêng (R-18 còn một nửa). Cổng đường dẫn trong getCurrentUser vẫn chặn khi Lương tắt, chỉ sai mã (401 thay vì 403).",
  "app/api/sync/[job]/route.ts": "Hai cửa xác thực: CRON_SECRET (không phiên) HOẶC phiên có sync:run. Đường dẫn không thuộc module nào (MODULE_FREE); sync:run thuộc module Kết nối dữ liệu nên can() đã chặn khi module tắt.",
};

const DUNG_PHIEN = /\b(?:getCurrentUser|requireUser|requirePermission|resolveCurrentUser|getSession)\s*\(/;

/**
 * S18b · ROUTE KHÔNG DÙNG PHIÊN PHẢI KHAI VÌ SAO NÓ CÔNG KHAI — và tự mang cổng của nó (Phase 11 · H1).
 *
 * Route không đọc phiên thì `getDb()` rơi về TỔ CHỨC NHÀ (không claim ⇒ HOME_DEFAULT). Một route mới quên `apiGuard`
 * không lộ ra như lỗi 401 — nó lặng lẽ trả dữ liệu của nhà cho bất kỳ ai gõ đúng URL. Nên mọi route như vậy phải có
 * mặt ở đây kèm lý do, VÀ mã của nó phải khớp đúng cổng đã khai (bí mật cron · chữ ký URL · webhook phân giải tổ
 * chức). Khoá kết thúc bằng `/` là cả thư mục.
 */
const ROUTE_CONG_KHAI: Record<string, { lyDo: string; cong: RegExp | null }> = {
  "app/api/platform/domain-allowed/route.ts": {
    lyDo: "Caddy on-demand TLS hỏi (0180) — không phiên. KHÔNG gọi getDb(): chỉ tra sổ tổ chức ở mặt phẳng điều khiển (organizationForHostSlug — chỉ tổ chức ĐÃ XUẤT BẢN) và trả 200 / 404, không một dòng dữ liệu nghiệp vụ nào.",
    cong: /organizationForHostSlug\(/,
  },
  "app/api/webhooks/": {
    lyDo: "Webhook máy-gọi-máy: xác thực bằng bí mật trong URL / chữ ký của nhà cung cấp và phân giải tổ chức qua resolveWebhookOrganization (S11) — không có phiên người dùng để đi qua.",
    cong: /\bresolveWebhookOrganization\(/,
  },
  "app/api/health/route.ts": { lyDo: "Tuyến sức khoẻ công khai của lượt deploy: chỉ trả cờ + số đếm của mặt phẳng điều khiển, không một dòng nghiệp vụ nào.", cong: null },
  "app/api/sync/organizations/route.ts": { lyDo: "Bộ lập lịch hỏi danh sách mã tổ chức để phân tán job — chỉ nhận CRON_SECRET, không phiên.", cong: /\bsecretEquals\(/ },
  "app/api/tech/agent-run/route.ts": { lyDo: "Máy chạy agent nộp kết quả — khoá riêng AGENT_INGEST_SECRET hoặc CRON_SECRET, có trần lượt gọi.", cong: /\bsecretEquals\(/ },
  "app/api/tech/worker/[op]/route.ts": {
    lyDo: "Worker headless của Phòng Tech AI (docs/tech-control-plane/README.md mục 4) — không phiên; khoá RIÊNG từng worker (CSDL nhà giữ băm). Rơi về tổ chức NHÀ là ĐÚNG ý đồ: mặt phẳng điều khiển Tech chỉ có ở tổ chức nhà, worker chỉ chạm việc mình đang giữ lease.",
    cong: /\bauthenticateTechWorker\(/,
  },
  "app/api/tech/agent-task/route.ts": { lyDo: "Máy chạy agent đọc việc được giao — cùng khoá với cửa ghi, có trần lượt gọi.", cong: /\bsecretEquals\(/ },
  "app/api/video-scale/public/[id]/route.ts": { lyDo: "URL tệp video Meta tải về để đăng Reel — không có phiên; mỗi URL mang chữ ký HMAC có hạn, sai / hết hạn ⇒ 404.", cong: /\bverifyAssetSignature\(/ },
  "app/api/ical/[token]/route.ts": { lyDo: "Lịch .ics của một phòng (module stays) cho kênh lưu trú tự tải — không phiên; serveStayFeed tách mã tổ chức khỏi token, chạy trong withOrganization, kiểm module + token phòng ngẫu nhiên; sai ⇒ 404.", cong: /\bserveStayFeed\(/ },
};

export function testRouteApiQuaApiGuard() {
  const routes = tepTrongKho().filter((t) => t.startsWith("app/api/") && /\/route\.tsx?$/.test(t));
  assert.ok(routes.length >= 20, `phải thấy các route API đã biết — mới thấy ${routes.length}`);
  const pham: string[] = [];
  const daDung = new Set<string>();
  const phamCongKhai: string[] = [];
  const daDungCongKhai = new Set<string>();
  let quaCong = 0;
  for (const tep of routes) {
    const m = ma(tep);
    const quaApiGuard = /\bapiGuard\s*\(/.test(m);
    if (quaApiGuard) quaCong += 1;
    if (!DUNG_PHIEN.test(m) && !quaApiGuard) {
      // Tuyến không phiên (webhook, bí mật, chữ ký URL) — phải khai, và phải mang đúng cổng đã khai.
      const khoa = Object.keys(ROUTE_CONG_KHAI).find((k) => (k.endsWith("/") ? tep.startsWith(k) : tep === k));
      if (!khoa) phamCongKhai.push(`${tep}: không phiên, không apiGuard, chưa khai lý do công khai`);
      else {
        daDungCongKhai.add(khoa);
        const cong = ROUTE_CONG_KHAI[khoa].cong;
        if (cong && !cong.test(m)) phamCongKhai.push(`${tep}: khai công khai nhờ ${cong} mà mã không còn cổng đó`);
      }
      continue;
    }
    if (ROUTE_PHIEN_MIEN_TRU[tep]) {
      daDung.add(tep);
      continue;
    }
    if (!quaApiGuard) pham.push(`${tep}: dùng phiên mà không qua apiGuard`);
    else if (DUNG_PHIEN.test(m)) pham.push(`${tep}: đã qua apiGuard mà vẫn tự đọc phiên lần hai`);
  }
  assert.deepEqual(pham, [], "route API dùng phiên phải qua apiGuard — trả đúng 401 / 403 MODULE_DISABLED / ORG_INACTIVE (S18 · R-18). Ngoại lệ khai ở ROUTE_PHIEN_MIEN_TRU kèm lý do");
  assert.ok(quaCong >= 15, `phải thấy các route đã qua apiGuard — mới thấy ${quaCong}: bộ dò có thể đã mù`);
  khongMienTruMoCoi("S18", ROUTE_PHIEN_MIEN_TRU, daDung);
  assert.deepEqual(phamCongKhai, [], "route không đọc phiên thì getDb() rơi về tổ chức NHÀ — phải qua apiGuard, hoặc khai vào ROUTE_CONG_KHAI kèm lý do và cổng riêng của nó (S18b · Phase 11 H1)");
  khongMienTruMoCoi(
    "S18b",
    Object.fromEntries(Object.entries(ROUTE_CONG_KHAI).map(([k, v]) => [k, v.lyDo])),
    daDungCongKhai,
  );
}

/* ═════════════ S19 · MỌI SERVER ACTION QUA CỔNG PHIÊN TRƯỚC LƯỢT ĐỌC / GHI ĐẦU TIÊN ═════════════ */

/**
 * Một export của tệp `"use server"` là một điểm gọi từ xa: trình duyệt gửi thẳng đối số tới nó, không đi qua trang nào.
 * Luật (Phase 11 · H1): lệnh `await` ĐẦU TIÊN trong thân mỗi export phải là `requireUser(` / `requirePermission(` —
 * hoặc một hàm cổng cục bộ mà lệnh `await` đầu tiên của NÓ là cổng (dò bắc cầu trong cùng tệp). Mã đồng bộ đứng trước
 * (zod, cắt chuỗi) không chạm CSDL nên được phép; mọi lượt đọc / ghi đều là `await`, nên "cổng là `await` đầu tiên"
 * nghĩa là "không một câu truy vấn nào chạy trước khi biết người gọi là ai".
 *
 * Ngoại lệ là cửa CHƯA CÓ PHIÊN theo định nghĩa — khai tên từng hàm kèm lý do; miễn trừ mồ côi là đỏ.
 */
const ACTION_CONG_KHAI: Record<string, string> = {
  "lib/actions/auth.ts::loginAction": "Đăng nhập: chạy khi CHƯA có phiên. Tra tài khoản trong ĐÚNG tổ chức ô «Mã tổ chức» chỉ (verifyLogin bọc withOrganization), có chặn dò mật khẩu theo cặp email + IP.",
  "lib/actions/auth.ts::logoutAction": "Đăng xuất: đọc phiên (getSession) chỉ để ghi nhật ký LOGOUT rồi xoá cookie — không đọc dữ liệu nghiệp vụ nào.",
  "lib/actions/onboarding.ts::checkInviteAction": "Bước 1 của /start (khách CHƯA có tài khoản): lõi kiểm cờ PLATFORM_SIGNUP_MODE + trần theo IP trước khi tra mã mời ở mặt phẳng điều khiển.",
  "lib/actions/onboarding.ts::checkOrgAction": "Bước 2 của /start: kiểm trùng mã tổ chức SẮP tạo — chế độ invite đòi mã mời hợp lệ, không cho dùng làm máy dò danh sách khách.",
  "lib/actions/onboarding.ts::checkAdminAction": "Bước 3 của /start: chỉ kiểm lược đồ (tên, email, độ dài mật khẩu) — hàm thuần, không đọc CSDL nào.",
  "lib/actions/onboarding.ts::previewSignupAction": "Xem trước của /start: lập kế hoạch cài trên một tổ chức TRẮNG tưởng tượng (freshOrgState) — không đọc dữ liệu của tổ chức nào có thật.",
  "lib/actions/onboarding.ts::sendSignupOtpAction": "Gửi mã xác minh SĐT qua Zalo ở /start (khách CHƯA có tài khoản, docs/platform/phone-otp.md). Lõi kiểm cờ đăng ký + công tắc OTP của người vận hành + ba trần gửi đếm từ bảng (SĐT · IP băm · toàn nền tảng) trước khi gọi Zalo; người vận hành bị từ chối.",
  "lib/actions/onboarding.ts::quickSignupAction": "Đăng ký nhanh một màn hình (/start, docs/platform/quick-start.md) — khách CHƯA có tài khoản. Dựng bản nháp rồi giao cho ĐÚNG lõi createOrganizationFromSignup (cờ PLATFORM_SIGNUP_MODE + mã mời + trần IP); hồ sơ Google / Facebook đọc từ cookie KÝ ở máy chủ.",
  "lib/actions/oauth.ts::pickSocialOrgAction": "Chọn cửa hàng sau Google / Facebook — CHƯA có phiên. Danh sách được chọn nằm trong cookie KÝ do máy chủ ghi ở bước callback (đã đổi code lấy hồ sơ ở nhà cung cấp); mã tổ chức gửi lên phải nằm trong danh sách đó, completeProviderLogin kiểm tài khoản trong withOrganization.",
  "lib/actions/oauth.ts::forgetSocialSignupAction": "Bỏ hồ sơ Google / Facebook đang điền sẵn ở /start — chỉ cho cookie hết hạn, không đọc dữ liệu nào.",
  "lib/actions/onboarding.ts::createOrganizationAction": "Tạo tổ chức từ /start: cổng là cờ + mã mời + trần IP trong lõi; mã đã có chủ ⇒ «đã có người dùng», chỉ đúng chủ (cùng mã mời / người vận hành) mới chạy lại.",
  "lib/actions/user-invites.ts::acceptUserInviteAction": "Nhận lời mời người dùng ở /join/<tổ chức>/<mã> — người được mời CHƯA có tài khoản. Lõi (lib/users/invites.ts) kiểm mã mời 256 bit (băm sha256, dùng một lần, điều kiện trong cùng giao dịch tạo tài khoản) trong withOrganization(mã trong đường dẫn) tường minh, chặn dò theo IP, mọi lý do sai ra một câu chung.",
  "lib/actions/password-reset.ts::completePasswordResetAction": "Đặt mật khẩu mới ở /reset/<tổ chức>/<mã> — người quên mật khẩu KHÔNG đăng nhập được. Lõi (lib/users/password-reset.ts) kiểm mã 256 bit (băm sha256, dùng một lần, tiêu mã + ghi mật khẩu trong cùng giao dịch) trong withOrganization(mã trong đường dẫn) tường minh, chặn dò theo IP, mọi lý do sai ra một câu chung; xong thì thu hồi mọi phiên của người đó.",
  "lib/actions/public-chat.ts::startPublicChatAction": "Trang chat CÔNG KHAI của chatbot bán hàng (0180) — khách của shop không có tài khoản. Tổ chức lấy từ HOST (header máy chủ x-erp-host-slug → CHỈ tổ chức đã xuất bản), mọi lượt đọc / ghi trong withOrganization(mã đó) tường minh; module «AI bán hàng» + bot đang bật mới mở; không nhận mã tổ chức nào từ client.",
  "lib/actions/public-chat.ts::sendPublicChatAction": "Như startPublicChatAction; hội thoại khoá theo băm của cookie khách truy cập (httpOnly) — đoán được id hội thoại cũng không gõ tiếp hội thoại của người khác; trần tần suất theo khách / IP (Caddy ghi) / tổ chức TRƯỚC mọi lượt đọc / ghi (lib/sales-chatbot/public-chat-limits.ts), trần theo khách / hội thoại ở lib/sales-chatbot/engine.ts.",
  "lib/actions/public-chat.ts::refreshPublicChatAction": "Khung chat công khai tự đọc lại hội thoại đang mở (tin nhân viên trả lời): CHỈ ĐỌC, tổ chức từ HOST trong withOrganization tường minh như startPublicChatAction; hội thoại phải là kênh WEB và đúng băm cookie khách — đoán được id cũng không đọc được hội thoại người khác; không mở hội thoại, không gọi AI.",
  "lib/actions/refresh.ts::refreshReportData": "Chỉ xoá đệm của tiến trình (clearMemo) khi có phiên — không đọc / ghi dòng nào; không phiên ⇒ trả lỗi, không làm gì.",
};

const CONG_PHIEN = ["requireUser", "requirePermission"] as const;

type KhaiBao = { chuKy: string; than: string; xuat: boolean; laHam: boolean };

/** Khai báo cấp cao nhất của một tệp đã bỏ chú thích: hàm / hằng, chữ ký và thân (tới dòng `}` ở cột đầu). */
function khaiBaoCapCao(m: string): Map<string, KhaiBao> {
  const out = new Map<string, KhaiBao>();
  for (const k of m.matchAll(/^(export\s+)?(?:async\s+)?function\s+(\w+)|^(export\s+)?const\s+(\w+)\s*=/gm)) {
    const ten = k[2] ?? k[4];
    const sau = m.slice(k.index ?? 0);
    const het = sau.search(/\n\}/);
    const van = het < 0 ? sau : sau.slice(0, het + 2);
    const moThan = van.search(/\{\s*\n/);
    out.set(ten, {
      chuKy: moThan < 0 ? van : van.slice(0, moThan),
      than: moThan < 0 ? "" : van.slice(moThan),
      xuat: Boolean(k[1] ?? k[3]),
      laHam: Boolean(k[2]) || /^[^\n]*=\s*(?:cache\()?async\b/.test(sau),
    });
  }
  return out;
}

/** Tên hàm của lệnh `await` đầu tiên trong thân (`await foo(` / `await (foo(`), hoặc `null`. */
function awaitDauTien(than: string): string | null {
  const k = than.match(/\bawait\s+(?:\(\s*)?([\w.$]+)\s*\(/);
  return k ? k[1] : null;
}

function tepServerAction(): string[] {
  return tepMa(["lib/", "app/"]).filter((t) => /^\s*["']use server["']/.test(readFileSync(path.join(goc, t), "utf8")));
}

export function testServerActionQuaCongPhien(): number {
  const pham: string[] = [];
  const daDung = new Set<string>();
  let dem = 0;
  for (const tep of tepServerAction()) {
    const kb = khaiBaoCapCao(ma(tep));
    // Hàm cổng cục bộ: `await` đầu tiên của nó là một cổng (bắc cầu).
    const cong = new Set<string>(CONG_PHIEN);
    for (let doi = true; doi; ) {
      doi = false;
      for (const [ten, k] of kb) {
        if (cong.has(ten) || !k.laHam) continue;
        const dau = awaitDauTien(k.than);
        if (dau && cong.has(dau)) {
          cong.add(ten);
          doi = true;
        }
      }
    }
    for (const [ten, k] of kb) {
      if (!k.xuat || !k.laHam) continue;
      dem += 1;
      const khoa = `${tep}::${ten}`;
      if (ACTION_CONG_KHAI[khoa]) {
        daDung.add(khoa);
        continue;
      }
      const dau = awaitDauTien(k.than);
      if (!dau || !cong.has(dau)) pham.push(`${khoa} — await đầu tiên: ${dau ?? "(không có)"}`);
    }
  }
  assert.ok(dem >= 300, `phải thấy hàng trăm server action đã biết — mới thấy ${dem}: bộ dò có thể đã mù`);
  assert.deepEqual(pham, [], "server action phải hỏi phiên (requireUser / requirePermission, hoặc hàm cổng cục bộ) TRƯỚC lượt đọc / ghi đầu tiên — đối số của nó do trình duyệt gửi thẳng (S19 · Phase 11 H1). Cửa chưa có phiên theo định nghĩa khai ở ACTION_CONG_KHAI kèm lý do");
  khongMienTruMoCoi("S19", ACTION_CONG_KHAI, daDung);
  return dem;
}

/* ═════════════ S20 · SERVER ACTION KHÔNG CHỌN TỔ CHỨC THEO ĐỐI SỐ CỦA CLIENT ═════════════ */

/**
 * Tổ chức của một lượt gọi đến từ PHIÊN do máy chủ ký (lib/platform/context.ts). Server action nhận mã tổ chức từ
 * trình duyệt rồi đem đi chọn CSDL là cửa đọc / ghi tổ chức khác bằng cách sửa một đối số. Luật:
 *  · trong lib/actions/*: KHÔNG `withOrganization(` / `getDbFor(` / `getDbForInspection(` / `getPlatformDb(`;
 *  · export nào nhận mã tổ chức (tham số `orgCode` / `organization…` / `org`, hoặc đọc ô `org` của FormData) phải khai
 *    ở đây: hoặc là cửa của NGƯỜI VẬN HÀNH (thân phải qua `platform:operate` — chỉ tổ chức nhà có), hoặc là cửa công
 *    khai của đăng nhập / tự đăng ký (đã khai ở S19) — nơi mã tổ chức là ĐÍCH người dùng tự chọn, không phải một
 *    CSDL được mở hộ họ.
 */
const ACTION_NHAN_MA_TO_CHUC: Record<string, { lyDo: string; loai: "VAN_HANH" | "CONG_KHAI" }> = {
  "lib/actions/ai-balance.ts::adjustAiBalanceAction": { loai: "VAN_HANH", lyDo: "Người vận hành tặng / điều chỉnh / hoàn Số dư AI của MỘT tổ chức (/platform/ai-balance, 0235) — requirePermission(platform:operate), lõi adjustAiBalance hỏi platformOperatorDenial trước mọi lượt đọc, bắt buộc lý do, dòng sổ + nhật ký nền tảng AI_BALANCE_ADJUST trong CÙNG một giao dịch." },
  "lib/actions/ai-balance.ts::reverseAiUsageChargeAction": { loai: "VAN_HANH", lyDo: "Người vận hành đảo ĐÚNG một khoản trừ AI oan của MỘT tổ chức (/platform/ai-balance) — requirePermission(platform:operate), lõi reverseAiUsageCharge hỏi platformOperatorDenial trước mọi lượt đọc, bắt buộc lý do, dòng sổ + nhật ký nền tảng trong CÙNG một giao dịch, mỗi khoản trừ một lần." },
  "lib/actions/ai-balance.ts::setAiBalanceEnabledAction": { loai: "VAN_HANH", lyDo: "Người vận hành bật / tắt Số dư AI (cờ canary ai_balance.enabled) của MỘT tổ chức — requirePermission(platform:operate), lõi setAiBalanceEnabled (kill-switches.ts) hỏi platformOperatorDenial, bắt buộc lý do, nhật ký nền tảng FLAG_SET; tắt cờ không đụng tiền." },
  "lib/actions/billing.ts::setOrgBillingAction": { loai: "VAN_HANH", lyDo: "Người vận hành bật / tắt / sửa ngày trả tới + ân hạn thu phí của MỘT tổ chức (/platform/org/<mã>) — requirePermission(platform:operate), lõi setOrgBilling hỏi platformOperatorDenial trước mọi lượt đọc, bắt buộc lý do, nhật ký nền tảng." },
  "lib/actions/oauth.ts::pickSocialOrgAction": { loai: "CONG_KHAI", lyDo: "Chọn cửa hàng sau đăng nhập Google / Facebook (CHƯA có phiên): mã tổ chức gửi lên chỉ được chấp nhận khi nằm trong danh sách của cookie KÝ do máy chủ ghi ở bước callback (sau khi đổi code lấy hồ sơ ở nhà cung cấp); completeProviderLogin kiểm tài khoản + trạng thái trong withOrganization." },
  "lib/actions/pricing.ts::setOrgPriceVersionAction": { loai: "VAN_HANH", lyDo: "Người vận hành chuyển MỘT tổ chức sang một phiên bản giá (/platform/saas, 0228) — requirePermission(platform:operate), lõi setOrgPriceVersion hỏi platformOperatorDenial trước mọi lượt đọc, bắt buộc lý do, nhật ký nền tảng PRICE_VERSION_PIN." },
  "lib/actions/pricing.ts::setOrgPricingAction": { loai: "VAN_HANH", lyDo: "Người vận hành ghi đè tính năng / hạn mức / mức áp của MỘT tổ chức (/platform/saas, 0222) — requirePermission(platform:operate), lõi setOrgPricing hỏi platformOperatorDenial trước mọi lượt đọc, bắt buộc lý do, nhật ký nền tảng ORG_PRICING_SET." },
  "lib/actions/billing.ts::setOrgAddonsAction": { loai: "VAN_HANH", lyDo: "Người vận hành sửa phần MUA THÊM hạn mức của MỘT tổ chức (/platform/org/<mã>, 0192) — requirePermission(platform:operate), lõi setOrgAddons hỏi platformOperatorDenial + parseOperatorTarget trước mọi lượt đọc, bắt buộc lý do, nhật ký nền tảng ORG_ADDONS_SET." },
  "lib/actions/platform-modules.ts::toggleModuleForOrgAction": { loai: "VAN_HANH", lyDo: "Người vận hành nền tảng bật/tắt module của tổ chức khác từ /platform — requirePermission(platform:operate) + platformOperatorDenial (chỉ tổ chức nhà), ghi nhật ký nền tảng kèm lý do." },
  "lib/actions/ai-usage.ts::setOrgAiControlAction": { loai: "VAN_HANH", lyDo: "Người vận hành tắt AI / ghi đè hạn mức AI của MỘT tổ chức từ /platform/org/<mã> — requirePermission(platform:operate), lõi setOrgAiControl kiểm lại người vận hành + tổ chức nhà, bắt buộc lý do, ghi platform_audit_log." },
  "lib/actions/platform-ops.ts::setPilotStageAction": { loai: "VAN_HANH", lyDo: "Người vận hành đổi giai đoạn pilot của một tổ chức (/platform/org/<mã>) — requirePermission(platform:operate) + platformOperatorDenial ở lõi, lý do, nhật ký nền tảng." },
  "lib/actions/platform-ops.ts::confirmPilotUatAction": { loai: "VAN_HANH", lyDo: "Người vận hành xác nhận UAT của một tổ chức — requirePermission(platform:operate) + platformOperatorDenial ở lõi, nhật ký nền tảng." },
  "lib/actions/platform-ops.ts::setOrgSuspendedAction": { loai: "VAN_HANH", lyDo: "Công tắc khẩn: đình chỉ / bật lại một tổ chức — requirePermission(platform:operate) + platformOperatorDenial ở lõi, lý do, nhật ký nền tảng." },
  "lib/actions/platform-ops.ts::setWorkflowsPausedAction": { loai: "VAN_HANH", lyDo: "Công tắc khẩn: tạm dừng luật tự động của một tổ chức (cờ control plane) — requirePermission(platform:operate) + platformOperatorDenial ở lõi, lý do, nhật ký nền tảng." },
  "lib/actions/platform-ops.ts::disableOrgConnectionAction": { loai: "VAN_HANH", lyDo: "Công tắc khẩn: tắt một kết nối của tổ chức qua sổ kết nối (lõi bọc withOrganization ĐÍCH, không phải action) — requirePermission(platform:operate) + platformOperatorDenial." },
  "lib/actions/platform-ops.ts::setOrgPlanAction": { loai: "VAN_HANH", lyDo: "Người vận hành đổi gói của MỘT tổ chức sau lúc tạo (/platform/org/<mã>) — requirePermission(platform:operate) + platformOperatorDenial ở lõi (lib/platform/org-plan.ts), chỉ ghi cột plan của control plane, không mở CSDL nào của tổ chức" },
  "lib/actions/platform-ops.ts::setOrgBrandAction": { loai: "VAN_HANH", lyDo: "Người vận hành đặt thương hiệu (vnx · chotdon, 0215) cho MỘT tổ chức có từ trước (/platform/org/<mã>) — requirePermission(platform:operate) + platformOperatorDenial ở lõi (lib/platform/org-brand.ts), chỉ ghi cột brand của control plane, không mở CSDL nào của tổ chức" },
  "lib/actions/onboarding.ts::retrySetupAction": { loai: "VAN_HANH", lyDo: "Người vận hành chạy lại việc dựng một tổ chức SETUP_FAILED — requireOperator (platform:operate + tổ chức nhà)." },
  "lib/actions/onboarding.ts::checkOrgAction": { loai: "CONG_KHAI", lyDo: "Mã tổ chức ĐỀ XUẤT cho tổ chức sắp tạo — chỉ kiểm trùng ở sổ tổ chức, không mở CSDL nào." },
  "lib/actions/onboarding.ts::previewSignupAction": { loai: "CONG_KHAI", lyDo: "Mã tổ chức đi cùng mã mời để tra mã mời đã gắn đúng tổ chức — xem trước chạy trên tổ chức TRẮNG tưởng tượng." },
  "lib/actions/password-reset.ts::completePasswordResetAction": { loai: "CONG_KHAI", lyDo: "Mã tổ chức trong liên kết đặt lại: mật khẩu được ghi TRONG tổ chức đó, và chỉ khi mã (băm) khớp một liên kết còn hạn trong CSDL của chính nó — mã của tổ chức A đem sang đường dẫn B không khớp gì." },
  "lib/actions/password-reset.ts::createResetLinkAsOperatorAction": { loai: "VAN_HANH", lyDo: "Người vận hành tạo liên kết đặt lại mật khẩu cho một tài khoản của tổ chức khách (/platform/org/<mã>) — requirePermission(platform:operate), lõi createResetLinkAsOperator hỏi platformOperatorDenial trước mọi lượt đọc, bắt buộc lý do, nhật ký nền tảng." },
  "lib/actions/user-invites.ts::acceptUserInviteAction": { loai: "CONG_KHAI", lyDo: "Mã tổ chức trong liên kết mời: tài khoản được tạo TRONG tổ chức đó, và chỉ khi mã mời (băm) khớp một lời mời còn hạn trong CSDL của chính nó — mã của tổ chức A đem sang đường dẫn B không khớp gì." },
  "lib/actions/auth.ts::loginAction": { loai: "CONG_KHAI", lyDo: "Ô «Mã tổ chức» của màn đăng nhập: người dùng chọn tổ chức để đăng nhập VÀO — mật khẩu kiểm trong CSDL của chính tổ chức đó." },
};

const NHAN_MA_TO_CHUC = /\b(?:orgCode|organizationCode|organization|org)\b\s*[?:]/;
const DOC_O_ORG = /\.get\(\s*["'](?:org|orgCode|organization)["']\s*\)/;
const CHON_CSDL = /\b(?:withOrganization|getDbFor|getDbForInspection|getPlatformDb)\s*\(/;

/** Danh sách tham số của chữ ký hàm (bỏ kiểu trả về — `Promise<{ orgCode: string }>` không phải đầu vào). */
function thamSoCua(chuKy: string): string {
  const mo = chuKy.indexOf("(");
  return mo < 0 ? "" : doiSoCuaLoiGoi(chuKy, mo + 1).join(", ");
}

export function testServerActionKhongChonToChuc() {
  const phamCsdl: string[] = [];
  const thay = new Set<string>();
  const phamKhai: string[] = [];
  for (const tep of tepServerAction()) {
    const m = ma(tep);
    if (CHON_CSDL.test(m)) phamCsdl.push(tep);
    for (const [ten, k] of khaiBaoCapCao(m)) {
      if (!k.xuat || !k.laHam) continue;
      if (!NHAN_MA_TO_CHUC.test(thamSoCua(k.chuKy)) && !DOC_O_ORG.test(k.than)) continue;
      const khoa = `${tep}::${ten}`;
      thay.add(khoa);
      const khai = ACTION_NHAN_MA_TO_CHUC[khoa];
      if (!khai) {
        phamKhai.push(`${khoa}: nhận mã tổ chức từ client mà chưa khai`);
        continue;
      }
      if (khai.loai === "VAN_HANH" && !/requirePermission\(\s*["']platform:operate["']\s*\)|\brequireOperator\(/.test(k.than)) phamKhai.push(`${khoa}: khai là cửa vận hành mà thân không qua platform:operate`);
      if (khai.loai === "CONG_KHAI" && !ACTION_CONG_KHAI[khoa]) phamKhai.push(`${khoa}: khai là cửa công khai mà không có trong ACTION_CONG_KHAI (S19)`);
    }
  }
  assert.deepEqual(phamCsdl, [], "server action tự chọn CSDL (withOrganization / getDbFor / getPlatformDb) là vòng qua tổ chức của PHIÊN — việc đó thuộc lõi nền tảng, không thuộc tệp nhận đối số từ trình duyệt (S20)");
  assert.deepEqual(phamKhai, [], "server action nhận mã tổ chức từ client phải khai ở ACTION_NHAN_MA_TO_CHUC: cửa vận hành (platform:operate) hoặc cửa công khai của đăng nhập / tự đăng ký (S20 · Phase 11 H1)");
  const moCoi = Object.keys(ACTION_NHAN_MA_TO_CHUC).filter((k) => !thay.has(k));
  assert.deepEqual(moCoi, [], "S20: khai báo không còn khớp export nào — xoá khỏi danh sách");
  // Tự kiểm bộ dò: không tin được nó thì luật trên mù.
  assert.ok(NHAN_MA_TO_CHUC.test("(input: { orgCode: string; x: 1 })") && NHAN_MA_TO_CHUC.test("(org: { name: string })") && !NHAN_MA_TO_CHUC.test("(input: { moduleKey: string })"));
  assert.equal(NHAN_MA_TO_CHUC.test(thamSoCua("export async function f(draft: unknown): Promise<{ ok: true; orgCode: string }> ")), false, "kiểu trả về không phải tham số");
  assert.equal(NHAN_MA_TO_CHUC.test(thamSoCua("export async function f(input: { invite: string | null; orgCode: string }): Promise<X> ")), true);
  assert.equal(awaitDauTien("{\n  const x = z.parse(a);\n  const u = await requireUser();\n  await getDb();\n}"), "requireUser");
  assert.equal(awaitDauTien("{\n  return nguoiGhi(id ? await topicIdOf(await getDb(), id) : null);\n}"), "topicIdOf");
}

/* ═════════════ S21 · LÕI VẬN HÀNH HỎI NGƯỜI VẬN HÀNH TRƯỚC LƯỢT ĐỌC / GHI ĐẦU TIÊN (pilot readiness) ═════════════ */

/**
 * Vỏ action của người vận hành (S20, loại VAN_HANH) chỉ là lớp THỨ NHẤT. Hàm lõi nó gọi nhìn XUYÊN ranh giới tổ chức (sổ
 * tổ chức, CSDL của khách, sổ dùng AI, nhật ký nền tảng) và còn được trang / bài kiểm gọi thẳng, nên lõi phải tự hỏi
 * `platformOperatorDenial(user)` TRƯỚC lượt `await` đầu tiên không phải đọc phiên. Luật:
 *  1. Mọi hàm xuất khẩu trong lib/ có gọi `platformOperatorDenial(` gọi nó TRƯỚC `await` đầu tiên (được phép: `await` đọc
 *     phiên, hoặc `await` một hàm CỤC BỘ tự hỏi trước — `parseCommon` của công tắc khẩn) — và phải khai ở LOI_VAN_HANH.
 *  2. LOI_VAN_HANH phải còn nguyên và thoả luật 1: xoá hẳn câu hỏi khỏi một lõi thì luật 1 mù, danh sách đóng này thì không.
 *  3. Mỗi server action qua `platform:operate` gọi một lõi trong LOI_VAN_HANH, hoặc hàm cổng cục bộ `requireOperator`
 *     (tự hỏi `platformOperatorDenial`).
 *  4. `loadOrgAiUsage(` đọc sổ AI theo MÃ TỔ CHỨC mà không hỏi người — chỉ được gọi ở chỗ khai; `/settings/plan` không
 *     nhận `params` / `searchParams` (mã tổ chức lấy từ PHIÊN).
 *  5. `writeOrgFlag(` (cờ `workflows.paused`) chỉ công tắc khẩn gọi.
 */
const LOI_VAN_HANH: Record<string, string> = {
  "lib/platform/kill-switches.ts::setOrganizationSuspended": "Công tắc khẩn: đình chỉ / bật lại một tổ chức (hỏi qua parseCommon).",
  "lib/platform/kill-switches.ts::setWorkflowsPaused": "Công tắc khẩn: tạm dừng luật tự động của một tổ chức (hỏi qua parseCommon).",
  "lib/platform/kill-switches.ts::disableOrgConnection": "Công tắc khẩn: tắt một kết nối trong CSDL của tổ chức đích (hỏi qua parseCommon).",
  "lib/platform/kill-switches.ts::setAiBalanceEnabled": "Bật / tắt Số dư AI (cờ canary ai_balance.enabled, 0235) của một tổ chức (hỏi qua parseCommon) — tắt cờ không đụng tiền.",
  "lib/billing/ai-balance.ts::reverseAiUsageCharge": "Đảo ĐÚNG một khoản trừ AI (mã dòng sổ) của một tổ chức — số tiền của khoản ấy, khoá aic-reverse:<mã>, dòng sổ + nhật ký nền tảng cùng một giao dịch, bắt buộc lý do.",
  "lib/billing/ai-balance.ts::adjustAiBalance": "Tặng / điều chỉnh / hoàn Số dư AI của một tổ chức — dòng sổ + nhật ký nền tảng AI_BALANCE_ADJUST trong CÙNG một giao dịch, bắt buộc lý do.",
  "lib/billing/ai-balance.ts::loadAiBalanceOperatorView": "Màn /platform/ai-balance: số dư mọi tổ chức (tiền thật · tiền tặng) + khoản tiền nạp cần xem lại — chỉ đọc mặt phẳng điều khiển.",
  "lib/platform/org-plan.ts::setOrganizationPlan": "Đổi gói của một tổ chức sau lúc tạo — ghi cột plan của mặt phẳng điều khiển + nhật ký nền tảng.",
  "lib/platform/org-brand.ts::setOrganizationBrand": "Đặt thương hiệu (vnx · chotdon, 0215) của một tổ chức có từ trước — ghi cột brand của mặt phẳng điều khiển + nhật ký nền tảng.",
  "lib/platform/pilot.ts::setPilotStage": "Đổi giai đoạn pilot của một tổ chức — ghi mặt phẳng điều khiển + đo CSDL của khách.",
  "lib/platform/pilot.ts::confirmPilotUat": "Xác nhận UAT của một tổ chức — ghi mặt phẳng điều khiển.",
  "lib/platform/support.ts::loadOrgSupport": "Trang sức khoẻ một tổ chức: ghi SUPPORT_VIEW rồi ĐẾM trong CSDL của khách.",
  "lib/platform/support.ts::listOrgSupportSummaries": "Tóm tắt mọi tổ chức ở /platform: mở CSDL từng tổ chức để đếm người dùng.",
  "lib/ai-usage/control.ts::setPlatformAiEnabled": "Công tắc AI toàn nền tảng.",
  "lib/ai-usage/control.ts::setOrgAiControl": "Công tắc AI + ghi đè hạn mức AI của một tổ chức.",
  // Platform AI Model Control (06/10/2026) — model của AI DÙNG CHUNG cho mọi tổ chức khách; sổ AI nguồn PLATFORM toàn nền tảng.
  "lib/ai-usage/platform-ai-admin.ts::loadPlatformAiControl": "Khung Platform AI Model Control: sổ AI nguồn PLATFORM của MỌI tổ chức (30 ngày theo model / loại việc) + mở CSDL từng tổ chức có lượt AI dùng chung để ĐẾM đơn AI gắn hội thoại + chính sách + lượt kiểm khả dụng + nhật ký.",
  "lib/ai-usage/platform-ai-admin.ts::probePlatformAiModelAsOperator": "Kiểm khả dụng một model bằng khoá nền tảng — lưu kết quả, nhật ký PLATFORM_AI_MODEL_PROBE.",
  "lib/ai-usage/platform-ai-admin.ts::setPlatformAiPolicy": "Chạy thử / áp dụng model AI dùng chung cho cả nền tảng — bắt buộc lý do + lượt kiểm AVAILABLE trong 24 giờ, nhật ký PLATFORM_AI_POLICY_SET.",
  "lib/ai-usage/platform-ai-ab.ts::loadPlatformModelAb": "Bảng A/B model AI dùng chung: sổ AI nguồn PLATFORM của MỌI tổ chức + mở CSDL từng tổ chức có hội thoại cohort để ĐẾM (SĐT · địa chỉ · chốt · handoff · công cụ) — không trả tên, SĐT, nội dung tin.",
  "lib/ai-usage/platform-ai-admin.ts::rollbackPlatformAiPolicy": "Hoàn tác chính sách model AI dùng chung — bắt buộc lý do, nhật ký PLATFORM_AI_POLICY_ROLLBACK.",
  "lib/ai-usage/view.ts::loadOperatorOrgAi": "Sổ AI theo ngày của MỘT tổ chức bất kỳ (màn người vận hành).",
  "lib/ai-usage/view.ts::loadPlatformAiSummary": "Top tổ chức theo chi phí AI toàn nền tảng.",
  "lib/platform/secrets-self-test.ts::runSecretsSelfTest": "Tự kiểm khoá bí mật của nền tảng (cổng mở bán A) — ghi nhật ký nền tảng.",
  "lib/platform-ui/module-toggle.ts::toggleModuleForOrganization": "Bật / tắt module của một tổ chức bất kỳ.",
  "lib/queries/platform-org-diagnostics.ts::loadOrgDiagnostics": "Chẩn đoán H4 một tổ chức: mở CSDL của tổ chức được chọn để đếm.",
  "lib/users/password-reset.ts::createResetLinkAsOperator": "Liên kết đặt lại mật khẩu cho tài khoản của một tổ chức khách (lối ra khi quản trị của khách quên mật khẩu).",
  "lib/onboarding/signup-mode.ts::setSignupSetting": "Cổng mở bán B: chế độ đăng ký /start của cả nền tảng.",
  // Thu phí thuê bao (0187) — mặt phẳng điều khiển của CSDL nhà; không mở CSDL của khách.
  "lib/billing/service.ts::setBillingReceiver": "Tài khoản nhận tiền thuê bao của nền tảng.",
  "lib/billing/service.ts::reconcileBillingAsOperator": "Nút đối chiếu lại tiền thuê bao từ sổ ngân hàng của nhà.",
  "lib/billing/service.ts::setOrgBilling": "Bật / tắt / sửa ngày trả tới + ân hạn của một tổ chức.",
  "lib/billing/service.ts::markInvoicePaidManually": "Xác nhận tay một hoá đơn (qua operatorInvoice).",
  "lib/billing/service.ts::voidInvoice": "Huỷ một hoá đơn đang mở (qua operatorInvoice).",
  "lib/billing/service.ts::setPlanPrice": "Sửa giá tháng của một gói.",
  "lib/billing/service.ts::setPlanAddonPrices": "Sửa đơn giá mua thêm hạn mức của một gói (0192).",
  "lib/billing/service.ts::setOrgAddons": "Sửa phần mua thêm hạn mức của một tổ chức (0192).",
  "lib/billing/service.ts::markVatIssued": "Ghi số hoá đơn VAT đã xuất cho một khoản đã thu (0192).",
  "lib/billing/service.ts::resolveBillingPayment": "Đánh dấu đã xử lý một khoản tiền không khớp.",
  "lib/billing/service.ts::confirmBankPayment": "Xác nhận tay MỘT khoản tiền thuê bao không do SePay tạo — đọc lại dòng sổ ngân hàng của nhà, khoá bank_ref (một dòng trả một hoá đơn), gia hạn.",
  "lib/billing/service.ts::dismissBankPayment": "Gạt một khoản tiền chờ xác nhận nguồn khỏi danh sách — ghi «đã xử lý» + nhật ký nền tảng, không xoá.",
  "lib/billing/service.ts::loadPlatformBilling": "Bảng thu phí mọi tổ chức ở /platform (MRR, hoá đơn mở, tiền chưa khớp).",
  "lib/billing/service.ts::loadOrgBilling": "Khung thu phí của MỘT tổ chức bất kỳ ở /platform/org/<mã>.",
  // Sổ kinh tế SaaS (0203) — Owner Cockpit /platform/saas.
  "lib/platform/saas-cockpit.ts::loadOwnerCockpit": "Owner Cockpit: MRR / biến động / biên lợi nhuận / kích hoạt của MỌI tổ chức — chụp ảnh hôm nay (mở CSDL từng tổ chức khách để đọc mốc kích hoạt) rồi đọc sổ.",
  "lib/platform/saas-ledger.ts::setPlatformCostDeclaration": "Khai chi phí hạ tầng / hỗ trợ khách theo tháng của nền tảng — mẫu số biên lợi nhuận; bắt buộc căn cứ, nhật ký nền tảng.",
  // Nền móng giá & thu phí (0222) — cấu hình gói, ghi đè theo tổ chức, Margin Guard, kinh tế đơn vị.
  "lib/pricing/admin.ts::setPlanCommercial": "Sửa tên / hạn mức tháng / tính năng / chính sách vượt của một gói — bắt buộc lý do, nhật ký PLAN_COMMERCIAL_SET.",
  "lib/pricing/admin.ts::setOrgPricing": "Ghi đè tính năng / hạn mức / mức áp / cờ giữ từ trước của MỘT tổ chức — bắt buộc lý do, nhật ký ORG_PRICING_SET.",
  "lib/pricing/admin.ts::setPricingGuard": "Ngưỡng Margin Guard + công tắc trần cứng của cả nền tảng — bắt buộc lý do, nhật ký PRICING_GUARD_SET.",
  "lib/pricing/admin.ts::setPricingMargin": "Dải biên lãi gộp chiếu (đích · cảnh báo · nguy cấp) của nền tảng — bắt buộc lý do, nhật ký nền tảng.",
  "lib/pricing/price-book.ts::setOrgPriceVersion": "Chuyển MỘT tổ chức sang một phiên bản giá (0228) — bắt buộc lý do, nhật ký PRICE_VERSION_PIN.",
  "lib/pricing/admin.ts::setAiUnitPrices": "Bảng giá đơn vị AI ghi đè (ƯỚC TÍNH) — bắt buộc lý do, nhật ký AI_UNIT_PRICES_SET.",
  "lib/pricing/admin.ts::loadPricingAdmin": "Cấu hình gói + ghi đè của MỌI tổ chức (màn người vận hành).",
  "lib/pricing/admin.ts::loadPricingEconomics": "Kinh tế đơn vị + Margin Guard của MỌI tổ chức: sổ AI toàn nền tảng + đếm số dùng trong CSDL từng tổ chức khách (lib/platform/usage-meter.ts).",
  "lib/billing/provider.ts::cancelSepaySubscription": "Cổng thu tiền: người vận hành dừng thuê bao của MỘT tổ chức (huỷ hoá đơn đang mở qua voidInvoice).",
  // SaaS Control Plane (0224, lib/saas/console.ts) — mặt phẳng điều khiển của CSDL nhà; cấp workspace qua provisionOrganization.
  "lib/saas/console.ts::loadCustomersConsole": "Danh sách MỌI tài khoản khách: thuê bao, dùng, chi phí, biên, bảng kê nháp (/platform/customers).",
  "lib/saas/console.ts::loadCustomerDetail": "MỘT tài khoản khách bất kỳ: workspace, entitlement, nhật ký, job, bảng kê, chi phí (/platform/customers/<mã>).",
  "lib/saas/console.ts::loadProductsConsole": "Kinh tế theo sản phẩm trên MỌI khách (/platform/products).",
  "lib/saas/console.ts::createCustomerAsOperator": "Tạo khách qua job cấp phát (tài khoản + workspace + CSDL + thuê bao + quản trị) rồi tạo liên kết kích hoạt.",
  "lib/saas/console.ts::resendActivationAsOperator": "Gửi lại liên kết kích hoạt cho quản trị khách CHƯA kích hoạt (người nhận do máy chủ tra từ workspace, không từ trình duyệt) — qua createResetLinkAsOperator: thu hồi liên kết cũ, chỉ băm trong CSDL, lý do bắt buộc, nhật ký nền tảng.",
  "lib/saas/console.ts::subscribeProductAsOperator": "Thuê thêm sản phẩm cho một workspace bất kỳ (job: bật module + mở thuê bao).",
  "lib/saas/console.ts::changeSubscriptionAsOperator": "Tạm dừng / tiếp tục / huỷ (job: tắt module độc quyền) thuê bao của một workspace bất kỳ.",
  "lib/saas/console.ts::retryProvisioningAsOperator": "Chạy lại một job cấp phát hỏng / treo.",
  "lib/saas/console.ts::updateAccountAsOperator": "Sửa tài khoản khách (loại, cách lập chứng từ, trạng thái, hồ sơ pháp nhân) — bắt buộc lý do.",
  "lib/saas/console.ts::moveWorkspaceAsOperator": "Chuyển workspace sang tài khoản khác (cách gộp hai tài khoản) — bắt buộc lý do.",
  "lib/saas/console.ts::reconcileSubscriptionsAsOperator": "Mở thuê bao còn thiếu cho sản phẩm workspace đang bật module (chỉ thêm).",
  "lib/saas/console.ts::addCostEntryAsOperator": "Ghi khoản chi phí ngoài AI có căn cứ phân bổ.",
  "lib/saas/console.ts::voidCostEntryAsOperator": "Huỷ khoản chi phí (giữ dòng, lý do bắt buộc).",
  "lib/saas/console.ts::finalizeStatementAsOperator": "Chốt bảng kê kỳ đã qua của một tài khoản (bất biến).",
  // «AI của workspace» (07/10/2026, lib/saas/operator-ai.ts) — khách không còn ô cấu hình AI; người vận hành sửa trong CSDL tổ chức đích.
  "lib/saas/operator-ai.ts::loadOperatorOrgAiConfig": "Đọc động cơ AI của chatbot + trạng thái khoá AI (không gợi ý, không bản mã) trong CSDL của MỘT tổ chức khách.",
  "lib/saas/operator-ai.ts::saveOrgChatbotEngine": "Đổi nguồn AI / model / dự phòng của chatbot một tổ chức khách — bắt buộc lý do, nhật ký tổ chức + nền tảng AI_ORG_CONTROL_SET.",
  "lib/saas/operator-ai.ts::operateOrgAiConnection": "Lưu / Kiểm tra / Bật / Tắt khoá AI của một tổ chức khách qua lõi sổ kết nối — bắt buộc lý do, nhật ký tổ chức + nền tảng.",
  // Tín hiệu vận hành (sứ mệnh saas-ops-signals, lib/platform/ops-signals.ts) — CHỈ ĐỌC CSDL nhà, không mở CSDL tổ chức nào.
  "lib/platform/ops-signals.ts::loadOpsSignalsForOrgs": "Tám tín hiệu vận hành (sự cố 24 giờ / 7 ngày) của NHIỀU tổ chức trong MỘT câu ở CSDL nhà: gương sức khoẻ, sổ lỗi đăng nhập (định danh đã che), sổ AI — cho danh sách khách.",
  "lib/platform/ops-signals.ts::loadOrgOpsSignals": "Khung «Sự cố 24 giờ / 7 ngày» của MỘT tổ chức ở /platform/org/<mã> — đi qua loadOpsSignalsForOrgs (cùng cổng, cùng câu).",
  // Cổng «nối thẳng Facebook» (review #706, 09/10/2026) — không phải cửa vận hành: chỉ quyết VẼ nút thật hay ô «sắp mở».
  "lib/channels/direct-connect.ts::directConnectFor": "Người vận hành nền tảng luôn thấy nút nối thẳng Facebook thật; người khác: đọc cờ meta.direct-connect.open ở CSDL nhà (CHỈ ĐỌC, so với mã tổ chức của PHIÊN) — hỏi platformOperatorDenial trước lượt đọc cờ.",
};

const DOC_PHIEN = new Set(["requireUser", "requirePermission", "getCurrentUser", "resolveCurrentUser", "getSession"]);

/** Vị trí `await` đầu tiên KHÔNG phải đọc phiên trong thân hàm, kèm tên hàm được await (hoặc `null`). */
function awaitKhongPhaiPhien(than: string): { i: number; ten: string | null } {
  for (const k of than.matchAll(/\bawait\b\s*(?:\(\s*)?([\w.$]+)?/g)) {
    const ten = k[1] ?? null;
    if (ten && DOC_PHIEN.has(ten)) continue;
    return { i: k.index ?? 0, ten };
  }
  return { i: -1, ten: null };
}

/** Thân `than` hỏi người vận hành trước lượt đọc / ghi đầu tiên (trực tiếp, hoặc qua hàm cục bộ `kb` tự hỏi trước). */
function hoiVanHanhTruoc(than: string, kb: Map<string, KhaiBao>, sau = 0): boolean {
  const hoi = than.indexOf("platformOperatorDenial(");
  const dau = awaitKhongPhaiPhien(than);
  if (hoi >= 0 && (dau.i < 0 || hoi < dau.i)) return true;
  const cucBo = dau.ten ? kb.get(dau.ten) : undefined;
  return Boolean(cucBo && sau < 3 && hoiVanHanhTruoc(cucBo.than, kb, sau + 1));
}

export function testLoiVanHanhHoiTruoc(): number {
  const pham: string[] = [];
  const thay = new Set<string>();
  for (const tep of tepMa(["lib/"])) {
    const m = ma(tep);
    if (!m.includes("platformOperatorDenial(") || /^\s*["']use server["']/.test(readFileSync(path.join(goc, tep), "utf8"))) continue;
    const kb = khaiBaoCapCao(m);
    for (const [ten, k] of kb) {
      if (!k.xuat || !k.laHam) continue;
      const truc = k.than.includes("platformOperatorDenial(");
      const quaCucBo = !truc && hoiVanHanhTruoc(k.than, kb);
      if (!truc && !quaCucBo) continue;
      const khoa = `${tep}::${ten}`;
      thay.add(khoa);
      if (!LOI_VAN_HANH[khoa]) pham.push(`${khoa}: lõi vận hành mới — khai vào LOI_VAN_HANH`);
      if (!hoiVanHanhTruoc(k.than, kb)) pham.push(`${khoa}: đọc / ghi (await ${awaitKhongPhaiPhien(k.than).ten ?? "?"}) TRƯỚC khi hỏi platformOperatorDenial`);
    }
  }
  const matCau = Object.keys(LOI_VAN_HANH).filter((k) => !thay.has(k));
  assert.deepEqual(pham, [], "S21: lõi của người vận hành phải hỏi platformOperatorDenial(user) TRƯỚC lượt đọc / ghi đầu tiên — vỏ action chỉ là lớp thứ nhất");
  assert.deepEqual(matCau, [], "S21: lõi vận hành đã khai mà không còn hỏi platformOperatorDenial (hoặc đã đổi tên) — cửa nhìn xuyên tổ chức không được mất câu hỏi");
  khongMienTruMoCoi("S21", LOI_VAN_HANH, thay);

  // 3 · Vỏ action qua platform:operate gọi đúng một lõi đã khai (hoặc requireOperator tự hỏi).
  const tenLoi = Object.keys(LOI_VAN_HANH).map((k) => k.split("::")[1]);
  const vo: string[] = [];
  let soVo = 0;
  for (const tep of tepServerAction()) {
    const kb = khaiBaoCapCao(ma(tep));
    const gateCucBo = kb.get("requireOperator");
    for (const [ten, k] of kb) {
      if (!k.xuat || !k.laHam) continue;
      const quaVanHanh = /requirePermission\(\s*["']platform:operate["']\s*\)/.test(k.than);
      const quaGate = /\brequireOperator\(/.test(k.than);
      if (!quaVanHanh && !quaGate) continue;
      soVo += 1;
      if (quaGate && gateCucBo && gateCucBo.than.includes("platformOperatorDenial(")) continue;
      if (!tenLoi.some((n) => new RegExp(`\\b${n}\\(`).test(k.than))) vo.push(`${tep}::${ten}`);
    }
  }
  assert.ok(soVo >= 10, `phải thấy các cửa vận hành đã biết (pilot, công tắc, AI, module, mã mời) — mới thấy ${soVo}: bộ dò có thể đã mù`);
  assert.deepEqual(vo, [], "S21: server action qua platform:operate phải gọi một lõi trong LOI_VAN_HANH (lõi tự hỏi lại người vận hành)");

  // 4 · Sổ AI theo mã tổ chức: chỉ gọi ở chỗ khai; /settings/plan lấy mã từ PHIÊN.
  const DOC_SO_AI: Record<string, string> = {
    "app/(dashboard)/settings/plan/page.tsx": "Gói & hạn mức: mã tổ chức = getPlanUsage(user.organization?.code) — PHIÊN, trang không nhận tham số.",
    "lib/platform/support.ts": "Ô Dùng AI của trang sức khoẻ — sau platformOperatorDenial của loadOrgSupport.",
    "lib/ai-usage/view.ts": "loadOperatorOrgAi — sau platformOperatorDenial.",
  };
  const goiSoAi: string[] = [];
  const daDungSoAi = new Set<string>();
  for (const tep of tepMa(["lib/", "app/", "components/"])) {
    if (!/\bloadOrgAiUsage\(/.test(ma(tep).replace(/export async function loadOrgAiUsage\(/, ""))) continue;
    if (DOC_SO_AI[tep]) daDungSoAi.add(tep);
    else goiSoAi.push(tep);
  }
  assert.deepEqual(goiSoAi, [], "S21: loadOrgAiUsage(mã) không hỏi người — chỉ gọi ở chỗ khai (mã tổ chức từ PHIÊN hoặc sau cổng người vận hành)");
  khongMienTruMoCoi("S21 · sổ AI", DOC_SO_AI, daDungSoAi);

  // 4b · Sổ Số dư AI của MỌI tổ chức (`readAiBalancePeriod`) không hỏi người — chỉ gọi ở chỗ khai, sau cổng người vận hành
  //      (review #648 L6). Bản đọc MỘT tổ chức (`readAiCustomerChargedUnits`) chỉ với mã tổ chức của PHIÊN.
  const DOC_SO_DU_AI: Record<string, string> = {
    "lib/pricing/admin.ts": "loadPricingEconomics — sau platformOperatorDenial.",
    "lib/platform/saas-cockpit.ts": "loadOwnerCockpit — sau platformOperatorDenial (doanh thu Số dư AI 30 ngày của cockpit).",
    "lib/saas/customers.ts": "loadCommercialSnapshot — chỉ lib/saas/console.ts (sau cổng vận hành), finalizeStatement (lõi chốt bảng kê của người vận hành) và lượt chụp sức khoẻ theo ngày của JOB nhà (lib/saas/tenant-health-daily.ts, không người dùng, không trang nào gọi) gọi.",
    "lib/pricing/customer.ts": "loadCustomerPlan(mã) — readAiCustomerChargedUnits với mã từ PHIÊN (/settings/plan: usage.orgCode của user.organization).",
    "lib/billing/prepaid-ai.ts": "planPrepaidAi(mã) — readAiCustomerChargedUnits của MỘT tổ chức cho kế hoạch trả trước; chỉ script ops org-prepaid-ai (người vận hành nền tảng chạy qua ops-vps, kết quả MÃ HOÁ) gọi — không server action / trang nào (tests/org-prepaid-ai.test.ts quét).",
    "lib/saas/tenant-value-capture.ts": "captureTenantValue — lượt chụp ảnh giá trị theo tổ chức (0240) của JOB nhà, không có người dùng: chỉ captureSaasSnapshot (nhánh source JOB) gọi, không trang / action nào (tests/saas-value-snapshots.test.ts quét); kết quả chỉ ghi vào CSDL nhà cho người vận hành đọc.",
  };
  const goiSoDu: string[] = [];
  const daDungSoDu = new Set<string>();
  for (const tep of tepMa(["lib/", "app/", "components/"])) {
    const code = ma(tep).replace(/export async function (readAiBalancePeriod|readAiCustomerChargedUnits)\(/g, "");
    if (!/\b(readAiBalancePeriod|readAiCustomerChargedUnits)\(/.test(code)) continue;
    if (DOC_SO_DU_AI[tep]) daDungSoDu.add(tep);
    else goiSoDu.push(tep);
  }
  assert.deepEqual(goiSoDu, [], "S21: sổ Số dư AI theo tổ chức chỉ đọc ở chỗ khai (sau cổng người vận hành, hoặc mã tổ chức từ PHIÊN)");
  khongMienTruMoCoi("S21 · sổ Số dư AI", DOC_SO_DU_AI, daDungSoDu);

  // 4c · Trạng thái kích hoạt quản trị khách (`lib/saas/activation.ts`, 08/10/2026) mở CSDL của workspace KHÁC (users + liên kết đặt
  //      mật khẩu) mà không hỏi người — chỉ gọi ở chỗ khai, sau cổng người vận hành (review #681 L5).
  const DOC_KICH_HOAT: Record<string, string> = {
    "lib/saas/console.ts": "loadCustomerDetail · createCustomerAsOperator · resendActivationAsOperator — cả ba hỏi platformOperatorDenial trước lượt đọc đầu tiên (LOI_VAN_HANH).",
    "lib/saas/activation.ts": "Tệp định nghĩa: loadWorkspaceActivation gọi loadAdminActivations trong cùng tệp, không nơi nào khác.",
    "lib/saas/acceptance.ts": "ops nghiệm thu (máy trong container, không phiên người): chỉ đọc trạng thái kích hoạt của workspace THỬ trong sổ khai lib/constants/saas-acceptance.ts, SAU lá chắn sổ khai (mã ngoài sổ ⇒ từ chối trước mọi lượt đọc) và kiểm sở hữu (job khoá saas-acceptance:<mã>) — mã không bao giờ đến từ người dùng.",
  };
  const goiKichHoat: string[] = [];
  const daDungKichHoat = new Set<string>();
  for (const tep of tepMa(["lib/", "app/", "components/", "scripts/", "chatbot/"])) {
    const code = ma(tep).replace(/export async function (loadAdminActivations|loadWorkspaceActivation)\(/g, "");
    if (!/\b(loadAdminActivations|loadWorkspaceActivation)\(/.test(code)) continue;
    if (DOC_KICH_HOAT[tep]) daDungKichHoat.add(tep);
    else goiKichHoat.push(tep);
  }
  assert.deepEqual(goiKichHoat, [], "S21: trạng thái kích hoạt quản trị khách đọc CSDL workspace khác — chỉ gọi sau cổng người vận hành (lib/saas/console.ts)");
  khongMienTruMoCoi("S21 · kích hoạt quản trị khách", DOC_KICH_HOAT, daDungKichHoat);
  assert.match(ma("lib/saas/console.ts"), /platformOperatorDenial\(/, "S21: bảng điều khiển SaaS (người gọi loadCommercialSnapshot) hỏi người vận hành");
  const plan = ma("app/(dashboard)/settings/plan/page.tsx");
  assert.ok(!/\b(?:searchParams|params)\b/.test(plan) && /getPlanUsage\(\s*user\.organization\?\.code\s*\)/.test(plan) && /loadOrgAiUsage\(\s*usage\.orgCode\s*\)/.test(plan), "S21: /settings/plan lấy mã tổ chức từ PHIÊN (user.organization) — không từ params / searchParams");

  // 5 · Cờ tạm dừng luật chỉ công tắc khẩn ghi.
  const ghiCo = tepMa(["lib/", "app/", "scripts/"]).filter((t) => /\bwriteOrgFlag\(/.test(ma(t)) && t !== "lib/platform/org-flags.ts" && t !== "lib/platform/kill-switches.ts");
  assert.deepEqual(ghiCo, [], "S21: writeOrgFlag chỉ được gọi từ lib/platform/kill-switches.ts (quyền vận hành + lý do + nhật ký nền tảng)");

  // Tự kiểm bộ dò.
  const kbThu = khaiBaoCapCao("async function parseCommon(user) {\n  const denial = platformOperatorDenial(user);\n  return denial;\n}\nexport async function tat(user) {\n  const p = await parseCommon(user);\n  await ghi();\n}\nexport async function sai(user) {\n  await ghi();\n  const d = platformOperatorDenial(user);\n}\n");
  assert.equal(hoiVanHanhTruoc(kbThu.get("tat")!.than, kbThu), true, "hỏi qua hàm cục bộ");
  assert.equal(hoiVanHanhTruoc(kbThu.get("sai")!.than, kbThu), false, "ghi trước khi hỏi");
  return Object.keys(LOI_VAN_HANH).length;
}

export function testPlatformIsolationStatic() {
  testKhongKetNoiCsdlThuHai();
  testHolderGlobalDaKhai();
  testSingletonTichHopDaKhai();
  testAfterMangToChuc();
  testMocPhienChiTrongKiemThu();
  testWebhookBocToChuc();
  testLoiGoiMangChanCredential();
  testBusKhongRoToChuc();
  testKhongGiaTienToDem();
  testMigrationKhongCanQuyenCum();
  testKhongIdNgoaiLamMacDinh();
  testCsdlChiDinhChiONenTang();
  testRouteApiQuaApiGuard();
  const soAction = testServerActionQuaCongPhien();
  testServerActionKhongChonToChuc();
  const soLoi = testLoiVanHanhHoiTruoc();
  console.log(
    `✓ Nền tảng · máy quét cô lập mức tiến trình: kết nối CSDL, holder globalThis, singleton, after(), webhook, credential, bus, tiền tố đệm, migration, mặc định ID, CSDL chỉ định chỉ ở mã nền tảng, route API qua apiGuard hoặc khai công khai kèm cổng riêng, ${soAction} server action hỏi phiên trước lượt đọc/ghi đầu tiên, không action nào chọn CSDL theo mã tổ chức của client, ${soLoi} lõi vận hành hỏi người vận hành trước lượt đọc/ghi đầu tiên (S21), sổ AI theo mã tổ chức chỉ đọc từ phiên / sau cổng vận hành`,
  );
}

// Chạy được độc lập, và cũng export để bộ kiểm thử chung dùng lại.
if (process.argv[1] && /platform-isolation-static\.test\.ts$/.test(process.argv[1])) testPlatformIsolationStatic();
