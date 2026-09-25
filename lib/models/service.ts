import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import type { Actor } from "@/lib/constants/actor";
import { MODEL_SUBJECT } from "@/lib/constants/domain-events";
import {
  checkModelTransition,
  isModelState,
  MODEL_REASON_MIN_LENGTH,
  MODEL_STATE_LABELS,
  normalizeModelCode,
  reasonIsEnough,
  type ModelActorKind,
  type ModelState,
} from "@/lib/constants/model-lifecycle";
import { emitDomainEvent } from "@/lib/events/emit";

/**
 * ═══════════ LÕI DỊCH VỤ SỔ MẪU (Company OS · Agent A) ═══════════
 *
 * KHÔNG "use server": server action (`lib/actions/models.ts`), job (`lib/sync/jobs.ts`) và các agent
 * sau (C/E/…) cùng gọi vào đây với một `Actor` — người hay máy đều đi MỘT đường.
 *
 * `transitionModelCore` là đường DUY NHẤT đổi `product_models.lifecycle_state`. Một giao dịch: kiểm cạnh →
 * UPDATE mẫu (có hàng rào trạng thái cũ) → INSERT lịch sử → phát `model.state_changed`. Không UPDATE thẳng
 * cột ấy ở bất kỳ chỗ nào khác.
 *
 * `product_model_state_history` và `domain_events` là APPEND-ONLY: tệp này chỉ INSERT vào chúng.
 */
type DbLike = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

const pm = schema.productModels;
const hist = schema.productModelStateHistory;

export type TransitionModelInput = {
  modelId: string;
  to: ModelState;
  /** Bắt buộc (≥ `MODEL_REASON_MIN_LENGTH` ký tự) khi `checkModelTransition` nói `needsReason`. */
  reason?: string | null;
  actor: Actor;
  actorKind: ModelActorKind;
  /** Nơi phát sinh: `ui:/models/<id>`, `event:sample.approved`… */
  source: string;
  /** Sự kiện miền GÂY RA lượt chuyển (khi máy chuyển theo một hành động nghiệp vụ — Q3). */
  sourceEventId?: string | null;
  related?: { type: string; id: string } | null;
  correlationId?: string | null;
  metadata?: Record<string, unknown>;
};

export type TransitionModelResult =
  | { ok: true; from: ModelState | null; to: ModelState; historyId: string; eventId: string | null; replayed: boolean }
  | { error: string };

/** Mục 34: người làm thì phải có khoá tài khoản. Chặn ở đây VÀ bằng CHECK ở CSDL. */
function actorError(actor: Actor, actorKind: ModelActorKind): string | null {
  if (actorKind === "USER" && !actor.id) return "Thao tác của người phải mang khoá tài khoản ERP (AGENTS.md mục 34)";
  return null;
}

/** Phần thân của một lượt chuyển, chạy TRONG giao dịch của nơi gọi. */
async function applyTransition(tx: DbLike, input: TransitionModelInput): Promise<TransitionModelResult> {
  const [m] = await tx.select({ id: pm.id, code: pm.code, state: pm.lifecycleState }).from(pm).where(eq(pm.id, input.modelId)).limit(1);
  if (!m) return { error: "Không tìm thấy mẫu trong sổ" };
  const from: ModelState | null = isModelState(m.state) ? m.state : null;

  // Máy chuyển theo một sự kiện: sự kiện gửi lại (job chạy lại) KHÔNG được ghi lượt thứ hai.
  if (input.sourceEventId) {
    const [daCo] = await tx
      .select({ id: hist.id, from: hist.fromState, to: hist.toState })
      .from(hist)
      .where(and(eq(hist.modelId, m.id), eq(hist.sourceEventId, input.sourceEventId)))
      .limit(1);
    if (daCo && daCo.to === input.to) return { ok: true, from: isModelState(daCo.from) ? daCo.from : null, to: input.to, historyId: daCo.id, eventId: null, replayed: true };
  }

  const kiem = checkModelTransition(from, input.to);
  if (!kiem.ok) return { error: kiem.error };
  const reason = (input.reason ?? "").trim();
  if (kiem.needsReason && !reasonIsEnough(reason)) {
    const vi = from === null ? "đây là lần khai trạng thái đầu tiên của mẫu" : `“${MODEL_STATE_LABELS[from]} → ${MODEL_STATE_LABELS[input.to]}” là lùi bước hoặc nhảy cóc`;
    return { error: `Cần ghi lý do (ít nhất ${MODEL_REASON_MIN_LENGTH} ký tự) vì ${vi}` };
  }

  const now = new Date();
  // Hàng rào trạng thái cũ: hai người cùng bấm thì người sau nhận lỗi, không ghi đè lời khai của người trước.
  const doi = await tx
    .update(pm)
    .set({ lifecycleState: input.to, stateChangedAt: now, updatedAt: now })
    .where(and(eq(pm.id, m.id), from === null ? isNull(pm.lifecycleState) : eq(pm.lifecycleState, from)))
    .returning({ id: pm.id });
  if (!doi.length) return { error: "Trạng thái mẫu vừa được người khác đổi — tải lại trang rồi thử lại" };

  const [h] = await tx
    .insert(hist)
    .values({
      modelId: m.id,
      fromState: from,
      toState: input.to,
      actorKind: input.actorKind,
      actorId: input.actor.id,
      actorName: input.actor.label,
      reason,
      source: input.source,
      sourceEventId: input.sourceEventId ?? null,
      relatedType: input.related?.type ?? null,
      relatedId: input.related?.id ?? null,
      metadata: { ...(input.metadata ?? {}), needsReason: kiem.needsReason },
      occurredAt: now,
    })
    .returning({ id: hist.id });

  const eventId = await emitDomainEvent(tx, {
    name: "model.state_changed",
    subjectType: MODEL_SUBJECT,
    subjectId: m.id,
    modelId: m.id,
    payload: { code: m.code, from, to: input.to, reason, needsReason: kiem.needsReason, historyId: h.id },
    actorKind: input.actorKind,
    actorId: input.actor.id,
    source: input.source,
    correlationId: input.correlationId ?? null,
    causationId: input.sourceEventId ?? null,
    dedupeKey: `model.state_changed:${h.id}`,
    occurredAt: now,
  });

  return { ok: true, from, to: input.to, historyId: h.id, eventId, replayed: false };
}

