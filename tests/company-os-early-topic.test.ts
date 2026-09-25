import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@/db";
import type { Permission } from "@/lib/auth/permissions";
import { clearMemo } from "@/lib/cache";
import {
  BEFORE_PRODUCTION_DISCUSSION_STATES,
  buildTopicOpenContext,
  describeTopicOpenContext,
  isEarlyOpen,
  PRE_WINNER_STATES,
  productionTrackState,
  suggestsTopicOpening,
  topicOpeningMode,
  topicOpenNotice,
  WINNER_FOLLOW_UP_PREFIX,
  winnerFollowUp,
  type ProductionTrackInput,
} from "@/lib/constants/early-topic";
import { BEFORE_PRODUCTION_DISCUSSION, deriveModelSuggestions, type SuggestionInput } from "@/lib/constants/model-360";
import { checkModelTransition, MODEL_REASON_MIN_LENGTH, MODEL_STATES, MODEL_TRANSITIONS, reasonIsEnough, type ModelState } from "@/lib/constants/model-lifecycle";
import { deriveModelSignal, MODEL_SIGNAL_HINT, MODEL_SIGNALS, type ModelSignal, type ModelSignalInputs } from "@/lib/constants/model-signal";
import { allowedKinds, OWNER_DECISION_KIND_SPEC, OWNER_DECISION_KINDS, type DecoratedItem } from "@/lib/constants/owner-decisions";
import { decideOwnerDecisionDigest, OWNER_DIGEST_URGENT_KINDS } from "@/lib/constants/owner-digest";
import { buildTopicEvidenceSnapshot, type TopicEvidenceSnapshot } from "@/lib/constants/production-os";
import { transitionModelCore } from "@/lib/models/service";
import { createSampleCore, submitSampleCore } from "@/lib/production/samples";
import { createTopicCore, setTopicStatusCore } from "@/lib/production/topics";
import { designModelLinks } from "@/lib/queries/early-topic";
import { getModelProductionSummary } from "@/lib/queries/model-production";
import type { ModelSignalBatchRow } from "@/lib/queries/model-signal";
import { modelEarlyTopicCandidates, modelEarlyTopicToItems, modelWinnerCandidates, modelWinnerSourceKey, OWNER_DECISION_LOADERS } from "@/lib/queries/owner-decisions";

/**
 * ═══════════ COMPANY OS · AGENT T — TOPIC SẢN XUẤT MỞ SỚM (quy tắc chủ shop 25/09/2026) ═══════════
 *
 * "Có thể tạo topic trao đổi sản xuất cho những mẫu có chỉ số tốt mà chưa win" — khoá ở đây:
 *
 *  1. "Chỉ số tốt mà chưa win" = tín hiệu TRIỂN VỌNG của bảng gộp có sẵn — không ngưỡng mới.
 *  2. Topic mở sớm là LUỒNG SONG SONG: vòng đời mẫu KHÔNG đổi (mẫu ADS_TESTING vẫn ADS_TESTING).
 *  3. Mẫu chỉ có thiết kế (TK, chưa có mã Pancake) mở được topic.
 *  4. Ảnh chụp lúc mở ghi tín hiệu + vòng đời (chỉ NHÃN, không câu chi tiết), trang topic in "Mở sớm".
 *  5. Buồng lái: loại MODEL_EARLY_TOPIC hiện cho mẫu TRIỂN VỌNG chưa có topic, biến mất khi topic mở;
 *     ưu tiên sau MODEL_SCALE; không phải loại gấp của bản tin Lark.
 *  6. Khai THẮNG khi sản xuất đã đi trước ⇒ đề xuất chuyển tiếp tới đúng chỗ sản xuất đang đứng.
 *  7. Quyền: link tạo topic chỉ với `production:write`; loại buồng lái cần đúng quyền như MODEL_SCALE.
 *
 * Không mốc tuyệt đối trỏ vào đồng hồ thật (luật 50, 65): phần thuần không đọc đồng hồ; bản tin dùng
 * MỘT mốc truyền vào cho mọi phép so; phần CSDL không lọc theo thời gian.
 */

const P = "cost-";

const sig = (i: Partial<ModelSignalInputs>, modelId: string) => ({
  ...deriveModelSignal({ ads: null, productVerdicts: null, creative: null, design: null, inventory: null, declaredState: null, ...i }),
  modelId,
  periodLabel: "30 ngày qua",
  summary: "",
});

/** Mẫu chỉ có thiết kế THẮNG ⇒ TRIỂN VỌNG theo bảng gộp (nhãn thử không bao giờ đủ để THẮNG). */
const trienVong = (id: string) => sig({ design: "WIN" }, id);
/** Quảng cáo có lãi + mẫu mã tốt ⇒ THẮNG. */
const thang = (id: string) => sig({ ads: { kind: "OK", action: "SCALE", reason: "x" }, productVerdicts: ["WINNER"], creative: { total: 0, byVerdict: {} }, inventory: [] }, id);

