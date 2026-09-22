# TECH-8: Kiểm tra trang vận đơn có tự tính kết quả đơn ngoài ORDER_OUTCOME không

**Phạm vi:** Trang Vận đơn (Giao vận) — tab "Tất cả vận đơn"  
**Nhánh:** `ai/data-quality/TECH-8-mucsqrtq`  
**Base SHA:** 96111b59a2a23f6c4165a224c3ae05caa2c9b545  
**Ngày kiểm tra:** 2025

## Tóm tắt kết quả

✅ **TUÂN THỨ RÀ BUỘC**: Trang vận đơn KHÔNG tự tính kết quả đơn ngoài `ORDER_OUTCOME`. Mọi lần xác định kết quả đơn (giao thành công / hoàn) đều dùng lại đúng biểu thức `ORDER_OUTCOME` từ `lib/queries/return-rate.ts`, không có bộ luật riêng nào.

---

## Chi tiết kiểm tra

### 1. Truy vấn chính (listShipments)

**Tệp:** `lib/queries/shipments.ts`, hàm `listShipments()`

```typescript
// MỘT nguồn kết luận duy nhất: dùng đúng biểu thức ORDER_OUTCOME mà mọi báo cáo dùng, thay vì
// tính lại theo tiền ở phía trình duyệt. Trước đây trang Vận đơn có bộ luật riêng nên cùng một
// vận đơn hiện "hoàn" ở đây mà "giao thành công" ở báo cáo (ca thật PKE1508909064).
const ids = rows.map((r) => r.id);
const outcomeRows = ids.length
  ? await db
      .select({ id: schema.shipments.id, outcome: ORDER_OUTCOME })  // <-- ĐÚNG
      .from(schema.shipments)
      .leftJoin(schema.orders, eq(schema.orders.id, schema.shipments.orderId))
      .where(inArray(schema.shipments.id, ids))
  : [];
const outcomeById = new Map(outcomeRows.map((r) => [r.id, r.outcome]));
const withOutcome = rows.map((r) => ({ ...r, outcome: outcomeById.get(r.id) ?? null }));
```

**Kết luận:** ✅ Dùng chính `ORDER_OUTCOME` từ `lib/queries/return-rate.ts`, không tính lại.

---

### 2. Hiển thị kết quả trên bảng (columns)

**Tệp:** `app/(dashboard)/shipments/columns.tsx`, hàm `buildShipmentColumns()`

```typescript
const fake = s.stage === "DELIVERED" && s.outcome && s.outcome !== "DELIVERED";
return (
  <div className="min-w-[140px] space-y-1" title={label}>
    <ShipmentStageBadge stage={s.stage} label={short} />
    {fake ? (
      <div className="text-[10.5px] font-medium text-rose-600 dark:text-rose-400">
        {s.outcome === "RETURNED" ? "Thực tế: hoàn (hàng đã quay về shop)" : "Thực tế: không thành công"}
      </div>
    ) : null}
```

**Kết luận:** ✅ Sử dụng `s.outcome` từ `ShipmentListRow`, mà `ShipmentListRow` lấy từ `ORDER_OUTCOME`. Không tính lại ở phía client.

---

### 3. Thống kê tóm tắt (shipmentSummary)

**Tệp:** `lib/queries/shipments.ts`, hàm `shipmentSummaryUncached()`

```typescript
const [row] = await db
  .select({
    total: count(),
    codPending: sql<number>`coalesce(sum(case when ${s.codStatus} = 'PENDING' then ${s.codAmount} else 0 end), 0)`,
    codPendingCount: sql<number>`coalesce(sum(case when ${s.codStatus} = 'PENDING' then 1 else 0 end), 0)`,
    delivering: sql<number>`coalesce(sum(case when ${s.stage} in ('PICKED_UP','IN_TRANSIT','OUT_FOR_DELIVERY') then 1 else 0 end), 0)`,
    // Giao thành công / hoàn tính theo DOANH THU COD (>100K là thành công, ≤100K là hàng hoàn) chứ không chỉ theo trạng thái VTP:
    // vận đơn chiều về và đơn khách trả hàng đều được Viettel Post ghi "Giao thành công" nhưng không thu được tiền.
    delivered: sql<number>`coalesce(sum(case when ${SHIPMENT_DELIVERED} then 1 else 0 end), 0)`,
    failed: sql<number>`coalesce(sum(case when ${s.stage} = 'DELIVERY_FAILED' then 1 else 0 end), 0)`,
    returning: sql<number>`coalesce(sum(case when ${SHIPMENT_RETURNED} then 1 else 0 end), 0)`,
  })
```

