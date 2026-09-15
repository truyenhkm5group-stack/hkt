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
// 14/09/2026: `0083_hmt_exception_resolution` ĐÃ lên main và đã chạy trên máy chủ (bản phát hành
// #276), nên nó không còn là "mới" nữa — giữ nó trong danh sách này làm bài kiểm đòi nâng mốc của
// một migration ĐÃ ÁP, tức là đúng điều nguy hiểm nhất có thể làm với sổ migration.
const MOI = ["0084_ai_workforce_foundation", "0085_sales_shadow_validation", "0086_product_resolver_v2", "0087_ad_media_url", "0088_fanpage_sales_profile", "0089_conversation_offer_snapshot", "0090_sales_knowledge"] as const;

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
    // 0081 CHƯA áp ở bước 1. Kiểm điều này để bài không lặng lẽ thành vô nghĩa vào ngày ai đó quên
    // cập nhật `MOI`: cột đã có sẵn từ trước thì "áp thêm migration" chẳng chứng minh được gì.
    // 0081 đã chạy thật trên máy chủ (bản phát hành #266) nên nay nó thuộc "trạng thái production
    // hôm nay", không còn là migration mới. Thứ CHƯA được có ở bước 1 là bảng của 0082 — kiểm điều
    // này để bài không lặng lẽ thành vô nghĩa vào ngày ai đó quên cập nhật `MOI`.
    assert.equal(await dem("select count(*)::int as n from information_schema.columns where table_name = 'cs_cases' and column_name = 'semantic'"), 1, "bước 1: 0081 phải đã áp — cột semantic có sẵn");
    assert.equal(await dem("select count(*)::int as n from information_schema.tables where table_name = 'hmt_workbooks'"), 1, "bước 1: 0082 phải đã áp — bảng hmt_workbooks có sẵn");
    // 0083 đã chạy thật trên máy chủ (bản phát hành #276) nên nay nó cũng thuộc "trạng thái
    // production hôm nay". Thứ CHƯA được có ở bước 1 là các bảng của nhân sự AI (0084) và bảng
    // nhận diện sản phẩm (0086) — kiểm điều này để bài không lặng lẽ thành vô nghĩa vào ngày ai đó
    // quên cập nhật `MOI`: cột đã có sẵn từ trước thì "áp thêm migration" chẳng chứng minh được gì.
    assert.equal(await dem("select count(*)::int as n from information_schema.columns where table_name = 'hmt_return_reconciliation' and column_name = 'resolution'"), 1, "bước 1: 0083 phải đã áp — cột resolution có sẵn");
    assert.equal(await dem("select count(*)::int as n from information_schema.tables where table_name = 'sales_conversations'"), 0, "bước 1: bảng nhân sự AI CHƯA được có — đó là thứ 0084 thêm vào");
    assert.equal(await dem("select count(*)::int as n from information_schema.tables where table_name = 'sales_product_resolutions'"), 0, "bước 1: bảng nhận diện sản phẩm CHƯA được có — đó là thứ 0086 thêm vào");
    await client.query(`insert into shipments (id, tracking_code, stage) values ('up-s9', 'UPS9', 'DELIVERY_FAILED')`);
    await client.query(`insert into shipments (id, tracking_code, stage) values ('up-s8', 'UPS8', 'DELIVERY_FAILED')`);
    await client.query(`insert into shipment_care (id, shipment_id, care_status, care_outcome, owner_at_resolution, opened_at, active, done_at) values ('up-care-1', 'up-s9', 'RESOLVED', null, null, now(), false, now())`);
    await client.query(`insert into shipment_care (id, shipment_id, care_status, care_outcome) values ('up-care-2', 'up-s8', 'NEW', 'PENDING')`);

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
      ═══ 0081 NAY NẰM TRONG TRẠNG THÁI PRODUCTION (bước 1) ═══

      Giữ lại phần kiểm quan trọng nhất của nó: case CŨ vẫn `NULL`. `NULL` nghĩa là CHƯA BIẾT (case
      sinh trước bản ấy), không phải "model đã xem và không nói gì" — và một backfill "hợp lý" thêm
      vào sau này sẽ làm bài này đỏ, đúng lúc cần đỏ.
    */
    assert.equal(await dem("select count(*)::int as n from cs_cases where id = 'up-c1' and semantic is null"), 1, "case cũ phải ở NULL — KHÔNG backfill, không mặc định");
    /*
      TRẠNG THÁI `NEEDS_REVIEW` KHÔNG CẦN MIGRATION, và bài này chứng minh điều đó thay vì tin lời.

      `cs_cases.status` là `text` không ràng buộc CHECK, nên mức tin cậy GIỮA chỉ là một giá trị
      mới của một cột đã có. Ngày nào có người thêm CHECK vào cột ấy thì bài này đỏ — đúng lúc cần
      đỏ, chứ không phải lúc job quét chạy trên production.
    */
    await client.query(`insert into cs_cases (id, kind, status, title) values ('up-c2', 'RETURN', 'NEEDS_REVIEW', 'Máy thấy nghi, người chưa xem')`);
    assert.equal(await dem("select count(*)::int as n from cs_cases where id = 'up-c2' and status = 'NEEDS_REVIEW'"), 1, "trạng thái 'chờ người xem lại' phải ghi được mà không cần migration");

    /*
      ═══ 0082: SỔ HÀNG HOÀN ĐƯA VÀO BẰNG CHÍNH ERP — MỘT BẢNG MỚI, KHOÁ LÀ NỘI DUNG ═══

      Bảng này là đường thay cho `scp`. Hai điều phải đúng: bảng có mặt, và cùng NỘI DUNG thì chỉ
      một dòng — kể cả khi người dùng đổi tên tệp, mà họ luôn đổi ("Bản sao của…", "… (1).xlsx").
      Hai dòng cho một tệp nghĩa là hai lượt đối soát đọc hai thứ khác nhau.
    */
    await client.query(`insert into hmt_workbooks (id, filename, sha256, bytes, content, uploaded_by) values ('up-wb1', 'so.xlsx', 'abc123', 3, 'AAA', 'Chủ shop')`);
    await assert.rejects(
      () => client.query(`insert into hmt_workbooks (id, filename, sha256, bytes, content, uploaded_by) values ('up-wb2', 'so (1).xlsx', 'abc123', 3, 'AAA', 'Chủ shop')`),
      () => true,
      "0082 (nay đã ở production): cùng nội dung, khác tên vẫn phải là MỘT bản",
    );
    // Người tải lên bị xoá tài khoản ⇒ khoá về NULL, DÒNG Ở LẠI: xoá bằng chứng theo người là mất dấu một lượt đối soát.
    await client.query(`update hmt_workbooks set uploaded_by_user_id = 'up-u1' where id = 'up-wb1'`);
    await client.query(`delete from users where id = 'up-u1'`);
    assert.equal(await dem("select count(*)::int as n from hmt_workbooks where id = 'up-wb1' and uploaded_by_user_id is null"), 1, "0082: xoá tài khoản người tải KHÔNG được cuốn theo dòng bằng chứng");
    await client.query(`insert into users (id, email, name, password_hash, role) values ('up-u1', 'a@shop.vn', 'An', 'x', 'CS')`);

    /*
      ═══ 0084 + 0085: NỀN TẢNG NHÂN SỰ AI — 14 BẢNG MỚI, KHÔNG ĐỤNG MỘT DÒNG NGHIỆP VỤ NÀO ═══

      Hai migration này từng mang số 0035/0036. Trên production, 0035 và 0036 là hai migration
      KHÁC đã chạy rồi — giữ số cũ thì drizzle thấy mục 0035 "đã áp" và bỏ qua vĩnh viễn phần nhân
      sự AI: không lỗi, không cảnh báo, bảng đơn giản là không tồn tại. Bài này là chỗ duy nhất
      chứng minh việc đánh số lại đã đúng, vì nó đi ĐÚNG đường mà máy chủ thật đi.
    */
    for (const bang of ["ai_agents", "ai_agent_versions", "ai_events", "ai_tasks", "ai_runs", "ai_tool_calls", "ai_model_calls", "ai_approvals", "ai_errors", "sales_conversations", "sales_messages", "sales_suggestions", "sales_followups", "sales_review_labels"]) {
      assert.equal(await dem(`select count(*)::int as n from information_schema.tables where table_name = '${bang}'`), 1, `0084/0085: thiếu bảng ${bang} trên đường nâng cấp — đây chính là kiểu hỏng mà số hiệu trùng gây ra`);
      assert.equal(await dem(`select count(*)::int as n from ${bang}`), 0, `0084/0085: migration KHÔNG được gieo sẵn dòng nào vào ${bang}`);
    }

    /*
      NẤC QUYỀN HẠN MẶC ĐỊNH PHẢI LÀ `SHADOW`, và đó là một ràng buộc AN TOÀN chứ không phải một
      lựa chọn thẩm mỹ. Một dòng nhân sự AI sinh ra ở nấc `AUTO` là một con bot được phép nhắn cho
      khách thật ngay khi có người quên khai cột. Mặc định phải nằm ở CSDL, không nằm ở mã nguồn.
    */
    await client.query(`insert into ai_agents (id, key, name) values ('up-ag1', 'sales', 'Nhân viên bán hàng AI')`);
    const nac = (await client.query<{ mode: string; enabled: boolean }>("select mode, enabled from ai_agents where id = 'up-ag1'")).rows[0];
    assert.equal(nac.mode, "SHADOW", "0084: nhân sự AI mới phải sinh ra ở nấc CHẠY NGẦM");

    /*
      CHỐNG TRÙNG TIN NHẮN NẰM Ở CSDL, không ở mã nguồn.

      Webhook và đường đọc bù có thể mang về cùng một tin. Nếu khoá duy nhất này không có thì hai
      đường sẽ cùng ghi, nhân sự AI đọc lịch sử hội thoại thấy khách "nhắc lại" câu vừa nói, và
      quyết định của nó đổi theo một sự kiện chưa từng xảy ra.
    */
    await client.query(`insert into sales_conversations (id, page_id, external_id) values ('up-cv1', 'page-1', 'conv-1')`);
    await client.query(`insert into sales_messages (id, conversation_id, external_id, text) values ('up-m1', 'up-cv1', 'msg-1', 'em muốn mua')`);
    await assert.rejects(
      () => client.query(`insert into sales_messages (id, conversation_id, external_id, text) values ('up-m2', 'up-cv1', 'msg-1', 'em muốn mua')`),
      (e: unknown) => /unique|duplicate|sales_messages_external_uq/i.test(String((e as { message?: string })?.message ?? e)),
      "0084: cùng một tin nhắn ghi lần hai phải bị CSDL chặn — webhook và đọc bù không được nhân đôi lịch sử",
    );
    // Cùng một hội thoại của cùng một page cũng vậy.
    await assert.rejects(
      () => client.query(`insert into sales_conversations (id, page_id, external_id) values ('up-cv2', 'page-1', 'conv-1')`),
      (e: unknown) => /unique|duplicate|sales_conversations_external_uq/i.test(String((e as { message?: string })?.message ?? e)),
      "0084: một hội thoại Pancake chỉ được có một dòng",
    );

    /*
      MƯỜI MỘT CỘT CỦA 0085 PHẢI CÓ MẶT SAU KHI ÁP CẢ HAI.

      Kiểm riêng vì chúng là `ALTER TABLE` trên bảng do 0084 tạo: nếu 0084 bị bỏ qua mà 0085 vẫn
      chạy thì lỗi hiện ra ở đây chứ không phải ở màn hình của chủ shop.
    */
    for (const [bang, cot] of [["ai_model_calls", "cached_input_tokens"], ["ai_model_calls", "pricing_version"], ["ai_runs", "cached_input_tokens"], ["ai_runs", "pricing_version"], ["sales_messages", "attachment_count"], ["sales_messages", "sender_type"], ["sales_messages", "platform"], ["sales_messages", "ingest_source"], ["sales_messages", "content_hash"], ["sales_suggestions", "human_reply_count"], ["sales_suggestions", "human_response_seconds"]] as const) {
      assert.equal(await dem(`select count(*)::int as n from information_schema.columns where table_name = '${bang}' and column_name = '${cot}'`), 1, `0085: thiếu cột ${bang}.${cot}`);
    }
    /*
      `human_response_seconds` phải là CHƯA BIẾT, không phải 0.

      Nhân viên chưa trả lời thì thời gian phản hồi là chưa biết. Điền 0 vào đó là khẳng định họ
      trả lời tức thì, và mọi con số trung bình sau này đều sai theo hướng đẹp hơn sự thật.
    */
    await client.query(`insert into sales_suggestions (id, conversation_id, suggested_reply) values ('up-sg1', 'up-cv1', 'Dạ mẫu này còn hàng ạ')`);
    const gy = (await client.query<{ human_reply_count: number; human_response_seconds: number | null }>("select human_reply_count, human_response_seconds from sales_suggestions where id = 'up-sg1'")).rows[0];
    assert.equal(gy.human_reply_count, 0, "0085: chưa có câu trả lời nào của người là 0 — đây là một PHÉP ĐẾM, đếm được");
    assert.equal(gy.human_response_seconds, null, "0085: chưa trả lời ⇒ thời gian phản hồi là CHƯA BIẾT (null), không phải 0 giây");
    await client.query(`delete from sales_conversations where id = 'up-cv1'`);
    await client.query(`delete from ai_agents where id = 'up-ag1'`);

    /*
      ═══ 0080 NAY NẰM TRONG TRẠNG THÁI PRODUCTION (bước 1) ═══

      Giữ lại phần kiểm ràng buộc của nó: chúng là ranh giới giữa "đã đối chiếu" và "đã đổi dữ
      liệu", và một ngày nào đó có người sửa bảng ấy thì bài này phải đỏ — dù migration sinh ra
      chúng đã cũ.
    */
    assert.equal(await dem("select count(*)::int as n from information_schema.tables where table_name = 'hmt_return_reconciliation'"), 1, "0080: bảng chứng cứ phải được tạo");
    assert.equal(await dem("select count(*)::int as n from hmt_return_reconciliation"), 0, "0080: KHÔNG gieo sẵn dòng nào — đối soát là một lượt chạy tay, không phải một backfill");

    /*
      ═══ 0083: KẾT LUẬN CỦA NGƯỜI TRÊN MỘT DÒNG KHÔNG KHỚP ═══

      Ràng buộc quan trọng nhất: dòng ĐÃ GHI (`written`) là chứng cứ nhận hàng của 672 kiện — không
      gắn kết luận của người lên nó được. Muốn sửa thì đi đường huỷ nhận, để lại dấu vết.
    */
    assert.equal(await dem("select count(*)::int as n from information_schema.columns where table_name = 'hmt_return_reconciliation' and column_name = 'resolution'"), 1, "0083: cột resolution phải được thêm");
    await client.query(`insert into shipments (id, tracking_code, stage) values ('up-s6', 'UPS6', 'RETURNED')`);
    await client.query(`insert into hmt_return_reconciliation (id, workbook, sheet, sheet_role, tracking_key, match_status, idempotency_key, shipment_id, written) values ('up-h9', 'wb', 's', 'FULL_RETURN_ITEMS', 'UPS6', 'MATCHED', 'k9', 'up-s6', true)`);
    await assert.rejects(
      () => client.query(`update hmt_return_reconciliation set resolution = 'DISMISSED', resolved_by = 'Kho', resolution_note = 'sửa cho đúng', resolved_at = now() where id = 'up-h9'`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("hmt_return_rec_resolution_written_check"),
      "0083: dòng đã ghi là bằng chứng — không viết đè kết luận của người lên nó",
    );
    // Gỡ rồi thì phải biết AI gỡ, LÚC NÀO, và VÌ SAO — ba vế, không thiếu vế nào.
    await client.query(`insert into hmt_return_reconciliation (id, workbook, sheet, sheet_role, tracking_key, match_status, idempotency_key) values ('up-h10', 'wb', 's', 'FULL_RETURN_ITEMS', 'UPS7X', 'SKU_MISMATCH', 'k10')`);
    await assert.rejects(
      () => client.query(`update hmt_return_reconciliation set resolution = 'DISMISSED' where id = 'up-h10'`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("hmt_return_rec_resolution_actor_check"),
      "0083: gỡ mà không ghi người/mốc/lý do phải bị chặn",
    );


    await client.query(`insert into shipments (id, tracking_code, stage) values ('up-s7', 'UPS7', 'RETURNED')`);
    await client.query(`insert into hmt_return_reconciliation (id, workbook, sheet, sheet_role, tracking_key, match_status, idempotency_key, shipment_id, written) values ('up-h1', 'wb', 'Chi tiết đơn hoàn', 'FULL_RETURN_ITEMS', 'UPS7', 'MATCHED', 'wb|FULL|UPS7|x|#1', 'up-s7', true)`);

    // Khoá chống trùng: chạy lại lượt đối soát KHÔNG được sinh thêm dòng nào.
    await assert.rejects(
      () => client.query(`insert into hmt_return_reconciliation (id, workbook, sheet, sheet_role, tracking_key, match_status, idempotency_key) values ('up-h2', 'wb', 'Chi tiết đơn hoàn', 'FULL_RETURN_ITEMS', 'UPS7', 'MATCHED', 'wb|FULL|UPS7|x|#1')`),
      (e: unknown) => /idempotency|unique|duplicate/i.test(String((e as { message?: string })?.message ?? e)),
      "0080: cùng một dòng nguồn ghi lần hai phải bị chặn — nếu không, chạy lại là nhân đôi chứng cứ",
    );
    // Trạng thái lạ bị chặn: danh sách PHẢI khớp `HMT_MATCH_STATUSES` ở mã nguồn.
    await assert.rejects(
      () => client.query(`insert into hmt_return_reconciliation (id, workbook, sheet, sheet_role, match_status, idempotency_key) values ('up-h3', 'wb', 's', 'FULL_RETURN_ITEMS', 'GAN_KHOP', 'k3')`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("hmt_return_rec_status_check"),
      "0080: 'gần khớp' không tồn tại — một dòng hoặc khớp đủ hai định danh hoặc không",
    );
    /*
      RÀNG BUỘC QUAN TRỌNG NHẤT CỦA 0080: chỉ dòng KHỚP mới được đánh dấu đã ghi.

      Chặn ở CSDL chứ không tin vào kỷ luật của mã nguồn — đây là ranh giới giữa "đã đối chiếu" và
      "đã đổi dữ liệu", và một dòng `written = true` mang trạng thái khác là một lượt ghi không ai
      giải thích được.
    */
    await assert.rejects(
      () => client.query(`insert into hmt_return_reconciliation (id, workbook, sheet, sheet_role, match_status, idempotency_key, written) values ('up-h4', 'wb', 's', 'FULL_RETURN_ITEMS', 'AMBIGUOUS_SKU', 'k4', true)`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("hmt_return_rec_written_check"),
      "0080: dòng KHÔNG khớp mà đánh dấu đã ghi là một lượt ghi không có căn cứ",
    );
    // Ô mã vận đơn trống mà khai một cách kế thừa không tồn tại thì bị chặn: ba giá trị, danh sách đóng.
    await assert.rejects(
      () => client.query(`insert into hmt_return_reconciliation (id, workbook, sheet, sheet_role, match_status, idempotency_key, inheritance) values ('up-h5', 'wb', 's', 'FULL_RETURN_ITEMS', 'MATCHED', 'k5', 'DOAN_TU_DONG_TREN')`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("hmt_return_rec_inheritance_check"),
      "0080: 'đoán từ dòng trên' không phải một cách kế thừa hợp lệ",
    );
    // Xoá kiện thì chứng cứ đi theo; nhưng chứng cứ KHÔNG giữ kiện lại.
    await client.query(`delete from shipments where id = 'up-s7'`);
    assert.equal(await dem("select count(*)::int as n from hmt_return_reconciliation where id = 'up-h1'"), 0, "0080: xoá kiện thì dòng chứng cứ của nó đi theo, không để lại dòng mồ côi");

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
      ═══ 0079: CHỨNG TỪ CỦA MỘT LƯỢT GỬI ═══

      Bốn cột NULLABLE, không mặc định — dòng cũ KHÔNG được đoán. Một dòng đã gửi từ trước mà điền
      đại `attempt_count = 1` là bịa ra một con số chưa ai đo.
    */
    for (const cot of ["provider_message_id", "accepted_at", "error_kind", "attempt_count"]) {
      assert.equal(await dem(`select count(*)::int as n from information_schema.columns where table_name = 'outreach_targets' and column_name = '${cot}'`), 1, `0079: thiếu cột ${cot}`);
    }
    await client.query(`insert into outreach_targets (id, segment, status, message, dedupe_key) values ('up-ot1', 'CROSS_SELL', 'SENDING', 'x', 'up-ot1')`);
    const ot = (await client.query<{ attempt_count: number; provider_message_id: string | null }>("select attempt_count, provider_message_id from outreach_targets where id = 'up-ot1'")).rows[0];
    assert.equal(ot.attempt_count, 0, "0079: chưa thử lần nào là 0, không phải 1");
    assert.equal(ot.provider_message_id, null, "0079: chưa có mã tin của nhà cung cấp ⇒ NULL, không phải chuỗi rỗng");
    // `SENDING` phải là trạng thái HỢP LỆ — không có nó thì cơ chế giành chỗ không ghi được.
    await assert.rejects(
      () => client.query(`insert into outreach_targets (id, segment, status, message, dedupe_key) values ('up-ot2', 'CROSS_SELL', 'LUNG_TUNG', 'x', 'up-ot2')`),
      (e: unknown) => String((e as { message?: string })?.message ?? e).includes("outreach_targets_status_check"),
      "0079: trạng thái lạ phải bị chặn — danh sách đóng",
    );
    await client.query(`delete from outreach_targets where id = 'up-ot1'`);

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
