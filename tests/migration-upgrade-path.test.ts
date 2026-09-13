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

/**
 * Migration mới của bản phát hành này — phần mà production CHƯA có.
 *
 * Là một DANH SÁCH chứ không phải một chuỗi: một bản phát hành có thể mang nhiều migration, và
 * lúc đó đường nâng cấp thật là "áp cả nhóm lên trạng thái cũ", không phải "áp từng cái lên một
 * trạng thái đã có những cái kia". Ép về một chuỗi sẽ làm bài kiểm gieo dữ liệu thử SAU khi
 * migration cần kiểm đã áp — và phần backfill của nó không bao giờ được kiểm.
 */
const MOI = ["0076_care_active_invariant", "0077_metric_target_bands", "0078_product_notes"] as const;

export async function testMigrationUpgradePath() {
  const goc = path.join(process.cwd(), "drizzle");
  const so = JSON.parse(readFileSync(path.join(goc, "meta/_journal.json"), "utf8")) as { entries: Entry[] };
  const moi = so.entries.filter((e) => (MOI as readonly string[]).includes(e.tag));
  assert.equal(moi.length, MOI.length, `sổ phải có đúng ${MOI.length} mục mới — đổi tên migration thì đổi luôn danh sách MOI ở đây`);
  // Mốc phải MUỘN HƠN mọi mốc cũ, nếu không drizzle bỏ qua nó trên máy đã chạy các migration kia.
  const mocCu = Math.max(...so.entries.filter((e) => !(MOI as readonly string[]).includes(e.tag)).map((e) => e.when));
  for (const m of moi) assert.ok(m.when > mocCu, `mốc của ${m.tag} (${m.when}) phải muộn hơn mọi mốc đã có (${mocCu})`);

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
    const cu = { ...so, entries: so.entries.filter((e) => !(MOI as readonly string[]).includes(e.tag)) };
    writeFileSync(soFile, JSON.stringify(cu, null, 2) + "\n");
    await migrate(db, { migrationsFolder: thuMucSo });

    const truoc = await dem("select count(*)::int as n from drizzle.__drizzle_migrations");
    assert.equal(truoc, cu.entries.length, "bước 1: số migration đã áp phải khớp sổ đã cắt");
    // 0075 đã áp: cột `active` có, và mặc định `true` cho cả dòng đã đóng — đúng trạng thái production
    // 13/09/2026 (7 RESOLVED + 6 CANCELLED vẫn active). Bài này dựng lại đúng tình huống đó.
    assert.equal(await dem("select count(*)::int as n from information_schema.columns where table_name = 'shipment_care' and column_name = 'active'"), 1, "bước 1: 0075 phải đã áp — cột active có sẵn");
    await client.query(`insert into shipments (id, tracking_code, stage) values ('up-s9', 'UPS9', 'DELIVERY_FAILED')`);
    await client.query(`insert into shipments (id, tracking_code, stage) values ('up-s8', 'UPS8', 'DELIVERY_FAILED')`);
    await client.query(`insert into shipment_care (id, shipment_id, care_status, care_outcome, owner_at_resolution, opened_at) values ('up-care-1', 'up-s9', 'RESOLVED', null, null, now())`);
    await client.query(`insert into shipment_care (id, shipment_id, care_status, care_outcome) values ('up-care-2', 'up-s8', 'NEW', 'PENDING')`);
    assert.equal(await dem("select count(*)::int as n from shipment_care where id = 'up-care-1' and active"), 1, "bước 1: dòng đã đóng vẫn active = true — đúng lỗ hổng mà bản này sửa");

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
    assert.equal(sau - truoc, MOI.length, `bước 2: phải áp thêm ĐÚNG ${MOI.length} migration, thực tế ${sau - truoc}`);

    /*
      ═══ 0076: ĐÓNG ⇔ active = false — SỬA CỜ, KHÔNG BACKFILL ═══

      Dòng đã đóng rời hàng đợi (`active = false`, `done_at` điền từ mốc có sẵn) nhưng KHÔNG được
      đoán thêm gì: `care_outcome` vẫn NULL, `owner_at_resolution` vẫn NULL. Dòng đang mở không bị đụng.
    */
    const dong = (await client.query<{ active: boolean; care_outcome: string | null; owner_at_resolution: string | null; done_at: string | null }>("select active, care_outcome, owner_at_resolution, done_at from shipment_care where id = 'up-care-1'")).rows[0];
    assert.equal(dong.active, false, "0076: đợt RESOLVED phải rời trạng thái đang mở");
    assert.equal(dong.care_outcome, null, "0076 KHÔNG được đoán kết quả cho đợt cũ");
    assert.equal(dong.owner_at_resolution, null, "0076 KHÔNG được đoán người cho đợt cũ");
    assert.ok(dong.done_at, "0076: done_at điền từ mốc cập nhật có sẵn, không để rỗng");
    const mo = (await client.query<{ active: boolean; care_outcome: string | null }>("select active, care_outcome from shipment_care where id = 'up-care-2'")).rows[0];
    assert.equal(mo.active, true, "0076: đợt đang mở KHÔNG bị đụng");
    assert.equal(mo.care_outcome, "PENDING");
    // Kiện đã có đợt đóng nay mở được đợt mới — điều mà cờ sai đã chặn ở chỉ mục duy nhất từng phần.
    await client.query(`insert into shipment_care (id, shipment_id, care_status, care_outcome, episode_no) values ('up-care-3', 'up-s9', 'NEW', 'PENDING', 2)`);

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
      ═══ NHÓM LÝ DO HOÀN (0074) ═══

      Điều kiện tiên quyết không đổi qua mọi migration: tài khoản có TRƯỚC bản này không mất gì.
    */
    const cu1 = (await client.query<{ data_scope: string }>("select data_scope from users where id = 'up-u1'")).rows[0];
    assert.equal(cu1.data_scope, "ALL", "tài khoản có từ trước phải giữ phạm vi ALL qua mọi migration sau đó");

    /*
      KHÔNG BACKFILL, KHÔNG MẶC ĐỊNH.

      Case có TRƯỚC bản này phải ở `NULL` — không phải `''`, không phải một khoá đoán ra từ tên.
      Đây là ràng buộc quan trọng nhất của migration này: một backfill "hợp lý" sẽ biến một lỗ
      hổng dữ liệu thành một lời khẳng định sai về việc ai đã làm việc gì, và sau đó không ai
      phân biệt được nữa.
    */
    const sauNang = (await client.query<{ assignee_user_id: string | null }>("select assignee_user_id from cs_cases where id = 'up-c1'")).rows[0];
    assert.equal(sauNang.assignee_user_id, null, "migration KHÔNG được đoán người phụ trách cho case cũ");

    // Bảng đích rỗng: ERP KHÔNG đặt sẵn đích nào cho ai.
    assert.equal(await dem("select count(*)::int as n from metric_targets"), 0, "migration không được đặt sẵn đích — đích là quyết định kinh doanh của chủ shop");

    /*
      ═══ 0077: ĐÍCH CÓ KỲ, CÓ DẢI, CÓ HẠN — VÀ VẪN KHÔNG CÓ ĐÍCH NÀO ═══

      Bảng rỗng trên production (0 dòng, đo 13/09/2026), nên các cột thêm vào có mặc định mà không
      phải đoán gì về dữ liệu cũ. `period_kind = 'ANY'` nghĩa là CHƯA KHAI KỲ, không phải "mỗi
      tháng": một đích 500 đơn mà máy tự gán cho một tháng sẽ chấm sai gấp bốn khi người ta xem
      theo tuần, và màn hình trông hoàn toàn bình thường.
    */
    for (const cot of ["target_max", "warning_at", "critical_at", "period_kind", "effective_to", "version", "owner_department"]) {
      assert.equal(await dem(`select count(*)::int as n from information_schema.columns where table_name = 'metric_targets' and column_name = '${cot}'`), 1, `0077: thiếu cột ${cot}`);
    }

    await client.query(`insert into metric_targets (id, metric_key, scope, scope_ref, target, note, effective_from, set_by_email) values ('up-t1', 'care_sla', 'USER', 'up-u1', 85, 'thử', now(), 'a@shop.vn')`);
    const t1 = (await client.query<{ period_kind: string; version: number; target_max: number | null }>("select period_kind, version, target_max from metric_targets where id = 'up-t1'")).rows[0];
    assert.equal(t1.period_kind, "ANY", "0077: mặc định là CHƯA KHAI KỲ, không phải một kỳ do máy chọn hộ");
    assert.equal(t1.version, 1, "0077: đích mới là phiên bản 1");
    assert.equal(t1.target_max, null, "0077: không có cận trên ⇒ đích một chiều, không phải dải");

    // Phạm vi CÁ NHÂN nay hợp lệ ở mức CSDL — nhưng vẫn là DANH SÁCH ĐÓNG, không phải ô gõ tự do.
    await assert.rejects(
      () => client.query(`insert into metric_targets (id, metric_key, scope, scope_ref, target, note, effective_from, set_by_email) values ('up-t2', 'care_sla', 'PRODUCT', 'p1', 5, 'x', now(), 'a@shop.vn')`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("metric_targets_scope_check"),
      "0077: phạm vi lạ phải bị CSDL chặn — chuỗi tự do buộc mã nguồn chọn giữa khoá nhầm người và lộ dữ liệu",
    );
    await assert.rejects(
      () => client.query(`insert into metric_targets (id, metric_key, scope, target, note, effective_from, period_kind, set_by_email) values ('up-t3', 'care_sla', 'COMPANY', 5, 'x', now(), 'MOI_NGAY', 'a@shop.vn')`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("metric_targets_period_check"),
      "0077: hình dạng kỳ lạ phải bị chặn",
    );
    await assert.rejects(
      () => client.query(`insert into metric_targets (id, metric_key, scope, target, target_max, note, effective_from, set_by_email) values ('up-t4', 'care_sla', 'COMPANY', 50, 20, 'x', now(), 'a@shop.vn')`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("metric_targets_range_check"),
      "0077: dải có cận trên NHỎ HƠN cận dưới thì không đích nào áp được — chặn ngay ở CSDL",
    );
    await assert.rejects(
      () => client.query(`insert into metric_targets (id, metric_key, scope, target, note, effective_from, effective_to, set_by_email) values ('up-t5', 'care_sla', 'COMPANY', 50, 'x', now(), now() - interval '1 day', 'a@shop.vn')`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("metric_targets_window_check"),
      "0077: khoảng hiệu lực rỗng thì đích không bao giờ áp cho kỳ nào, và người đặt sẽ đi tìm xem vì sao",
    );
    /*
      ĐÍCH THEO TUẦN VÀ ĐÍCH THEO THÁNG PHẢI CÙNG TỒN TẠI ĐƯỢC.

      `resolveTarget` lọc theo `period_kind`, tức nó giả định hai đích khác hình dạng kỳ sống song
      song. Nếu `period_kind` không nằm trong khoá duy nhất thì dòng thứ hai bị chặn — và tệ hơn,
      lượt ghi thứ hai tra dòng cũ không theo kỳ nên nó SỬA ĐÈ đích tuần thành đích tháng. Chủ shop
      mất một đích đã đặt, không một dòng cảnh báo nào.
    */
    await client.query(`insert into metric_targets (id, metric_key, scope, target, note, effective_from, period_kind, set_by_email) values ('up-tw', 'delivered_orders', 'COMPANY', 500, 'tuần', '2026-01-01', 'WEEK', 'a@shop.vn')`);
    await client.query(`insert into metric_targets (id, metric_key, scope, target, note, effective_from, period_kind, set_by_email) values ('up-tm', 'delivered_orders', 'COMPANY', 2000, 'tháng', '2026-01-01', 'MONTH', 'a@shop.vn')`);
    assert.equal(await dem("select count(*)::int as n from metric_targets where metric_key = 'delivered_orders'"), 2, "0077: đích theo TUẦN và theo THÁNG của cùng một chỉ số phải cùng tồn tại");
    // Nhưng TRÙNG HOÀN TOÀN (cùng kỳ, cùng mốc) thì vẫn phải bị chặn — nếu không, không ai biết
    // màn hình đang chấm theo dòng nào.
    await assert.rejects(
      () => client.query(`insert into metric_targets (id, metric_key, scope, target, note, effective_from, period_kind, set_by_email) values ('up-tm2', 'delivered_orders', 'COMPANY', 2500, 'trùng', '2026-01-01', 'MONTH', 'a@shop.vn')`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("metric_targets_uq"),
      "0077: hai đích cùng chỉ số, cùng tầng, CÙNG kỳ, cùng mốc thì phải bị chặn",
    );
    await client.query(`delete from metric_targets where id in ('up-tw','up-tm')`);
    await client.query(`delete from metric_targets where id = 'up-t1'`);

    /*
      ═══ 0078: GHI CHÚ VẬN HÀNH — BẢNG MỚI, KHÔNG ĐỤNG GÌ TỚI DỮ LIỆU CŨ ═══

      Cột `products.note` (đồng bộ từ Pancake) phải còn nguyên: bản này KHÔNG chuyển nó sang bảng
      mới. Chuyển là hai cái sai cùng lúc — lần đồng bộ Pancake sau ghi đè lại cột đó, và một ghi
      chú của Pancake bỗng mang tên một người trong shop.
    */
    assert.equal(await dem("select count(*)::int as n from information_schema.tables where table_name = 'product_notes'"), 1, "0078: bảng ghi chú phải được tạo");
    assert.equal(await dem("select count(*)::int as n from product_notes"), 0, "0078: KHÔNG chuyển ghi chú Pancake sang bảng mới — cột cũ giữ nguyên vai của nó");
    await client.query(`insert into products (id, name, note) values ('up-p1', 'Đầm cũ', 'ghi chú của Pancake')`);
    const spCu = (await client.query<{ note: string }>("select note from products where id = 'up-p1'")).rows[0];
    assert.equal(spCu.note, "ghi chú của Pancake", "0078: cột note cũ không bị đụng tới");

    await assert.rejects(
      () => client.query(`insert into product_notes (id, product_id, body) values ('up-n1', 'up-p1', '   ')`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("product_notes_body_check"),
      "0078: ghi chú rỗng chiếm chỗ 'ghi chú mới nhất' và đẩy ghi chú thật xuống — chặn ở CSDL",
    );
    await assert.rejects(
      () => client.query(`insert into product_notes (id, product_id, body, category) values ('up-n2', 'up-p1', 'x y z', 'LUNG_TUNG')`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("product_notes_category_check"),
      "0078: nhóm lạ phải bị chặn — ô gõ tự do sinh ra ba cách viết cho cùng một nhóm",
    );
    /*
      Người viết bị gỡ tài khoản thì ghi chú KHÔNG biến mất — chỉ mất khoá, ảnh chụp tên còn lại.

      Dùng một tài khoản RIÊNG (`up-u9`) chứ không mượn `up-u1`: khối kiểm đích phía dưới còn cần
      `up-u1` sống để chứng minh xoá người đặt không cuốn theo đích. Xoá sớm ở đây thì bài kiểm kia
      đỏ vì khoá ngoại, và nguyên nhân thật nằm cách đó hai trăm dòng.
    */
    await client.query(`insert into users (id, email, name, password_hash, role) values ('up-u9', 'kho@shop.vn', 'An Kho', 'x', 'WAREHOUSE')`);
    await client.query(`insert into product_notes (id, product_id, body, actor_user_id, actor_name) values ('up-n3', 'up-p1', 'Lô này vải mỏng', 'up-u9', 'An Kho')`);
    await client.query(`delete from users where id = 'up-u9'`);
    const conLai = (await client.query<{ actor_user_id: string | null; actor_name: string }>("select actor_user_id, actor_name from product_notes where id = 'up-n3'")).rows[0];
    assert.equal(conLai.actor_user_id, null, "0078: gỡ tài khoản thì khoá về null");
    assert.equal(conLai.actor_name, "An Kho", "0078: nhưng ảnh chụp tên còn lại — ghi chú vẫn đọc được, chỉ là không quy kết được nữa");

    /*
      BA CỘT MỚI CỦA 0074 CÓ MẶC ĐỊNH — và đó KHÔNG phải một phép đoán về dữ liệu cũ.

      `shipment_return_reasons` rỗng trên production (0 dòng, đo 13/09/2026), nên mặc định không
      gán nhãn sai cho bất kỳ dòng nào đang có. Nếu bảng đã có dữ liệu thì mặc định `UNKNOWN` cho
      `reason_group` mới là lựa chọn đúng: chưa xếp nhóm, không phải xếp nhầm nhóm.
    */
    for (const cot of ["reason_group", "source", "confidence"]) {
      assert.equal(await dem(`select count(*)::int as n from information_schema.columns where table_name = 'shipment_return_reasons' and column_name = '${cot}' and column_default is not null`), 1, `cột ${cot} phải có mặc định`);
    }
    assert.equal(await dem("select count(*)::int as n from shipment_return_reasons"), 0, "migration KHÔNG được tự sinh lý do hoàn nào — lý do chi tiết chỉ có khi NGƯỜI ghi");

    // Nguồn lạ bị CSDL chặn: chỉ ba giá trị có nghĩa, và mỗi cái nói một mức thẩm quyền khác nhau.
    await client.query(`insert into shipments (id, tracking_code, stage) values ('up-s2', 'UPS2', 'RETURNED')`);
    await assert.rejects(
      () => client.query(`insert into shipment_return_reasons (id, shipment_id, reason, source) values ('rr-x', 'up-s2', 'QUALITY_FABRIC_BAD', 'GUESS')`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("shipment_return_reasons_source_check"),
      "nguồn lạ phải bị chặn ở CSDL — 'đoán' không phải một nguồn",
    );
    await client.query(`delete from shipments where id = 'up-s2'`);

    // Ảnh chụp cũ nhận phiên bản nguồn mặc định 1, không phải NULL: kỳ cũ vẫn so sánh được.
    assert.equal(await dem("select count(*)::int as n from information_schema.columns where table_name = 'performance_snapshots' and column_name = 'source_version' and column_default is not null"), 1, "ảnh chụp cũ phải có phiên bản nguồn mặc định, không để NULL");

    // Tầng công ty KHÔNG được gắn tham chiếu; hai tầng kia BẮT BUỘC có — chặn ở CSDL, không ở giao diện.
    await assert.rejects(
      () => client.query(`insert into metric_targets (id, metric_key, scope, scope_ref, target, effective_from) values ('mt-x', 'care_sla', 'COMPANY', 'LOGISTICS', 80, now())`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("metric_targets_ref_check"),
      "đích toàn công ty mà gắn một phòng thì không ai biết nó áp cho ai — ràng buộc phải chặn",
    );
    await assert.rejects(
      () => client.query(`insert into metric_targets (id, metric_key, scope, target, effective_from) values ('mt-y', 'care_sla', 'DEPARTMENT', 80, now())`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("metric_targets_ref_check"),
      "đích cấp phòng mà không nói phòng nào — ràng buộc phải chặn",
    );

    /*
      ═══ CA CHĂM SÓC THEO ĐỢT (0075 + 0076) ═══

      Ba điều phải đúng cùng lúc, và cả ba đều kiểm ở mức CSDL chứ không tin vào kỷ luật mã nguồn.
    */
    // 1. Dòng care CÓ TỪ TRƯỚC không mất gì: đợt thứ nhất, có mốc mở đợt (0075 chép từ mốc tạo),
    //    kết quả vẫn NULL. Đây KHÔNG phải suy đoán kết quả — chỉ là chép một mốc đã có sang đúng cột.
    const careCu = (await client.query<{ active: boolean; episode_no: number; opened_at: string | null; care_outcome: string | null }>(
      "select active, episode_no, opened_at, care_outcome from shipment_care where id = 'up-care-1'",
    )).rows[0];
    assert.equal(careCu.active, false, "dòng care đã RESOLVED không còn là đợt đang mở (0076)");
    assert.equal(careCu.episode_no, 1, "dòng care cũ là đợt thứ nhất");
    assert.ok(careCu.opened_at, "dòng care cũ phải có mốc mở đợt");
    assert.equal(careCu.care_outcome, null, "KHÔNG backfill kết quả logistics cho ca cũ — NULL là CHƯA BIẾT");

    // 2. Đợt THỨ HAI đã mở được ở trên (up-care-3) vì đợt trước đã đóng; đợt THỨ BA cùng mở thì bị chặn.
    await assert.rejects(
      () => client.query(`insert into shipment_care (id, shipment_id, episode_no) values ('up-care-4', 'up-s9', 3)`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("shipment_care_active_uidx"),
      "hai đợt CÙNG MỞ trên một kiện thì webhook phát lại sinh ra ca trùng — chỉ mục phải chặn",
    );
    assert.equal(await dem("select count(*)::int as n from shipment_care where shipment_id = 'up-s9'"), 2, "kiện hỏng lần hai phải có đợt thứ hai, KHÔNG ghi đè đợt một");

    // 3. Kết quả lạ bị chặn: năm giá trị, mỗi cái dẫn tới một kết luận khác nhau về đội chăm sóc.
    await assert.rejects(
      () => client.query(`update shipment_care set care_outcome = 'RESCUED' where id = 'up-care-3'`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("shipment_care_outcome_check"),
      "kết quả ngoài danh mục phải bị CSDL chặn",
    );
    // Thao tác nghiệp vụ ngoài bốn quyết định cũng bị chặn — "đã gọi khách" không phải một quyết định.
    await assert.rejects(
      () => client.query(`insert into care_business_actions (id, care_case_id, shipment_id, action_type) values ('ba-x', 'up-care-3', 'up-s9', 'CALL')`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("care_business_actions_type_check"),
      "chỉ bốn quyết định nghiệp vụ được ghi vào sổ này",
    );
    assert.equal(await dem("select count(*)::int as n from care_business_actions"), 0, "migration KHÔNG được tự sinh thao tác nào");

    await client.query(`delete from shipment_care where shipment_id in ('up-s9', 'up-s8')`);
    await client.query(`delete from shipments where id in ('up-s9', 'up-s8')`);

    // Một tầng · một chỉ số · một mốc hiệu lực = MỘT đích. Hai dòng trùng thì không ai biết cái nào thắng.
    await client.query(`insert into metric_targets (id, metric_key, scope, target, effective_from) values ('mt-1', 'care_sla', 'COMPANY', 80, '2026-01-01')`);
    await assert.rejects(
      () => client.query(`insert into metric_targets (id, metric_key, scope, target, effective_from) values ('mt-2', 'care_sla', 'COMPANY', 90, '2026-01-01')`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("metric_targets_uq"),
      "hai đích cùng tầng cùng mốc thì màn hình chấm theo cái nào cũng sai — ràng buộc phải chặn",
    );

    // Người đặt đích nghỉ việc thì ĐÍCH VẪN CÒN, chỉ mất phần nối về tài khoản.
    await client.query(`update metric_targets set set_by = 'up-u1' where id = 'mt-1'`);
    await client.query(`delete from users where id = 'up-u1'`);
    assert.equal(await dem("select count(*)::int as n from metric_targets where id = 'mt-1' and set_by is null"), 1, "xoá người đặt KHÔNG được cuốn theo đích — đó là quyết định của shop, không phải tài sản của một tài khoản");
    await client.query(`delete from metric_targets where id = 'mt-1'`);

    // ══ BƯỚC 3: áp lại — migration phải idempotent ══
    await migrate(db, { migrationsFolder: thuMucSo });
    assert.equal(await dem("select count(*)::int as n from departments"), 7, "chạy lại migration KHÔNG được gieo thêm phòng ban lần hai");
    assert.equal(await dem("select count(*)::int as n from metric_targets"), 0, "chạy lại migration KHÔNG được sinh đích nào");
    assert.equal(await dem("select count(*)::int as n from shipment_return_reasons"), 0, "chạy lại migration KHÔNG được sinh lý do hoàn nào");
    assert.equal(await dem("select count(*)::int as n from cs_cases where id = 'up-c1' and assignee_user_id is null"), 1, "chạy lại migration vẫn KHÔNG được đoán người phụ trách");

    console.log(`✓ Đường nâng cấp từ production: ${truoc} → ${sau} migration (+${sau - truoc}) · dữ liệu nghiệp vụ nguyên vẹn · tài khoản cũ giữ nguyên phạm vi ALL · KHÔNG backfill người phụ trách · đích rỗng và bốn ràng buộc mới chặn đúng, xoá người đặt không cuốn theo đích · work_items rỗng (phép chiếu, không bản sao) · chạy lại không nhân đôi`);
  } finally {
    await client.close().catch(() => {});
    rmSync(tmp, { recursive: true, force: true });
  }
}