/**
 * Chuyển trạng thái vòng đời. Đây là đường DUY NHẤT đổi `lifecycle_state` — Agent C/E/… gọi hàm này,
 * không UPDATE thẳng. Lỗi nghiệp vụ trả `{ error }`; lỗi CSDL (vi phạm CHECK…) thì ném.
 */
export async function transitionModelCore(db: Db, input: TransitionModelInput): Promise<TransitionModelResult> {
  const loi = actorError(input.actor, input.actorKind);
  if (loi) return { error: loi };
  return db.transaction(async (tx) => applyTransition(tx, input));
}

// ─────────────────────────── NGƯỜI PHỤ TRÁCH ───────────────────────────

export type SetModelOwnerResult = { ok: true; changed: boolean; from: string | null; to: string | null } | { error: string };

/** Đổi người phụ trách — do NGƯỜI chọn. `ownerUserId = null` = gỡ người phụ trách. */
export async function setModelOwnerCore(
  db: Db,
  input: { modelId: string; ownerUserId: string | null; actor: Actor; actorKind: ModelActorKind; source: string; correlationId?: string | null },
): Promise<SetModelOwnerResult> {
  const loi = actorError(input.actor, input.actorKind);
  if (loi) return { error: loi };
  return db.transaction(async (tx) => {
    const [m] = await tx.select({ id: pm.id, code: pm.code, owner: pm.ownerUserId }).from(pm).where(eq(pm.id, input.modelId)).limit(1);
    if (!m) return { error: "Không tìm thấy mẫu trong sổ" };
    if (m.owner === input.ownerUserId) return { ok: true as const, changed: false, from: m.owner, to: m.owner };
    await tx.update(pm).set({ ownerUserId: input.ownerUserId, updatedAt: new Date() }).where(eq(pm.id, m.id));
    await emitDomainEvent(tx, {
      name: "model.owner_changed",
      subjectType: MODEL_SUBJECT,
      subjectId: m.id,
      modelId: m.id,
      payload: { code: m.code, from: m.owner, to: input.ownerUserId },
      actorKind: input.actorKind,
      actorId: input.actor.id,
      source: input.source,
      correlationId: input.correlationId ?? null,
    });
    return { ok: true as const, changed: true, from: m.owner, to: input.ownerUserId };
  });
}

// ─────────────────────────── MẪU MỚI DO NGƯỜI GÕ ───────────────────────────

export type RegisterModelResult = { ok: true; modelId: string; code: string } | { error: string };

/** Lý do của dòng lịch sử đầu tiên khi người đăng ký một mẫu mới — mô tả đúng hành động vừa xảy ra. */
export const REGISTER_REASON = "Người đăng ký mẫu mới vào sổ ở giai đoạn Ý tưởng";

