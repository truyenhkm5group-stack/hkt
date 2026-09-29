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
  "lib/onboarding/signup-mode.ts::__erpSignupSetting": { loai: "NEN_TANG", lyDo: "Đệm ≤ 10 giây của MỘT cài đặt nền tảng (chế độ đăng ký /start, CSDL nhà) — không thuộc tổ chức nào, không chứa dữ liệu nghiệp vụ; lượt ghi xoá đệm ngay." },
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
  "lib/landing/sheet.ts": "CSV công khai của Google Sheet, URL đọc từ `settings` của CHÍNH tổ chức đang chạy — không có credential môi trường.",
  "lib/actions/workshop-ledger.ts": "Link Google Sheet công khai do người dùng dán vào form — không có credential môi trường.",
  "lib/creative/import.ts": "Tải ảnh từ một URL công khai (http/https) — không gắn khoá nào vào request.",
  "lib/ai-builder/providers.ts":
    "Provider AI BYOK của AI Builder (Phase 8): khoá là `apiKey` TƯỜNG MINH do lib/connectors/service.ts giải mã từ org_connections của CHÍNH tổ chức đang chạy; `authToken` / `organization` / `project` đặt null và `baseURL` là hằng, nên không biến môi trường nào của tổ chức nhà lọt vào. Đường của tổ chức nhà đi qua `getAiProvider` (lib/ai/provider.ts — đã gọi assertHomeCredentials).",
  "lib/connectors/testers.ts":
    "Kiểm tra kết nối THEO TỔ CHỨC (Phase 9): bí mật do lib/connectors/service.ts giải mã từ org_connections của CHÍNH tổ chức đang chạy — không đọc biến môi trường nào; đích chỉ là máy chủ Lark / api.telegram.org, không theo chuyển hướng.",
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
  "lib/queries/platform-health.ts": "Máy quét sức khoẻ nền tảng: mở CSDL TỪNG tổ chức để đếm migration và bảng platform_* — việc của nó là nhìn sang mọi tổ chức.",
  "lib/queries/platform-org-diagnostics.ts": "Chẩn đoán MỘT tổ chức cho người vận hành nền tảng (/platform/org/<mã>, Phase 11 · H4): mở CSDL của tổ chức được chọn để ĐẾM (chỉ SELECT), kiểm platformOperatorDenial trước mọi truy vấn.",
  "app/api/health/route.ts": "Tuyến sức khoẻ công khai của lượt deploy: đọc mặt phẳng điều khiển (cờ + số đếm, không mã tổ chức nào) — không có phiên để đi qua ngữ cảnh.",
  "lib/onboarding/": "Tự phục vụ (Phase 10): mã mời, lượt đăng ký, trạng thái dựng tổ chức — mặt phẳng điều khiển (CSDL nhà); dữ liệu của tổ chức mới chỉ chạm qua provisionOrganization + withOrganization.",
  "scripts/platform-load-probe.ts": "Script ĐO TẢI chạy tay (Phase 11 · H2), không nằm trong đường chạy của ứng dụng: cấp rồi GỠ năm tổ chức thử `lprobe-*` của chính nó ở mặt phẳng điều khiển (CSDL nhà); dữ liệu của tổ chức chỉ chạm qua provisionOrganization + withOrganization + getDb().",
  "scripts/restore-drill-org-config.ts": "Script DIỄN TẬP KHÔI PHỤC tầng cấu hình chạy tay / trong bài kiểm (sẵn sàng thương mại C), không nằm trong đường chạy của ứng dụng: trên PGlite RIÊNG của chính nó (không đọc .env), cấp một tổ chức thử, xoá rồi cấp lại dòng sổ ở mặt phẳng điều khiển; dữ liệu của tổ chức chỉ chạm qua provisionOrganization + withOrganization + getDb().",
  "lib/entitlements/": "Gói + hạn mức (Phase 10): đọc bảng platform_plans ở CSDL nhà; bộ đếm mức dùng vẫn đi getDb() của tổ chức ngữ cảnh.",
};

