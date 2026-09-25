import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import { schema, type Db } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import {
  maskUrls,
  OWNER_DIGEST_VIEWER_ID,
  ownerDigestViewer,
  resetOwnerDigestThrottle,
  runOwnerDecisionDigest,
  type OwnerDigestDeps,
} from "@/lib/alerts/owner-decision-digest";
import {
  decideOwnerDecisionDigest,
  digestCandidates,
  digestChip,
  EMPTY_OWNER_DIGEST_LEDGER,
  OWNER_DIGEST_CONFIG_KEY,
  OWNER_DIGEST_LEDGER_KEY,
  OWNER_DIGEST_RULE,
  OWNER_DIGEST_URGENT_KINDS,
  ownerDigestMorningDone,
  parseOwnerDigestLedger,
  type OwnerDigestLedger,
  type OwnerDigestMessage,
  type OwnerDigestQueue,
} from "@/lib/constants/owner-digest";
import { OWNER_DECISION_KINDS, type DecoratedItem, type OwnerDecisionItem, type OwnerDecisionKind, type RecommendationDecisionRow } from "@/lib/constants/owner-decisions";
import { recordRecommendationDecisionCore } from "@/lib/owner-decisions/service";
import { getOwnerDecisionQueue, viewerKinds, type SourceLoader } from "@/lib/queries/owner-decisions";
import { setSettingJson } from "@/lib/settings";
import { MORNING_BRIEF_HOUR_VN } from "@/lib/work/morning-brief";

/**
 * ═══════════ COMPANY OS · AGENT L · "CẦN ANH QUYẾT" → NHÓM LARK QUẢN LÝ ═══════════
 *
 * Bài khoá:
 *  1. Một bản sáng mỗi NGÀY GIỜ VIỆT NAM; ranh giới ngày suy ra từ `now` truyền vào (không đồng hồ thật —
 *     luật 50, 65): 01:00 VN ngày mới vẫn là 18:00 UTC hôm trước, và phải được coi là NGÀY MỚI.
 *  2. Tin thêm trong ngày CHỈ cho dòng MỚI thuộc loại gấp (yêu cầu duyệt, mẫu chờ duyệt) — quảng cáo /
 *     tồn nhúc nhích không kích tin; hai tin thêm cách nhau ≥ minGap.
 *  3. Dòng BỎ QUA / HẸN NHẮC (dòng mới nhất của sổ phản ứng) không vào tin — cả ở hàm thuần lẫn đường
 *     thật qua `getOwnerDecisionQueue` + `recommendation_decisions`.
 *  4. Hàng đợi rỗng ⇒ không gửi; tắt ⇒ không gửi (và không đọc hàng đợi); chạy lại cùng phút ⇒ không gửi
 *     trùng; hai lượt SONG SONG ⇒ đúng một tin; gửi hỏng ⇒ không ghi "đã gửi", lượt sau thử lại.
 *  5. Tin không mang URL webhook / khoá ký, không mang tiền (không "₫" ở đâu trong tin), không mang email.
 *  6. Người xem máy = bộ quyền mẫu MANAGER: không có quyền lương / quản trị người dùng.
 *
 * Đường gửi Lark LUÔN là hàm giả — bài này không gọi mạng.
 */

const P = "cosl-";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY_MS = 24 * HOUR;
const APP = "https://erp.test.local";
const FAKE_URL = "https://open.larksuite.com/open-apis/bot/v2/hook/FAKE-cosl-0000";
const FAKE_SECRET = "cosl-khoa-ky-gia";

/** Mốc của phần thuần: hàm thuần chỉ đọc `now` truyền vào, nên một mốc cố định là đủ và ổn định. */
const BASE = new Date(Date.UTC(2026, 0, 5, 1, 0)); // 08:00 giờ VN
const at = (ms: number) => new Date(BASE.getTime() + ms);

