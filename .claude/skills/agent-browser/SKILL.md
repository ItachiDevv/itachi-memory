---
name: agent-browser
description: "Use when the user needs to interact with websites, automate browsers, test web apps, scrape data, fill forms, take screenshots, automate Electron apps (VS Code, Slack, Discord), or perform any browser-based task. Also use for E2E testing, visual regression, and local app automation."
---

# agent-browser — Headless Browser Automation for AI Agents

A CLI tool by Vercel Labs for browser automation. NOT an MCP server — invoke via Bash.
93% less context than DOM-dumping approaches. Boots in <50ms (Rust).

## Windows Issues & Fixes (IMPORTANT)

### Hyper-V Port Conflict (CRITICAL on Windows)

On Windows, Hyper-V reserves dynamic port ranges (49152-65535) that conflict with the daemon port.
The default session "default" hashes to port 50838 which is typically blocked. **Always use `--session x`**:

```bash
# WRONG (will fail with "Daemon failed to start" / EACCES on Windows):
agent-browser open https://example.com

# CORRECT (session "x" maps to port 49272, outside Hyper-V exclusions):
agent-browser --session x open https://example.com
agent-browser --session x snapshot -i
agent-browser --session x click @e1
```

Use `netsh interface ipv4 show excludedportrange protocol=tcp` to see reserved ranges.
Pick a session name that hashes to an allowed port (a, b, x, z, abc all work).

### Other Known Windows Issues

- **Windows Defender quarantine** — The Rust binary may be flagged as malicious. Add an exclusion for the agent-browser executable path.
- **Antivirus blocking** — Win32-x64 executable sometimes flagged; not code-signed yet. Whitelist in your AV.
- **Daemon not starting after reboot** — Compiled binary may not spawn daemon subprocess. Run `agent-browser install` again.
- **NPM install failures** — Postinstall scripts may be skipped. Run `agent-browser install` manually after `npm install -g agent-browser`.
- **Socket path errors** — Older versions used Unix `.sock` files. Update to latest which uses TCP `.port` files.
- **subprocess.run hangs** — When calling from Python/scripts, use `subprocess.Popen` with explicit timeout instead.
- **`--auto-connect` timeout** — May fail with ETIMEDOUT on Windows. Use `--cdp <port>` with explicit port instead.

## Installation

```bash
npm install -g agent-browser
agent-browser install                  # Download Chromium (first time)
agent-browser install --with-deps      # Also install system deps (Linux)
```

## Core Pattern: Snapshot + Refs

```bash
# 1. Navigate
agent-browser --session x open https://example.com

# 2. Snapshot interactive elements (ALWAYS use -i for agents)
agent-browser --session x snapshot -i
# Output:
# - button "Sign In" [ref=e1]
# - textbox "Email" [ref=e2]
# - textbox "Password" [ref=e3]

# 3. Interact using refs
agent-browser --session x fill @e2 "user@test.com"
agent-browser --session x fill @e3 "password123"
agent-browser --session x click @e1

# 4. CRITICAL: Re-snapshot after any navigation/DOM change
agent-browser --session x snapshot -i
```

**Refs invalidate after navigation.** Always re-snapshot after clicks that navigate.

## Complete Commands Reference

### Core Commands
```bash
open <url>                 # Navigate to URL
click <sel>                # Click element (or @ref)
dblclick <sel>             # Double-click element
type <sel> <text>          # Type into element (appends)
fill <sel> <text>          # Clear and fill (for inputs)
press <key>                # Press key (Enter, Tab, Control+a)
keyboard type <text>       # Type text with real keystrokes (no selector)
keyboard inserttext <text> # Insert text without key events
hover <sel>                # Hover element
focus <sel>                # Focus element
check <sel>                # Check checkbox
uncheck <sel>              # Uncheck checkbox
select <sel> <val...>      # Select dropdown option
drag <src> <dst>           # Drag and drop
upload <sel> <files...>    # Upload files
download <sel> <path>      # Download file by clicking element
scroll <dir> [px]          # Scroll (up/down/left/right)
scrollintoview <sel>       # Scroll element into view
wait <sel|ms>              # Wait for element or time
screenshot [path]          # Take screenshot
pdf <path>                 # Save as PDF
snapshot                   # Accessibility tree with refs (for AI)
eval <js>                  # Run JavaScript
connect <port|url>         # Connect to browser via CDP
close                      # Close browser
```

### Navigation
```bash
agent-browser back                    # Go back
agent-browser forward                 # Go forward
agent-browser reload                  # Reload page
agent-browser close                   # Close session
```