/**
 * Người gõ mã một mẫu CHƯA có ở đâu cả (ý tưởng, mockup chưa lên Pancake) ⇒ mẫu ở giai đoạn `IDEA`,
 * `registered_by = 'USER'`. Mã đã là sản phẩm Pancake hoặc thiết kế TK ⇒ TỪ CHỐI và chỉ đường sang nút
 * đồng bộ sổ: đường ấy nối đúng một khớp và để trạng thái CHƯA KHAI, còn đăng ký tay ở đây sẽ gắn nhãn
 * "Ý tưởng" lên một mẫu có khi đang bán.
 */
export async function registerModelCore(db: Db, input: { code: string; name?: string | null; actor: Actor; source: string }): Promise<RegisterModelResult> {
  const loi = actorError(input.actor, "USER");
  if (loi) return { error: loi };
  const code = normalizeModelCode(input.code);
  if (!code) return { error: "Nhập mã mẫu (ví dụ Q012)" };
  const name = (input.name ?? "").trim();

  return db.transaction(async (tx) => {
    const [daCo] = await tx.select({ id: pm.id }).from(pm).where(eq(pm.code, code)).limit(1);
    if (daCo) return { error: `Mã ${code} đã có trong sổ mẫu` };
    const sanPham = await tx
      .select({ id: schema.products.id })
      .from(schema.products)
      .where(sql`upper(regexp_replace(coalesce(${schema.products.customId}, ''), '\\s', '', 'g')) = ${code}`)
      .limit(1);
    const thietKe = await tx.select({ id: schema.designConcepts.id }).from(schema.designConcepts).where(eq(schema.designConcepts.code, code)).limit(1);
    if (sanPham.length || thietKe.length) {
      return { error: `Mã ${code} đã là ${sanPham.length ? "sản phẩm trên Pancake" : "thiết kế trong vòng creative"} — bấm “Đồng bộ sổ mẫu” để đưa vào sổ, rồi khai trạng thái ở trang của mẫu` };
    }

    const [moi] = await tx.insert(pm).values({ code, name, registeredBy: "USER", ownerUserId: null }).returning({ id: pm.id });
    await emitDomainEvent(tx, {
      name: "model.registered",
      subjectType: MODEL_SUBJECT,
      subjectId: moi.id,
      modelId: moi.id,
      payload: { code, name, registeredBy: "USER", productId: null, designConceptId: null },
      actorKind: "USER",
      actorId: input.actor.id,
      source: input.source,
      dedupeKey: `model.registered:${moi.id}`,
    });
    const chuyen = await applyTransition(tx, { modelId: moi.id, to: "IDEA", reason: REGISTER_REASON, actor: input.actor, actorKind: "USER", source: input.source });
    if ("error" in chuyen) throw new Error(chuyen.error);
    return { ok: true as const, modelId: moi.id, code };
  });
}

// ─────────────────────────── ĐỒNG BỘ SỔ MẪU ───────────────────────────

export type RegistryProduct = { id: string; name: string; customId: string | null; isRemoved: boolean };
export type RegistryDesign = { id: string; code: string };
export type RegistryModel = { id: string; code: string; name: string; productId: string | null; designConceptId: string | null };

export type RegistryInsert = { code: string; name: string; productId: string | null; designConceptId: string | null };
export type RegistryLink = { modelId: string; code: string; productId: string | null; designConceptId: string | null; name: string | null };
export type RegistryAmbiguous = {
  code: string;
  reason: string;
  products: { id: string; name: string }[];
  designConceptId: string | null;
  modelId: string | null;
};
export type RegistryPlan = { toInsert: RegistryInsert[]; toLink: RegistryLink[]; ambiguous: RegistryAmbiguous[] };

/**
 * KẾ HOẠCH đồng bộ sổ mẫu — hàm THUẦN, ổn định (cùng đầu vào ⇒ cùng kết quả, xếp theo mã).
 *
 *  · Một mẫu cho mỗi mã đã chuẩn hoá xuất hiện ở `products.custom_id` (ô gõ tự do, KHÔNG duy nhất) hoặc
 *    ở `design_concepts.code` (`TK-YYMMDD-NN`).
 *  · Thiết kế và sản phẩm CÙNG mã ⇒ MỘT mẫu nối cả hai.
 *  · Hai sản phẩm trở lên cùng mã ⇒ `AMBIGUOUS`: KHÔNG đăng ký, KHÔNG nối, trả về để người quyết (luật 35:
 *    chỉ ánh xạ khi ĐÚNG MỘT khớp). Sản phẩm đã xoá trên Pancake chỉ được xét khi không còn sản phẩm đang
 *    sống nào mang mã ấy — cùng tinh thần `resolveProductByCode`.
 *  · Mẫu đã có ⇒ chỉ NỐI phần còn trống (không bao giờ đổi một liên kết đã có). Chạy lại ⇒ không có gì mới.
 *  · Mẫu mới luôn `lifecycle_state = NULL` — KHÔNG backfill trạng thái (mục 8.8, 35).
 */
