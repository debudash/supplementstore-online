# Local pre-push check that mirrors the GitLab pipeline (build-test + e2e).
# CI gives each suite its own fresh Postgres; here each suite gets its own fresh
# database (cerbo_test, cerbo_e2e) so suites never pollute each other or the dev DB (cerbo).
# Usage (repo root): powershell -ExecutionPolicy Bypass -File scripts/local-check.ps1
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

docker compose up -d --wait db | Out-Null

function Reset-Db($name) {
  docker exec cerbo-context-pack-db-1 psql -q -U postgres -c "DROP DATABASE IF EXISTS $name WITH (FORCE);" -c "CREATE DATABASE $name;" | Out-Null
}

function Step($label, $dbName, $cmd) {
  if ($dbName) { Reset-Db $dbName; $env:DATABASE_URL = "postgres://postgres:postgres@localhost:5432/$dbName" }
  Write-Host "===== $label" -ForegroundColor Cyan
  npm run $cmd
  if ($LASTEXITCODE -ne 0) { Write-Host "FAILED: $label" -ForegroundColor Red; exit 1 }
}

$env:NODE_ENV = 'test'
Step 'lint' $null 'lint'
Step 'typecheck' $null 'typecheck'
Step 'build' $null 'build'
Step 'unit + api tests' 'cerbo_test' 'test'
Step 'e2e (evals + red team)' 'cerbo_e2e' 'test:e2e'
Write-Host 'ALL CHECKS PASSED - matches CI build-test + e2e' -ForegroundColor Green