### Snapshots (How the agent "sees" the page)
```bash
agent-browser snapshot -i             # Interactive elements only (RECOMMENDED)
agent-browser snapshot -i -c          # Compact — remove empty structural elements
agent-browser snapshot -i -d 3        # Limit tree depth
agent-browser snapshot -i -s "#main"  # Scope to CSS selector
agent-browser snapshot -i --json      # JSON output
```

Snapshot Options:
- `-i, --interactive` — Only interactive elements
- `-c, --compact` — Remove empty structural elements
- `-d, --depth <n>` — Limit tree depth
- `-s, --selector <sel>` — Scope to CSS selector
- `--json` — JSON format output

### Interactions
```bash
agent-browser click @e1               # Click element
agent-browser dblclick @e1            # Double-click
agent-browser fill @e2 "text"         # Clear + type (for inputs)
agent-browser type @e2 "text"         # Append without clearing
agent-browser keyboard type "text"    # Real keystrokes, no selector needed
agent-browser keyboard inserttext "t" # Insert without key events
agent-browser press Enter             # Press key
agent-browser press Control+a         # Key combo
agent-browser hover @e1               # Hover
agent-browser focus @e1               # Focus element
agent-browser check @e1               # Check checkbox
agent-browser uncheck @e1             # Uncheck
agent-browser select @e1 "value"      # Select dropdown
agent-browser scroll down 500         # Scroll direction + pixels
agent-browser scrollintoview @e1      # Scroll element into view
agent-browser drag @e1 @e2            # Drag and drop
agent-browser upload @e1 file.pdf     # File upload
agent-browser download @e1 ./out.pdf  # Download by clicking
```

### Get Information
```bash
agent-browser get text @e1            # Element text
agent-browser get html @e1            # Element HTML
agent-browser get value @e1           # Input value
agent-browser get attr @e1 href       # Attribute value
agent-browser get title               # Page title
agent-browser get url                 # Current URL
agent-browser get count ".item"       # Count elements matching selector
agent-browser get box @e1             # Bounding box
agent-browser get styles @e1          # Computed styles
```

### State Checks
```bash
agent-browser is visible @e1
agent-browser is enabled @e1
agent-browser is checked @e1
```

### Semantic Locators (Alternative to Refs)
```bash
agent-browser find role button click --name "Submit"
agent-browser find text "Sign In" click
agent-browser find label "Email" fill "user@test.com"
agent-browser find placeholder "Search" type "query"
agent-browser find alt "Logo" click
agent-browser find title "Close" click
agent-browser find testid "submit-btn" click
agent-browser find first ".item" click
agent-browser find last ".item" click
agent-browser find nth ".item" 3 click
```

### Waiting
```bash
agent-browser wait @e1                # Wait for element
agent-browser wait 2000               # Wait ms
agent-browser wait --text "Success"   # Wait for text
agent-browser wait --url "**/dash"    # Wait for URL pattern
agent-browser wait --load networkidle # Wait for network idle
agent-browser wait --fn "window.ready" # Wait for JS condition
```

### Mouse Control
```bash
agent-browser mouse move 100 200      # Move to coordinates
agent-browser mouse down               # Mouse button down
agent-browser mouse up                 # Mouse button up
agent-browser mouse wheel 100          # Scroll wheel
```

### Screenshots & Recording
```bash
agent-browser screenshot              # Viewport screenshot
agent-browser screenshot out.png      # Save to path
agent-browser screenshot --full       # Full page (or -f)
agent-browser screenshot --annotate   # Numbered labels + legend (for vision)
agent-browser pdf output.pdf          # Save as PDF
agent-browser record start ./demo.webm # Start video recording
agent-browser record stop             # Stop and save video
```

### Visual Diffing (Verification)
```bash
agent-browser diff snapshot                    # Compare vs last snapshot
agent-browser diff screenshot --baseline b.png # Compare screenshots
agent-browser diff url <url1> <url2>           # Compare two pages
```

### Session Management
```bash
agent-browser --session myname open <url>  # Named session
agent-browser session                      # Show current session name
agent-browser session list                 # List active sessions
agent-browser close                        # Close current session
```

### Cookies & Storage
```bash
agent-browser cookies get                  # Get all cookies
agent-browser cookies set --url https://example.com --domain example.com
agent-browser cookies clear                # Clear all cookies
agent-browser storage local                # View localStorage
agent-browser storage session              # View sessionStorage
```

### Authentication Vault (LLM never sees passwords)
```bash
echo "pass" | agent-browser auth save github \
  --url https://github.com/login \
  --username user --password-stdin
agent-browser auth login github            # Perform login
agent-browser auth list                    # List saved profiles
agent-browser auth show github             # Show profile metadata
agent-browser auth delete github           # Delete profile
```

