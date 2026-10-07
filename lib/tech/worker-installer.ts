import { ENROLLMENT_CODE_PATTERN, WORKER_EXIT } from "@/lib/constants/tech-worker-onboarding";
import { API_BILLING_ENV, TECH_QUEUE_PROVIDERS, type TechExecutionProvider } from "@/lib/constants/tech-worker";

/**
 * ═══════════ BỘ CÀI WORKER CHO WINDOWS — SINH RA TỪ HÀM THUẦN ═══════════
 *
 * docs/tech-control-plane/README.md mục 15. Hàm THUẦN (không CSDL, không đồng hồ, không mạng) — bài kiểm phân tích tĩnh
 * đúng chuỗi mà chủ shop sẽ tải về, không cần máy Windows (AGENTS.md mục 65).
 *
 * ─── HÌNH DẠNG TỆP ───
 *
 * Một tệp `.cmd` bấm đúp là chạy: vài dòng batch ASCII gọi `powershell.exe -ExecutionPolicy Bypass` cho CHÍNH phần
 * PowerShell nhúng ở cuối tệp (đọc lại tệp, cắt từ dấu `#VNX-PS-BEGIN`). Không đổi chính sách thực thi của máy, không
 * đòi quyền quản trị, không ghi script tạm ra đĩa.
 *
 * ─── TỆP MANG GÌ, KHÔNG MANG GÌ ───
 *
 *   · MANG: gốc ERP, mã worker, đường thi hành, URL kho PUBLIC, và MÃ GHI DANH dùng một lần (30 phút).
 *   · KHÔNG BAO GIỜ MANG: khoá worker (`tw_…`), khoá Anthropic, token GitHub. Khoá worker chỉ sinh ra lúc bộ cài đổi
 *     mã, nằm trong biến của tiến trình bộ cài vài giây rồi được cất bằng DPAPI.
 *
 * ─── VÌ SAO DPAPI THEO NGƯỜI DÙNG CHỨ KHÔNG PHẢI CREDENTIAL MANAGER ───
 *
 * Cả hai đều dựa trên DPAPI của tài khoản Windows: chỉ ĐÚNG người dùng đó trên ĐÚNG máy đó giải được; chép tệp sang
 * máy / tài khoản khác là vô dụng. Khác biệt là đường gọi: Windows PowerShell 5.1 có sẵn `ConvertFrom-SecureString`
 * (DPAPI CurrentUser) nhưng KHÔNG có cmdlet cho Credential Manager — muốn dùng phải cài module ngoài hoặc `Add-Type`
 * biên dịch C# gọi `CredWrite` lúc chạy (hay bị phần mềm diệt virus / AMSI chặn, và là mã gốc nhúng trong bộ cài).
 * Nên chọn DPAPI: ít mảnh chuyển động nhất, không phụ thuộc mạng / module, cùng mức bảo vệ. Tệp mã hoá nằm trong
 * `%LOCALAPPDATA%\VNX\tech-worker\<mã>\` và ACL chỉ cho chính người dùng. GIỚI HẠN THẬT (giống hệt Credential
 * Manager): mọi tiến trình chạy dưới CÙNG tài khoản Windows giải được — nên tài liệu mục 14 vẫn khuyên tài khoản
 * Windows riêng cho worker khi chạy việc R1 trở lên.
 */

export type WorkerInstallerInput = {
  origin: string;
  workerKey: string;
  provider: TechExecutionProvider;
  enrollmentCode: string;
  repoUrl: string;
  expiresAt: Date;
};

export const INSTALLER_PS_MARKER = "#VNX-PS-BEGIN";
export const INSTALLER_VERSION = "tech-worker-installer/1";

const ORIGIN_RE = /^(https:\/\/[A-Za-z0-9.-]+(:\d{2,5})?|http:\/\/(localhost|127\.0\.0\.1)(:\d{2,5})?)$/;
const REPO_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/;
const KEY_RE = /^[a-z][a-z0-9-]{2,39}$/;

