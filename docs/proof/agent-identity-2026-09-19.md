# Bằng chứng danh tính agent — 2026-09-19

PR này do **`erp-agent-vnx[bot]`** mở, KHÔNG phải `truyenhkm5group-stack`. Đó là toàn bộ mục đích của nó.

| | |
|---|---|
| App | `erp-agent-vnx` (id `5001810`) |
| Cài đặt | `163026219`, phạm vi `selected` |
| Kho | `truyenhkm5group-stack/hkt` |
| Quyền | `checks=read` · `actions=read` · `contents=write` · `metadata=read` · `pull_requests=write` |
| Đường ghi | GitHub API (môi trường chạy tự tiêm credential git nên git push không chứng minh được danh tính) |

Chỉ có tệp này. Không đụng mã nghiệp vụ, không đụng cấu hình, không đụng ruleset.

Sinh bởi `scripts/agent-identity-proof.ts`. Bối cảnh: `docs/agent-github-identity.md`.
