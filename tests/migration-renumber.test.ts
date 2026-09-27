import assert from "node:assert/strict";
import { planRenumber, replaceTags, splitTag, type JournalEntry } from "../scripts/migration-renumber";

/**
 * Công cụ đánh lại số migration (`scripts/migration-renumber.ts`) — khoá đúng ba lỗi đã xảy ra khi
 * làm tay 25–26/09/2026: sắp lại sổ của main, thay số trượt tên đầy đủ, mốc không vượt main.
 */
const e = (idx: number, tag: string, when: number): JournalEntry => ({ idx, version: "7", when, tag, breakpoints: true });

export function testMigrationRenumber() {
  // Sổ base CỐ Ý không theo thứ tự idx ở giữa (đúng như sổ thật của main ở 41–43).
  const base = [e(0, "0000_init", 1000), e(2, "0002_b", 2000), e(1, "0001_a", 3000), e(3, "0003_c", 4000)];

  // ───────── Nhánh lấy trùng số 0003 với main ─────────
  const p = planRenumber(base, [
    { tag: "0004_hai", when: 3500 },
    { tag: "0003_mot", when: 3400 },
  ]);
  assert.deepEqual(
    p.entries.slice(0, 4).map((x) => x.tag),
    ["0000_init", "0002_b", "0001_a", "0003_c"],
    "sổ base giữ NGUYÊN VĂN thứ tự — không bao giờ sắp lại",
  );
  assert.deepEqual(
    p.steps.map((s) => [s.from, s.to]),
    [
      ["0003_mot", "0004_mot"],
      ["0004_hai", "0005_hai"],
    ],
    "nối vào cuối theo thứ tự số cũ, số mới = max base + 1, + 2",
  );
  assert.deepEqual(p.steps.map((s) => s.when), [4000 + 60_000, 4000 + 120_000], "mốc cũ không vượt base ⇒ cấp mốc mới tăng dần");
  assert.ok(p.changed);
  for (let i = 1; i < p.entries.length; i += 1) {
    if (i >= 4) assert.ok(p.entries[i].when > p.entries[i - 1].when, "mục của nhánh: mốc tăng nghiêm ngặt");
  }

  // ───────── Mốc cũ đã vượt base ⇒ giữ nguyên ─────────
  const q = planRenumber(base, [{ tag: "0004_x", when: 9000 }]);
  assert.deepEqual(q.steps, [{ from: "0004_x", to: "0004_x", when: 9000, whenChanged: false }]);
  assert.equal(q.changed, false, "đã đúng số và mốc ⇒ không đổi gì");

  // ───────── Mục chưa có trong sổ (sổ đang xung đột) ⇒ cấp mốc ─────────
  assert.equal(planRenumber(base, [{ tag: "0004_x", when: null }]).steps[0].when, 64_000);

  // ───────── Không đụng migration base đã có ─────────
  assert.throws(() => planRenumber(base, [{ tag: "0003_c", when: 1 }]), /đã có ở base/);
  assert.throws(() => splitTag("156_thieu_so"), /sai dạng/);

  // ───────── Thay tên đầy đủ, không nối chuỗi ─────────
  const text = 'MOI = ["0003_mot", "0004_hai"]; // xem drizzle/0003_mot.sql';
  assert.equal(
    replaceTags(text, [
      { from: "0003_mot", to: "0004_mot" },
      { from: "0004_hai", to: "0005_hai" },
    ]),
    'MOI = ["0004_mot", "0005_hai"]; // xem drizzle/0004_mot.sql',
    "đổi dây chuyền 0003→0004, 0004→0005 không được biến 0003 thành 0005",
  );
  console.log("✓ Đánh lại số migration: giữ nguyên sổ base, nối cuối, mốc vượt base, thay tên đầy đủ không nối chuỗi");
}
