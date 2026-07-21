# Daily auto-fetch of Kaspi Marketing ad spend -> RNP database.
# Schedule in Windows Task Scheduler (runs at 00:00 for the day that just ended).
# Log: data\ads-sync.log  -- shows whether the session survived overnight.
# Requires: running Docker (kaspi_postgres) and a valid KASPI_MARKETING_SESSION in .env.
# When the cookie expires, fetchAds exits with code 2 and the log says SESSION EXPIRED.
#
# enrichImages runs before importAds on purpose: ads are matched to our SKUs via
# sku.master_code, and a SKU first sold today has none yet. Without this step its
# ad spend silently falls on the floor (that is how ~19k KZT/day went missing).
$ErrorActionPreference = 'Continue'
$root = $PSScriptRoot
$backend = Join-Path $root 'backend'
$log = Join-Path $root 'data\ads-sync.log'
$ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
Set-Location $backend

Add-Content -Path $log -Value "==== [$ts] start ===="
& npx tsx src/scripts/fetchAds.ts *>> $log
$code = $LASTEXITCODE

if ($code -eq 0) {
  & npx tsx src/scripts/enrichImages.ts *>> $log
  Add-Content -Path $log -Value "[$ts] enrich done, exit=$LASTEXITCODE"
  & npx tsx src/scripts/importAds.ts *>> $log
  $importCode = $LASTEXITCODE
  Add-Content -Path $log -Value "[$ts] import done, exit=$importCode"

  # Reports are already in ad_spend -- keep only today's, else data\ grows by 19 files/day.
  # Runs ONLY after a successful import: on failure the CSVs are the only copy.
  # Cleanup lives in a .ts script -- the filename mask is Cyrillic and this file must stay ASCII.
  if ($importCode -eq 0) {
    & npx tsx src/scripts/cleanReports.ts 1 *>> $log
    Add-Content -Path $log -Value "[$ts] clean done, exit=$LASTEXITCODE"
  }
  else {
    Add-Content -Path $log -Value "[$ts] import failed -- keeping CSVs for retry"
  }
}
elseif ($code -eq 2) {
  Add-Content -Path $log -Value "[$ts] SESSION EXPIRED (exit 2) -- refresh KASPI_MARKETING_SESSION in .env. Import skipped."
}
else {
  Add-Content -Path $log -Value "[$ts] fetchAds failed, exit=$code. Import skipped."
}

# Stock lives in the seller cabinet, behind its OWN cookie (KASPI_MC_COOKIE) -- a dead
# marketing session must not skip it, so this runs regardless of the ads outcome.
& npx tsx src/scripts/fetchStock.ts *>> $log
$stockCode = $LASTEXITCODE
if ($stockCode -eq 2) {
  Add-Content -Path $log -Value "[$ts] STOCK SESSION EXPIRED (exit 2) -- refresh KASPI_MC_COOKIE in .env."
}
else {
  Add-Content -Path $log -Value "[$ts] stock done, exit=$stockCode"
}