function bRow(id: string, over: { state?: ModelState | null; open?: number | null; signal?: ModelSignalBatchRow["signal"] } = {}): ModelSignalBatchRow {
  return {
    model: { id, code: `TK-${id}`, name: "Váy", state: over.state === undefined ? null : over.state, productId: null },
    signal: over.signal ?? trienVong(id),
    openProductionTopics: over.open === undefined ? 0 : over.open,
  };
}

const track = (o: Partial<ProductionTrackInput> = {}): ProductionTrackInput => ({ topics: [], finalCosting: null, draftCostings: 0, latestSample: null, approvedDesign: null, openOrders: [], ...o });

// ═══════════════════════════════ THUẦN ═══════════════════════════════

export function testCompanyOsEarlyTopicPure() {
  // ─── 1. Tín hiệu TRIỂN VỌNG là "chỉ số tốt mà chưa win" — từ bảng có sẵn ───
  assert.equal(trienVong("x").signal, "PROMISING", "thiết kế THẮNG, chưa có nguồn thị trường ⇒ TRIỂN VỌNG");
  assert.equal(sig({ ads: { kind: "OK", action: "SCALE", reason: "x" }, productVerdicts: [] }, "x").signal, "PROMISING", "quảng cáo tốt, thiếu nguồn mẫu mã ⇒ TRIỂN VỌNG");
  assert.equal(thang("x").signal, "WINNER");
  const src = readFileSync("lib/constants/early-topic.ts", "utf8").replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "");
  assert.ok(!/\d{2,}/.test(src.replace(/["'`][^"'`\n]*["'`]/g, "")), "early-topic.ts không mang ngưỡng số nào (luật 27, 38)");

  // ─── 2. Chế độ mở topic ───
  assert.deepEqual([...BEFORE_PRODUCTION_DISCUSSION], [...BEFORE_PRODUCTION_DISCUSSION_STATES], "trang 360 và luật mở sớm dùng CÙNG một tập trạng thái");
  assert.deepEqual([...BEFORE_PRODUCTION_DISCUSSION_STATES], [...PRE_WINNER_STATES, "WINNER"]);
  for (const s of MODEL_SIGNALS) {
    for (const st of [null, ...MODEL_STATES] as (ModelState | null)[]) {
      const truocThang = st === null || st === "IDEA" || st === "CREATIVE" || st === "ADS_TESTING";
      const truocBan = truocThang || st === "WINNER";
      const mong = !truocBan ? null : s === "WINNER" ? "NORMAL" : s === "PROMISING" ? (st === "WINNER" ? "NORMAL" : "EARLY") : null;
      assert.equal(topicOpeningMode(s, st), mong, `chế độ · ${s} · ${st}`);
    }
  }
  assert.equal(topicOpeningMode("PROMISING", "LOSER"), null, "mẫu đã khai Loại không được đề xuất");
  assert.equal(topicOpeningMode("PROMISING", "DISCONTINUED"), null, "mẫu Ngừng không được đề xuất");
  assert.equal(suggestsTopicOpening("PROMISING", null, 0), "EARLY");
  assert.equal(suggestsTopicOpening("PROMISING", null, 1), null, "đã có topic đang mở ⇒ không đề xuất");
  assert.equal(suggestsTopicOpening("PROMISING", null, null), null, "số topic CHƯA BIẾT ⇒ không đề xuất (có thể đã có)");

  // ─── 3. Trang 360: đề xuất phân biệt SỚM vs thường; link chỉ với production:write ───
  const base: SuggestionInput = { modelId: "m1", declaredState: "ADS_TESTING", signal: null, ads: null, inventory: null, creativeHref: null, periodQuery: "period=30d", production: { openTopics: 0 }, canCreateTopic: true };
  const som = deriveModelSuggestions({ ...base, signal: { signal: "PROMISING", summary: "Thiết kế: Thắng" } });
  assert.equal(som.length, 1);
  assert.equal(som[0].key, "topic-open-early");
  assert.match(som[0].what, /SỚM/);
  assert.equal(som[0].transition, null, "mở sớm KHÔNG kèm chuyển vòng đời — luồng song song");
  assert.deepEqual(som[0].links, [{ label: "Mở topic sản xuất sớm", href: "/production/topics/new?model=m1" }]);
  assert.ok(som[0].why.includes("25/09/2026"), "vì sao dẫn quy tắc chủ shop");
  const thuong = deriveModelSuggestions({ ...base, signal: { signal: "WINNER", summary: "QC: Tăng" } });
  assert.equal(thuong[0].key, "lifecycle-production-discussion");
  assert.doesNotMatch(thuong[0].what, /SỚM/, "mẫu THẮNG không gọi là sớm");
  assert.equal(thuong[0].transition?.to, "PRODUCTION_DISCUSSION");
  assert.deepEqual(thuong[0].links.map((l) => l.label), ["Tạo topic sản xuất"]);
  const khaiThang = deriveModelSuggestions({ ...base, declaredState: "WINNER", signal: { signal: "PROMISING", summary: "x" } });
  assert.equal(khaiThang[0].key, "topic-open", "đã khai THẮNG + tín hiệu TRIỂN VỌNG ⇒ mở topic thường, không 'sớm'");
  assert.equal(khaiThang[0].transition, null, "mở topic thì vòng đời tự đi theo — không đề xuất chuyển tay");
  assert.equal(deriveModelSuggestions({ ...base, signal: { signal: "PROMISING", summary: "x" }, canCreateTopic: false })[0].links.length, 0, "không production:write ⇒ không link tạo topic");
  assert.equal(deriveModelSuggestions({ ...base, signal: { signal: "PROMISING", summary: "x" }, production: { openTopics: 2 } }).length, 0, "đã có topic đang mở ⇒ không đề xuất mở sớm");
  assert.ok(deriveModelSuggestions({ ...base, signal: { signal: "PROMISING", summary: "x" }, production: null })[0].caveat, "không đọc được sản xuất ⇒ đề xuất kèm lưu ý");
  for (const s of ["TESTING", "LOSER", "NEEDS_MORE_DATA"] as ModelSignal[]) assert.equal(deriveModelSuggestions({ ...base, signal: { signal: s, summary: "x" } }).length, 0, `tín hiệu ${s} ⇒ không đề xuất topic`);

  // ─── 4. Bối cảnh lúc mở (ảnh chụp) ───
  const ctx = buildTopicOpenContext(trienVong("m1"), "ADS_TESTING");
  assert.equal(ctx.signalAtOpen?.signal, "PROMISING");
  assert.equal(ctx.lifecycleAtOpen, "ADS_TESTING");
  assert.equal(ctx.signalErrorAtOpen, null);
  assert.ok(ctx.signalAtOpen?.reasons.every((r) => Object.keys(r).sort().join(",") === "source,verdict,vote"), "lá phiếu chỉ giữ NHÃN — không câu chi tiết (có thể chứa biên lợi nhuận / chi QC)");
  const khongDoc = buildTopicOpenContext(null, null, "hỏng thử");
  assert.equal(khongDoc.signalAtOpen, null, "tín hiệu không đọc được ⇒ CHƯA BIẾT, không bịa");
  assert.equal(khongDoc.signalErrorAtOpen, "hỏng thử");

  assert.equal(isEarlyOpen("ADS_TESTING", "WINNER"), true, "chưa khai THẮNG ⇒ sớm, dù máy thấy thắng");
  assert.equal(isEarlyOpen("IDEA", null), true);
  assert.equal(isEarlyOpen(null, "PROMISING"), true, "chưa khai + TRIỂN VỌNG (thiết kế TK) ⇒ sớm");
  assert.equal(isEarlyOpen(null, "TESTING"), false, "chưa khai + tín hiệu khác ⇒ KHÔNG khẳng định sớm (mẫu bán lâu năm cũng chưa khai)");
  assert.equal(isEarlyOpen(null, null), false);
  assert.equal(isEarlyOpen("WINNER", "PROMISING"), false, "đã khai THẮNG ⇒ không sớm");
  assert.equal(isEarlyOpen("SELLING", "PROMISING"), false, "tái sản xuất ⇒ không sớm");
  const nhan = describeTopicOpenContext({ ...buildTopicEvidenceSnapshot({ orders30d: null, ordersTotal: null, adSpend30d: null }, null, new Date(0)), ...ctx });
  assert.deepEqual(nhan, { early: true, label: "Mở sớm — mẫu đang Triển vọng / Test quảng cáo" });
  assert.equal(describeTopicOpenContext({ kind: "SNAPSHOT" }), null, "ảnh chụp cũ không có bối cảnh ⇒ không nhãn, KHÔNG đoán");
  assert.equal(describeTopicOpenContext(null), null);
  assert.equal(describeTopicOpenContext({ lifecycleAtOpen: "WINNER", signalAtOpen: { signal: "WINNER" } })?.early, false);
  assert.match(describeTopicOpenContext({ lifecycleAtOpen: null, signalAtOpen: null })?.label ?? "", /chưa đọc được tín hiệu/);
  assert.equal(topicOpenNotice("ADS_TESTING", "PROMISING")?.early, true);
  assert.match(topicOpenNotice("ADS_TESTING", "PROMISING")?.text ?? "", /vòng đời mẫu KHÔNG đổi/);
  assert.equal(topicOpenNotice("WINNER", "WINNER")?.early, false, "đã khai THẮNG ⇒ nhắc vòng đời tự đi theo");
  assert.equal(topicOpenNotice("SELLING", null), null);

  // ─── 5. Chuyển tiếp sau khi khai THẮNG — mỗi hình dạng tóm tắt sản xuất ───
  assert.equal(winnerFollowUp(null), null, "không đọc được sản xuất ⇒ không đề xuất");
  assert.equal(winnerFollowUp(track()), null, "sản xuất chưa bắt đầu ⇒ bước tiếp là cạnh tiến thường");
  assert.equal(winnerFollowUp(track({ topics: [{ status: "CLOSED" }] })), null, "topic chỉ còn Đã đóng không tính (có thể bỏ dở)");
  const hinhDang: [string, Partial<ProductionTrackInput>, ModelState][] = [
    ["topic đang trao đổi", { topics: [{ status: "WAITING_QUOTE" }] }, "PRODUCTION_DISCUSSION"],
    ["topic đã chốt phương án", { topics: [{ status: "SELECTED" }, { status: "CLOSED" }] }, "PRODUCTION_DISCUSSION"],
    ["giá thành nháp", { topics: [{ status: "SELECTED" }], draftCostings: 1 }, "COSTING"],
    ["giá thành chốt", { finalCosting: { version: 2 } }, "COSTING"],
    ["mẫu đang làm", { finalCosting: { version: 1 }, latestSample: { version: 1, status: "IN_PROGRESS" } }, "SAMPLING"],
    ["mẫu yêu cầu sửa", { latestSample: { version: 1, status: "CHANGES_REQUESTED" } }, "SAMPLING"],
    ["mẫu đã gửi duyệt", { latestSample: { version: 2, status: "SUBMITTED" } }, "SAMPLE_REVIEW"],
    ["mẫu bị loại", { latestSample: { version: 2, status: "REJECTED" } }, "SAMPLE_REVIEW"],
    ["mẫu đã duyệt", { latestSample: { version: 2, status: "APPROVED" } }, "APPROVED"],
    ["bản thiết kế duyệt", { approvedDesign: { version: 1 }, latestSample: { version: 3, status: "IN_PROGRESS" } }, "APPROVED"],
    ["lệnh SX trỏ bản duyệt", { approvedDesign: { version: 1 }, openOrders: [{ code: "LSX-1", designVersionId: "dv1" }] }, "PRODUCTION_PLANNING"],
  ];
  for (const [ten, p, to] of hinhDang) {
    const f = winnerFollowUp(track(p));
    assert.equal(f?.to, to, `chuyển tiếp · ${ten}`);
    assert.ok(f && f.reason.startsWith(WINNER_FOLLOW_UP_PREFIX), `lý do điền sẵn mang tiền tố · ${ten}`);
    assert.ok(f && reasonIsEnough(f.reason) && f.reason.length >= MODEL_REASON_MIN_LENGTH, `lý do qua được kiểm tra lý do · ${ten}`);
    const kiem = checkModelTransition("WINNER", to);
    assert.ok(kiem.ok, `WINNER → ${to} là lượt chuyển hợp lệ`);
    assert.ok(MODEL_STATES.indexOf(to) > MODEL_STATES.indexOf("WINNER"), "đích luôn sau THẮNG");
  }
  assert.equal(winnerFollowUp(track({ openOrders: [{ code: "LSX-9", designVersionId: null }] })), null, "lệnh SX không trỏ bản duyệt không phải chứng cứ (lệnh tái sản xuất cũ)");
  assert.deepEqual(productionTrackState(track({ topics: [{ status: "SELECTED" }], finalCosting: { version: 1 } }))?.evidence.length, 2, "mọi chứng cứ được nêu, không chỉ cái đi xa nhất");
  assert.deepEqual(MODEL_TRANSITIONS.ADS_TESTING, ["WINNER", "LOSER"], "cạnh tiến ra khỏi Test quảng cáo KHÔNG đổi — mở sớm không phải cú nhảy vòng đời");

  // Trang 360: mẫu ĐÃ khai THẮNG mà sản xuất đi trước ⇒ đề xuất chuyển tiếp thay cho "mở trao đổi".
  const diTruoc = winnerFollowUp(track({ topics: [{ status: "SELECTED" }], latestSample: { version: 1, status: "SUBMITTED" } }));
  const s360 = deriveModelSuggestions({ ...base, declaredState: "WINNER", signal: { signal: "WINNER", summary: "x" }, production: { openTopics: 0, winnerFollowUp: diTruoc } });
  assert.equal(s360.length, 1);
  assert.equal(s360[0].key, "lifecycle-production-ahead");
  assert.equal(s360[0].transition?.to, "SAMPLE_REVIEW");
  assert.equal(s360[0].transition?.reason, diTruoc?.reason, "lý do điền sẵn đúng câu của hàm thuần");
  assert.equal(deriveModelSuggestions({ ...base, declaredState: "ADS_TESTING", signal: { signal: "PROMISING", summary: "x" }, production: { openTopics: 0, winnerFollowUp: diTruoc } })[0].key, "topic-open-early", "chưa khai THẮNG ⇒ KHÔNG đề xuất chuyển tiếp (khai THẮNG là việc của người)");

  // ─── 6. Buồng lái: loại mới, ứng viên, khoá ───
  assert.ok(OWNER_DECISION_KINDS.indexOf("MODEL_EARLY_TOPIC") > OWNER_DECISION_KINDS.indexOf("MODEL_SCALE"), "ưu tiên SAU mẫu THẮNG");
  const spec = OWNER_DECISION_KIND_SPEC.MODEL_EARLY_TOPIC;
  assert.deepEqual([...spec.requires], [...OWNER_DECISION_KIND_SPEC.MODEL_SCALE.requires], "quyền như MODEL_SCALE");
  assert.equal(spec.scopeResource, OWNER_DECISION_KIND_SPEC.MODEL_SCALE.scopeResource);
  assert.equal(spec.source, "MODEL_SCALE", "cùng một lượt đọc lô tín hiệu");
  const ung = modelEarlyTopicCandidates([
    bRow("a"),
    bRow("b", { open: 1 }),
    bRow("c", { open: null }),
    bRow("d", { state: "ADS_TESTING" }),
    bRow("e", { state: "WINNER" }),
    bRow("f", { state: "LOSER" }),
    bRow("g", { state: "DISCONTINUED" }),
    bRow("h", { state: "PRODUCTION_DISCUSSION" }),
    bRow("i", { signal: thang("i") }),
    bRow("j", { signal: sig({ design: "TESTING" }, "j") }),
  ]);
  assert.deepEqual(ung.map((r) => r.model.id), ["a", "d", "e"], "TRIỂN VỌNG · 0 topic mở (không phải chưa biết) · trước Bàn sản xuất · không Loại / Ngừng");
  assert.deepEqual(modelWinnerCandidates([bRow("a"), bRow("i", { signal: thang("i") })]).map((r) => r.model.id), ["i"], "hai loại không chồng nhau: THẮNG sang MODEL_SCALE");
  const it = modelEarlyTopicToItems(ung)[0];
  assert.equal(it.kind, "MODEL_EARLY_TOPIC");
  assert.ok(it.sourceKey.startsWith("model:PROMISING:a:"), "khoá mang tín hiệu — không trùng khoá THẮNG của cùng mẫu");
  assert.equal(it.sourceKey, modelWinnerSourceKey("a", trienVong("a")), "khoá tất định");
  assert.notEqual(it.sourceKey, modelWinnerSourceKey("a", thang("a")));
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(it.sourceKey), "khoá KHÔNG mang ngày");
  assert.ok(it.why.startsWith(MODEL_SIGNAL_HINT.PROMISING));
  assert.equal(it.impact.amountVnd, null, "không bịa tiền cho một lời mời báo giá");
  assert.equal(it.action.href, "/models/a");
  assert.ok(it.data.every((d) => d.value === null || !/\d/.test(d.value)), "ô số liệu chỉ là NHÃN");

  // Quyền: đúng tập của MODEL_SCALE — thiếu một quyền hay phạm vi ADS ⇒ không thấy.
  const co = (ps: Permission[]) => (p: Permission) => ps.includes(p);
  assert.ok(allowedKinds(co(["models:view", "expenses:view"]), () => true).includes("MODEL_EARLY_TOPIC"));
  assert.ok(!allowedKinds(co(["models:view"]), () => true).includes("MODEL_EARLY_TOPIC"), "thiếu expenses:view ⇒ không thấy");
  assert.ok(!allowedKinds(co(["expenses:view"]), () => true).includes("MODEL_EARLY_TOPIC"), "thiếu models:view ⇒ không thấy");
  assert.ok(!allowedKinds(co(["models:view", "expenses:view"]), () => false).includes("MODEL_EARLY_TOPIC"), "phạm vi ADS = không ⇒ không thấy");

  // ─── 7. Bản tin Lark: KHÔNG gấp ⇒ chỉ bản sáng ───
  assert.ok(!OWNER_DIGEST_URGENT_KINDS.includes("MODEL_EARLY_TOPIC"), "mở topic sớm không phải việc có người đang đứng chờ chữ ký");
  const now = new Date(Date.UTC(2026, 0, 5, 3, 0)); // 10:00 giờ VN — mốc TRUYỀN VÀO, không so với đồng hồ thật
  const dec: DecoratedItem = { ...it, latest: null };
  const queue = { groups: [{ items: [dec] }], hidden: [], kinds: [...OWNER_DECISION_KINDS], failed: [] };
  const sang = decideOwnerDecisionDigest(null, queue, now, { enabled: true, appUrl: "https://erp.local" });
  assert.equal(sang.reason, "MORNING");
  assert.ok(sang.keys.includes(it.sourceKey), "bản sáng có dòng mở topic sớm");
  assert.deepEqual(sang.nextState.seen, [], "dòng không gấp không vào sổ 'đã báo gấp'");
  const trongNgay = decideOwnerDecisionDigest(sang.nextState, queue, new Date(now.getTime() + 3 * 3_600_000), { enabled: true, appUrl: "https://erp.local" });
  assert.equal(trongNgay.send, false);
  assert.equal(trongNgay.reason, "NO_NEW_URGENT", "dòng MỚI của loại này KHÔNG kích tin thêm trong ngày");

  // ─── 8. Quét mã nguồn: đường thật dùng đúng hàm ───
  const action = readFileSync("lib/actions/production-topics.ts", "utf8");
  assert.ok(action.includes("buildTopicOpenContext(") && action.includes("getModelSignal("), "server action chụp tín hiệu + vòng đời lúc mở topic");
  assert.ok(/can\(user, "production:write"\)/.test(action), "mở topic vẫn cần production:write");
  const loader = readFileSync("lib/queries/owner-decisions.ts", "utf8");
  assert.ok(loader.includes("modelEarlyTopicToItems(modelEarlyTopicCandidates("), "nguồn tín hiệu mẫu sinh cả loại mở sớm");
  const tab = readFileSync("app/(dashboard)/marketing/creatives/design-tab.tsx", "utf8");
  assert.ok(tab.includes("canCreateTopic && EARLY_TOPIC_DESIGN_STATUSES.includes(r.status)"), "link topic ở tab Thiết kế chỉ với production:write và thiết kế đang test / thắng");
  assert.ok(tab.includes("Đồng bộ sổ mẫu trước") && !/syncModelRegistry|registerModel/.test(tab), "thiết kế chưa vào sổ ⇒ nhắc đồng bộ, KHÔNG tự đăng ký");
  assert.ok(readFileSync("app/(dashboard)/marketing/creatives/page.tsx", "utf8").includes('canCreateTopic={can(user, "production:write")}'));
  const newPage = readFileSync("app/(dashboard)/production/topics/new/page.tsx", "utf8");
  assert.ok(newPage.includes('requirePermission("production:write")'), "biểu mẫu mở topic cần production:write");
  assert.ok(!/state\s*!==?\s*"(LOSER|DISCONTINUED)"|filter\(\(m\) => .*state/.test(newPage), "ô chọn mẫu KHÔNG lọc theo trạng thái (C không lọc)");
  const controls = readFileSync("app/(dashboard)/models/[id]/model-controls.tsx", "utf8");
  assert.ok(controls.includes('setFollowUp(to === "WINNER" ? winnerFollowUp : null)') && controls.includes("transitionModel({ modelId, to: followUp.to, reason: followUp.reason })"), "chuyển tiếp sau khai THẮNG: một cú bấm, đi qua transitionModel");
  console.log("✓ Company OS · T (thuần): TRIỂN VỌNG = chỉ số tốt chưa win · mở sớm không đổi vòng đời · 360 phân biệt sớm/thường · buồng lái MODEL_EARLY_TOPIC không gấp · chuyển tiếp sau khai THẮNG cho 11 hình dạng sản xuất");
}

// ═══════════════════════════════ CSDL ═══════════════════════════════

export async function testCompanyOsEarlyTopicDb(db: Db) {
  const U = `${P}u`;
  const actor = { id: U, label: "Trưởng nhóm T" };
  await db.insert(schema.users).values({ id: U, email: "cos-t@test.local", name: "Trưởng nhóm T", passwordHash: "x", role: "LEADER" });
  // Mẫu chỉ có thiết kế (TK, chưa có mã Pancake): thiết kế THẮNG ⇒ tín hiệu TRIỂN VỌNG; vòng đời chưa khai.
  await db.insert(schema.designConcepts).values([
    { id: `${P}d1`, code: "TK-990925-71", dna: {}, dnaVersion: 1, status: "WIN" },
    { id: `${P}d2`, code: "TK-990925-72", dna: {}, dnaVersion: 1, status: "TESTING" },
    { id: `${P}d3`, code: "TK-990925-73", dna: {}, dnaVersion: 1, status: "TESTING" },
  ]);
  const [tk] = await db.insert(schema.productModels).values({ id: `${P}m-tk`, code: "TKCOST01", name: "Váy TK", designConceptId: `${P}d1`, lifecycleState: null, registeredBy: "SYNC" }).returning();
  const [qc] = await db.insert(schema.productModels).values({ id: `${P}m-qc`, code: "TKCOST02", name: "Áo đang test", designConceptId: `${P}d2`, lifecycleState: "ADS_TESTING", registeredBy: "USER" }).returning();
  const evidence = (productId: string | null): TopicEvidenceSnapshot => buildTopicEvidenceSnapshot({ orders30d: null, ordersTotal: null, adSpend30d: null }, productId, new Date(0));
  const req = { material: "", colors: [], sizes: [], trims: "", designNotes: "", targetPrice: null, expectedQty: null, deadline: null };

  // ─── A. Buồng lái: mẫu TRIỂN VỌNG chưa có topic ⇒ có dòng (đọc bằng lô THẬT, không giả nguồn) ───
  clearMemo();
  const doc = async () => (await OWNER_DECISION_LOADERS.MODEL_SCALE({ now: new Date(), viewer: { id: U, email: "", name: "", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null } })).items;
  const truoc = await doc();
  const dongTk = truoc.find((i) => i.kind === "MODEL_EARLY_TOPIC" && i.modelId === tk.id);
  assert.ok(dongTk, "mẫu TK chỉ có thiết kế THẮNG, chưa có topic ⇒ hiện 'cân nhắc mở topic sớm'");
  assert.ok(!truoc.some((i) => i.modelId === qc.id), "thiết kế còn đang test ⇒ tín hiệu Đang thử ⇒ không đề xuất (chỉ TRIỂN VỌNG)");
  assert.ok(!truoc.some((i) => i.kind === "MODEL_SCALE" && i.modelId === tk.id), "TRIỂN VỌNG không vào loại mẫu THẮNG");

  // ─── B. Mẫu chỉ có thiết kế MỞ ĐƯỢC topic; vòng đời chưa khai đứng yên ───
  const ctxTk = buildTopicOpenContext(trienVong(tk.id), tk.lifecycleState as ModelState | null);
  const t1 = await createTopicCore(db, { modelId: tk.id, title: "Hỏi giá váy TK sớm", requirements: req, supplierId: null, evidence: { ...evidence(null), ...ctxTk }, actor });
  assert.ok("ok" in t1, "mẫu chưa có mã Pancake vẫn mở được topic");
  if (!("ok" in t1)) return;
  assert.deepEqual(t1.lifecycle, { moved: false, reason: "UNDECLARED", current: null }, "mẫu chưa khai ⇒ vòng đời KHÔNG đổi");
  const [row1] = await db.select().from(schema.productionTopics).where(eq(schema.productionTopics.id, t1.topicId));
  const snap1 = row1.evidenceSnapshot as Partial<TopicEvidenceSnapshot>;
  assert.equal(snap1.signalAtOpen?.signal, "PROMISING", "ảnh chụp ghi tín hiệu lúc mở");
  assert.equal(snap1.lifecycleAtOpen, null, "ảnh chụp ghi vòng đời lúc mở (chưa khai = null, không phải chuỗi rỗng)");
  assert.equal(snap1.kind, "SNAPSHOT", "trường cũ của C giữ nguyên");
  assert.deepEqual(describeTopicOpenContext(row1.evidenceSnapshot), { early: true, label: "Mở sớm — mẫu đang Triển vọng / Chưa khai" });

  // ─── C. Topic mở ⇒ dòng buồng lái biến mất (điều kiện ở nguồn hết — không ai bấm "xong") ───
  clearMemo();
  assert.ok(!(await doc()).some((i) => i.kind === "MODEL_EARLY_TOPIC" && i.modelId === tk.id), "đã có topic đang mở ⇒ rời hàng đợi");

  // ─── D. Topic sớm trên mẫu ADS_TESTING KHÔNG đổi vòng đời ───
  const t2 = await createTopicCore(db, { modelId: qc.id, title: "Hỏi giá áo đang test", requirements: req, supplierId: null, evidence: { ...evidence(null), ...buildTopicOpenContext(null, "ADS_TESTING", "không đọc được") }, actor });
  assert.ok("ok" in t2);
  if (!("ok" in t2)) return;
  assert.deepEqual(t2.lifecycle, { moved: false, reason: "NOT_FORWARD", current: "ADS_TESTING" }, "ADS_TESTING → Bàn sản xuất không phải cạnh tiến ⇒ không đi theo");
  const sm = await createSampleCore(db, { modelId: qc.id, topicId: t2.topicId, fields: { supplierId: null, costVnd: null, images: [], notes: "", problems: "" }, actor });
  assert.ok("ok" in sm && !sm.lifecycle.moved, "làm mẫu song song cũng không kéo vòng đời");
  if (!("ok" in sm)) return;
  assert.ok("ok" in (await submitSampleCore(db, { sampleId: sm.sampleId, actor })));
  const [qcNow] = await db.select({ s: schema.productModels.lifecycleState }).from(schema.productModels).where(eq(schema.productModels.id, qc.id));
  assert.equal(qcNow.s, "ADS_TESTING", "sau topic + mẫu gửi duyệt, mẫu VẪN đang test quảng cáo");
  const lichSu = await db.select().from(schema.productModelStateHistory).where(eq(schema.productModelStateHistory.modelId, qc.id));
  assert.equal(lichSu.length, 0, "không một dòng lịch sử vòng đời nào do luồng song song sinh ra");
  assert.equal(describeTopicOpenContext((await db.select().from(schema.productionTopics).where(eq(schema.productionTopics.id, t2.topicId)))[0].evidenceSnapshot)?.early, true, "ADS_TESTING lúc mở ⇒ nhãn Mở sớm dù tín hiệu chưa đọc được");

  // ─── E. Người khai THẮNG ⇒ máy đề xuất chuyển tiếp đúng chỗ sản xuất đang đứng; người bấm ───
  assert.ok("ok" in (await setTopicStatusCore(db, { topicId: t2.topicId, to: "DISCUSSING", actor })));
  assert.ok("ok" in (await setTopicStatusCore(db, { topicId: t2.topicId, to: "SELECTED", selectedOption: "PA1", actor })));
  const tomTat = await getModelProductionSummary(qc.id);
  const f = winnerFollowUp(tomTat);
  assert.equal(f?.to, "SAMPLE_REVIEW", "topic đã chốt + mẫu đã gửi duyệt ⇒ Duyệt mẫu");
  assert.ok("ok" in (await transitionModelCore(db, { modelId: qc.id, to: "WINNER", reason: null, actor, actorKind: "USER", source: "test" })), "khai THẮNG vẫn là cạnh tiến từ Test quảng cáo");
  const [sauThang] = await db.select({ s: schema.productModels.lifecycleState }).from(schema.productModels).where(eq(schema.productModels.id, qc.id));
  assert.equal(sauThang.s, "WINNER", "khai THẮNG không tự kéo tiếp — đề xuất chỉ hiện, người bấm");
  const buoc = await transitionModelCore(db, { modelId: qc.id, to: f!.to, reason: f!.reason, actor, actorKind: "USER", source: "test" });
  assert.ok("ok" in buoc, "lượt chuyển tiếp với lý do điền sẵn được lõi chấp nhận (nhảy cóc cần lý do)");
  const [cuoi] = await db
    .select()
    .from(schema.productModelStateHistory)
    .where(and(eq(schema.productModelStateHistory.modelId, qc.id), eq(schema.productModelStateHistory.toState, "SAMPLE_REVIEW")));
  assert.ok(cuoi && cuoi.reason.startsWith(WINNER_FOLLOW_UP_PREFIX), "lịch sử ghi đúng lý do chuyển tiếp");

  // ─── F. Tab Thiết kế: thiết kế ⇒ mẫu ⇒ topic đang mở; thiết kế chưa vào sổ ⇒ không có ───
  const links = await designModelLinks(db, [`${P}d1`, `${P}d2`, `${P}d3`]);
  assert.deepEqual(links.get(`${P}d1`), { modelId: tk.id, openTopicId: t1.topicId }, "thiết kế có topic đang mở ⇒ link tới topic đó");
  assert.deepEqual(links.get(`${P}d2`), { modelId: qc.id, openTopicId: null }, "topic đã chốt không còn 'đang mở' ⇒ link mở topic mới");
  assert.equal(links.has(`${P}d3`), false, "thiết kế chưa có mẫu trong sổ ⇒ màn hình nhắc đồng bộ, không tự đăng ký");
  assert.equal((await db.select().from(schema.productModels).where(eq(schema.productModels.designConceptId, `${P}d3`))).length, 0, "đọc KHÔNG đăng ký mẫu");
  assert.equal((await designModelLinks(db, [])).size, 0);
  console.log("✓ Company OS · T (CSDL): mẫu TK chỉ có thiết kế mở được topic · buồng lái hiện rồi rời khi topic mở · ADS_TESTING đứng yên qua topic + mẫu · khai THẮNG → chuyển tiếp Duyệt mẫu một cú bấm · tab Thiết kế nối đúng mẫu");
}
