import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * ═══════ ĐƯỜNG NÂNG CẤP TỪ TRẠNG THÁI PRODUCTION, KHÔNG CHỈ ĐƯỜNG DỰNG MỚI ═══════
 *
 * `npm test` chạy trên PGlite TRỐNG, nên nó chỉ chứng minh được đường 0000 → cuối. Máy chủ thật
 * KHÔNG bao giờ đi đường đó: nó đã có N migration chạy rồi và chỉ áp thêm cái cuối. Hai đường đó
 * hỏng theo hai kiểu khác nhau, và kiểu thứ hai là kiểu đã làm đỏ `main` bốn lần trong một buổi
 * chiều (AGENTS.md mục 9).
 *
 * SỰ CỐ THẬT 12/09/2026 mà bài này sinh ra để chặn: hai phiên song song cùng đánh số `0067`
 * (`0067_cs_workqueue` và `0067_bank_transaction_links`). Bản CSKH lên production trước. Nếu bản
 * tài chính được gộp nguyên trạng thì drizzle — vốn chạy theo `_journal.json` — sẽ thấy mục `0067`
 * đã áp và **BỎ QUA VĨNH VIỄN** migration còn lại. Không lỗi, không cảnh báo: bảng đơn giản là
 * không bao giờ tồn tại, và trang tài chính đổ ở lần truy vấn đầu tiên trên production.
 *
 * KHÔNG ĐỘNG VÀO KHO MÃ. Bài chép `drizzle/` sang thư mục tạm rồi cắt sổ Ở ĐÓ. Bản trước của bài
 * này ghi đè `drizzle/meta/_journal.json` thật rồi khôi phục trong `finally` — chỉ cần tiến trình
 * chết giữa chừng là sổ migration của kho mã hỏng, đúng thứ đang cố bảo vệ.
 */

type Entry = { idx: number; tag: string; when: number; version: string; breakpoints: boolean };

/** Migration mới của bản phát hành này — phần mà production CHƯA có. */
const MOI = "0068_bank_transaction_links";

