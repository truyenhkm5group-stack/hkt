import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { normalizeOutreachConfig, nurtureNextAt } from "@/lib/constants/outreach";
import type { PancakeMessage } from "@/lib/integrations/pancake/pages";
import { sendOutreachTargets } from "@/lib/outreach/send";

/**
 * ═══════ KỊCH BẢN BĂN KHOĂN NẰM TRỌN TRONG 24 GIỜ CỦA META ═══════
 *
 * Bản cũ gửi mỗi NGÀY một bước ⇒ bước 2–7 luôn ngoài cửa sổ 24 giờ, và danh sách 7 ngày ⇒ khách nhắn 2–7
 * ngày trước bị từ chối ngay bước 1. Mốc dựng tương đối với đồng hồ thật (AGENTS.md mục 50).
 */

const H = 3_600_000;

export function testNurtureWindowPure() {
  const cu = normalizeOutreachConfig({ nurtureWindowHours: 168, nurtureStepGapDays: 1 });
  assert.equal(cu.nurtureWindowHours, 24, "cấu hình cũ 7 ngày về 24 giờ — quá 24 giờ Meta không cho nhắn");
  assert.equal(cu.nurtureStepGapHours, 8, "khoảng cách 1 NGÀY cũ không quy đổi (không bao giờ kịp) — dùng mặc định giờ");
  assert.equal(cu.nurtureStepGapDays, undefined);
  assert.equal(normalizeOutreachConfig({ nurtureStepGapHours: 3 }).nurtureStepGapHours, 3);
  assert.equal(normalizeOutreachConfig({ nurtureStepGapHours: 40 }).nurtureStepGapHours, 23, "không quá 23 giờ");

  const BAY_GIO = new Date("2026-09-26T10:00:00Z");
  const truoc = (h: number) => new Date(BAY_GIO.getTime() - h * H);
  assert.equal(nurtureNextAt(BAY_GIO, 8, truoc(2))?.getTime(), BAY_GIO.getTime() + 8 * H, "khách nhắn 2 giờ trước: bước sau +8 giờ vẫn kịp");
  assert.equal(nurtureNextAt(BAY_GIO, 8, truoc(20)), null, "khách nhắn 20 giờ trước: +8 giờ là quá hạn ⇒ kịch bản kết thúc");
  // Biên 10 phút: đúng hạn trừ biên thì KHÔNG kịp.
  assert.equal(nurtureNextAt(BAY_GIO, 8, new Date(BAY_GIO.getTime() + 8 * H - 24 * H + 10 * 60_000)), null);
  assert.ok(nurtureNextAt(BAY_GIO, 8, null), "không biết tin cuối ⇒ vẫn hẹn, lượt gửi sau tự kiểm lại");
  console.log("✓ Băn khoăn · luật thuần: cửa sổ tối đa 24 giờ · bước cách nhau theo giờ · bước không kịp thì kịch bản kết thúc");
}

export async function testNurtureWindowSendDb(db: Db) {
  const P = "onw-";
  const ago = (h: number) => new Date(Date.now() - h * H);
  const t = schema.outreachTargets;
  const lastCustomer: Record<string, number> = { cu: 30, moi: 2, sat: 20, tra: 1 };
  try {
    const mk = (id: string, v: Partial<typeof t.$inferInsert> = {}) => ({
      id: `${P}${id}`,
      segment: "NURTURE",
      status: "PENDING",
      pageId: "page-onw",
      conversationId: `${P}conv-${id}`,
      pancakeCustomerId: `cust-${id}`,
      customerName: "Nguyễn Thị Lan",
      message: "Chị ơi, em hỗ trợ chị lên đơn nhé",
      lastActivityAt: ago(lastCustomer[id]),
      dedupeKey: `${P}${id}`,
      ...v,
    });
    await db.insert(t).values([mk("cu"), mk("moi"), mk("sat"), mk("tra", { sentCount: 1, step: 1, sentAt: ago(3) })]);

    const sends: string[] = [];
    const client = {
      async listMessages(_page: string, conversationId: string): Promise<PancakeMessage[]> {
        const id = conversationId.replace(`${P}conv-`, "");
        const m = (fromPage: boolean, h: number): PancakeMessage => ({ id: `${id}-${h}`, text: "x", fromId: "", fromName: "", fromPage, insertedAt: ago(h), hasAttachment: false });
        return [m(false, lastCustomer[id]), m(true, lastCustomer[id] - 0.5)];
      },
      async sendMessage(_page: string, conversationId: string) {
        sends.push(conversationId.replace(`${P}conv-`, ""));
        return { ok: true, id: `mid-${conversationId}` };
      },
      async sendAttachment() {
        return { ok: true };
      },
    };
    await sendOutreachTargets(["cu", "moi", "sat", "tra"].map((x) => `${P}${x}`), "test", { client: client as never });
    const rows = new Map((await db.select().from(t).where(sql`${t.id} like ${`${P}%`}`)).map((r) => [r.id.slice(P.length), r]));

    assert.equal(rows.get("cu")?.status, "SKIPPED", "khách nhắn 30 giờ trước: KHÔNG gọi Meta");
    assert.equal(rows.get("cu")?.errorKind, "POLICY_WINDOW");
    assert.equal(rows.get("tra")?.status, "REPLIED", "khách nhắn lại sau tin gần nhất ⇒ nhân viên tiếp quản");
    assert.deepEqual(sends.sort(), ["moi", "sat"], "chỉ hai khách còn trong cửa sổ được nhắn");

    const moi = rows.get("moi");
    assert.equal(moi?.status, "PENDING", "còn nhiều thời gian ⇒ bước 2 được hẹn");
    assert.equal(moi?.step, 1);
    const hen = (moi?.nextAt?.getTime() ?? 0) - Date.now();
    assert.ok(hen > 7 * H && hen <= 8 * H, "hẹn sau đúng 8 giờ (mặc định), không phải 1 ngày");
    assert.equal(rows.get("sat")?.status, "SENT", "bước sau không kịp trước hạn 24 giờ ⇒ kịch bản kết thúc, không xếp hàng một tin sẽ bị từ chối");
    assert.equal(rows.get("sat")?.nextAt, null);
    console.log("✓ Băn khoăn · gửi: quá 24 giờ bỏ qua không gọi Meta · khách nhắn lại chuyển nhân viên · bước sau chỉ hẹn khi còn kịp");
  } finally {
    await db.delete(t).where(sql`${t.id} like ${`${P}%`}`);
  }
}