export function planModelRegistry(input: { products: readonly RegistryProduct[]; designs: readonly RegistryDesign[]; models: readonly RegistryModel[] }): RegistryPlan {
  const theoMa = new Map<string, { products: RegistryProduct[]; design: RegistryDesign | null }>();
  const nhom = (code: string) => {
    let g = theoMa.get(code);
    if (!g) theoMa.set(code, (g = { products: [], design: null }));
    return g;
  };
  for (const p of input.products) {
    const code = normalizeModelCode(p.customId);
    if (code) nhom(code).products.push(p);
  }
  for (const d of input.designs) {
    const code = normalizeModelCode(d.code);
    if (code && !nhom(code).design) nhom(code).design = d;
  }

  const mauTheoMa = new Map(input.models.map((m) => [m.code, m]));
  const spDaNoi = new Set(input.models.map((m) => m.productId).filter((x): x is string => !!x));
  const tkDaNoi = new Set(input.models.map((m) => m.designConceptId).filter((x): x is string => !!x));

  const plan: RegistryPlan = { toInsert: [], toLink: [], ambiguous: [] };
  for (const code of [...theoMa.keys()].sort()) {
    const g = theoMa.get(code)!;
    const dangSong = g.products.filter((p) => !p.isRemoved);
    const ungVien = [...(dangSong.length ? dangSong : g.products)].sort((a, b) => a.id.localeCompare(b.id));
    const mau = mauTheoMa.get(code) ?? null;
    const thietKe = g.design && !tkDaNoi.has(g.design.id) ? g.design : null;

    if (ungVien.length > 1) {
      plan.ambiguous.push({
        code,
        reason: `${ungVien.length} sản phẩm Pancake${dangSong.length ? " đang bán" : " (đều đã xoá)"} cùng mang mã ${code} — máy không chọn hộ, người quyết sản phẩm nào là mẫu này`,
        products: ungVien.map((p) => ({ id: p.id, name: p.name })),
        designConceptId: g.design?.id ?? null,
        modelId: mau?.id ?? null,
      });
      // Thiết kế thì vẫn nối được vào mẫu ĐÃ CÓ — phần mơ hồ chỉ nằm ở phía sản phẩm.
      if (mau && mau.designConceptId === null && thietKe) {
        plan.toLink.push({ modelId: mau.id, code, productId: null, designConceptId: thietKe.id, name: null });
        tkDaNoi.add(thietKe.id);
      }
      continue;
    }

    const sp = ungVien[0] ?? null;
    const spTrong = sp && !spDaNoi.has(sp.id) ? sp : null;

    if (mau) {
      const noiSp = mau.productId === null && spTrong ? spTrong.id : null;
      const noiTk = mau.designConceptId === null && thietKe ? thietKe.id : null;
      if (noiSp || noiTk) {
        plan.toLink.push({ modelId: mau.id, code, productId: noiSp, designConceptId: noiTk, name: noiSp && !mau.name ? spTrong!.name : null });
        if (noiSp) spDaNoi.add(noiSp);
        if (noiTk) tkDaNoi.add(noiTk);
      }
      if (sp && mau.productId !== null && mau.productId !== sp.id && spTrong) {
        plan.ambiguous.push({
          code,
          reason: `Mẫu ${code} đang nối một sản phẩm khác với sản phẩm Pancake hiện mang mã này — máy không đổi liên kết đã có`,
          products: [{ id: sp.id, name: sp.name }],
          designConceptId: g.design?.id ?? null,
          modelId: mau.id,
        });
      }
      continue;
    }

    // Sản phẩm / thiết kế đã thuộc một mẫu KHÁC (ví dụ custom_id bị gõ lại) ⇒ không đẻ mẫu thứ hai.
    if (!spTrong && !thietKe) continue;
    plan.toInsert.push({ code, name: spTrong?.name ?? "", productId: spTrong?.id ?? null, designConceptId: thietKe?.id ?? null });
    if (spTrong) spDaNoi.add(spTrong.id);
    if (thietKe) tkDaNoi.add(thietKe.id);
  }
  return plan;
}