### Network Control
```bash
agent-browser network route <url> --abort      # Block requests
agent-browser network route <url> --body '{}'  # Mock response
agent-browser network unroute [url]            # Remove route
agent-browser network requests --filter api    # View requests
agent-browser network requests --clear         # Clear logged requests
```

### Tabs
```bash
agent-browser tab                     # List tabs
agent-browser tab new https://url     # Open new tab
agent-browser tab 2                   # Switch to tab 2
agent-browser tab close               # Close current tab
```

### Browser Config
```bash
agent-browser set viewport 1920 1080
agent-browser set device "iPhone 14"
agent-browser set geo 37.7749 -122.4194  # Geolocation
agent-browser set offline on
agent-browser set headers '{"Authorization":"Bearer token"}'
agent-browser set credentials user pass
agent-browser set media dark              # Color scheme
agent-browser set media reduced-motion    # Reduced motion
```

### JavaScript Evaluation
```bash
agent-browser eval "document.title"
agent-browser eval "document.querySelectorAll('.item').length"
```

### Debug & Profiling
```bash
agent-browser trace start              # Start Playwright trace
agent-browser trace stop [path]        # Stop and save trace
agent-browser profiler start           # Start Chrome DevTools profile
agent-browser profiler stop [path]     # Stop and save profile
agent-browser console                  # View console logs
agent-browser console --clear          # Clear console logs
agent-browser errors                   # View page errors
agent-browser errors --clear           # Clear page errors
agent-browser highlight @e1            # Highlight element visually
```

### Confirmation (Action Policy)
```bash
agent-browser confirm <id>             # Approve a pending action
agent-browser deny <id>                # Deny a pending action
```

## Electron App Automation

Connect to any Electron app (VS Code, Slack, Discord, Figma, etc.) via CDP:

### Launch with CDP Port
```bash
# macOS
open -a "Slack" --args --remote-debugging-port=9222
open -a "Code" --args --remote-debugging-port=9224

# Windows
"C:\Users\...\slack.exe" --remote-debugging-port=9222

# Linux
/usr/bin/slack --remote-debugging-port=9222 &
code --remote-debugging-port=9224 &
```

### Connect and Automate
```bash
agent-browser connect 9222            # Connect to CDP port
agent-browser --cdp 9222 snapshot -i  # Or per-command
agent-browser --auto-connect snapshot -i # Auto-discover

# Then use standard commands:
agent-browser snapshot -i
agent-browser click @e5
agent-browser fill @e8 "hello"
agent-browser press Enter
```

### Multi-App with Named Sessions
```bash
agent-browser --session slack --cdp 9222 snapshot -i
agent-browser --session vscode --cdp 9224 snapshot -i
```

**Important:** `--remote-debugging-port` must be set at launch. Quit and relaunch if already running.

## Global Options

```bash
--session <name>           # Isolated session (or AGENT_BROWSER_SESSION env)
--profile <path>           # Persistent browser profile
--state <path>             # Load storage state from JSON file
--headers <json>           # HTTP headers scoped to URL's origin
--executable-path <path>   # Custom browser executable
--extension <path>         # Load browser extensions (repeatable)
--args <args>              # Browser launch args, comma-separated
--user-agent <ua>          # Custom User-Agent
--proxy <server>           # Proxy server URL (e.g., http://user:pass@127.0.0.1:7890)
--proxy-bypass <hosts>     # Bypass proxy for these hosts
--ignore-https-errors      # Ignore HTTPS certificate errors
--allow-file-access        # Allow file:// URLs (Chromium only)
--headed                   # Show browser window (not headless)
--cdp <port>               # Connect via Chrome DevTools Protocol
--auto-connect             # Auto-discover running Chrome
--color-scheme <scheme>    # dark, light, no-preference
--download-path <path>     # Default download directory
--session-name <name>      # Auto-save/restore session state
--content-boundaries       # Wrap output in boundary markers
--max-output <chars>       # Truncate output to N chars
--allowed-domains <list>   # Restrict navigation domains
--action-policy <path>     # Action policy JSON file
--confirm-actions <list>   # Categories requiring confirmation
--json                     # JSON output
--full, -f                 # Full page screenshot
--annotate                 # Annotated screenshot with labels
--native                   # [Experimental] Use native Rust daemon
--config <path>            # Custom config file path
--debug                    # Debug output
--version, -V              # Show version
```

## Environment Variables

