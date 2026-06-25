param(
  [int]$Port = 3766,
  [switch]$OpenConsole
)

$ErrorActionPreference = "Stop"

function Write-Step($Text) {
  Write-Host ""
  Write-Host "==> $Text" -ForegroundColor Cyan
}

function Find-EdgeOrChrome {
  $programFilesX86 = [Environment]::GetFolderPath("ProgramFilesX86")
  $candidates = @(
    "$programFilesX86\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "$programFilesX86\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  )
  foreach ($item in $candidates) {
    if ($item -and (Test-Path $item)) { return $item }
  }
  return $null
}

function Ensure-PortableNode {
  param(
    [Parameter(Mandatory = $true)]
    [string]$AppRoot
  )
  $runtimeDir = Join-Path $AppRoot ".runtime"
  $nodeDir = Join-Path $runtimeDir "node-v22.22.1-win-x64"
  $nodeExe = Join-Path $nodeDir "node.exe"
  $npmCmd = Join-Path $nodeDir "npm.cmd"
  if ((Test-Path $nodeExe) -and (Test-Path $npmCmd)) {
    return @{ Node = $nodeExe; Npm = $npmCmd; NodeDir = $nodeDir }
  }

  Write-Step "Download portable Node.js 22"
  New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
  $zip = Join-Path $runtimeDir "node-v22.22.1-win-x64.zip"
  $url = "https://nodejs.org/dist/v22.22.1/node-v22.22.1-win-x64.zip"
  if (!(Test-Path $zip)) {
    Invoke-WebRequest -Uri $url -OutFile $zip
  }
  if (Test-Path $nodeDir) {
    Remove-Item -Recurse -Force $nodeDir
  }
  Expand-Archive -Path $zip -DestinationPath $runtimeDir -Force
  if (!(Test-Path $nodeExe)) {
    throw "Portable Node extraction failed: $nodeExe not found"
  }
  return @{ Node = $nodeExe; Npm = $npmCmd; NodeDir = $nodeDir }
}

function Resolve-AppRoot {
  $sourceRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
  $sourceText = $sourceRoot.ProviderPath
  if (!$sourceText.StartsWith("\\")) {
    return $sourceText
  }

  Write-Step "Copy app from UNC path to local disk"
  $targetRoot = "C:\DouyinLocalPublishMMVP\app"
  New-Item -ItemType Directory -Force -Path $targetRoot | Out-Null
  robocopy $sourceText $targetRoot /MIR `
    /XD node_modules .git .runtime douyin-output temp .openclaw .wjz_browser_data cookies logs vendor\social-auto-upload\cookies vendor\social-auto-upload\logs vendor\social-auto-upload\.venv `
    /XF .env .env.* .env.local *.log | Out-Null
  if ($LASTEXITCODE -ge 8) {
    throw "Failed to copy app to $targetRoot"
  }
  return (Resolve-Path $targetRoot).ProviderPath
}

$appRoot = Resolve-AppRoot
Set-Location $appRoot

Write-Step "Check Windows browser"
$browser = Find-EdgeOrChrome
if (!$browser) {
  throw "Microsoft Edge or Chrome was not found. Install Edge/Chrome, or set BROWSER_PATH."
}
Write-Host "Browser: $browser"

$runtime = Ensure-PortableNode -AppRoot $appRoot
Write-Host "Node: $($runtime.Node)"
$env:PATH = "$($runtime.NodeDir);$env:PATH"

Write-Step "Install Node dependencies"
$nodeModules = Join-Path $appRoot "node_modules"
if (Test-Path $nodeModules) {
  Remove-Item -Recurse -Force $nodeModules
}
& $runtime.Npm ci
if ($LASTEXITCODE -ne 0) {
  throw "npm ci failed"
}

$stateDir = Join-Path $env:LOCALAPPDATA "DouyinLocalPublishConsole"
$profileDir = Join-Path $stateDir "browser-profile"
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
New-Item -ItemType Directory -Force -Path $profileDir | Out-Null

$env:LOCAL_PUBLISH_CONSOLE_PORT = [string]$Port
$env:LOCAL_PUBLISH_CONSOLE_STATE_DIR = $stateDir
$env:BROWSER_PATH = $browser
$env:BROWSER_USER_DATA_DIR = $profileDir
$env:BROWSER_HEADLESS = "false"
$env:BROWSER_PROTOCOL_TIMEOUT = "1200000"
$env:LOCAL_PUBLISH_PORTABLE_NODE = "true"

Write-Step "Start local publish console"
$consoleUrl = "http://127.0.0.1:$Port"
$creatorUrl = "https://creator.douyin.com/"
Write-Host "Console API: $consoleUrl" -ForegroundColor Green
Write-Host "Opening Douyin Creator: $creatorUrl" -ForegroundColor Green
if ($OpenConsole) {
  Start-Process $consoleUrl
} else {
  Start-Process $browser $creatorUrl
}
& $runtime.Node "local-publish-console/server.js"
