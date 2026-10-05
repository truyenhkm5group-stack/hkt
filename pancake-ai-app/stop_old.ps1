# Stop an OLD Pancake AI Sales Manager instance holding the port (e.g. old window left open after updating files).
# Only stops a process that identifies itself as this app via /api/health - never any other program.
param([int]$Port = 8800)
$ErrorActionPreference = "SilentlyContinue"
if (Test-Path ".env") {
  $line = Get-Content ".env" | Where-Object { $_ -match '^\s*PORT\s*=\s*(\d+)\s*$' } | Select-Object -First 1
  if ($line -and $line -match '(\d+)') { $Port = [int]$Matches[1] }
}
$h = $null
try { $h = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 3 } catch {}
if (-not $h) { exit 0 }  # port free, or another program (server.py moves to the next free port)
$isOurs = $h.ok -and (($h.app -eq "pancake-ai-sales-manager") -or ($h.PSObject.Properties.Name -contains "auth_required"))
if (-not $isOurs) { exit 0 }
$pids = @()
if ($h.pid) { $pids += [int]$h.pid }
$pids += (Get-NetTCPConnection -LocalPort $Port -State Listen).OwningProcess
foreach ($id in ($pids | Sort-Object -Unique)) {
  if ($id -and $id -ne $PID) {
    Write-Host "Tat ban bot cu dang chay (PID $id) de chay ban moi..."
    Stop-Process -Id $id -Force
  }
}
for ($i = 0; $i -lt 20; $i++) {
  if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen)) { break }
  Start-Sleep -Milliseconds 500
}
exit 0