export function testCsdlChiDinhChiONenTang() {
  const pham: string[] = [];
  const daDung = new Set<string>();
  let dem = 0;
  for (const tep of tepMa(["lib/", "app/", "db/", "scripts/", "components/", "chatbot/", "middleware.ts", "instrumentation"])) {
    if (!/\b(?:getPlatformDb|getDbFor|getDbForInspection)\b/.test(ma(tep))) continue;
    dem += 1;
    const khoa = Object.keys(CSDL_CHI_DINH_DUOC_PHEP).find((k) => (k.endsWith("/") ? tep.startsWith(k) : tep === k));
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
  "app/api/webhooks/": {
    lyDo: "Webhook máy-gọi-máy: xác thực bằng bí mật trong URL / chữ ký của nhà cung cấp và phân giải tổ chức qua resolveWebhookOrganization (S11) — không có phiên người dùng để đi qua.",
    cong: /\bresolveWebhookOrganization\(/,
  },
  "app/api/health/route.ts": { lyDo: "Tuyến sức khoẻ công khai của lượt deploy: chỉ trả cờ + số đếm của mặt phẳng điều khiển, không một dòng nghiệp vụ nào.", cong: null },
  "app/api/sync/organizations/route.ts": { lyDo: "Bộ lập lịch hỏi danh sách mã tổ chức để phân tán job — chỉ nhận CRON_SECRET, không phiên.", cong: /\bsecretEquals\(/ },
  "app/api/tech/agent-run/route.ts": { lyDo: "Máy chạy agent nộp kết quả — khoá riêng AGENT_INGEST_SECRET hoặc CRON_SECRET, có trần lượt gọi.", cong: /\bsecretEquals\(/ },
  "app/api/tech/agent-task/route.ts": { lyDo: "Máy chạy agent đọc việc được giao — cùng khoá với cửa ghi, có trần lượt gọi.", cong: /\bsecretEquals\(/ },
  "app/api/video-scale/public/[id]/route.ts": { lyDo: "URL tệp video Meta tải về để đăng Reel — không có phiên; mỗi URL mang chữ ký HMAC có hạn, sai / hết hạn ⇒ 404.", cong: /\bverifyAssetSignature\(/ },
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
  "lib/actions/onboarding.ts::createOrganizationAction": "Tạo tổ chức từ /start: cổng là cờ + mã mời + trần IP trong lõi; mã đã có chủ ⇒ «đã có người dùng», chỉ đúng chủ (cùng mã mời / người vận hành) mới chạy lại.",
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
  "lib/actions/platform-modules.ts::toggleModuleForOrgAction": { loai: "VAN_HANH", lyDo: "Người vận hành nền tảng bật/tắt module của tổ chức khác từ /platform — requirePermission(platform:operate) + platformOperatorDenial (chỉ tổ chức nhà), ghi nhật ký nền tảng kèm lý do." },
  "lib/actions/onboarding.ts::retrySetupAction": { loai: "VAN_HANH", lyDo: "Người vận hành chạy lại việc dựng một tổ chức SETUP_FAILED — requireOperator (platform:operate + tổ chức nhà)." },
  "lib/actions/onboarding.ts::checkOrgAction": { loai: "CONG_KHAI", lyDo: "Mã tổ chức ĐỀ XUẤT cho tổ chức sắp tạo — chỉ kiểm trùng ở sổ tổ chức, không mở CSDL nào." },
  "lib/actions/onboarding.ts::previewSignupAction": { loai: "CONG_KHAI", lyDo: "Mã tổ chức đi cùng mã mời để tra mã mời đã gắn đúng tổ chức — xem trước chạy trên tổ chức TRẮNG tưởng tượng." },
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
  console.log(
    `✓ Nền tảng · máy quét cô lập mức tiến trình: kết nối CSDL, holder globalThis, singleton, after(), webhook, credential, bus, tiền tố đệm, migration, mặc định ID, CSDL chỉ định chỉ ở mã nền tảng, route API qua apiGuard hoặc khai công khai kèm cổng riêng, ${soAction} server action hỏi phiên trước lượt đọc/ghi đầu tiên, không action nào chọn CSDL theo mã tổ chức của client`,
  );
}

// Chạy được độc lập, và cũng export để bộ kiểm thử chung dùng lại.
if (process.argv[1] && /platform-isolation-static\.test\.ts$/.test(process.argv[1])) testPlatformIsolationStatic();
