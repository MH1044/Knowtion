---
name: run-knowtion
description: Build, launch, and verify the Knowtion Electron desktop app on Windows — including killing stale electron.exe processes, screenshotting the app window without stealing focus, and reading renderer console errors over the Chrome DevTools Protocol. Use whenever asked to run, start, launch, or verify the Knowtion app, or to confirm a UI change actually took effect.
---

# Running and verifying Knowtion

Knowtion is an Electron app (`apps/desktop`). Building and eyeballing it by hand is
fiddly enough that it's worth following this exactly, in order.

## 1. Kill stale processes first

Knowtion's `userData` path is derived from the app name (`Knowtion`, set via
`app.setName('Knowtion')`), and that data persists across restarts. If an old
`electron.exe` from a previous run is still alive, launching a new one on top of it can
leave you looking at the stale instance — so it looks like your change did nothing, or
worse, mixes old and new state. Always kill stale instances first:

```powershell
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force
```

## 2. Build and launch

From the repo root:

```powershell
npm start
```

This builds every workspace (tsc/vite) and then launches Electron. It blocks the
terminal (Electron stays attached to the shell) — either run it with a tool that
supports background execution, or open a separate terminal for it, so you can continue
issuing commands (like the verification steps below) while it's running.

If you need the remote debugging port for step 4, don't use the plain `npm start`
alias — build first, then launch Electron directly with the extra flag:

```powershell
npm run build
npm run start -w @knowtion/desktop -- --remote-debugging-port=9222
```

(`--` forwards the flag through to `electron .`; Electron/Chromium recognize
`--remote-debugging-port` automatically.)

## 3. Verify visually without stealing window focus

The developer or another agent may have a full-screen application in the foreground.
**Never** use `SetForegroundWindow`, `Activate()`, or click into the window to
screenshot it — that steals focus and can disrupt whatever they're doing. Instead, find
the window by its exact title (`Knowtion`) via `EnumWindows`/`GetWindowText`, then
capture its pixels directly with the Win32 `PrintWindow` API using flag `2`
(`PW_RENDERFULLCONTENT`), which works even when the window is occluded or unfocused.

```powershell
Add-Type -Namespace Win32 -Name Capture -MemberDefinition @"
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
[DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
[DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
"@

$target = [IntPtr]::Zero
$callback = {
    param($hWnd, $lParam)
    $sb = New-Object System.Text.StringBuilder 256
    [Win32.Capture]::GetWindowText($hWnd, $sb, 256) | Out-Null
    if ($sb.ToString() -eq 'Knowtion') { $script:target = $hWnd; return $false }
    return $true
}
[Win32.Capture]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null

if ($target -eq [IntPtr]::Zero) { throw 'Knowtion window not found' }

$rect = New-Object Win32.Capture+RECT
[Win32.Capture]::GetWindowRect($target, [ref]$rect) | Out-Null
$w = $rect.Right - $rect.Left
$h = $rect.Bottom - $rect.Top

$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
[Win32.Capture]::PrintWindow($target, $hdc, 2) | Out-Null   # 2 = PW_RENDERFULLCONTENT
$g.ReleaseHdc($hdc)
$g.Dispose()

$outPath = "$env:TEMP\knowtion-screenshot.png"
$bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output $outPath
```

Then read the PNG at `$outPath` (e.g. with the Read tool) to inspect the app visually.

## 4. Verify renderer console errors without opening DevTools by hand

A silent failure in the renderer (blank window, no visible error) can be a
Content-Security-Policy misconfiguration, a blocked WebAssembly module, or similar —
things that won't show up in a screenshot and won't fail typecheck/lint/tests. Launch
Electron with `--remote-debugging-port=<port>` (step 2), then connect over the Chrome
DevTools Protocol to watch `Runtime.consoleAPICalled` and `Runtime.exceptionThrown`.

Save this as `check-console.mjs` and run with `node check-console.mjs`. It requires
Node's built-in global `WebSocket` (no dependency needed) and assumes Electron was
launched with `--remote-debugging-port=9222`:

```javascript
// check-console.mjs
// Usage: node check-console.mjs [port] [durationMs]
const port = process.argv[2] ?? 9222;
const durationMs = Number(process.argv[3] ?? 5000);

const res = await fetch(`http://localhost:${port}/json`);
const targets = await res.json();
const page = targets.find((t) => t.type === 'page');
if (!page) {
  console.error('No page target found — is Electron running with --remote-debugging-port?');
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', reject);
});

ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }));

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);

  if (msg.method === 'Runtime.consoleAPICalled') {
    const args = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
    console.log(`[console.${msg.params.type}] ${args}`);
  }

  if (msg.method === 'Runtime.exceptionThrown') {
    const detail = msg.params.exceptionDetails;
    console.error(`[exception] ${detail.text}: ${detail.exception?.description ?? ''}`);
  }
});

setTimeout(() => {
  ws.close();
  process.exit(0);
}, durationMs);
```

Run it right after launching, while the app is starting up, so you catch startup-time
errors (like a CSP blocking a WASM fetch) rather than only steady-state ones.

## 5. Closing checklist

Before treating any change as verified, **all** of the following must pass — the
console-error check (step 4) and the visual screenshot check (step 3) are _in addition_
to these, not a substitute for them, since none of typecheck/lint/tests would catch a
blank renderer window:

- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm test`
- [ ] Screenshot of the `Knowtion` window looks correct (step 3)
- [ ] No unexpected entries in `Runtime.consoleAPICalled` / `Runtime.exceptionThrown`
      during startup and while exercising the change (step 4)