```bash
AGENT_BROWSER_SESSION=x                    # Session name (ALWAYS set on Windows)
AGENT_BROWSER_HEADED=1                     # Show browser window
AGENT_BROWSER_COLOR_SCHEME=dark            # Color scheme
AGENT_BROWSER_ALLOWED_DOMAINS="*.com"      # Domain allowlist
AGENT_BROWSER_MAX_OUTPUT=50000             # Max output chars
AGENT_BROWSER_DEFAULT_TIMEOUT=25000        # Playwright timeout (ms)
AGENT_BROWSER_EXECUTABLE_PATH=/path        # Custom browser binary
AGENT_BROWSER_EXTENSIONS=ext1,ext2         # Browser extension paths
AGENT_BROWSER_PROXY=http://localhost:8080  # Proxy server
AGENT_BROWSER_PROXY_BYPASS=localhost       # Proxy bypass hosts
AGENT_BROWSER_DOWNLOAD_PATH=./downloads    # Download directory
AGENT_BROWSER_IGNORE_HTTPS_ERRORS=1        # Ignore cert errors
AGENT_BROWSER_CONTENT_BOUNDARIES=1         # Boundary markers
AGENT_BROWSER_STREAM_PORT=9223             # WebSocket streaming port
AGENT_BROWSER_ENCRYPTION_KEY=<64-hex>      # AES-256-GCM for state encryption
AGENT_BROWSER_STATE_EXPIRE_DAYS=30         # Auto-delete old states
AGENT_BROWSER_NATIVE=1                     # Use Rust daemon (experimental)
AGENT_BROWSER_AUTO_CONNECT=1               # Auto-discover Chrome
AGENT_BROWSER_ALLOW_FILE_ACCESS=1          # Allow file:// URLs
AGENT_BROWSER_JSON=1                       # JSON output
AGENT_BROWSER_FULL=1                       # Full page screenshots
AGENT_BROWSER_ANNOTATE=1                   # Annotated screenshots
AGENT_BROWSER_DEBUG=1                      # Debug output
```

## Configuration File

`agent-browser.json` is loaded from (lowest to highest priority):
1. `~/.agent-browser/config.json` — User-level defaults
2. `./agent-browser.json` — Project-level overrides
3. Environment variables — Override config
4. CLI flags — Override everything

Example:
```json
{"headed": true, "proxy": "http://localhost:8080", "profile": "./browser-data"}
```

## Cloud Providers

```bash
agent-browser -p browserbase open <url>   # Browserbase
agent-browser -p kernel open <url>        # Kernel
agent-browser -p browseruse open <url>    # Browser Use
agent-browser -p ios open <url>           # iOS Simulator
agent-browser -p ios --device "iPhone 15 Pro" open <url>
```

## Common Workflows

### Scrape Data
```bash
agent-browser --session x open https://news.ycombinator.com
agent-browser --session x snapshot -i
# Read the snapshot, identify story refs
agent-browser --session x get text @e1
agent-browser --session x get attr @e1 href
```

### Fill and Submit Form
```bash
agent-browser --session x open https://example.com/login
agent-browser --session x snapshot -i
agent-browser --session x fill @e2 "username"
agent-browser --session x fill @e3 "password"
agent-browser --session x click @e1  # submit button
agent-browser --session x wait --url "**/dashboard"
agent-browser --session x snapshot -i
```

### Visual Regression Test
```bash
agent-browser --session x open https://myapp.com
agent-browser --session x screenshot baseline.png
# ... make changes ...
agent-browser --session x diff screenshot --baseline baseline.png
```

### E2E Test Flow
```bash
agent-browser --session x open https://myapp.com
agent-browser --session x snapshot -i
agent-browser --session x click @e1      # Navigate
agent-browser --session x wait --load networkidle
agent-browser --session x snapshot -i    # Re-snapshot after nav
agent-browser --session x screenshot     # Capture proof
```

### Save and Restore Auth State
```bash
# Save after login
agent-browser --session x cookies get > cookies.json
# Restore in new session
agent-browser --session x --state cookies.json open https://app.com
```

## Gotchas

1. **Always re-snapshot after navigation** — refs are invalidated
2. **Use `fill` for inputs** (clears first), `type` to append
3. **Chain commands with `&&`** — daemon persists browser between calls
4. **Use `-i` flag on snapshots** — full DOM is too verbose for agents
5. **If element missing, check frames:** `agent-browser frame "#iframe"` then re-snapshot
6. **For Electron apps,** some inputs need `keyboard type "text"` instead of `fill`
7. **On Windows, ALWAYS use `--session x`** to avoid Hyper-V port conflicts
8. **Windows Defender may quarantine** the binary — add exclusion for the executable
9. **`--auto-connect` unreliable on Windows** — use `--cdp <port>` explicitly instead