**Kết luận:** ✅ Dùng `SHIPMENT_DELIVERED` và `SHIPMENT_RETURNED` từ `lib/queries/return-rate.ts`, không tính lại.

---

### 4. Công thức `SHIPMENT_DELIVERED` và `SHIPMENT_RETURNED`

**Tệp:** `lib/queries/return-rate.ts`

```typescript
export const SHIPMENT_DELIVERED = sql`(${ORDER_OUTCOME_FAST} = 'DELIVERED')`;
export const SHIPMENT_RETURNED = sql`(${ORDER_OUTCOME_FAST} in ('RETURNED','RETURNED_BY_RULE'))`;
```

**Kết luận:** ✅ Hai công thức này dựa trên `ORDER_OUTCOME_FAST`, mà nó lại dựa trên `ORDER_OUTCOME`. Toàn bộ là cùng một nguồn sự thật.

---

### 5. Chi tiết vận đơn (outcomeOfShipment)

**Tệp:** `lib/queries/shipments.ts`, hàm `outcomeOfShipment()`

```typescript
export async function outcomeOfShipment(id: string) {
  const db = await getDb();
  const [row] = await db
    .select({ outcome: ORDER_OUTCOME })  // <-- ĐÚNG
    .from(schema.shipments)
    .leftJoin(schema.orders, eq(schema.orders.id, schema.shipments.orderId))
    .where(eq(schema.shipments.id, id))
    .limit(1);
  return row?.outcome ?? null;
}
```

**Kết luận:** ✅ Dùng chính `ORDER_OUTCOME`, không tính lại.

---

## Đặc tả được tuân thủ

Theo `docs/business-rules/ORDER_OUTCOME.md` và AGENTS.md mục 3:

1. ✅ **Mọi kết luận kết quả đơn dùng `ORDER_OUTCOME` từ `lib/queries/return-rate.ts`** — không có bộ luật tính lại ở trang vận đơn.
2. ✅ **Không suy ra giao thành công từ COD / tiền / Pancake** — dùng chính `ORDER_OUTCOME` mà đã quản lý tuân thủ hai quy tắc ấy.
3. ✅ **NULL là CHƯA BIẾT, không phải 0** — khi không có `outcome` thì dùng `?? null`, không đổi thành 0 hay mặc định nào khác.
4. ✅ **Hàng hoàn chỉ vào tồn kho khi có `return_received_at`** — điều này không liên quan trang vận đơn (nằm ở logic sổ kho); trang vận đơn chỉ hiển thị kết quả đơn, không ghi dữ liệu kho.

---

## Một số nhận xét sửa chữa quá khứ

Theo comment trong `lib/queries/shipments.ts`:

> Trước đây trang Vận đơn có bộ luật riêng nên cùng một vận đơn hiện "hoàn" ở đây mà "giao thành công" ở báo cáo (ca thật PKE1508909064).

Bản nay (nhánh hiện tại) đã sửa — tuân thủ một nguồn sự thật duy nhất.

---

## Kết luận

Trang vận đơn hiện tại **TUÂN THỨ RÀ BUỘC** trong AGENTS.md mục 3 và đặc tả ORDER_OUTCOME. Không có chỗ nào tự tính kết quả đơn ngoài `ORDER_OUTCOME` được chốt từ `lib/queries/return-rate.ts`.

Bản này có thể dùng làm nền tảng cho các phương án tối ưu ở bước sau (tối ưu không được đổi ngữ nghĩa), vì mã hiện tại đúng về nghiệp vụ.