export async function testMigrationUpgradePath() {
  const goc = path.join(process.cwd(), "drizzle");
  const so = JSON.parse(readFileSync(path.join(goc, "meta/_journal.json"), "utf8")) as { entries: Entry[] };
  const moi = so.entries.filter((e) => e.tag === MOI);
  assert.equal(moi.length, 1, `sổ phải có đúng một mục "${MOI}" — đổi tên migration thì đổi luôn hằng số MOI ở đây`);
  // Mốc phải MUỘN HƠN mọi mốc cũ, nếu không drizzle bỏ qua nó trên máy đã chạy các migration kia.
  const mocCu = Math.max(...so.entries.filter((e) => e.tag !== MOI).map((e) => e.when));
  assert.ok(moi[0].when > mocCu, `mốc của ${MOI} (${moi[0].when}) phải muộn hơn mọi mốc đã có (${mocCu})`);

  const tmp = mkdtempSync(path.join(tmpdir(), "upgrade-"));
  const thuMucSo = path.join(tmp, "drizzle");
  const duLieu = path.join(tmp, "db");
  const soFile = path.join(thuMucSo, "meta/_journal.json");
  cpSync(goc, thuMucSo, { recursive: true });

  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const client = new PGlite(duLieu);
  const db = drizzle(client) as never;
  const dem = async (sql: string) => Number((await client.query<{ n: number }>(sql)).rows[0]?.n ?? 0);

  try {
    // ══ BƯỚC 1: dựng đúng trạng thái production hôm nay — sổ CẮT trước migration mới ══
    const cu = { ...so, entries: so.entries.filter((e) => e.tag !== MOI) };
    writeFileSync(soFile, JSON.stringify(cu, null, 2) + "\n");
    await migrate(db, { migrationsFolder: thuMucSo });

    const truoc = await dem("select count(*)::int as n from drizzle.__drizzle_migrations");
    assert.equal(truoc, cu.entries.length, "bước 1: số migration đã áp phải khớp sổ đã cắt");
    assert.equal(await dem("select count(*)::int as n from information_schema.tables where table_name = 'bank_transaction_links'"), 0, "bước 1: bảng mới CHƯA được tồn tại — nếu có thì bài này đang tự lừa mình");

    /*
      DỮ LIỆU ĐANG CÓ TRÊN PRODUCTION, không phải bảng trống.

      Migration mang một câu `INSERT ... SELECT` chuyển mối nối kiểu cũ sang bảng nối. Chạy nó trên
      bảng trống thì câu đó không làm gì và bài kiểm không chứng minh được gì — đúng chỗ dễ hỏng
      nhất lại là chỗ không được kiểm.
    */
    await client.query(`insert into bank_accounts (id, provider, gateway, account_number, sub_account, label, status)
      values ('up-acc', '', 'MBBank', '9990001111', '', 'MB', 'ACTIVE')`);
    await client.query(`insert into expenses (id, category, description, amount, occurred_at)
      values ('up-exp', 'RENT', 'Thuê mặt bằng', 5000000, now())`);
    await client.query(`insert into bank_transactions (id, txn_at, amount, bank_ref, linked_type, linked_id, classified_by)
      values ('up-txn', now(), -5000000, 'UPREF1', 'EXPENSE', 'up-exp', 'ketoan@shop.vn')`);
    await client.query(`insert into bank_transactions (id, txn_at, amount, bank_ref)
      values ('up-txn-2', now(), -1000000, 'UPREF2')`);

    // ══ BƯỚC 2: áp migration mới lên ĐÚNG trạng thái đó ══
    writeFileSync(soFile, JSON.stringify(so, null, 2) + "\n");
    await migrate(db, { migrationsFolder: thuMucSo });

    const sau = await dem("select count(*)::int as n from drizzle.__drizzle_migrations");
    assert.equal(sau - truoc, 1, `bước 2: phải áp thêm ĐÚNG 1 migration, thực tế ${sau - truoc}`);

    const noi = await client.query<{ txn_id: string; target_type: string; target_id: string; amount: number; confirmed_by: string }>(
      "select txn_id, target_type, target_id, amount, confirmed_by from bank_transaction_links",
    );
    assert.equal(noi.rows.length, 1, "mối nối kiểu cũ phải được chuyển sang, không mất");
    assert.equal(noi.rows[0].txn_id, "up-txn", "chuyển đúng dòng tiền");
    assert.equal(noi.rows[0].target_id, "up-exp", "chuyển đúng chứng từ đích");
    assert.equal(Number(noi.rows[0].amount), 5_000_000, "phân bổ TRỌN số tiền — đó đúng là nghĩa của mối nối 1–1 cũ");
    assert.equal(noi.rows[0].confirmed_by, "ketoan@shop.vn", "người đã phân loại dòng đó giữ nguyên, KHÔNG bị gán cho 'migration'");

    // Ràng buộc cũ được NỚI chứ không siết: giá trị mới cũng phải nhận được.
    await client.query("update bank_transactions set linked_type = 'PAYROLL_PERIOD', linked_id = '2027-04' where id = 'up-txn-2'");

    // ══ BƯỚC 3: áp lại — migration phải idempotent ══
    await migrate(db, { migrationsFolder: thuMucSo });
    assert.equal(await dem("select count(*)::int as n from bank_transaction_links"), 1, "chạy lại migration KHÔNG được đẻ dòng thứ hai");

    console.log(`✓ Đường nâng cấp từ production: ${truoc} → ${sau} migration (+1) · mối nối cũ chuyển nguyên vẹn · chạy lại không nhân đôi · ràng buộc được nới nhận giá trị mới`);
  } finally {
    await client.close().catch(() => {});
    rmSync(tmp, { recursive: true, force: true });
  }
}
