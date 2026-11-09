# Разворачивает Edge Function "api" (личный кабинет) в Supabase.
#
# Использование:
#   $env:SUPABASE_ACCESS_TOKEN = "<токен управления Supabase Portal>"
#   powershell -File scripts/deploy_edge_api.ps1
#
# Токен управления берётся на https://supabase.com/dashboard/account/tokens
# (Account -> Access Tokens). Он не равен anon/service_role ключам проекта.
#
# Секреты функции (SECRET_KEY, TELEGRAM_BOT_TOKEN, CRON_SECRET, OPENAI_COMPAT_*)
# задаются один раз через дашборд Supabase или Management API и здесь не нужны.

param(
    [string]$ProjectRef = "yapnxwamxmyobnffdhvu",
    [string]$Slug = "api"
)

$ErrorActionPreference = "Stop"

$token = $env:SUPABASE_ACCESS_TOKEN
if (-not $token) {
    Write-Error "Не задан SUPABASE_ACCESS_TOKEN. Получите токен: https://supabase.com/dashboard/account/tokens"
}

$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root "supabase\functions\$Slug\index.ts"
if (-not (Test-Path $src)) { Write-Error "Не найден исходник функции: $src" }

# Во временный ASCII-путь, чтобы curl не спотыкался о кириллицу и кавычки.
$tmp = Join-Path $env:TEMP "edge_deploy_$Slug"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
Copy-Item $src (Join-Path $tmp "index.ts") -Force
[IO.File]::WriteAllText((Join-Path $tmp "metadata.json"),
    "{`"entrypoint_path`":`"index.ts`",`"verify_jwt`":false,`"name`":`"$Slug`"}")

$url = "https://api.supabase.com/v1/projects/$ProjectRef/functions/deploy?slug=$Slug"
$out = Join-Path $tmp "deploy_result.json"
$code = & curl.exe -s -m 120 -o $out -w "%{http_code}" -X POST $url `
    -H "Authorization: Bearer $token" `
    -F "metadata=<$tmp\metadata.json;type=application/json" `
    -F "file=@$tmp\index.ts;type=application/typescript"

Write-Host "deploy HTTP $code"
Get-Content -Raw $out
if ($code -notin @("200", "201")) { exit 1 }

Write-Host ""
Write-Host "Проверка:"
Start-Sleep -Seconds 8
& curl.exe -s -m 30 "https://$ProjectRef.supabase.co/functions/v1/$Slug/api/health"