/** Kiểm đầu vào — mọi giá trị đi vào chuỗi PowerShell phải có hình dạng ĐÓNG (không có `'`, khoảng trắng, `$`…). */
export function validateInstallerInput(i: Pick<WorkerInstallerInput, "origin" | "workerKey" | "provider" | "repoUrl"> & { enrollmentCode?: string }): string | null {
  if (!ORIGIN_RE.test(i.origin)) return "Địa chỉ ERP phải là https://… (hoặc http://localhost khi chạy thử).";
  if (!KEY_RE.test(i.workerKey)) return "Mã worker không hợp lệ.";
  if (!(TECH_QUEUE_PROVIDERS as readonly string[]).includes(i.provider)) return "Đường thi hành không hợp lệ.";
  if (!REPO_RE.test(i.repoUrl)) return "URL kho phải là https://github.com/<chủ>/<kho>.git, không kèm credential.";
  if (i.enrollmentCode !== undefined && !ENROLLMENT_CODE_PATTERN.test(i.enrollmentCode)) return "Mã ghi danh không hợp lệ.";
  return null;
}

/** Chuỗi PowerShell trong nháy đơn — đầu vào đã kiểm hình dạng, `''` chỉ là lưới cuối. */
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Tên tệp tải về — không mang bí mật nào. */
export function installerFileName(workerKey: string): string {
  return `cai-worker-${workerKey}.cmd`;
}
export function uninstallerFileName(workerKey: string): string {
  return `go-worker-${workerKey}.cmd`;
}

/** Vỏ batch ASCII: chạy phần PowerShell nhúng ở cuối CHÍNH tệp này. */
function batchShell(title: string): string {
  return [
    "@echo off",
    "setlocal",
    `title ${title}`,
    'set "VNX_SELF=%~f0"',
    `powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$s=[IO.File]::ReadAllText($env:VNX_SELF,[Text.Encoding]::UTF8);$i=$s.LastIndexOf('${INSTALLER_PS_MARKER}');if($i -lt 0){exit 9};& ([ScriptBlock]::Create($s.Substring($i)))"`,
    'set "VNX_RC=%ERRORLEVEL%"',
    "echo.",
    "pause",
    "exit /b %VNX_RC%",
  ].join("\r\n");
}

const API_VARS_PS = `@(${API_BILLING_ENV.map((k) => q(k)).join(", ")})`;

/**
 * Trình khởi động `start-worker.ps1` — bộ cài ghi nó ra thư mục worker. KHÔNG mang bí mật: đọc cấu hình thường từ
 * `worker.json`, giải khoá DPAPI vào biến môi trường CỦA TIẾN TRÌNH worker (không ghi tệp thường), gỡ mọi biến tính
 * tiền API khỏi tiến trình worker gói thuê bao, và mở lại worker khi nó thoát bằng mã "khởi động lại".
 */
