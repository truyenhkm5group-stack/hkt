import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { REQUIRE_APPROVED_DESIGN_KEY } from "@/lib/constants/production-os";
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
