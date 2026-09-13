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
const MOI = "0071_performance_snapshots";

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
    assert.equal(await dem("select count(*)::int as n from information_schema.tables where table_name = 'performance_snapshots'"), 0, "bước 1: bảng mới CHƯA được tồn tại — nếu có thì bài này đang tự lừa mình");

    /*
      DỮ LIỆU ĐANG CÓ TRÊN PRODUCTION, không phải bảng trống.

      Work OS là lớp CHỈ CỘNG THÊM: nó không được đụng tới một dòng nghiệp vụ nào. Gieo sẵn một
      người dùng, một đơn và một case CSKH rồi kiểm lại sau khi áp migration — nếu một ngày nào đó
      có ai thêm `UPDATE`/`ALTER` vào 0069 thì bài này đỏ, chứ không phải production đỏ.
    */
    await client.query(`insert into users (id, email, name, password_hash, role) values ('up-u1', 'a@shop.vn', 'An', 'x', 'CS')`);
    await client.query(`insert into orders (id, stage, status, inserted_at, bill_full_name) values ('up-o1', 'CONFIRMED', 2, now(), 'Khách Cũ')`);
    await client.query(`insert into cs_cases (id, order_id, kind, status, title) values ('up-c1', 'up-o1', 'OTHER', 'OPEN', 'Case có từ trước')`);

    // ══ BƯỚC 2: áp migration mới lên ĐÚNG trạng thái đó ══
    writeFileSync(soFile, JSON.stringify(so, null, 2) + "\n");
    await migrate(db, { migrationsFolder: thuMucSo });

    const sau = await dem("select count(*)::int as n from drizzle.__drizzle_migrations");
    assert.equal(sau - truoc, 1, `bước 2: phải áp thêm ĐÚNG 1 migration, thực tế ${sau - truoc}`);

    // Bảy phòng ban mặc định phải có mặt, nếu không hàng đợi mở lên lần đầu sẽ rỗng.
    const phong = await client.query<{ code: string }>("select code from departments order by sort_order");
    assert.deepEqual(
      phong.rows.map((r) => r.code),
      ["SALES", "LOGISTICS", "WAREHOUSE", "MARKETING", "FINANCE", "MANAGEMENT", "HR"],
      "bảy phòng ban mặc định phải được gieo, đúng thứ tự hiển thị",
    );

    // CHỈ CỘNG THÊM: dữ liệu nghiệp vụ có từ trước phải nguyên vẹn.
    assert.equal(await dem("select count(*)::int as n from cs_cases where id = 'up-c1' and status = 'OPEN'"), 1, "case CSKH có từ trước không được đụng tới");
    assert.equal(await dem("select count(*)::int as n from orders where id = 'up-o1'"), 1, "đơn có từ trước không được đụng tới");
    assert.equal(await dem("select count(*)::int as n from work_items"), 0, "migration KHÔNG được chép việc sẵn có vào work_items — hàng đợi là PHÉP CHIẾU, không phải bản sao");

    /*
      RÀNG BUỘC QUAN TRỌNG NHẤT CỦA BẢN NÀY, kiểm ở mức CSDL chứ không tin vào kỷ luật:
      dòng CHIẾU không được giữ trạng thái, và việc TAY bắt buộc phải giữ.
    */
    const deptId = (await client.query<{ id: string }>("select id from departments where code = 'SALES'")).rows[0].id;
    await client.query(`insert into work_items (id, source_type, source_key, authority, department_id) values ('up-w1', 'CS_CASE', 'up-c1', 'SOURCE', '${deptId}')`);
    await assert.rejects(
      () => client.query(`update work_items set status = 'DONE' where id = 'up-w1'`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("work_items_authority_check"),
      "dòng CHIẾU mà ghi được trạng thái nghĩa là hai nơi cùng giữ một sự thật — ràng buộc phải chặn",
    );
    await assert.rejects(
      () => client.query(`insert into work_items (id, source_type, source_key, authority, title) values ('up-w2', 'MANUAL_TASK', 'up-w2', 'WORK', 'Việc tay không trạng thái')`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("work_items_authority_check"),
      "việc TAY mà thiếu trạng thái thì không nơi nào giữ trạng thái của nó — ràng buộc phải chặn",
    );
    await assert.rejects(
      () => client.query(`insert into work_items (id, source_type, source_key, authority, status, title, blocked_reason) values ('up-w3', 'MANUAL_TASK', 'up-w3', 'WORK', 'BLOCKED', 'Bị chặn', '')`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("work_items_blocked_reason_check"),
      "chặn mà không nói vì sao là xoá bằng chứng lặng lẽ — ràng buộc phải chặn",
    );

    /*
      ═══ ẢNH CHỤP HIỆU SUẤT (0071) ═══

      Điều kiện tiên quyết vẫn là điều kiện cũ: tài khoản có từ TRƯỚC migration không mất gì.
      Cột `data_scope` do 0070 thêm đã có ở bước 1, nên ở đây kiểm nó vẫn nguyên `ALL`.
    */
    const cu1 = (await client.query<{ data_scope: string }>("select data_scope from users where id = 'up-u1'")).rows[0];
    assert.equal(cu1.data_scope, "ALL", "tài khoản có từ trước phải giữ phạm vi ALL qua mọi migration sau đó");

    // Bảng mới rỗng: migration KHÔNG được tự dựng lịch sử hiệu suất cho những kỳ đã qua.
    assert.equal(await dem("select count(*)::int as n from performance_snapshots"), 0, "migration không được tự chụp ngược lịch sử — số đó sẽ là số bịa");

    const chup = (k: string, v: string) =>
      client.query(
        `insert into performance_snapshots (id, kind, period, period_start, period_end, subject_type, subject_id, metric_label, metric_key, value, unit, sample, confidence, linkage)
         values ('${k}', 'WEEKLY', '2026-W37', now() - interval '7 days', now(), 'PERSON', 'up-u1', 'SLA', 'care_sla', ${v}, 'PERCENT', 10, 'MEDIUM', 'USER_ID')`,
      );
    await chup("ps1", "91");

    // BẤT BIẾN: cùng (kỳ, chủ thể, chỉ số) thì lần ghi thứ hai phải bị chặn ở mức CSDL.
    await assert.rejects(
      () => chup("ps2", "42"),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("performance_snapshots_uq"),
      "số đã chụp của một kỳ không được ghi đè — nếu ghi đè được thì 'lịch sử' chỉ là ảnh chụp của lần chạy gần nhất",
    );

    // Chụp một con số mà quên mẫu số là chụp một thứ không kiểm chứng được.
    await assert.rejects(
      () =>
        client.query(
          `insert into performance_snapshots (id, kind, period, period_start, period_end, subject_type, subject_id, metric_label, metric_key, value, unit, sample, confidence, linkage)
           values ('ps3', 'WEEKLY', '2026-W38', now(), now(), 'PERSON', 'up-u1', 'SLA', 'care_sla', 91, 'PERCENT', 0, 'MEDIUM', 'USER_ID')`,
        ),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("performance_snapshots_sample_check"),
      "có giá trị thì phải có mẫu số — ràng buộc phải chặn",
    );

    // `null` = CHƯA ĐO ĐƯỢC vẫn ghi được, và đó là điểm khác biệt với 0.
    await client.query(
      `insert into performance_snapshots (id, kind, period, period_start, period_end, subject_type, subject_id, metric_label, metric_key, value, unit, sample, confidence, linkage)
       values ('ps4', 'WEEKLY', '2026-W38', now(), now(), 'PERSON', 'up-u1', 'SLA', 'care_sla', null, 'PERCENT', 0, 'UNKNOWN', 'USER_ID')`,
    );
    assert.equal(await dem("select count(*)::int as n from performance_snapshots where value is null"), 1, "CHƯA ĐO ĐƯỢC phải lưu được là NULL, không bị ép thành 0");

    // ══ BƯỚC 3: áp lại — migration phải idempotent ══
    await migrate(db, { migrationsFolder: thuMucSo });
    assert.equal(await dem("select count(*)::int as n from departments"), 7, "chạy lại migration KHÔNG được gieo thêm phòng ban lần hai");
    assert.equal(await dem("select count(*)::int as n from performance_snapshots"), 2, "chạy lại migration KHÔNG được đụng tới ảnh chụp đã ghi");

    console.log(`✓ Đường nâng cấp từ production: ${truoc} → ${sau} migration (+1) · dữ liệu nghiệp vụ nguyên vẹn · tài khoản cũ giữ nguyên phạm vi ALL · ảnh chụp hiệu suất bất biến (ghi đè bị CSDL chặn) · work_items rỗng (phép chiếu, không bản sao) · 5 ràng buộc chặn đúng · chạy lại không nhân đôi`);
  } finally {
    await client.close().catch(() => {});
    rmSync(tmp, { recursive: true, force: true });
  }
}
