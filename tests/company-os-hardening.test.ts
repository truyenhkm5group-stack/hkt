import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { guardWithinScope, withApprovalExecution } from "@/lib/approvals/execution";
import {
  approvalExecutedDedupeKey,
  confirmApprovalExecution,
  decideApprovalCore,
  guardSecondApprovalCore,
  releaseApprovalExecution,
  type ApprovalUser,
  type GuardInput,
} from "@/lib/approvals/service";
import { APPROVAL_ENFORCE_KEY } from "@/lib/constants/approval";
import { DOMAIN_EVENT_BY_NAME } from "@/lib/constants/domain-events";
import { productionTrackState, suggestsTopicOpening } from "@/lib/constants/early-topic";
import { deriveModelSuggestions, type SuggestionInput } from "@/lib/constants/model-360";
import { countTopicsBlockingSuggestion, REQUIRE_APPROVED_DESIGN_KEY, TOPIC_BLOCKS_NEW_SUGGESTION, TOPIC_OPEN_STATUSES, TOPIC_STATUSES } from "@/lib/constants/production-os";
import { clearMemo } from "@/lib/cache";
import { getModelSignalsBatch } from "@/lib/queries/model-signal";
import { modelEarlyTopicCandidates, modelWinnerCandidates } from "@/lib/queries/owner-decisions";
import { writeStockReceiptCore } from "@/lib/inventory/receipt-create";
import { domainEventDimension, getModelTimeline } from "@/lib/queries/models";
import { transitionModelCore } from "@/lib/models/service";
import { requireApprovedDesignFlag } from "@/lib/queries/production-os";
import { getSettingJson, mergeSettingJson, setSettingJson } from "@/lib/settings";
import { createCostSheetCore } from "@/lib/production/costing";
import { followModelLifecycle } from "@/lib/production/lifecycle";
import { createTopicCore } from "@/lib/production/topics";

/**
 * ═══════════ COMPANY OS · AGENT K — GIA CỐ NĂM CHỖ HỞ ═══════════
 *
 * Mỗi mục một khối, mỗi khối khoá đúng chỗ hở mà một agent khác đã báo:
 *  1. Vòng đời mẫu đi theo TRONG giao dịch nghiệp vụ (yêu cầu của C, handoff-c mục 5).
 *  2. `getSettingJson` đọc được giá trị nguyên thuỷ mà không đổi một khoá object nào (C báo).
 *  3. Lời duyệt không mất khi thao tác được duyệt hỏng; `approval.executed` LIVE (G, handoff-g mục 4).
 *  4. `stock_receipt.linked_production` LIVE (RESERVED từ D).
 *  5. "Đã có đường sản xuất" (chặn đề xuất mở topic) — một định nghĩa, kể cả topic Đã chốt (T báo).
 *
 * Dữ liệu mang tiền tố `cos-k-` / mã `COSK`; không mốc tuyệt đối, không cửa sổ "N giờ trước" (luật 50, 65).
 */

const P = "cos-k-";

function lanTheoLoi(e: unknown): string {
  const chuoi: string[] = [];
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur; i++) {
    chuoi.push(String((cur as { message?: string })?.message ?? cur));
    cur = (cur as { cause?: unknown })?.cause;
  }
  return chuoi.join(" ← ");
}

async function demLichSu(db: Db, modelId: string): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.productModelStateHistory).where(eq(schema.productModelStateHistory.modelId, modelId));
  return Number(r.n);
}

async function trangThai(db: Db, modelId: string): Promise<string | null> {
  const [r] = await db.select({ s: schema.productModels.lifecycleState }).from(schema.productModels).where(eq(schema.productModels.id, modelId));
  return r?.s ?? null;
}

// ─────────────────────────── 1. VÒNG ĐỜI TRONG GIAO DỊCH NGHIỆP VỤ ───────────────────────────