function it(kind: OwnerDecisionKind, key: string, extra: Partial<OwnerDecisionItem> = {}): OwnerDecisionItem {
  return {
    kind,
    sourceKey: key,
    what: `Việc ${key}`,
    why: "vì kiểm thử — người xin nv@cong-ty.test",
    data: [
      { label: "Tiền", value: "5.000.000 ₫" },
      { label: "Mã", value: `M-${key}` },
    ],
    impact: { amountVnd: 5_000_000, basis: "kiểm thử" },
    action: { label: "Mở", href: "/x" },
    modelId: null,
    ...extra,
  };
}

function dec(i: OwnerDecisionItem, latest: RecommendationDecisionRow | null = null): DecoratedItem {
  return { ...i, latest };
}

function row(sourceKey: string, decision: RecommendationDecisionRow["decision"], decidedAt: Date, snoozeUntil: Date | null = null): RecommendationDecisionRow {
  return { id: `${sourceKey}:${decision}`, sourceKey, kind: "APPROVAL", decision, reason: decision === "DISMISSED" ? "không hợp lý" : "", snoozeUntil, decidedByUserId: "u", decidedBy: "U", decidedAt };
}

function q(visible: DecoratedItem[], hidden: DecoratedItem[] = [], extra: Partial<OwnerDigestQueue> = {}): OwnerDigestQueue {
  return { groups: [{ items: visible }], hidden, kinds: [...OWNER_DECISION_KINDS], failed: [], ...extra };
}

const ON = { enabled: true, appUrl: APP };

function allText(m: OwnerDigestMessage | null): string {
  if (!m) return "";
  return [m.title, ...m.lines.flatMap((l) => l.map((p) => `${p.text} ${p.href ?? ""}`))].join("\n");
}

const APPROVAL_1 = it("APPROVAL", `approval:${P}a1`, { what: "Duyệt · Chi phí thuê kho · 5000000đ · nhân sự NV-042" });
const SAMPLE_1 = it("SAMPLE_REVIEW", `sample:${P}s1`, { what: "Q005 · mẫu V2 chờ duyệt", data: [{ label: "Gửi duyệt", value: "05/01/2026" }] });
const INV_1 = it("INVENTORY_STOCKOUT", `inventory:STOCKOUT_RISK:${P}v1`, { what: "Q005 · Đen/M · Nguy cơ hết hàng" });
const ADS_1 = it("ADS_CUT", `ads:CUT:campaign:${P}c1:ACTUAL`, { what: "Cắt · Chiến dịch Q005" });