export function buildWorkerLauncher(): string {
  return `param([switch]$Check)
# VNX Tech Worker — trình khởi động (sinh bởi /tech/workers). KHÔNG chứa bí mật nào.
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$cfg = Get-Content -Raw -Path (Join-Path $Root 'worker.json') | ConvertFrom-Json
$RepoDir = [string]$cfg.repoDir
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + (Join-Path $env:APPDATA 'npm')
Set-Content -Path (Join-Path $Root 'worker.pid') -Value $PID -Encoding ASCII
# Ranh giới thanh toán: worker gói thuê bao không bao giờ thấy biến tính tiền API. Chỉ gỡ khỏi TIẾN TRÌNH NÀY — biến của máy giữ nguyên.
if ([string]$cfg.provider -eq 'SUBSCRIPTION_CLAUDE_CODE') {
  foreach ($k in ${API_VARS_PS}) { Remove-Item -Path ('Env:' + $k) -ErrorAction SilentlyContinue }
}
function Read-Dpapi([string]$name) {
  $f = Join-Path $Root $name
  if (-not (Test-Path $f)) { return '' }
  $sec = ConvertTo-SecureString -String ((Get-Content -Raw -Path $f).Trim())
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}
function Refresh-Repo {
  git -C $RepoDir fetch origin main --quiet
  git -C $RepoDir checkout -q -B main origin/main
  $h = (Get-FileHash -Path (Join-Path $RepoDir 'package-lock.json')).Hash
  $f = Join-Path $Root 'lock.sha256'
  if (-not (Test-Path $f) -or ((Get-Content -Raw -Path $f).Trim() -ne $h)) {
    Push-Location $RepoDir
    npm ci --no-audit --no-fund
    Pop-Location
    Set-Content -Path $f -Value $h -Encoding ASCII
  }
}
$env:TECH_WORKER_URL = [string]$cfg.origin
$env:TECH_WORKER_REPO = $RepoDir
$env:TECH_WORKER_ROOT = Join-Path $Root 'work'
$env:TECH_WORKER_INSTALLED = '1'
New-Item -ItemType Directory -Force -Path $env:TECH_WORKER_ROOT | Out-Null
$env:TECH_WORKER_TOKEN = Read-Dpapi 'worker-credential.dpapi'
if ([string]$cfg.provider -eq 'ANTHROPIC_API') { $env:TECH_WORKER_ANTHROPIC_API_KEY = Read-Dpapi 'anthropic-key.dpapi' }
if (-not $env:TECH_WORKER_TOKEN) { Write-Host 'Chưa có khoá worker — chạy lại bộ cài tải từ /tech/workers.'; exit ${WORKER_EXIT.CONFIG} }
$tsx = Join-Path $RepoDir 'node_modules\\tsx\\dist\\cli.mjs'
$nodeArgs = @($tsx, '--tsconfig', (Join-Path $RepoDir 'tsconfig.json'), (Join-Path $RepoDir 'scripts\\tech-worker.ts'))
if ($Check) { $nodeArgs += '--check' }
$log = Join-Path $Root 'worker.log'
do {
  if ((Test-Path $log) -and ((Get-Item $log).Length -gt 5MB)) { Move-Item -Force $log ($log + '.old') }
  Push-Location $RepoDir
  if ($Check) { & node @nodeArgs } else { & node @nodeArgs *>> $log }
  $rc = $LASTEXITCODE
  Pop-Location
  if ($rc -eq ${WORKER_EXIT.REFRESH_AND_RESTART}) { Refresh-Repo }
} while ((-not $Check) -and ($rc -eq ${WORKER_EXIT.RESTART} -or $rc -eq ${WORKER_EXIT.REFRESH_AND_RESTART}))
$env:TECH_WORKER_TOKEN = $null
$env:TECH_WORKER_ANTHROPIC_API_KEY = $null
exit $rc
`;
}

/**
 * Bộ cài: dựng thư mục cô lập, kiểm / cài Git + Node LTS + Claude Code, clone kho public, đổi mã ghi danh lấy khoá
 * (thân request), cất khoá bằng DPAPI, đăng nhập Claude một lần nếu cần, tự kiểm, tuỳ chọn tự chạy khi đăng nhập
 * Windows. Mọi câu in ra là tiếng Việt và không câu nào chứa bí mật.
 */