export async function testHardeningLifecycleInTx(db: Db) {
  const U = `${P}writer`;
  const nguoi = { id: U, label: "Trưởng nhóm kiểm K" };
  await db.insert(schema.users).values({ id: U, email: "cos-k-w@test.local", name: "Trưởng nhóm kiểm K", passwordHash: "x", role: "LEADER" }).onConflictDoNothing();
  const [m1] = await db.insert(schema.productModels).values({ id: `${P}m1`, code: "COSK1", name: "Đầm COSK1", lifecycleState: "PRODUCTION_DISCUSSION", registeredBy: "USER" }).returning();
  const [m2] = await db.insert(schema.productModels).values({ id: `${P}m2`, code: "COSK2", name: "Áo COSK2", lifecycleState: "WINNER", registeredBy: "USER" }).returning();
  const dong = [{ kind: "FABRIC" as const, description: "Vải", qty: 1.2, unit: "m", unitCost: 50_000 }];

  // ── (a) Lượt chuyển vòng đời NÉM ⇒ phiên bản giá thành cũng không còn ──
  // Trình kích hoạt tạm trên bảng lịch sử vòng đời, CHỈ cho mẫu thử này: bước vòng đời hỏng ở tầng CSDL.
  await db.execute(sql.raw(`create or replace function cos_k_no() returns trigger language plpgsql as $$ begin if new.model_id = '${P}m1' then raise exception 'cos-k: lịch sử vòng đời hỏng'; end if; return new; end $$`));
  await db.execute(sql.raw(`create trigger cos_k_no_hist before insert on product_model_state_history for each row execute function cos_k_no()`));
  try {
    await assert.rejects(
      () => createCostSheetCore(db, { modelId: m1.id, topicId: null, lines: dong, notes: "", actor: nguoi }),
      (e) => /lịch sử vòng đời hỏng/.test(lanTheoLoi(e)),
      "bước vòng đời hỏng phải nổi lên thành lỗi",
    );
  } finally {
    await db.execute(sql.raw(`drop trigger if exists cos_k_no_hist on product_model_state_history`));
  }
  const bangSau = await db.select({ id: schema.costSheets.id }).from(schema.costSheets).where(eq(schema.costSheets.modelId, m1.id));
  assert.equal(bangSau.length, 0, "vòng đời hỏng ⇒ phiên bản giá thành bị huỷ theo (trước đây nó đã chốt RỒI mới đi theo vòng đời)");
  const suKienSau = await db.select({ id: schema.domainEvents.id }).from(schema.domainEvents).where(and(eq(schema.domainEvents.modelId, m1.id), eq(schema.domainEvents.name, "costing.version_created")));
  assert.equal(suKienSau.length, 0, "sự kiện gây ra cũng bị huỷ — không có sự kiện nào mà vòng đời không đi theo");
  assert.equal(await trangThai(db, m1.id), "PRODUCTION_DISCUSSION");

  // ── (b) Hết hỏng ⇒ cùng hành động đi trọn: bảng + sự kiện + lượt chuyển, lượt chuyển trỏ về sự kiện ──
  const v1 = await createCostSheetCore(db, { modelId: m1.id, topicId: null, lines: dong, notes: "", actor: nguoi });
  assert.ok("ok" in v1 && v1.lifecycle.moved, "PRODUCTION_DISCUSSION → COSTING đi theo");
  if (!("ok" in v1)) return;
  const [h] = await db.select().from(schema.productModelStateHistory).where(eq(schema.productModelStateHistory.modelId, m1.id));
  assert.equal(h.sourceEventId, v1.eventId, "lượt chuyển trỏ đúng sự kiện gây ra nó");
  assert.equal(h.actorKind, "SYSTEM");

  // ── (c) Hành động nghiệp vụ hỏng LÚC CHỐT (sau khi vòng đời đã đi) ⇒ lượt chuyển cũng biến mất ──
  // Ràng buộc hoãn tới lúc COMMIT trên bảng topic: mọi câu lệnh trong giao dịch đã chạy xong, kể cả lượt
  // chuyển vòng đời, rồi giao dịch mới đổ.
  await db.execute(sql.raw(`create or replace function cos_k_no_topic() returns trigger language plpgsql as $$ begin if new.model_id = '${P}m2' then raise exception 'cos-k: topic hỏng lúc chốt'; end if; return new; end $$`));
  await db.execute(sql.raw(`create constraint trigger cos_k_no_topic_commit after insert on production_topics deferrable initially deferred for each row execute function cos_k_no_topic()`));
  const evidence = { kind: "SNAPSHOT" as const, capturedAt: new Date().toISOString(), basis: "kiểm thử K", productId: null, orders30d: null, ordersTotal: null, adSpend30d: null };
  const req = { material: "", colors: [], sizes: [], trims: "", designNotes: "", targetPrice: null, expectedQty: null, deadline: null };
  try {
    await assert.rejects(
      () => createTopicCore(db, { modelId: m2.id, title: "Hỏi giá COSK2", requirements: req, supplierId: null, evidence, actor: nguoi }),
      (e) => /topic hỏng lúc chốt/.test(lanTheoLoi(e)),
    );
  } finally {
    await db.execute(sql.raw(`drop trigger if exists cos_k_no_topic_commit on production_topics`));
  }
  assert.equal(await trangThai(db, m2.id), "WINNER", "giao dịch nghiệp vụ đổ ⇒ vòng đời KHÔNG đứng ở Bàn sản xuất");
  assert.equal(await demLichSu(db, m2.id), 0, "không dòng lịch sử mồ côi");

  // ── (d) Được trao giao dịch thì KHÔNG mở giao dịch lồng ──
  const lanLong = await db.transaction(async (tx) => {
    const goc = tx.transaction.bind(tx);
    let longNhau = 0;
    (tx as unknown as { transaction: typeof goc }).transaction = ((...a: Parameters<typeof goc>) => {
      longNhau += 1;
      return goc(...a);
    }) as typeof goc;
    const r = await transitionModelCore(tx, { modelId: m2.id, to: "PRODUCTION_DISCUSSION", actor: nguoi, actorKind: "USER", source: "test:k" });
    assert.ok("ok" in r, "chuyển được trong giao dịch của nơi gọi");
    return longNhau;
  });
  assert.equal(lanLong, 0, "transitionModelCore nhận giao dịch đang mở thì chạy thẳng trong nó, không mở savepoint");
  assert.equal(await trangThai(db, m2.id), "PRODUCTION_DISCUSSION");

  // ── (e) Phát lại: không dòng thứ hai ──
  const truoc = await demLichSu(db, m1.id);
  const phatLai = await db.transaction((tx) => transitionModelCore(tx, { modelId: m1.id, to: "COSTING", actor: { id: null, label: "job:phát lại" }, actorKind: "SYSTEM", source: "event:costing.version_created", sourceEventId: v1.eventId }));
  assert.ok("ok" in phatLai && phatLai.replayed, "cùng sự kiện gây ra ⇒ lượt chuyển cũ, không ghi lại");
  const theoLai = await db.transaction((tx) => followModelLifecycle(tx, { modelId: m1.id, eventName: "costing.version_created", eventId: null, triggeredBy: nguoi, related: { type: "cost_sheet", id: v1.costSheetId } }));
  assert.equal(theoLai.moved ? "moved" : theoLai.reason, "NO_EVENT", "sự kiện trùng (id null) ⇒ không làm gì");
  assert.equal(await demLichSu(db, m1.id), truoc, "phát lại không đẻ dòng lịch sử");

  console.log("✓ Company OS · K1: vòng đời mẫu đi theo TRONG giao dịch nghiệp vụ — vòng đời hỏng ⇒ giá thành huỷ theo · nghiệp vụ đổ lúc chốt ⇒ không lượt chuyển mồ côi · không savepoint lồng · phát lại không ghi lần hai");
}

// ─────────────────────────── 2. getSettingJson VỚI GIÁ TRỊ NGUYÊN THUỶ ───────────────────────────

/** Luật CŨ, chép nguyên văn để so: mọi khoá object phải đọc ra y như vậy. */
function mergeCu<T>(raw: string, fallback: T): T {
  try {
    return { ...fallback, ...(JSON.parse(raw) as Partial<T>) } as T;
  } catch {
    return fallback;
  }
}