export function testCompanyOsOwnerDigestPure() {
  // ─── Hằng số khớp bản tin sáng; loại gấp đúng hai loại ───
  assert.equal(OWNER_DIGEST_RULE.morningHourVN, MORNING_BRIEF_HOUR_VN, "giờ bắt đầu gửi phải CÙNG giờ bản tin sáng — hai số ở hai nơi là mở đường cho hai giờ khác nhau");
  assert.deepEqual([...OWNER_DIGEST_URGENT_KINDS].sort(), ["APPROVAL", "SAMPLE_REVIEW"], "chỉ yêu cầu duyệt và mẫu chờ duyệt là gấp tự nhiên");
  assert.deepEqual(parseOwnerDigestLedger("rác{"), EMPTY_OWNER_DIGEST_LEDGER, "sổ hỏng không làm sập job");

  const full = q([dec(APPROVAL_1), dec(SAMPLE_1), dec(INV_1), dec(ADS_1)]);

  // ─── Tắt ⇒ không gửi ───
  const off = decideOwnerDecisionDigest(null, full, BASE, { enabled: false, appUrl: APP });
  assert.equal(off.send, false);
  assert.equal(off.reason, "DISABLED");

  // ─── Hàng đợi rỗng ⇒ không gửi; ghi "đã xét hôm nay" — trừ khi rỗng vì nguồn hỏng ───
  const empty = decideOwnerDecisionDigest(null, q([]), BASE, ON);
  assert.equal(empty.send, false);
  assert.equal(empty.reason, "EMPTY");
  assert.equal(empty.nextState.day, "2026-01-05", "rỗng lúc sáng ⇒ ngày đã xét, dòng không gấp xuất hiện sau đó không kích tin");
  const emptyFailed = decideOwnerDecisionDigest(null, q([], [], { failed: [{ label: "Quyết định vốn tồn" }] }), BASE, ON);
  assert.equal(emptyFailed.send, false);
  assert.equal(emptyFailed.reason, "SOURCES_FAILED");
  assert.equal(emptyFailed.nextState.day, null, "rỗng vì nguồn hỏng ⇒ KHÔNG ghi ngày, lượt sau đọc lại");

  // ─── Ngoài giờ ⇒ không gửi ───
  assert.equal(decideOwnerDecisionDigest(null, full, at(-2 * HOUR), ON).reason, "OUTSIDE_HOURS", "06:00 VN chưa tới giờ");
  assert.equal(decideOwnerDecisionDigest(null, full, at(14 * HOUR), ON).reason, "OUTSIDE_HOURS", "22:00 VN đã hết giờ");

  // ─── Bản sáng ───
  const m1 = decideOwnerDecisionDigest(null, full, BASE, ON);
  assert.equal(m1.send, true);
  assert.equal(m1.reason, "MORNING");
  assert.equal(m1.keys.length, 4);
  assert.deepEqual(m1.nextState.seen, [APPROVAL_1.sourceKey, SAMPLE_1.sourceKey].sort(), "sổ chỉ giữ khoá loại gấp — loại khác không bao giờ kích tin thêm");
  assert.equal(m1.nextState.day, "2026-01-05");
  const t1 = allText(m1.message);
  assert.ok(m1.message!.title.includes("4 việc"), "tiêu đề mang số việc");
  assert.ok(!/₫|\d\s*đ\b/.test(m1.message!.title), "tiêu đề không mang tiền");
  assert.ok(!t1.includes("₫"), "tin nhóm không in tiền ở bất kỳ đâu (ô số liệu tiền bị bỏ qua)");
  assert.ok(!t1.includes("5000000") && !t1.includes("NV-042"), "yêu cầu duyệt KHÔNG in câu tóm tắt (có thể mang tiền / mã nhân sự)");
  assert.ok(!t1.includes("@"), "không email người xin");
  assert.ok(!t1.includes("open-apis") && !t1.includes("hook") && !t1.includes(FAKE_SECRET), "tin không mang webhook / khoá ký");
  assert.ok(t1.includes(`${APP}/cockpit`), "tin mang link tuyệt đối tới /cockpit");
  assert.ok(t1.includes(`${APP}/cockpit?kind=APPROVAL`), "mỗi loại mở đúng bộ lọc của nó");
  assert.ok(t1.includes("M-" + APPROVAL_1.sourceKey), "mỗi dòng đầu mang MỘT ô số liệu (ô đầu tiên không phải tiền)");
  assert.deepEqual(digestChip([{ label: "Tiền", value: "1 ₫" }, { label: "Trễ", value: null }, { label: "Xưởng", value: "X1" }]), { label: "Xưởng", value: "X1" });

  // Không có APP_URL ⇒ không in link hỏng
  const noUrl = decideOwnerDecisionDigest(null, full, BASE, { enabled: true, appUrl: "" });
  assert.ok(noUrl.message!.lines.every((l) => l.every((p) => p.href === undefined)), "không biết địa chỉ ERP ⇒ không in link tương đối");

  // ─── Chạy lại cùng phút với sổ đã ghi ⇒ không gửi trùng ───
  const again = decideOwnerDecisionDigest(m1.nextState, full, BASE, ON);
  assert.equal(again.send, false, "chạy lại cùng phút không gửi lần hai");
  assert.equal(again.reason, "NO_NEW_URGENT");

  // ─── Trong ngày: tồn / quảng cáo mới KHÔNG kích tin ───
  const INV_2 = it("INVENTORY_REORDER", `inventory:REORDER:${P}v2`);
  const ADS_2 = it("ADS_CUT", `ads:CUT:campaign:${P}c2:ACTUAL`);
  const churn = decideOwnerDecisionDigest(m1.nextState, q([dec(APPROVAL_1), dec(SAMPLE_1), dec(INV_1), dec(INV_2), dec(ADS_2)]), at(2 * HOUR), ON);
  assert.equal(churn.send, false, "tồn / quảng cáo nhúc nhích trong ngày không phải lý do nhắn");

  // ─── Trong ngày: yêu cầu duyệt MỚI ⇒ một tin thêm, chỉ mang dòng mới ───
  const APPROVAL_2 = it("APPROVAL", `approval:${P}a2`);
  const x1 = decideOwnerDecisionDigest(m1.nextState, q([dec(APPROVAL_1), dec(APPROVAL_2), dec(INV_2)]), at(HOUR), ON);
  assert.equal(x1.send, true);
  assert.equal(x1.reason, "NEW_URGENT");
  assert.deepEqual(x1.keys, [APPROVAL_2.sourceKey], "tin thêm chỉ nói dòng MỚI");
  assert.ok(x1.nextState.seen.includes(APPROVAL_2.sourceKey) && x1.nextState.seen.includes(APPROVAL_1.sourceKey));
  assert.ok(!allText(x1.message).includes("₫"));
  // Mẫu chờ duyệt mới cũng gấp
  const SAMPLE_2 = it("SAMPLE_REVIEW", `sample:${P}s2`);
  assert.equal(decideOwnerDecisionDigest(m1.nextState, q([dec(SAMPLE_2)]), at(HOUR), ON).reason, "NEW_URGENT");

  // ─── Khoảng cách tối thiểu giữa hai tin thêm; dòng chưa báo đi cùng tin kế ───
  const APPROVAL_3 = it("APPROVAL", `approval:${P}a3`);
  const gap = decideOwnerDecisionDigest(x1.nextState, q([dec(APPROVAL_3)]), at(HOUR + 10 * MIN), ON);
  assert.equal(gap.send, false);
  assert.equal(gap.reason, "GAP");
  assert.deepEqual(gap.nextState, x1.nextState, "bị hoãn vì khoảng cách ⇒ sổ không đổi, dòng chưa báo vẫn MỚI");
  const later = decideOwnerDecisionDigest(x1.nextState, q([dec(APPROVAL_3)]), at(HOUR + OWNER_DIGEST_RULE.minGapMinutes * MIN), ON);
  assert.equal(later.reason, "NEW_URGENT");

  // ─── BỎ QUA / HẸN NHẮC không vào tin ───
  const dismissed = decideOwnerDecisionDigest(m1.nextState, q([], [dec(APPROVAL_2, row(APPROVAL_2.sourceKey, "DISMISSED", BASE))]), at(HOUR), ON);
  assert.equal(dismissed.send, false, "dòng đã bỏ qua không kích tin");
  // phòng thủ: dòng mang phản ứng BỎ QUA lọt vào nhóm hiện vẫn bị loại (áp lại `applyDecisions`)
  const leaked = decideOwnerDecisionDigest(m1.nextState, q([dec(APPROVAL_2, row(APPROVAL_2.sourceKey, "DISMISSED", BASE))]), at(HOUR), ON);
  assert.equal(leaked.send, false, "áp lại sổ phản ứng ở chính lượt gửi");
  const snoozed = dec(APPROVAL_2, row(APPROVAL_2.sourceKey, "SNOOZED", BASE, at(3 * HOUR)));
  assert.equal(decideOwnerDecisionDigest(m1.nextState, q([], [snoozed]), at(HOUR), ON).send, false, "hẹn nhắc chưa tới ngày ⇒ không vào tin");
  const due = decideOwnerDecisionDigest(m1.nextState, q([], [snoozed]), at(3 * HOUR + MIN), ON);
  assert.equal(due.reason, "NEW_URGENT", "hẹn nhắc TỚI ngày ⇒ hiện lại như chưa ai đụng — và là dòng gấp chưa báo hôm nay");
  const morningDismiss = decideOwnerDecisionDigest(null, q([dec(INV_1)], [dec(APPROVAL_1, row(APPROVAL_1.sourceKey, "DISMISSED", BASE))]), BASE, ON);
  assert.deepEqual(morningDismiss.keys, [INV_1.sourceKey], "bản sáng cũng không mang dòng đã bỏ qua");
  assert.deepEqual(
    digestCandidates(q([dec(APPROVAL_1, row(APPROVAL_1.sourceKey, "ACCEPTED", BASE))]), BASE).map((i) => i.sourceKey),
    [APPROVAL_1.sourceKey],
    "chấp nhận ≠ đã làm: dòng vẫn vào tin",
  );

  // ─── Loại người xem không được thấy ⇒ không vào tin ───
  const narrow = decideOwnerDecisionDigest(null, q([dec(ADS_1), dec(INV_1)], [], { kinds: ["INVENTORY_STOCKOUT"] }), BASE, ON);
  assert.deepEqual(narrow.keys, [INV_1.sourceKey], "tin nhóm không mang loại mà người xem máy (MANAGER) không có quyền");

  // ─── Ranh giới NGÀY GIỜ VIỆT NAM suy từ `now` ───
  const vnMidnightPlus1h = new Date(Date.UTC(2026, 0, 5, 18, 0)); // 01:00 VN ngày 06, UTC vẫn ngày 05
  assert.equal(ownerDigestMorningDone(m1.nextState, vnMidnightPlus1h), false, "01:00 VN là NGÀY MỚI dù UTC còn ngày cũ");
  assert.equal(ownerDigestMorningDone(m1.nextState, new Date(Date.UTC(2026, 0, 5, 16, 59))), true, "23:59 VN vẫn là hôm nay");
  const nextMorning = decideOwnerDecisionDigest(m1.nextState, full, new Date(Date.UTC(2026, 0, 6, 0, 0)), ON);
  assert.equal(nextMorning.reason, "MORNING", "07:00 VN hôm sau ⇒ bản sáng mới");
  assert.equal(nextMorning.nextState.day, "2026-01-06");

  // ─── Lượt đang gửi giữ quyền; quá hạn thì lượt sau lấy lại ───
  const claimed: OwnerDigestLedger = { ...EMPTY_OWNER_DIGEST_LEDGER, claim: { token: "t", at: at(-MIN).toISOString() } };
  assert.equal(decideOwnerDecisionDigest(claimed, full, BASE, ON).reason, "CLAIMED");
  const stale: OwnerDigestLedger = { ...EMPTY_OWNER_DIGEST_LEDGER, claim: { token: "t", at: at(-(OWNER_DIGEST_RULE.claimTtlMinutes + 1) * MIN).toISOString() } };
  assert.equal(decideOwnerDecisionDigest(stale, full, BASE, ON).reason, "MORNING", "lượt chết giữa chừng không khoá bản tin cả ngày");

  // ─── Che URL trong câu lỗi ───
  assert.equal(maskUrls(`HTTP 500 at ${FAKE_URL}?x=1`), "HTTP 500 at [url]");

  // ─── Mã nguồn: hàm thuần không đọc đồng hồ; không thêm lịch; job cảnh báo gọi đúng hàm ───
  const goc = path.resolve(__dirname, "..");
  const thuan = readFileSync(path.join(goc, "lib/constants/owner-digest.ts"), "utf8");
  assert.ok(!/new Date\(\)|Date\.now\(\)/.test(thuan), "tệp thuần không đọc đồng hồ thật");
  const jobs = readFileSync(path.join(goc, "lib/sync/jobs.ts"), "utf8");
  assert.ok(!/"owner-digest"\s*:/.test(jobs), "không thêm job / lịch mới (AGENTS.md §7)");
  const rules = readFileSync(path.join(goc, "lib/alerts/rules.ts"), "utf8");
  assert.ok(rules.includes("runOwnerDecisionDigest()"), "tin chạy trong job `alerts` có sẵn");
  const runner = readFileSync(path.join(goc, "lib/alerts/owner-decision-digest.ts"), "utf8");
  assert.ok(!/console\.(log|info|error|warn)/.test(runner), "không in gì ra nhật ký (kho PUBLIC)");

  console.log("✓ Company OS · L (thuần): một bản sáng / ngày VN · tin thêm chỉ cho yêu cầu duyệt / mẫu MỚI, cách ≥ 30 phút · bỏ qua / hẹn nhắc không vào tin · rỗng / tắt / ngoài giờ không gửi · không tiền, không webhook, không email");
}

