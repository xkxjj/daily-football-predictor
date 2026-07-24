param(
  [string]$RepositoryPath = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
)

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $RepositoryPath

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments
  )

  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Command failed with exit code $LASTEXITCODE"
  }
}

$lockPath = Join-Path $RepositoryPath ".git\football-prediction-update.lock"
$lock = $null

try {
  try {
    $lock = [System.IO.File]::Open(
      $lockPath,
      [System.IO.FileMode]::OpenOrCreate,
      [System.IO.FileAccess]::ReadWrite,
      [System.IO.FileShare]::None
    )
  }
  catch {
    throw "Another football prediction update is already running."
  }

  $dirty = @(git status --porcelain)
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to inspect the Git working tree."
  }
  if ($dirty.Count -gt 0) {
    throw "The updater checkout contains uncommitted changes; refusing to overwrite them."
  }

  Invoke-Checked git -c credential.interactive=never pull --rebase origin main
  Invoke-Checked npm.cmd test
  Invoke-Checked npm.cmd run update
  Invoke-Checked npm.cmd test

  & git diff --quiet -- data
  $diffExitCode = $LASTEXITCODE
  if ($diffExitCode -eq 0) {
    Write-Host "No auditable data changes."
    exit 0
  }
  if ($diffExitCode -ne 1) {
    throw "Unable to inspect generated data changes."
  }

  Invoke-Checked git add -- data
  Invoke-Checked git commit -m "Update daily football predictions"
  Invoke-Checked git -c credential.interactive=never push origin HEAD:main
  Write-Host "Football predictions updated and pushed successfully."
}
finally {
  if ($null -ne $lock) {
    $lock.Dispose()
  }
}
