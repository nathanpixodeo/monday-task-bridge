# Monday Task Bridge installer for Windows (PowerShell 5.1 or 7).
#
#   irm https://raw.githubusercontent.com/nathanpixodeo/monday-task-bridge/main/scripts/install.ps1 | iex
#
# Downloads (or updates) the bridge, builds it, registers the MCP server with every agent CLI it finds
# (Claude Code, Codex, agy), starts the bridge, then walks through loading the Chrome extension and pairing.
# Run it again to update. Optional environment variables:
#   MONDAY_BRIDGE_HOME     install folder (default: %LOCALAPPDATA%\Programs\monday-task-bridge)
#   MONDAY_BRIDGE_CLIENTS  agent CLIs to register, comma-separated (default: claude,codex,agy; "none" registers none)
#   MONDAY_BRIDGE_APPROVAL auto (default: agents read monday without asking each time) or manual (they ask)

& {
  $ErrorActionPreference = 'Stop'
  $Repo = 'https://github.com/nathanpixodeo/monday-task-bridge.git'
  $Name = 'monday-task-bridge'
  $Health = 'http://127.0.0.1:3457/health'

  function Write-Step([string]$Text) {
    Write-Host ''
    Write-Host "==> $Text" -ForegroundColor Cyan
  }

  # The .exe or .cmd behind a command: npm's and Codex's .ps1 shims are blocked by the default execution policy.
  function Find-App([string]$CommandName) {
    foreach ($candidate in @("$CommandName.exe", "$CommandName.cmd", "$CommandName.bat")) {
      $found = Get-Command $candidate -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($found) { return $found.Source }
    }
    return $null
  }

  function Invoke-Checked([string]$Exe, [string[]]$Arguments) {
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) {
      throw "'$(Split-Path $Exe -Leaf) $($Arguments -join ' ')' failed with exit code $LASTEXITCODE."
    }
  }

  # For a command that may fail harmlessly, such as removing a server that is not registered.
  function Invoke-Quiet([string]$Exe, [string[]]$Arguments) {
    $ErrorActionPreference = 'Continue'
    & $Exe @Arguments 2>&1 | Out-Null
  }

  try {
    Write-Step 'Checking requirements'
    $git = Find-App 'git'
    if (-not $git) { throw 'Git is required: https://git-scm.com/download/win' }
    $node = Find-App 'node'
    if (-not $node) { throw 'Node.js 22.12 or newer is required: https://nodejs.org' }
    $nodeVersion = [version](& $node -p 'process.versions.node')
    if ($nodeVersion -lt [version]'22.12.0') {
      throw "Node.js 22.12 or newer is required (found $nodeVersion): https://nodejs.org"
    }
    $npm = Find-App 'npm'
    if (-not $npm) { throw 'npm was not found next to Node.js. Reinstall Node.js from https://nodejs.org' }
    Write-Host "  Node.js $nodeVersion, $(& $git --version)"

    # Run from a checkout (.\scripts\install.ps1), the installer uses that checkout as it is.
    $dir = $env:MONDAY_BRIDGE_HOME
    $useCheckout = $false
    if (-not $dir -and $PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot '..\bridge\mcp.ts'))) {
      $dir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
      $useCheckout = $true
    }
    if (-not $dir) { $dir = Join-Path $env:LOCALAPPDATA 'Programs\monday-task-bridge' }

    if ($useCheckout) {
      Write-Step "Using this checkout: $dir"
    } elseif (Test-Path (Join-Path $dir '.git')) {
      Write-Step "Updating $dir"
      Invoke-Checked $git @('-C', $dir, 'pull', '--ff-only')
    } elseif ((Test-Path $dir) -and (Get-ChildItem $dir -Force | Select-Object -First 1)) {
      throw "$dir is not empty and is not a git checkout. Remove it, or set MONDAY_BRIDGE_HOME to another folder."
    } else {
      Write-Step "Downloading into $dir"
      Invoke-Checked $git @('clone', '--depth', '1', $Repo, $dir)
    }

    Write-Step 'Installing dependencies and building'
    Push-Location $dir
    try {
      Invoke-Checked $npm @('ci', '--no-audit', '--no-fund')
      Invoke-Checked $npm @('run', 'build')
    } finally {
      Pop-Location
    }

    $mcp = Join-Path $dir 'dist\bridge\mcp.js'
    $clients = 'claude,codex,agy'
    if ($env:MONDAY_BRIDGE_CLIENTS) { $clients = $env:MONDAY_BRIDGE_CLIENTS }
    $wanted = @($clients.Split(',') | ForEach-Object { $_.Trim().ToLower() })

    Write-Step 'Registering the MCP server'
    foreach ($client in @('claude', 'codex', 'agy')) {
      if ($wanted -notcontains $client) { continue }
      $exe = Find-App $client
      if (-not $exe) {
        Write-Host "  ${client}: not installed, skipped"
        continue
      }
      switch ($client) {
        'claude' {
          Invoke-Quiet $exe @('mcp', 'remove', '-s', 'user', $Name)
          Invoke-Checked $exe @('mcp', 'add', '-s', 'user', $Name, '--', 'node', $mcp)
        }
        'codex' {
          Invoke-Quiet $exe @('mcp', 'remove', $Name)
          Invoke-Checked $exe @('mcp', 'add', $Name, '--', 'node', $mcp)
        }
        'agy' {
          Invoke-Checked $exe @('mcp', 'add', $Name, 'node', $mcp)
        }
      }
      Write-Host "  ${client}: registered" -ForegroundColor Green
    }

    $approval = 'auto'
    if ($env:MONDAY_BRIDGE_APPROVAL) { $approval = $env:MONDAY_BRIDGE_APPROVAL }
    Write-Step "Approval mode: $approval"
    & $node (Join-Path $dir 'dist\bridge\approval-cli.js') $approval
    if ($LASTEXITCODE -ne 0) {
      Write-Host '  The approval mode was not applied everywhere (see above). The agents will ask before each read.' -ForegroundColor Yellow
    }

    Write-Step 'Starting the bridge'
    # Started apart from this window: on Windows the bridge would otherwise inherit this script's output handles,
    # and a caller that reads that output (an agent, CI) would wait for the bridge to exit.
    $starter = Start-Process -FilePath $node -ArgumentList "`"$(Join-Path $dir 'dist\bridge\start-cli.js')`"" -WindowStyle Hidden -PassThru
    $null = $starter.Handle
    $starter.WaitForExit()
    if ($starter.ExitCode -ne 0) {
      throw 'The bridge did not start. Its log is bridge.log in %LOCALAPPDATA%\monday-task-bridge.'
    }
    $status = Invoke-RestMethod $Health -TimeoutSec 5
    Write-Host '  Bridge running on 127.0.0.1:3457'
    $pairCli = Join-Path $dir 'dist\bridge\pair-cli.js'
    $extension = Join-Path $dir 'dist\extension'

    Write-Step 'Chrome extension'
    if ($status.paired -and $status.extensionConnected) {
      Write-Host '  Already paired and connected.'
      Write-Host '  After an update, click Reload on the Monday Task Bridge card in chrome://extensions.'
    } else {
      try { Set-Clipboard -Value $extension } catch { }
      try { Start-Process 'chrome' 'chrome://extensions' } catch { }
      Write-Host '  In the Chrome profile that is signed in to monday.com:'
      Write-Host '  1. Open chrome://extensions and turn on Developer mode.'
      Write-Host '  2. Click Load unpacked and choose this folder (copied to the clipboard):'
      Write-Host "       $extension" -ForegroundColor Yellow
      Write-Host '     Already loaded? Click Reload on its card instead.'
      Write-Host '  3. Open the extension popup and tap the power button. It shows a 6-digit code.'
      while ($true) {
        $code = (Read-Host '  Enter the code here (or press Enter to pair later)').Trim()
        if (-not $code) {
          Write-Host '  To pair later, run:'
          Write-Host "    node `"$pairCli`" <code>" -ForegroundColor Yellow
          break
        }
        if ($code -notmatch '^\d{6}$') {
          Write-Host '  The code has 6 digits.' -ForegroundColor Red
          continue
        }
        & $node $pairCli $code
        if ($LASTEXITCODE -eq 0) { break }
        Write-Host '  Pairing failed. Tap the power button again for a new code.' -ForegroundColor Red
      }
    }

    Write-Step 'Done'
    Write-Host "  Installed in $dir"
    Write-Host '  Restart open Claude Code, Codex, or agy sessions to load the monday tools.'
    Write-Host '  To update, run the install command again, then click Reload on the extension card.'
  } catch {
    Write-Host ''
    Write-Host "Install failed: $($_.Exception.Message)" -ForegroundColor Red
  }
}