export async function testCompanyOsOwnerDigestDb(db: Db) {
  const USER = `${P}owner`;
  await db.delete(schema.settings).where(inArray(schema.settings.key, [OWNER_DIGEST_CONFIG_KEY, OWNER_DIGEST_LEDGER_KEY]));
  await db.insert(schema.users).values({ id: USER, email: `${USER}@t.local`, name: "Chủ shop L", passwordHash: "x", role: "ADMIN" });

  const sent: { url: string; secret: string; title: string; text: string }[] = [];
  let failNext = false;
  const send: NonNullable<OwnerDigestDeps["send"]> = async (url, secret, title, lines) => {
    await new Promise((r) => setTimeout(r, 5));
    if (failNext) {
      failNext = false;
      return { ok: false, error: `HTTP 500 từ ${url}` };
    }
    sent.push({ url, secret, title, text: [title, ...lines.flatMap((l) => l.map((p) => `${p.text} ${p.href ?? ""}`))].join("\n") });
    return { ok: true };
  };
  const target = async () => ({ url: FAKE_URL, secret: FAKE_SECRET });

  // Nguồn giả đi qua ĐƯỜNG THẬT của hàng đợi (quyền, sổ phản ứng trong CSDL, áp BỎ QUA / HẸN NHẮC).
  let approvals: OwnerDecisionItem[] = [];
  const loaders: Partial<Record<"APPROVALS" | "SAMPLES" | "TOPICS" | "ADS_CUT" | "MODEL_SCALE" | "PRODUCTION_LATE" | "INVENTORY" | "STOCK_FEEDBACK", SourceLoader>> = {
    APPROVALS: async () => ({ items: approvals }),
    SAMPLES: async () => ({ items: [] }),
    TOPICS: async () => ({ items: [] }),
    ADS_CUT: async () => ({ items: [ADS_1] }),
    MODEL_SCALE: async () => ({ items: [] }),
    PRODUCTION_LATE: async () => ({ items: [] }),
    INVENTORY: async () => ({ items: [INV_1] }),
    STOCK_FEEDBACK: async () => ({ items: [] }),
  };
  const seenCalls: { viewer: SessionUser; onlyKinds: readonly OwnerDecisionKind[] | undefined }[] = [];
  const loadQueue: NonNullable<OwnerDigestDeps["loadQueue"]> = async (viewer, now, onlyKinds) => {
    seenCalls.push({ viewer, onlyKinds });
    return getOwnerDecisionQueue({ viewer, now, onlyKinds, loaders, scopeOk: async () => true });
  };
  const deps = (now: Date, extra: Partial<OwnerDigestDeps> = {}): OwnerDigestDeps => ({ now, send, target, loadQueue, fullRetryMs: 0, ...extra });
  const ledger = async () => {
    const [r] = await db.select().from(schema.settings).where(eq(schema.settings.key, OWNER_DIGEST_LEDGER_KEY));
    return parseOwnerDigestLedger(r?.value ?? null);
  };
  const resetLedger = async () => {
    await db.delete(schema.settings).where(eq(schema.settings.key, OWNER_DIGEST_LEDGER_KEY));
    resetOwnerDigestThrottle();
  };

  // ─── Người xem máy: bộ quyền MANAGER, không quyền lương / người dùng ───
  const viewer = await ownerDigestViewer();
  assert.equal(viewer.id, OWNER_DIGEST_VIEWER_ID);
  assert.equal(viewer.role, "MANAGER");
  assert.ok(viewer.permissions.includes("approvals:decide"), "Quản lý duyệt được ⇒ yêu cầu duyệt vào tin");
  assert.ok(!viewer.permissions.includes("payroll:view") && !viewer.permissions.includes("users:manage"), "người xem máy không mang quyền lương / quản trị");
  const kinds = await viewerKinds(viewer, async () => true);
  assert.ok(kinds.includes("APPROVAL") && kinds.includes("SAMPLE_REVIEW"), "loại gấp nằm trong tập MANAGER thấy được");

  // ─── Tắt (mặc định) ⇒ không đọc hàng đợi, không gửi ───
  const off = await runOwnerDecisionDigest(deps(BASE));
  assert.equal(off.sent, null);
  assert.equal(sent.length, 0);
  assert.equal(seenCalls.length, 0, "tắt thì không tốn một truy vấn hàng đợi nào");

  await setSettingJson(OWNER_DIGEST_CONFIG_KEY, { enabled: true });
  // Chưa khai webhook nhóm Quản lý ⇒ không gửi (không lùi về nhóm vận đơn)
  const noHook = await runOwnerDecisionDigest(deps(BASE, { target: async () => ({ url: "", secret: "" }) }));
  assert.equal(noHook.sent, null);
  assert.equal(sent.length, 0);

  // ─── Bản sáng: đúng một tin; chạy lại cùng phút không gửi trùng ───
  approvals = [APPROVAL_1];
  const r1 = await runOwnerDecisionDigest(deps(BASE));
  assert.equal(r1.sent, "MORNING");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, FAKE_URL, "gửi đúng webhook nhóm Quản lý");
  assert.ok(!sent[0].text.includes("open-apis") && !sent[0].text.includes(FAKE_SECRET) && !sent[0].text.includes("₫"), "thân tin không mang webhook / khoá / tiền");
  assert.equal(seenCalls.at(-1)!.onlyKinds, undefined, "bản sáng đọc mọi loại MANAGER thấy được");
  assert.equal(seenCalls.at(-1)!.viewer.role, "MANAGER");
  assert.ok(!JSON.stringify(r1).includes(FAKE_URL), "kết quả job không mang webhook");
  assert.equal((await ledger()).day, "2026-01-05");
  assert.equal((await ledger()).claim, null, "gửi xong trả quyền gửi");

  const r2 = await runOwnerDecisionDigest(deps(BASE));
  assert.equal(r2.sent, null);
  assert.equal(sent.length, 1, "chạy lại cùng phút ⇒ không gửi trùng");
  assert.deepEqual([...(seenCalls.at(-1)!.onlyKinds ?? [])].sort(), [...OWNER_DIGEST_URGENT_KINDS].sort(), "bản sáng xong ⇒ chỉ đọc hai nguồn gấp, không dựng lại tồn / quảng cáo");

  // ─── Yêu cầu duyệt mới nhưng đã BỎ QUA trong sổ phản ứng thật ⇒ không kích tin ───
  const APPROVAL_2 = it("APPROVAL", `approval:${P}a2`);
  approvals = [APPROVAL_1, APPROVAL_2];
  const actor = { id: USER, label: "Chủ shop L" };
  const bo = await recordRecommendationDecisionCore(db, { item: APPROVAL_2, decision: "DISMISSED", reason: "không cần duyệt nữa", snoozeUntil: null, actor, source: "test", now: at(30 * MIN) });
  assert.ok("ok" in bo);
  const r3 = await runOwnerDecisionDigest(deps(at(HOUR)));
  assert.equal(r3.sent, null);
  assert.equal(sent.length, 1, "dòng đã bỏ qua (sổ recommendation_decisions) không kích tin");

  // ─── Yêu cầu duyệt MỚI đang HẸN NHẮC (dài hơn đồng hồ thật của CSDL) ⇒ không kích tin ───
  const APPROVAL_3 = it("APPROVAL", `approval:${P}a3`);
  approvals = [APPROVAL_1, APPROVAL_2, APPROVAL_3];
  // Ngày nhắc phải ở tương lai so với `now` của lượt ghi — dựng từ chính mốc truyền vào lõi.
  const hen = await recordRecommendationDecisionCore(db, { item: APPROVAL_3, decision: "SNOOZED", reason: "", snoozeUntil: at(5 * HOUR), actor, source: "test", now: at(30 * MIN) });
  assert.ok("ok" in hen);
  const r4 = await runOwnerDecisionDigest(deps(at(HOUR)));
  assert.equal(r4.sent, null);
  assert.equal(sent.length, 1, "dòng đang hẹn nhắc không kích tin");

  // ─── Yêu cầu duyệt MỚI thật ⇒ một tin thêm ───
  const APPROVAL_4 = it("APPROVAL", `approval:${P}a4`);
  approvals = [APPROVAL_1, APPROVAL_2, APPROVAL_3, APPROVAL_4];
  const r5 = await runOwnerDecisionDigest(deps(at(HOUR)));
  assert.equal(r5.sent, "NEW_URGENT");
  assert.equal(r5.items, 1);
  assert.equal(sent.length, 2);

  // ─── Gửi hỏng ⇒ không ghi "đã gửi", câu lỗi đã che URL; lượt sau gửi được ───
  await resetLedger();
  failNext = true;
  const bad = await runOwnerDecisionDigest(deps(BASE));
  assert.equal(bad.sent, null);
  assert.ok(bad.error && !bad.error.includes("open-apis") && bad.error.includes("[url]"), "câu lỗi không mang webhook");
  const afterBad = await ledger();
  assert.equal(afterBad.day, null, "gửi hỏng ⇒ không đánh dấu đã gửi");
  assert.equal(afterBad.claim, null, "gửi hỏng ⇒ trả quyền gửi");
  const retry = await runOwnerDecisionDigest(deps(BASE));
  assert.equal(retry.sent, "MORNING", "lượt sau thử lại, không im lặng bỏ cả ngày");
  assert.equal(sent.length, 3);

  // ─── Hai lượt SONG SONG ⇒ đúng một tin ───
  await resetLedger();
  const truoc = sent.length;
  const [c1, c2] = await Promise.all([runOwnerDecisionDigest(deps(BASE)), runOwnerDecisionDigest(deps(BASE))]);
  assert.equal(sent.length - truoc, 1, `hai lượt chạy song song chỉ gửi một tin (${c1.sent ?? c1.skipped} · ${c2.sent ?? c2.skipped})`);
  assert.equal([c1, c2].filter((r) => r.sent === "MORNING").length, 1);
  // Đường THƯỜNG NGÀY: sổ đã có dòng (bản sáng hôm qua) ⇒ hai lượt cùng đổi MỘT dòng — chỉ lượt nào thấy
  // đúng bản sổ nó đã đọc mới giành được quyền gửi.
  await resetLedger();
  const homQua: OwnerDigestLedger = { day: "2026-01-04", seen: [APPROVAL_1.sourceKey], lastSentAt: at(-DAY_MS).toISOString(), claim: null };
  await setSettingJson(OWNER_DIGEST_LEDGER_KEY, homQua);
  const truoc2 = sent.length;
  await Promise.all([runOwnerDecisionDigest(deps(BASE)), runOwnerDecisionDigest(deps(BASE))]);
  assert.equal(sent.length - truoc2, 1, "sổ đã có dòng: hai lượt song song vẫn chỉ gửi một tin (so-sánh-rồi-đổi trên đúng giá trị đã đọc)");
  assert.equal((await ledger()).day, "2026-01-05");

  // ─── Tắt lại ⇒ không gửi dù có dòng mới ───
  await setSettingJson(OWNER_DIGEST_CONFIG_KEY, { enabled: false });
  approvals = [...approvals, it("APPROVAL", `approval:${P}a5`)];
  const offAgain = await runOwnerDecisionDigest(deps(at(2 * HOUR)));
  assert.equal(offAgain.sent, null);
  assert.equal(sent.length, truoc + 2);

  // Dọn: khoá settings của chính bài này (sổ phản ứng append-only giữ nguyên — CSDL dùng một lần).
  await db.delete(schema.settings).where(inArray(schema.settings.key, [OWNER_DIGEST_CONFIG_KEY, OWNER_DIGEST_LEDGER_KEY]));
  resetOwnerDigestThrottle();
  console.log("✓ Company OS · L (CSDL): tắt không đọc hàng đợi · một bản sáng, chạy lại không trùng · bỏ qua / hẹn nhắc trong sổ thật không kích tin · gửi hỏng trả sổ, lỗi che URL · hai lượt song song đúng một tin");
}