/** Tách đối số cấp ngoài cùng của lời gọi có dấu `(` ở vị trí `mo`. */
function doiSo(src: string, mo: number): string[] {
  const out: string[] = [];
  let sau = 0;
  let cur = "";
  let chuoi: string | null = null;
  for (let i = mo + 1; i < src.length; i++) {
    const c = src[i];
    if (chuoi) {
      cur += c;
      if (c === chuoi && src[i - 1] !== "\\") chuoi = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      chuoi = c;
      cur += c;
      continue;
    }
    if ("([{".includes(c)) sau++;
    if (")]}".includes(c)) {
      if (sau === 0) {
        out.push(cur.trim());
        return out;
      }
      sau--;
    }
    if (c === "," && sau === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  return out;
}

type LoiGoiSetting = { file: string; key: string; fallbackText: string };

/** Mọi lời gọi `getSettingJson(key, fallback)` trong mã nguồn đã vào kho (lib · app · scripts). */
function loiGoiGetSettingJson(): LoiGoiSetting[] {
  const tep = execSync("git ls-files lib app scripts", { encoding: "utf8" })
    .split("\n")
    .map((f) => f.trim())
    .filter((f) => /\.(ts|tsx)$/.test(f) && f !== "lib/settings.ts" && existsSync(f));
  const out: LoiGoiSetting[] = [];
  for (const file of tep) {
    const src = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const re = /getSettingJson\s*(<)?/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      let i = m.index + m[0].length;
      if (m[1]) {
        // Bỏ tham số kiểu (có thể lồng `<…<…>>` và xuống dòng; `=>` không đóng ngoặc nhọn).
        let sau = 1;
        while (i < src.length && sau > 0) {
          if (src[i] === "<") sau++;
          else if (src[i] === ">" && src[i - 1] !== "=") sau--;
          i++;
        }
      }
      while (/\s/.test(src[i] ?? "")) i++;
      if (src[i] !== "(") continue; // `import { getSettingJson }`, chú thích còn sót…
      const a = doiSo(src, i);
      if (a.length === 2) out.push({ file, key: a[0], fallbackText: a[1] });
    }
  }
  return out;
}

/** Giá trị của một hằng số được export ở lib/** (mặc định cấu hình). */
async function giaTriHang(ten: string): Promise<{ found: true; value: unknown } | { found: false }> {
  const tep = execSync("git ls-files lib", { encoding: "utf8" }).split("\n").map((f) => f.trim()).filter((f) => /\.ts$/.test(f));
  for (const f of tep) {
    if (!new RegExp(`export const ${ten}\\b`).test(readFileSync(f, "utf8"))) continue;
    const mod = (await import(`@/${f.replace(/\.ts$/, "")}`)) as Record<string, unknown>;
    if (ten in mod) return { found: true, value: mod[ten] };
  }
  return { found: false };
}

/** Khoá được đọc qua `getSettingJson` mà giá trị là NGUYÊN THUỶ — khai tường minh, kèm lý do. */
const KHOA_NGUYEN_THUY: Record<string, string> = {
  REQUIRE_APPROVED_DESIGN_KEY: "cờ bật / tắt bắt buộc bản duyệt (JSON true) — Agent C",
};

export async function testHardeningSettingsPrimitive(db: Db) {
  // ── (a) Luật mới cho giá trị nguyên thuỷ ──
  assert.deepEqual(mergeCu("true", false), {}, "luật CŨ: cờ boolean đọc ra object rỗng — đúng lỗi C báo");
  assert.equal(mergeSettingJson("true", false), true, "JSON true đọc ra true");
  assert.equal(mergeSettingJson("false", true), false);
  assert.equal(mergeSettingJson("42", 0), 42);
  assert.equal(mergeSettingJson('"abc"', ""), "abc");
  assert.equal(mergeSettingJson("true", null), true, "mặc định null nhận mọi giá trị nguyên thuỷ");
  assert.equal(mergeSettingJson('"true"', false), false, "chuỗi “true” KHÁC KIỂU với cờ boolean ⇒ mặc định, không ép kiểu");
  assert.equal(mergeSettingJson("1", false), false, "số 1 không phải true");
  assert.equal(mergeSettingJson("null", false), false, "JSON null ⇒ mặc định");
  assert.equal(mergeSettingJson("null", null), null);
  assert.equal(mergeSettingJson("{hỏng", true), true, "JSON hỏng ⇒ mặc định");

  // ── (b) MỌI lời gọi có mặc định object: đọc ra Y NHƯ luật cũ với mọi kiểu giá trị đã lưu ──
  const loiGoi = loiGoiGetSettingJson();
  assert.ok(loiGoi.length >= 40, `đọc hụt lời gọi getSettingJson (chỉ thấy ${loiGoi.length})`);
  const mauDaLuu = ['{"a":1,"enabled":true}', "{}", '{"list":[{"id":"x"}]}', "[1,2]", "[]", "true", "false", "0", "7", '"chuoi"', '""', "null", "{hỏng"];
  const khoaObject = new Set<string>();
  const nguyenThuy: string[] = [];
  let soSanh = 0;
  for (const g of loiGoi) {
    const t = g.fallbackText;
    let fb: unknown;
    let biet = true;
    if (t === "null") fb = null;
    else if (t === "true" || t === "false") fb = t === "true";
    else if (/^-?\d+$/.test(t)) fb = Number(t);
    else if (/^["']/.test(t)) fb = t.slice(1, -1);
    else if (t.startsWith("{") || t.startsWith("[")) {
      try {
        fb = new Function(`return (${t});`)();
      } catch {
        // Object có định danh bên trong (`{ presets: X }`) — vẫn là object; so bằng một object đại diện.
        fb = { doiDien: t };
      }
    } else if (/^[A-Z][A-Z0-9_]*$/.test(t)) {
      const v = await giaTriHang(t);
      assert.ok(v.found, `${g.file}: không tìm thấy hằng số mặc định ${t}`);
      fb = v.found ? v.value : undefined;
    } else biet = false;
    assert.ok(biet, `${g.file}: mặc định "${t}" không nhận diện được — thêm nhánh vào bài kiểm`);
    const laObject = fb !== null && typeof fb === "object";
    if (!laObject && fb !== null) {
      nguyenThuy.push(g.key);
      assert.ok(g.key in KHOA_NGUYEN_THUY, `${g.file}: ${g.key} đọc với mặc định nguyên thuỷ nhưng chưa khai ở KHOA_NGUYEN_THUY`);
      continue;
    }
    if (!laObject) continue;
    khoaObject.add(g.key);
    for (const raw of mauDaLuu) {
      assert.deepEqual(mergeSettingJson(raw, fb), mergeCu(raw, fb), `${g.file}: ${g.key} với giá trị đã lưu ${raw} phải đọc ra Y NHƯ luật cũ`);
      soSanh++;
    }
  }
  assert.ok(khoaObject.size >= 30, `phải so được hầu hết khoá object (mới ${khoaObject.size})`);
  assert.deepEqual(nguyenThuy, ["REQUIRE_APPROVED_DESIGN_KEY"], "đúng một khoá nguyên thuỷ đọc qua getSettingJson: cờ bản duyệt của C");

  // ── (c) Đường đọc thật trên CSDL: cờ bản duyệt đi qua bộ đọc chung, cùng hành vi mọi nhánh ──
  const nguonC = readFileSync("lib/queries/production-os.ts", "utf8");
  assert.match(nguonC, /getSettingJson<boolean>\(REQUIRE_APPROVED_DESIGN_KEY, false\)/, "cờ bản duyệt đọc qua bộ đọc chung");
  assert.ok(!/findFirst\(\{ where: eq\(schema\.settings\.key, REQUIRE_APPROVED_DESIGN_KEY\)/.test(nguonC), "bỏ bản đọc thẳng dòng");
  const [cu] = await db.select().from(schema.settings).where(eq(schema.settings.key, REQUIRE_APPROVED_DESIGN_KEY));
  try {
    await db.delete(schema.settings).where(eq(schema.settings.key, REQUIRE_APPROVED_DESIGN_KEY));
    assert.equal(await requireApprovedDesignFlag(), false, "không có dòng ⇒ TẮT");
    await setSettingJson(REQUIRE_APPROVED_DESIGN_KEY, true);
    assert.equal(await requireApprovedDesignFlag(), true, "JSON true ⇒ BẬT");
    assert.equal(await getSettingJson<boolean>(REQUIRE_APPROVED_DESIGN_KEY, false), true);
    await setSettingJson(REQUIRE_APPROVED_DESIGN_KEY, "true");
    assert.equal(await requireApprovedDesignFlag(), false, "chuỗi “true” ⇒ TẮT");
    await db.update(schema.settings).set({ value: "{hỏng" }).where(eq(schema.settings.key, REQUIRE_APPROVED_DESIGN_KEY));
    assert.equal(await requireApprovedDesignFlag(), false, "JSON hỏng ⇒ TẮT");
  } finally {
    await db.delete(schema.settings).where(eq(schema.settings.key, REQUIRE_APPROVED_DESIGN_KEY));
    if (cu) await db.insert(schema.settings).values(cu);
  }

  console.log(`✓ Company OS · K2: getSettingJson đọc được boolean / số / chuỗi (khác kiểu ⇒ mặc định) · ${khoaObject.size} khoá object × ${mauDaLuu.length} dạng giá trị = ${soSanh} phép so, Y NHƯ luật cũ · cờ bản duyệt của C đi qua bộ đọc chung`);
}

// ─────────────────────────── 3. LỜI DUYỆT KHÔNG MẤT KHI THAO TÁC HỎNG ───────────────────────────

type DongDuyet = typeof schema.approvalRequests.$inferSelect;

async function yeuCau(db: Db, id: string): Promise<DongDuyet> {
  const [r] = await db.select().from(schema.approvalRequests).where(eq(schema.approvalRequests.id, id));
  return r;
}

async function demSuKienDuyet(db: Db, id: string): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.domainEvents).where(and(eq(schema.domainEvents.name, "approval.executed"), eq(schema.domainEvents.subjectId, id)));
  return Number(r.n);
}

/** Thân các export trong một tệp "use server" — cắt theo `\nexport ` kế tiếp. */
function thanCacHam(src: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  const re = /^export async function (\w+)\(/gm;
  const vt: { name: string; at: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) vt.push({ name: m[1], at: m.index });
  vt.forEach((v, i) => out.push({ name: v.name, body: src.slice(v.at, i + 1 < vt.length ? vt[i + 1].at : undefined) }));
  return out;
}

/**
 * Nơi gọi cổng mà CHƯA thanh toán theo kết quả — khai tường minh, kèm lý do. Một lời gọi mới không bọc
 * mà không khai ở đây là ĐỎ.
 */
const CONG_CHUA_THANH_TOAN: Record<string, string> = {
  "lib/actions/return-dispositions.ts:setReturnDisposition":
    "thuộc vùng Agent R đang sửa song song (lib/returns/*, return_dispositions) — cổng chạy IMMEDIATE như cũ; nêu ở handoff-k mục mở",
};

export async function testHardeningApprovalExecution(db: Db) {
  const R = `${P}xin`;
  const A = `${P}duyet`;
  await db
    .insert(schema.users)
    .values([
      { id: R, email: "cos-k-xin@test.local", name: "Người xin K", passwordHash: "x", role: "LEADER" },
      { id: A, email: "cos-k-duyet@test.local", name: "Người duyệt K", passwordHash: "x", role: "MANAGER" },
    ])
    .onConflictDoNothing();
  const xin: ApprovalUser = { id: R, email: "cos-k-xin@test.local" };
  const [cauHinhCu] = await db.select().from(schema.settings).where(eq(schema.settings.key, APPROVAL_ENFORCE_KEY));
  await db
    .insert(schema.settings)
    .values({ key: APPROVAL_ENFORCE_KEY, value: JSON.stringify({ v: 2, groups: { INVENTORY_ADJUSTMENT: true, EXPENSE_EDIT: true } }) })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: JSON.stringify({ v: 2, groups: { INVENTORY_ADJUSTMENT: true, EXPENSE_EDIT: true } }) } });

  let so = 0;
  const viec = (): GuardInput => ({ group: "EXPENSE_EDIT", action: "expense.update", entity: "EXPENSE", entityId: `${P}chi-${++so}`, summary: "Sửa khoản chi kiểm K", amount: 9_000_000, payload: { so } });
  /** Xin + người khác duyệt ⇒ id yêu cầu đã APPROVED cho đúng việc `v`. */
  const duocDuyet = async (v: GuardInput): Promise<string> => {
    const g = await guardSecondApprovalCore(db, xin, v);
    assert.equal(g.mode, "NEEDS_APPROVAL", "tiền đề: cưỡng chế bật ⇒ phải xin");
    const d = await decideApprovalCore(db, { id: A, email: "cos-k-duyet@test.local", canDecide: true }, g.requestId!, true, undefined);
    assert.ok("ok" in d);
    return g.requestId!;
  };

  try {
    // ── (a) DEFERRED · thao tác xong ⇒ EXECUTED + đúng một approval.executed ──
    const v1 = viec();
    const id1 = await duocDuyet(v1);
    const r1 = await withApprovalExecution(async () => {
      const g = await guardWithinScope(db, xin, v1);
      assert.ok(g.consumed && g.settlement === "DEFERRED", "trong phạm vi thanh toán ⇒ tiêu thụ GIỮ CHỖ");
      assert.equal((await yeuCau(db, id1)).status, "EXECUTED", "giữ chỗ: lật EXECUTED ngay để lượt đồng thời không lấy được");
      assert.equal(await demSuKienDuyet(db, id1), 0, "sự kiện CHƯA phát khi thao tác chưa xong");
      return { ok: true as const };
    });
    assert.ok("ok" in r1);
    const sau1 = await yeuCau(db, id1);
    assert.deepEqual([sau1.status, sau1.executionError], ["EXECUTED", null]);
    assert.equal(await demSuKienDuyet(db, id1), 1, "thao tác xong ⇒ đúng một approval.executed");
    const [ev1] = await db.select().from(schema.domainEvents).where(eq(schema.domainEvents.dedupeKey, approvalExecutedDedupeKey(id1)));
    assert.deepEqual([ev1.subjectType, ev1.actorKind, ev1.actorId, ev1.modelId], ["approval_request", "USER", R, null]);
    assert.equal(DOMAIN_EVENT_BY_NAME["approval.executed"].status, "LIVE");
    assert.equal((await confirmApprovalExecution(db, id1, xin)).eventId, null, "khẳng định lại ⇒ trùng khoá, không sự kiện thứ hai");
    assert.equal(await releaseApprovalExecution(db, id1, "muộn", xin), false, "lượt đã khẳng định xong KHÔNG bao giờ bị hồi sinh");
    assert.equal((await yeuCau(db, id1)).status, "EXECUTED");

    // ── (b) DEFERRED · thao tác trả { error } ⇒ lời duyệt trả lại + execution_error; làm lại không cần xin lại ──
    const v2 = viec();
    const id2 = await duocDuyet(v2);
    const hong = await withApprovalExecution(async () => {
      const g = await guardWithinScope(db, xin, v2);
      assert.ok(g.consumed);
      return { error: "Khoản chi vừa bị khoá sổ — ghi không được" };
    });
    assert.ok("error" in hong);
    const sau2 = await yeuCau(db, id2);
    assert.deepEqual([sau2.status, sau2.executedAt, sau2.executionError], ["APPROVED", null, "Khoản chi vừa bị khoá sổ — ghi không được"], "thao tác hỏng ⇒ lời duyệt còn nguyên, kèm câu lỗi");
    assert.equal(await demSuKienDuyet(db, id2), 0, "không có sự kiện 'đã thực hiện' cho việc chưa chạy");
    const lai = await withApprovalExecution(async () => {
      const g = await guardWithinScope(db, xin, v2);
      assert.ok(g.consumed && g.requestId === id2, "làm lại ĐÚNG việc ⇒ dùng lại ĐÚNG lời duyệt cũ");
      return { ok: true as const };
    });
    assert.ok("ok" in lai);
    const sau2b = await yeuCau(db, id2);
    assert.deepEqual([sau2b.status, sau2b.executionError], ["EXECUTED", null], "lần sau xong ⇒ EXECUTED, câu lỗi cũ xoá");
    assert.equal(await demSuKienDuyet(db, id2), 1);

    // ── (c) DEFERRED · thao tác NÉM ⇒ như trên, lỗi vẫn nổi lên ──
    const v3 = viec();
    const id3 = await duocDuyet(v3);
    await assert.rejects(
      () =>
        withApprovalExecution(async () => {
          await guardWithinScope(db, xin, v3);
          throw new Error("mất kết nối giữa chừng");
        }),
      /mất kết nối/,
    );
    const sau3 = await yeuCau(db, id3);
    assert.deepEqual([sau3.status, sau3.executionError], ["APPROVED", "mất kết nối giữa chừng"]);

    // ── (d) Hai lượt ĐỒNG THỜI trong phạm vi thanh toán: đúng một lượt tiêu thụ ──
    const v4 = viec();
    const id4 = await duocDuyet(v4);
    const hai = await Promise.all(
      [0, 1].map(() =>
        withApprovalExecution(async () => {
          const g = await guardWithinScope(db, xin, v4);
          return g.consumed ? { ok: true as const } : { error: `không tiêu thụ (${g.mode})` };
        }),
      ),
    );
    assert.equal(hai.filter((x) => "ok" in x).length, 1, "đồng thời chỉ MỘT lượt thắng");
    assert.equal((await yeuCau(db, id4)).status, "EXECUTED");
    assert.equal(await demSuKienDuyet(db, id4), 1);

    // ── (e) Ngoài phạm vi (IMMEDIATE): hành vi cũ + sự kiện trong CÙNG giao dịch với lượt lật ──
    const v5 = viec();
    const id5 = await duocDuyet(v5);
    const g5 = await guardSecondApprovalCore(db, xin, v5);
    assert.ok(g5.consumed && g5.settlement === "IMMEDIATE");
    assert.equal(await demSuKienDuyet(db, id5), 1);

    // ── (f) IN_TRANSACTION · phiếu kho thật: phiếu hỏng ⇒ lời duyệt còn; phiếu xong ⇒ lật + sự kiện cùng giao dịch ──
    await db.insert(schema.products).values({ id: `${P}p-kho`, name: "Đầm COSK kho", customId: "COSKKHO" }).onConflictDoNothing();
    await db.insert(schema.productVariants).values({ id: `${P}v-kho`, productId: `${P}p-kho`, sku: "COSKKHO-M", color: "Đen", size: "M" }).onConflictDoNothing();
    const nguoiKho = { id: R, label: "Người xin K" };
    const congKho: GuardInput = { group: "INVENTORY_ADJUSTMENT", action: "stock.adjustment", entity: "STOCK_RECEIPT", summary: "Điều chỉnh kiểm kê COSK", amount: null, payload: { ref: `${P}kk-1` } };
    const phieu = (variantId: string) => ({
      kind: "ADJUSTMENT" as const,
      receipt: { receivedAt: new Date(), reference: `${P}kk-1`, supplier: "", supplierId: null, productionOrderId: null, productionBatchId: null, note: "", totalQuantity: 2, totalCost: 0, createdBy: "Người xin K" },
      lines: [{ variantId, quantity: 2, unitCost: 0, shipmentId: null }],
      note: "",
      actor: nguoiKho,
      approver: xin,
      gate: congKho,
    });
    const demPhieu = async () => Number((await db.select({ n: sql<number>`count(*)::int` }).from(schema.stockReceipts).where(eq(schema.stockReceipts.reference, `${P}kk-1`)))[0].n);
    const xinKho = await writeStockReceiptCore(db, phieu(`${P}v-kho`));
    assert.ok("error" in xinKho && xinKho.gate?.mode === "NEEDS_APPROVAL", "cưỡng chế bật ⇒ phiếu dừng ở cổng, yêu cầu được ghi");
    assert.equal(await demPhieu(), 0);
    const idKho = xinKho.gate!.requestId!;
    assert.equal((await yeuCau(db, idKho)).status, "PENDING", "yêu cầu ghi trong giao dịch vẫn còn sau khi phiếu dừng");
    await decideApprovalCore(db, { id: A, email: "cos-k-duyet@test.local", canDecide: true }, idKho, true, undefined);
    // Phiếu hỏng GIỮA giao dịch (dòng trỏ mẫu mã không tồn tại ⇒ khoá ngoại) — SAU khi cổng đã tiêu thụ.
    await assert.rejects(() => writeStockReceiptCore(db, phieu(`${P}v-khong-co`)));
    const sauHong = await yeuCau(db, idKho);
    assert.equal(sauHong.status, "APPROVED", "phiếu hỏng ⇒ lượt tiêu thụ huỷ theo giao dịch, lời duyệt còn nguyên");
    assert.ok((sauHong.executionError ?? "").length > 0, "câu lỗi được ghi lại cho người xin / người duyệt");
    assert.equal(await demSuKienDuyet(db, idKho), 0);
    assert.equal(await demPhieu(), 0, "không phiếu nửa vời");
    const xong = await writeStockReceiptCore(db, phieu(`${P}v-kho`));
    assert.ok("ok" in xong && xong.gate?.consumed && xong.gate.settlement === "IN_TRANSACTION", "làm lại ⇒ dùng đúng lời duyệt, tiêu thụ TRONG giao dịch phiếu");
    const sauXong = await yeuCau(db, idKho);
    assert.deepEqual([sauXong.status, sauXong.executionError], ["EXECUTED", null]);
    assert.equal(await demSuKienDuyet(db, idKho), 1);
    assert.equal(await demPhieu(), 1);
    const lan3 = await writeStockReceiptCore(db, phieu(`${P}v-kho`));
    assert.ok("error" in lan3 && lan3.gate?.mode === "NEEDS_APPROVAL", "lời duyệt dùng một lần — lần ba phải xin lại");
    assert.equal(await demPhieu(), 1, "không phiếu thứ hai");
    const nhatKy = await db.select({ action: schema.auditLogs.action }).from(schema.auditLogs).where(eq(schema.auditLogs.entityId, idKho));
    assert.ok(nhatKy.some((x) => x.action === "approval.execute:stock.adjustment"), "nhật ký cổng ghi SAU khi giao dịch chốt");
    assert.ok(nhatKy.some((x) => x.action === "approval.execute_failed:stock.adjustment"), "lượt hỏng để lại dòng nhật ký");

    // ── (g) Cổng trong giao dịch mà không hoãn nhật ký ⇒ lỗi lập trình (khoá chết trên PGlite) ──
    await assert.rejects(() => db.transaction((tx) => guardSecondApprovalCore(tx, xin, viec())), /auditSink/);

    // ── (h) Quét mã nguồn: mọi action gọi cổng đều thanh toán theo kết quả ──
    const chuaBoc: string[] = [];
    const tep = execSync("git ls-files lib/actions", { encoding: "utf8" }).split("\n").map((f) => f.trim()).filter((f) => f.endsWith(".ts") && f !== "lib/actions/approvals.ts");
    for (const f of tep) {
      const khongChuThich = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      for (const h of thanCacHam(khongChuThich)) {
        if (!/\bguardSecondApproval\b/.test(h.body)) continue;
        const boc = /^export async function \w+\([^]*?\{\s*\n\s*return withApprovalExecution\(async \(\) => \{/.test(h.body);
        if (!boc && !(`${f}:${h.name}` in CONG_CHUA_THANH_TOAN)) chuaBoc.push(`${f}:${h.name}`);
      }
    }
    assert.deepEqual(chuaBoc, [], "action gọi guardSecondApproval phải bọc thân bằng withApprovalExecution (hoặc khai ở CONG_CHUA_THANH_TOAN kèm lý do)");
    assert.ok(!/^\s*["']use server["'];?\s*$/m.test(readFileSync("lib/approvals/execution.ts", "utf8")),"hàm trả lời duyệt về APPROVED KHÔNG được là server action");
  } finally {
    if (cauHinhCu) await db.update(schema.settings).set({ value: cauHinhCu.value }).where(eq(schema.settings.key, APPROVAL_ENFORCE_KEY));
    else await db.delete(schema.settings).where(eq(schema.settings.key, APPROVAL_ENFORCE_KEY));
  }

  console.log("✓ Company OS · K3: lời duyệt không mất khi thao tác hỏng — giữ chỗ rồi thanh toán theo kết quả (xong ⇒ approval.executed; { error } / ném ⇒ APPROVED + execution_error) · phiếu kho tiêu thụ TRONG giao dịch · đồng thời một lượt thắng · lượt đã xong không hồi sinh · mọi action gọi cổng đều thanh toán");
}

// ─────────────────────────── 4. PHIẾU NHẬP NỐI SẢN XUẤT ⇒ SỰ KIỆN ───────────────────────────

export async function testHardeningReceiptLinkedEvent(db: Db) {
  const U = `${P}kho4`;
  await db.insert(schema.users).values({ id: U, email: "cos-k-kho4@test.local", name: "Kho K4", passwordHash: "x", role: "LEADER" }).onConflictDoNothing();
  const nguoi = { id: U, label: "Kho K4" };
  await db.insert(schema.products).values([
    { id: `${P}p4`, name: "Đầm COSK4", customId: "COSK4" },
    { id: `${P}p5`, name: "Áo COSK5 (chưa vào sổ mẫu)", customId: "COSK5" },
  ]);
  await db.insert(schema.productVariants).values([
    { id: `${P}v4`, productId: `${P}p4`, sku: "COSK4-M", color: "Đen", size: "M" },
    { id: `${P}v5`, productId: `${P}p5`, sku: "COSK5-M", color: "Trắng", size: "M" },
  ]);
  const [m4] = await db.insert(schema.productModels).values({ id: `${P}m4`, code: "COSK4", name: "Đầm COSK4", productId: `${P}p4`, lifecycleState: "IN_PRODUCTION", registeredBy: "USER" }).returning();
  await db.insert(schema.productionOrders).values({ id: `${P}po4`, code: `${P}PO-4`, productId: `${P}p4`, productName: "Đầm COSK4", colors: ["Đen"], sizes: ["M"], cells: { "Đen|M": 30 }, totalQty: 30, status: "SENT" });
  await db.insert(schema.productionBatches).values({ id: `${P}lo5`, productId: `${P}p5`, productCode: "COSK5", batchNo: 1, orderedAt: new Date(), orderedQty: 10 });

  const phieu = (o: { po?: string | null; lo?: string | null; variantId: string; ref: string }) => ({
    kind: "RECEIPT" as const,
    receipt: { receivedAt: new Date(), reference: o.ref, supplier: "", supplierId: null, productionOrderId: o.po ?? null, productionBatchId: o.lo ?? null, note: "", totalQuantity: 30, totalCost: 0, createdBy: "Kho K4" },
    lines: [{ variantId: o.variantId, quantity: 30, unitCost: 0, shipmentId: null }],
    note: "",
    actor: nguoi,
    approver: { id: U, email: "cos-k-kho4@test.local" },
    gate: null,
  });
  const suKien = async (receiptId: string) =>
    db.select().from(schema.domainEvents).where(and(eq(schema.domainEvents.name, "stock_receipt.linked_production"), eq(schema.domainEvents.subjectId, receiptId)));

  // ── (a) Phiếu nối lệnh SX ⇒ đúng một sự kiện, mẫu = mẫu của sản phẩm trong lệnh ──
  const a = await writeStockReceiptCore(db, phieu({ po: `${P}po4`, variantId: `${P}v4`, ref: `${P}nhap-po` }));
  assert.ok("ok" in a);
  if (!("ok" in a)) return;
  const [ea, ...thua] = await suKien(a.receiptId);
  assert.ok(ea, "phiếu nối lệnh SX phải phát stock_receipt.linked_production");
  assert.equal(thua.length, 0, "một phiếu, một sự kiện");
  assert.deepEqual([ea.subjectType, ea.modelId, ea.actorKind, ea.actorId, ea.dedupeKey], ["stock_receipt", m4.id, "USER", U, `stock_receipt.linked_production:${a.receiptId}`]);
  assert.deepEqual((ea.payload as { productionOrderId?: string; productId?: string }).productionOrderId, `${P}po4`);
  assert.equal((ea.payload as { productId?: string }).productId, `${P}p4`);
  assert.equal(DOMAIN_EVENT_BY_NAME["stock_receipt.linked_production"].status, "LIVE");
  assert.equal(domainEventDimension("stock_receipt.linked_production"), "INVENTORY", "đứng ở chiều Kho trên dòng thời gian mẫu");
  const dong = await getModelTimeline(m4.id);
  assert.ok(dong.some((e) => e.basis === "RECORDED" && e.dimension === "INVENTORY" && e.title === "Phiếu nhập nối lệnh / lô sản xuất"), "trang 360 của mẫu thấy mốc phiếu nhập nối lệnh");

  // ── (b) Phiếu chỉ nối lô xưởng, sản phẩm của lô chưa vào sổ mẫu ⇒ sự kiện với model_id NULL (không đoán) ──
  const b = await writeStockReceiptCore(db, phieu({ lo: `${P}lo5`, variantId: `${P}v5`, ref: `${P}nhap-lo` }));
  assert.ok("ok" in b);
  if (!("ok" in b)) return;
  const [eb] = await suKien(b.receiptId);
  assert.ok(eb, "nối lô cũng phát");
  assert.deepEqual([eb.modelId, (eb.payload as { productionBatchId?: string }).productionBatchId, (eb.payload as { productId?: string }).productId], [null, `${P}lo5`, `${P}p5`]);

  // ── (c) Phiếu không nối ⇒ không sự kiện ──
  const c = await writeStockReceiptCore(db, phieu({ variantId: `${P}v4`, ref: `${P}nhap-tu-do` }));
  assert.ok("ok" in c && (await suKien(c.receiptId)).length === 0, "phiếu không nối sản xuất không phát gì");

  // ── (d) Phiếu hỏng giữa giao dịch ⇒ không sự kiện mồ côi ──
  await assert.rejects(() => writeStockReceiptCore(db, phieu({ po: `${P}po4`, variantId: `${P}v-khong-co`, ref: `${P}nhap-hong` })));
  const [{ n: moCoi }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.domainEvents)
    .where(and(eq(schema.domainEvents.name, "stock_receipt.linked_production"), eq(schema.domainEvents.modelId, m4.id)));
  assert.equal(Number(moCoi), 1, "phiếu đổ ⇒ sự kiện đổ theo");

  console.log("✓ Company OS · K4: phiếu nhập nối lệnh SX / lô xưởng ⇒ stock_receipt.linked_production LIVE, cùng giao dịch với phiếu · mẫu theo sản phẩm của lệnh / lô (chưa vào sổ ⇒ NULL, không đoán) · chiều Kho trên trang 360 · phiếu không nối / phiếu đổ không phát");
}

// ─────────────────────────── 5. "ĐÃ CÓ ĐƯỜNG SẢN XUẤT" — MỘT ĐỊNH NGHĨA ───────────────────────────

export async function testHardeningTopicTrackSemantics(db: Db) {
  // ── (a) Định nghĩa: mọi trạng thái trừ Đã đóng, KỂ CẢ Đã chốt phương án ──
  assert.deepEqual([...TOPIC_BLOCKS_NEW_SUGGESTION].sort(), TOPIC_STATUSES.filter((s) => s !== "CLOSED").sort());
  assert.ok(TOPIC_BLOCKS_NEW_SUGGESTION.includes("SELECTED") && !TOPIC_OPEN_STATUSES.includes("SELECTED"), "Đã chốt phương án chặn đề xuất dù đã rời hàng đợi");
  assert.equal(countTopicsBlockingSuggestion([{ status: "SELECTED" }, { status: "CLOSED" }]), 1);
  const chiChot = countTopicsBlockingSuggestion([{ status: "SELECTED" }]);
  const chiDong = countTopicsBlockingSuggestion([{ status: "CLOSED" }]);

  // ── (b) Luật topic sớm + trang 360: mẫu chỉ có topic ĐÃ CHỐT không được đề xuất mở topic lần nữa ──
  assert.equal(suggestsTopicOpening("PROMISING", "ADS_TESTING", chiChot), null, "TRIỂN VỌNG + topic đã chốt ⇒ không đề xuất mở sớm lần nữa");
  assert.equal(suggestsTopicOpening("WINNER", "WINNER", chiChot), null);
  assert.equal(suggestsTopicOpening("PROMISING", "ADS_TESTING", chiDong), "EARLY", "chỉ còn topic Đã đóng (có thể bỏ dở) ⇒ vẫn đề xuất");
  const base: SuggestionInput = { modelId: "k5", declaredState: "ADS_TESTING", signal: null, ads: null, inventory: null, creativeHref: null, periodQuery: "period=30d", production: { trackTopics: chiChot }, canCreateTopic: true };
  const moTopic = (s: ReturnType<typeof deriveModelSuggestions>) => s.filter((x) => ["topic-open-early", "topic-open", "lifecycle-production-discussion"].includes(x.key));
  assert.equal(moTopic(deriveModelSuggestions({ ...base, signal: { signal: "PROMISING", summary: "x" } })).length, 0, "trang 360: TRIỂN VỌNG + topic đã chốt ⇒ không đề xuất");
  assert.equal(moTopic(deriveModelSuggestions({ ...base, declaredState: "WINNER", signal: { signal: "WINNER", summary: "x" } })).length, 0, "trang 360: THẮNG + topic đã chốt ⇒ không đề xuất");
  assert.equal(moTopic(deriveModelSuggestions({ ...base, signal: { signal: "PROMISING", summary: "x" }, production: { trackTopics: chiDong } })).length, 1, "trang 360: chỉ topic đã đóng ⇒ đề xuất lại");
  assert.ok(productionTrackState({ topics: [{ status: "SELECTED" }], finalCosting: null, draftCostings: 0, latestSample: null, approvedDesign: null, openOrders: [] }), "topic đã chốt là chứng cứ đường sản xuất");
  assert.equal(productionTrackState({ topics: [{ status: "CLOSED" }], finalCosting: null, draftCostings: 0, latestSample: null, approvedDesign: null, openOrders: [] }), null);

  // ── (c) Buồng lái: lô tín hiệu đếm theo CÙNG định nghĩa; hai loại đề xuất đều bỏ mẫu đã chốt topic ──
  const ev = { kind: "SNAPSHOT", capturedAt: new Date().toISOString(), basis: "kiểm thử K5", productId: null, orders30d: null, ordersTotal: null, adSpend30d: null };
  const mau = async (code: string, status: "SELECTED" | "CLOSED" | null) => {
    const [m] = await db.insert(schema.productModels).values({ id: `${P}${code}`, code, name: code, lifecycleState: "ADS_TESTING", registeredBy: "USER" }).returning();
    if (status) await db.insert(schema.productionTopics).values({ modelId: m.id, title: `Topic ${code}`, status, selectedOption: status === "SELECTED" ? "Xưởng A · vải đũi" : null, evidenceSnapshot: ev });
    return m.id;
  };
  const idChot = await mau("COSK5-CHOT", "SELECTED");
  const idDong = await mau("COSK5-DONG", "CLOSED");
  const idTrong = await mau("COSK5-TRONG", null);
  clearMemo();
  const lo = await getModelSignalsBatch();
  const dong = (id: string) => {
    const r = lo.rows.find((x) => x.model.id === id);
    assert.ok(r, `lô phải có mẫu ${id}`);
    return r;
  };
  assert.deepEqual([dong(idChot).productionTrackTopics, dong(idDong).productionTrackTopics, dong(idTrong).productionTrackTopics], [1, 0, 0], "lô đếm topic đã chốt, bỏ topic đã đóng");
  const voi = (id: string, signal: "WINNER" | "PROMISING") => {
    const r = dong(id);
    return { ...r, signal: { ...r.signal, signal } };
  };
  const thang = modelWinnerCandidates([voi(idChot, "WINNER"), voi(idDong, "WINNER"), voi(idTrong, "WINNER")]).map((r) => r.model.id);
  assert.deepEqual(thang.sort(), [idDong, idTrong].sort(), "MODEL_SCALE: mẫu đã chốt topic không bị đề xuất mở topic lần nữa");
  const som = modelEarlyTopicCandidates([voi(idChot, "PROMISING"), voi(idDong, "PROMISING"), voi(idTrong, "PROMISING")]).map((r) => r.model.id);
  assert.deepEqual(som.sort(), [idDong, idTrong].sort(), "MODEL_EARLY_TOPIC: như trên");

  // ── (d) Mã nguồn: không nơi đề xuất nào tự viết lại tập trạng thái ──
  const bo = (f: string) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.match(bo("lib/queries/model-signal.ts"), /inArray\(t\.status, \[\.\.\.TOPIC_BLOCKS_NEW_SUGGESTION\]\)/, "lô tín hiệu đếm theo TOPIC_BLOCKS_NEW_SUGGESTION");
  assert.match(bo("app/(dashboard)/models/[id]/blocks.tsx"), /trackTopics: countTopicsBlockingSuggestion\(prod\.data\.topics\)/, "khối Đề xuất 360 đếm theo cùng hàm");
  for (const f of ["lib/constants/early-topic.ts", "lib/constants/model-360.ts", "lib/queries/owner-decisions.ts", "lib/queries/model-signal.ts"]) {
    assert.ok(!/status\s*!==\s*"CLOSED"|TOPIC_OPEN_STATUSES/.test(bo(f)), `${f}: đề xuất mở topic không được tự dựng tập trạng thái — dùng TOPIC_BLOCKS_NEW_SUGGESTION`);
  }

  console.log("✓ Company OS · K5: “đã có đường sản xuất” = mọi trạng thái topic trừ Đã đóng (KỂ CẢ Đã chốt phương án), một định nghĩa cho MODEL_SCALE · MODEL_EARLY_TOPIC · khối Đề xuất 360 · luật topic sớm; chỉ còn topic Đã đóng ⇒ vẫn đề xuất");
}