/** Đầu vào của `planModelRegistry` — đọc chung cho lượt đồng bộ và bản xem trước trên trang `/models`. */
export async function loadRegistryInputs(db: Db): Promise<{ products: RegistryProduct[]; designs: RegistryDesign[]; models: RegistryModel[] }> {
  const [products, designs, models] = await Promise.all([
    db
      .select({ id: schema.products.id, name: schema.products.name, customId: schema.products.customId, isRemoved: schema.products.isRemoved })
      .from(schema.products)
      .where(sql`coalesce(btrim(${schema.products.customId}), '') <> ''`),
    db.select({ id: schema.designConcepts.id, code: schema.designConcepts.code }).from(schema.designConcepts).orderBy(asc(schema.designConcepts.code)),
    db.select({ id: pm.id, code: pm.code, name: pm.name, productId: pm.productId, designConceptId: pm.designConceptId }).from(pm),
  ]);
  return { products, designs, models };
}

export type RegistrySyncResult = {
  inserted: number;
  linked: number;
  ambiguous: RegistryAmbiguous[];
  failed: { code: string; error: string }[];
  plan: { toInsert: number; toLink: number };
};

/**
 * Áp kế hoạch vào CSDL. Mỗi mẫu một giao dịch nhỏ (ghi + sự kiện cùng lúc), để một mã hỏng không kéo cả
 * lượt đồng bộ đổ theo. `ON CONFLICT DO NOTHING` + hàng rào `IS NULL` khi nối ⇒ chạy chồng hai lượt vẫn
 * không đẻ mẫu trùng hay đổi liên kết.
 *
 * Người bấm nút KHÔNG phải người quyết từng dòng: đăng ký theo luật là việc của MÁY (`actor_kind = SYSTEM`),
 * còn ai đã bấm thì ghi vào `payload.triggeredBy` và `sync_runs.actor`.
 */
export async function syncModelRegistry(db: Db, opts: { triggeredBy: string; correlationId?: string | null } = { triggeredBy: "job:model-registry" }): Promise<RegistrySyncResult> {
  const plan = planModelRegistry(await loadRegistryInputs(db));
  const source = "job:model-registry";
  const ket: RegistrySyncResult = { inserted: 0, linked: 0, ambiguous: plan.ambiguous, failed: [], plan: { toInsert: plan.toInsert.length, toLink: plan.toLink.length } };

  for (const m of plan.toInsert) {
    try {
      const ok = await db.transaction(async (tx) => {
        const [moi] = await tx
          .insert(pm)
          .values({ code: m.code, name: m.name, productId: m.productId, designConceptId: m.designConceptId, registeredBy: "SYNC" })
          .onConflictDoNothing()
          .returning({ id: pm.id });
        if (!moi) return false;
        await emitDomainEvent(tx, {
          name: "model.registered",
          subjectType: MODEL_SUBJECT,
          subjectId: moi.id,
          modelId: moi.id,
          payload: { code: m.code, name: m.name, registeredBy: "SYNC", productId: m.productId, designConceptId: m.designConceptId, triggeredBy: opts.triggeredBy },
          actorKind: "SYSTEM",
          actorId: null,
          source,
          correlationId: opts.correlationId ?? null,
          dedupeKey: `model.registered:${moi.id}`,
        });
        return true;
      });
      if (ok) ket.inserted += 1;
    } catch (e) {
      ket.failed.push({ code: m.code, error: e instanceof Error ? e.message : String(e) });
    }
  }

  for (const l of plan.toLink) {
    try {
      const n = await db.transaction(async (tx) => {
        let dem = 0;
        for (const [cot, giaTri, loai] of [
          [pm.productId, l.productId, "product"],
          [pm.designConceptId, l.designConceptId, "design"],
        ] as const) {
          if (!giaTri) continue;
          const doi = await tx
            .update(pm)
            .set(loai === "product" ? { productId: giaTri, updatedAt: new Date(), ...(l.name ? { name: l.name } : {}) } : { designConceptId: giaTri, updatedAt: new Date() })
            .where(and(eq(pm.id, l.modelId), isNull(cot)))
            .returning({ id: pm.id });
          if (!doi.length) continue;
          await emitDomainEvent(tx, {
            name: "model.linked",
            subjectType: MODEL_SUBJECT,
            subjectId: l.modelId,
            modelId: l.modelId,
            payload: { code: l.code, kind: loai, targetId: giaTri, triggeredBy: opts.triggeredBy },
            actorKind: "SYSTEM",
            actorId: null,
            source,
            correlationId: opts.correlationId ?? null,
            dedupeKey: `model.linked:${l.modelId}:${loai}:${giaTri}`,
          });
          dem += 1;
        }
        return dem;
      });
      ket.linked += n;
    } catch (e) {
      ket.failed.push({ code: l.code, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return ket;
}
