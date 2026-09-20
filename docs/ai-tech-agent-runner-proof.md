# Bằng chứng lượt chạy runner đầu tiên của Phòng Tech AI

## Vì sao có trang này

Một lượt chạy agent chỉ đáng tin khi người đọc kiểm lại được: nó đứng trên commit nào, viết vào
nhánh nào, chạm đúng những tệp nào, và bốn cổng chất lượng ra kết quả gì. Thiếu bất kỳ mảnh nào
trong số đó thì "agent đã chạy xong" chỉ là một lời kể.

Trang này là hiện vật của lượt chạy ĐẦU TIÊN — lượt kiểm chứng vai `documentation` (Phase 2A).
Nó cố tình nhỏ: đúng một tệp markdown, không chạm mã nguồn. Mục đích không phải làm ra một tài
liệu hay, mà là chứng minh đường ống runner có thật và hàng rào phạm vi có siết.

## Lượt chạy

| Mục | Giá trị |
| --- | --- |
| Mã việc | `TECH-1` — "Kiểm chứng DOCUMENTATION agent Phase 2A" |
| Vai agent đã chạy | `DOCUMENTATION` (khoá `documentation`) |
| Mức rủi ro | R0 (do máy xếp qua `classifyTechRisk`, không ai đè) |
| Base SHA | **agent không tự đọc được** — xem mục "Base SHA và tên nhánh" bên dưới |
| Nhánh làm việc | **agent không tự đọc được** — xem mục bên dưới |
| Phạm vi ghi | ĐÚNG MỘT tệp: `docs/ai-tech-agent-runner-proof.md` |

### Base SHA và tên nhánh

Tôi ghi thẳng ra điều này thay vì điền một con số nghe hợp lý: trong hộp cát của vai tài liệu, mọi
lệnh `git` đều bị chặn (`git rev-parse HEAD`, `git branch --show-current`, `git status` đều trả
"không nằm trong danh sách được phép"), và thư mục `.git/` nằm trong vùng không bao giờ đọc. Nên
agent này **không quan sát được** base SHA lẫn tên nhánh của chính lượt chạy đang chứa nó.

Đó không phải lỗ hổng, đó là hàng rào đang làm đúng việc: agent tài liệu không có lý do gì cần đọc
kho git. Hai giá trị này do RUNNER ghi, và tra được ở hai nơi:

- Sổ `tech_agent_runs`: cột `base_commit` và `branch` của dòng mới nhất thuộc `TECH-1`.
- Bản in `npm run agent:proof-report -- --task TECH-1`, kèm hiện vật `bang-chung-agent.json`.

`scripts/agent-run.ts` lấy base bằng `git rev-parse HEAD` trên kho gốc — nghĩa là base luôn là một
commit ĐÃ VÀO KHO, không phải trạng thái cây làm việc đang bẩn.

## Bốn cổng

Ba cổng tôi tự chạy được và đọc mã thoát thật:

| Cổng | Lệnh | Kết quả |
| --- | --- | --- |
| typecheck | `npm run typecheck` (`tsc --noEmit`) | exit 0 — sạch |
| lint | `npm run lint` (`eslint`) | exit 0 — sạch |
| test | `npm run test` | **không chạy được ở đây** — lệnh bị hộp cát chặn |
| build | `npm run build` (`next build`) | exit 0 — dựng xong, kèm cảnh báo Edge Runtime của `jose` (`CompressionStream` / `DecompressionStream`), không phải lỗi |

Về cổng `test`: nó không nằm trong danh sách lệnh cho phép của vai tài liệu, nên tôi KHÔNG có kết
quả để báo. Kết quả thật của cổng này nằm ở cột `test_result` trong `tech_agent_runs` — runner mới
là bên chạy bốn cổng và ghi mã thoát vào sổ. Tôi không suy ra nó từ việc ba cổng kia xanh.

## Vai tài liệu KHÔNG được làm những gì

Đây không phải quy ước mềm; `scripts/agent-proof-setup.ts` kiểm lại từng quyền và dừng nếu sai:

- **Không merge** (`can_merge = false`).
- **Không deploy** (`can_deploy = false`).
- **Không ghi vào production** (`can_run_prod_write = false`).
- **Không đọc production** (`can_run_prod_read = false`).
- **Không review** (`can_review = false`).
- Chỉ nhận việc mức **R0** (`allowed_risks = ["R0"]`).
- Không sửa mã nguồn, không chạy lệnh ngoài danh sách cho phép, không commit — runner commit sau.
- Không đọc biến môi trường, không đọc `.git/`, không in secret. Các biến bí mật bị gỡ khỏi tiến
  trình con bằng `sandboxEnv()`.

Ngoài ra, mọi vai sinh ra ở trạng thái TẮT; đúng một vai `documentation` được NGƯỜI bật cho lượt
này — máy không tự bật agent cho chính nó.

## Câu kết

Agent không merge, không deploy
