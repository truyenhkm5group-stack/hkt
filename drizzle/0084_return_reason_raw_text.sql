-- CHỮ GỐC CỦA LÝ DO HOÀN ĐƯỢC LƯU LẠI KHI NGƯỜI XÁC NHẬN ĐÈ LÊN MÁY.
--
-- Trước bản này, người xử lý bấm "vải xấu" thì chữ ĐVVC ("Tồn - Khách hẹn giao lại") biến mất
-- khỏi mọi màn hình. Mất chữ gốc là mất đường kiểm chứng: một ca xếp lỗi sản phẩm mà chứng từ
-- ĐVVC nói chuyện khác là ca đáng hỏi lại, nhưng không ai còn thấy được nữa.
--
-- Cột có MẶC ĐỊNH RỖNG và KHÔNG backfill. Rỗng nghĩa là CHƯA CÓ CHỨNG TỪ — đoán hộ chữ gốc cho
-- dòng cũ là bịa ra một chứng từ, và sau đó không ai phân biệt được nữa.
ALTER TABLE "shipment_return_reasons" ADD COLUMN IF NOT EXISTS "raw_reason" text DEFAULT '' NOT NULL;