export function buildWorkerInstaller(input: WorkerInstallerInput): string {
  const sai = validateInstallerInput(input);
  if (sai) throw new Error(sai);
  const hetHan = input.expiresAt.toISOString();
  const launcher = buildWorkerLauncher();
  if (/^'@/m.test(launcher)) throw new Error("Trình khởi động không được có dòng bắt đầu bằng '@");
  const ps = `${INSTALLER_PS_MARKER}
# VNX Tech Worker — bộ cài cho worker ${input.workerKey} (sinh bởi /tech/workers, ${INSTALLER_VERSION}).
# Tệp này KHÔNG chứa khoá worker. Nó mang một MÃ GHI DANH dùng MỘT lần, hết hạn lúc ${hetHan} (UTC).
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

$Origin = ${q(input.origin)}
$WorkerKey = ${q(input.workerKey)}
$Provider = ${q(input.provider)}
$EnrollCode = ${q(input.enrollmentCode)}
$RepoUrl = ${q(input.repoUrl)}
$InstallerVersion = ${q(INSTALLER_VERSION)}
$ApiVars = ${API_VARS_PS}

$Root = Join-Path $env:LOCALAPPDATA ('VNX\\tech-worker\\' + $WorkerKey)
$RepoDir = Join-Path $Root 'repo'
$CredFile = Join-Path $Root 'worker-credential.dpapi'
$Launcher = Join-Path $Root 'start-worker.ps1'
$TaskName = 'VNX Tech Worker ' + $WorkerKey
$Me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

function Say([string]$m) { Write-Host $m }
function Step([string]$n, [string]$m) { Write-Host ''; Write-Host ('[' + $n + '/8] ' + $m) -ForegroundColor Cyan }
function Fail([string]$m) { Write-Host ''; Write-Host ('CHƯA CÀI XONG: ' + $m) -ForegroundColor Red; exit 1 }
function Have([string]$c) { return [bool](Get-Command $c -CommandType Application -ErrorAction SilentlyContinue) }
function Refresh-Path { $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + (Join-Path $env:APPDATA 'npm') }
function Protect-File([string]$f) { icacls $f /inheritance:r /grant:r ($Me + ':F') | Out-Null }
function Ensure-Tool([string]$cmd, [string]$wingetId, [string]$label) {
  if (Have $cmd) { Say ('  ' + $label + ': đã có.'); return }
  if (-not (Have 'winget')) { Fail ($label + ' chưa có trên máy và máy không có winget để tự cài. Cài ' + $label + ' rồi bấm đúp lại tệp này.') }
  Say ('  Đang cài ' + $label + ' bằng winget (vài phút)...')
  winget install --id $wingetId -e --source winget --accept-package-agreements --accept-source-agreements --silent --scope user | Out-Host
  Refresh-Path
  if (-not (Have $cmd)) {
    winget install --id $wingetId -e --source winget --accept-package-agreements --accept-source-agreements --silent | Out-Host
    Refresh-Path
  }
  if (-not (Have $cmd)) { Fail ('Không tự cài được ' + $label + '. Cài ' + $label + ' rồi bấm đúp lại tệp này.') }
}
function Claude-Auth {
  $o = (claude auth status --json 2>$null | Out-String)
  try { $j = $o | ConvertFrom-Json } catch { return 'UNKNOWN' }
  if ($j.loggedIn -eq $false) { return 'NOT_LOGGED_IN' }
  if ($j.loggedIn -ne $true) { return 'UNKNOWN' }
  if ([string]$j.authMethod -eq 'claude.ai') { return 'SUBSCRIPTION' }
  return 'API'
}

Say ('Cài worker ' + $WorkerKey + ' cho ' + $Origin)
Say 'Không cần quyền quản trị. Không cần dán khoá nào. Có thể đóng cửa sổ bất kỳ lúc nào và chạy lại.'

Step 1 'Tạo thư mục riêng cho worker'
New-Item -ItemType Directory -Force -Path $Root | Out-Null
Say ('  ' + $Root)

Step 2 'Kiểm Git và Node.js'
Refresh-Path
Ensure-Tool 'git' 'Git.Git' 'Git'
Ensure-Tool 'node' 'OpenJS.NodeJS.LTS' 'Node.js LTS'
$nodeMajor = 0
try { $nodeMajor = [int](((node -v) -replace '^v', '').Split('.')[0]) } catch {}
if ($nodeMajor -lt 20) { Fail ('Node.js quá cũ (cần bản 20 trở lên, máy đang có ' + (node -v) + '). Cập nhật Node.js LTS rồi chạy lại.') }

Step 3 'Kiểm Claude Code'
if (-not (Have 'claude')) {
  Say '  Đang cài Claude Code (npm, chỉ cho người dùng này)...'
  npm install -g @anthropic-ai/claude-code --no-audit --no-fund | Out-Host
  Refresh-Path
}
if (-not (Have 'claude')) { Fail 'Không cài được Claude Code. Kiểm kết nối mạng rồi chạy lại.' }
Say ('  ' + (claude --version 2>$null | Out-String).Trim())

Step 4 'Lấy kho mã vào thư mục riêng của worker'
if (Test-Path (Join-Path $RepoDir '.git')) {
  git -C $RepoDir remote set-url origin $RepoUrl
  git -C $RepoDir fetch origin main --quiet
  git -C $RepoDir checkout -q -B main origin/main
} else {
  git clone --quiet --branch main $RepoUrl $RepoDir
}
if (-not (Test-Path (Join-Path $RepoDir 'package.json'))) { Fail 'Không lấy được kho mã. Kiểm kết nối mạng rồi chạy lại.' }
Say '  Đang cài thư viện cho worker (lần đầu vài phút)...'
Push-Location $RepoDir
npm ci --no-audit --no-fund | Out-Host
$npmRc = $LASTEXITCODE
Pop-Location
if ($npmRc -ne 0) { Fail 'npm ci thất bại trong kho của worker. Chạy lại bộ cài; nếu vẫn lỗi, bấm «Sửa lỗi tự động» trên /tech/workers.' }
Set-Content -Path (Join-Path $Root 'lock.sha256') -Value (Get-FileHash -Path (Join-Path $RepoDir 'package-lock.json')).Hash -Encoding ASCII

Step 5 'Ghi danh worker với máy chủ (mã dùng một lần)'
$body = @{ code = $EnrollCode; host = $env:COMPUTERNAME; version = $InstallerVersion } | ConvertTo-Json -Compress
$resp = $null
try {
  $resp = Invoke-RestMethod -Method Post -Uri ($Origin + '/api/tech/worker/enroll') -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 60 -ErrorAction Stop
} catch { $resp = $null }
$EnrollCode = $null
$body = $null
if ($resp -and ([string]$resp.token).StartsWith('tw_')) {
  Step 6 'Cất khoá worker bằng DPAPI của tài khoản Windows này'
  $sec = ConvertTo-SecureString -String ([string]$resp.token) -AsPlainText -Force
  Set-Content -Path $CredFile -Value (ConvertFrom-SecureString -SecureString $sec) -Encoding ASCII
  Protect-File $CredFile
  $sec = $null
  $resp = $null
  Say '  Đã cất. Khoá không được in ra và không nằm trong tệp thường nào.'
} elseif (Test-Path $CredFile) {
  Step 6 'Dùng khoá worker đã cất từ lần cài trước'
  Say '  Mã ghi danh không còn dùng được (đã dùng / hết hạn) — giữ khoá đã cất. Nếu khoá cũ đã bị thu hồi, tải bộ cài mới.'
} else {
  Fail 'Máy chủ không nhận mã ghi danh (đã dùng, hết hạn sau 30 phút, hoặc worker vừa được tạo lại token). Vào /tech/workers bấm «Tải bộ cài» để lấy tệp mới.'
}

if ($Provider -eq 'ANTHROPIC_API') {
  $keyFile = Join-Path $Root 'anthropic-key.dpapi'
  if (-not (Test-Path $keyFile)) {
    Say ''
    Say 'Worker này trả tiền Anthropic API theo token. Cần khoá API RIÊNG cho worker (không dùng khoá của sản phẩm khác).'
    $k = Read-Host -AsSecureString 'Dán khoá Anthropic API rồi Enter (ký tự không hiện ra, không lưu lịch sử)'
    Set-Content -Path $keyFile -Value (ConvertFrom-SecureString -SecureString $k) -Encoding ASCII
    Protect-File $keyFile
    $k = $null
  }
}

Step 7 'Đăng nhập Claude (chỉ khi cần)'
if ($Provider -eq 'SUBSCRIPTION_CLAUDE_CODE') {
  foreach ($v in $ApiVars) { Remove-Item -Path ('Env:' + $v) -ErrorAction SilentlyContinue }
  $auth = Claude-Auth
  if ($auth -eq 'API') {
    Say '  Claude Code trên máy đang đăng nhập bằng tiền API (Console). Worker gói thuê bao KHÔNG chạy bằng đăng nhập này.'
    $a = Read-Host '  Đăng xuất rồi đăng nhập lại bằng gói thuê bao Claude? (C/k)'
    if ($a -eq '' -or $a -match '^[cCyY]') { claude auth logout | Out-Null; $auth = 'NOT_LOGGED_IN' }
  }
  if ($auth -ne 'SUBSCRIPTION') {
    Say '  Một cửa sổ đăng nhập Claude sẽ mở. Đăng nhập bằng tài khoản có gói Claude (Pro / Max) rồi quay lại đây.'
    $claudeCmd = (Get-Command claude -CommandType Application | Select-Object -First 1).Source
    Start-Process -FilePath $claudeCmd -ArgumentList @('auth', 'login', '--claudeai') -Wait
    $auth = Claude-Auth
  }
  if ($auth -eq 'SUBSCRIPTION') { Say '  Đã đăng nhập bằng gói thuê bao.' } else { Say '  Chưa đăng nhập được — worker sẽ báo trên /tech/workers và CHƯA nhận việc. Chạy lại tệp này để thử lại.' }
} else {
  Say '  Đường Anthropic API — không cần đăng nhập Claude.'
}

Step 8 'Tự kiểm và khởi động worker'
@{ origin = $Origin; key = $WorkerKey; provider = $Provider; repoDir = $RepoDir } | ConvertTo-Json | Set-Content -Path (Join-Path $Root 'worker.json') -Encoding UTF8
$LauncherText = @'
${launcher}'@
Set-Content -Path $Launcher -Value $LauncherText -Encoding UTF8
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
foreach ($pf in @('worker.pid', 'node.pid')) {
  $pidFile = Join-Path $Root $pf
  if (Test-Path $pidFile) { Stop-Process -Id ([int]((Get-Content -Raw -Path $pidFile).Trim())) -Force -ErrorAction SilentlyContinue }
}
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Launcher -Check
$rc = $LASTEXITCODE
if ($rc -eq 0) { Say '  Tự kiểm ĐẠT.' }
elseif ($rc -eq ${WORKER_EXIT.BILLING_BOUNDARY}) { Say '  Tự kiểm: ranh giới thanh toán chặn (có biến tính tiền API hoặc đăng nhập Console). Worker sẽ không nhận việc cho tới khi sửa — xem /tech/workers.' }
else { Say ('  Tự kiểm CHƯA ĐẠT (mã ' + $rc + ') — chi tiết hiện trên /tech/workers. Worker vẫn chạy để báo trạng thái.') }

$auto = Read-Host 'Cho worker tự chạy nền mỗi khi bạn đăng nhập Windows? (C/k)'
$started = $false
if ($auto -eq '' -or $auto -match '^[cCyY]') {
  try {
    $act = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $Launcher + '"')
    $trg = New-ScheduledTaskTrigger -AtLogOn -User $Me
    $set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5)
    $pri = New-ScheduledTaskPrincipal -UserId $Me -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $TaskName -Action $act -Trigger $trg -Settings $set -Principal $pri -Force -ErrorAction Stop | Out-Null
    Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $started = $true
    Say ('  Đã đặt tự chạy khi đăng nhập Windows (Task Scheduler: ' + $TaskName + ') và khởi động worker.')
  } catch {
    Say '  Không đặt được tự chạy (Windows không cho) — khởi động worker một lần trong cửa sổ thu nhỏ.'
  }
}
if (-not $started) {
  Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Launcher) -WindowStyle Minimized
}
Say ''
Say 'XONG. Mở /tech/workers — worker sẽ hiện «Đang sống» trong khoảng 30 giây.'
Say ('Nhật ký của worker: ' + (Join-Path $Root 'worker.log'))
exit 0
`;
  return `${batchShell(`VNX Tech Worker - cai dat ${input.workerKey}`)}\r\n${ps.replace(/\r?\n/g, "\r\n")}`;
}

/** Tệp gỡ cài đặt: dừng + xoá Scheduled Task, dừng tiến trình, xoá thư mục worker (gồm khoá DPAPI). Không mang bí mật. */
export function buildWorkerUninstaller(input: { workerKey: string }): string {
  if (!KEY_RE.test(input.workerKey)) throw new Error("Mã worker không hợp lệ.");
  const ps = `${INSTALLER_PS_MARKER}
# VNX Tech Worker — gỡ worker ${input.workerKey} khỏi máy này (sinh bởi /tech/workers). Không chứa bí mật nào.
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$WorkerKey = ${q(input.workerKey)}
$Root = Join-Path $env:LOCALAPPDATA ('VNX\\tech-worker\\' + $WorkerKey)
$TaskName = 'VNX Tech Worker ' + $WorkerKey
Write-Host ('Gỡ worker ' + $WorkerKey + ' khỏi máy này...')
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
foreach ($pf in @('worker.pid', 'node.pid')) {
  $pidFile = Join-Path $Root $pf
  if (Test-Path $pidFile) { Stop-Process -Id ([int]((Get-Content -Raw -Path $pidFile).Trim())) -Force -ErrorAction SilentlyContinue }
}
Start-Sleep -Seconds 2
if (Test-Path $Root) { Remove-Item -Recurse -Force -Path $Root -ErrorAction SilentlyContinue }
if (Test-Path $Root) { Write-Host ('Còn sót thư mục ' + $Root + ' (tệp đang mở) — khởi động lại máy rồi chạy lại tệp này.') -ForegroundColor Yellow; exit 1 }
Write-Host 'Đã gỡ: tác vụ tự chạy, khoá worker đã cất (DPAPI), kho và cây làm việc của worker.'
Write-Host 'Git, Node.js và Claude Code KHÔNG bị gỡ (có thể đang dùng cho việc khác).'
exit 0
`;
  return `${batchShell(`VNX Tech Worker - go ${input.workerKey}`)}\r\n${ps.replace(/\r?\n/g, "\r\n")}`;
}
