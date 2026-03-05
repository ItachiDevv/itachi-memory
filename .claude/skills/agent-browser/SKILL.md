---
name: agent-browser
description: "Use when the user needs to interact with websites, automate browsers, test web apps, scrape data, fill forms, take screenshots, automate Electron apps (VS Code, Slack, Discord), or perform any browser-based task. Also use for E2E testing, visual regression, and local app automation."
---

# agent-browser — Headless Browser Automation for AI Agents

A CLI tool by Vercel Labs for browser automation. NOT an MCP server — invoke via Bash.
93% less context than DOM-dumping approaches. Boots in <50ms (Rust).

## Core Pattern: Snapshot + Refs

```bash
# 1. Navigate
agent-browser open https://example.com

# 2. Snapshot interactive elements (ALWAYS use -i for agents)
agent-browser snapshot -i
# Output:
# - button "Sign In" [ref=e1]
# - textbox "Email" [ref=e2]
# - textbox "Password" [ref=e3]

# 3. Interact using refs
agent-browser fill @e2 "user@test.com"
agent-browser fill @e3 "password123"
agent-browser click @e1

# 4. CRITICAL: Re-snapshot after any navigation/DOM change
agent-browser snapshot -i
```

**Refs invalidate after navigation.** Always re-snapshot after clicks that navigate.

## Installation

```bash
npm install -g agent-browser
agent-browser install    # Downloads Chromium
```

## Commands Reference

### Navigation
```bash
agent-browser open <url>              # Navigate to URL
agent-browser back                    # Browser back
agent-browser forward                 # Browser forward
agent-browser reload                  # Reload page
agent-browser close                   # Close session
```

### Snapshots (How the agent "sees" the page)
```bash
agent-browser snapshot -i             # Interactive elements only (RECOMMENDED)
agent-browser snapshot -i -c          # Compact output
agent-browser snapshot -i -d 3        # Limit depth
agent-browser snapshot -i -s "#main"  # Scope to selector
agent-browser snapshot -i --json      # JSON output
agent-browser snapshot -i -C          # Include cursor-interactive divs
```

### Interactions
```bash
agent-browser click @e1               # Click element
agent-browser click @e1 --new-tab     # Click, open in new tab
agent-browser dblclick @e1            # Double-click
agent-browser fill @e2 "text"         # Clear + type (for inputs)
agent-browser type @e2 "text"         # Append without clearing
agent-browser press Enter             # Press key
agent-browser press Control+a         # Key combo
agent-browser hover @e1               # Hover
agent-browser check @e1               # Check checkbox
agent-browser uncheck @e1             # Uncheck
agent-browser select @e1 "value"      # Select dropdown
agent-browser scroll down 500         # Scroll
agent-browser scrollintoview @e1      # Scroll element into view
agent-browser drag @e1 @e2            # Drag and drop
agent-browser upload @e1 file.pdf     # File upload
```

### Get Information
```bash
agent-browser get text @e1            # Element text
agent-browser get html @e1            # Element HTML
agent-browser get value @e1           # Input value
agent-browser get attr @e1 href       # Attribute value
agent-browser get title               # Page title
agent-browser get url                 # Current URL
agent-browser get count ".item"       # Count elements
agent-browser get box @e1             # Bounding box
```

### State Checks
```bash
agent-browser is visible @e1
agent-browser is enabled @e1
agent-browser is checked @e1
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

### Screenshots & Recording
```bash
agent-browser screenshot              # Viewport screenshot
agent-browser screenshot out.png      # Save to path
agent-browser screenshot --full       # Full page
agent-browser screenshot --annotate   # Numbered labels (vision)
agent-browser pdf output.pdf          # Save as PDF
agent-browser record start ./demo.webm # Start recording
agent-browser record stop             # Stop recording
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
agent-browser session list                 # List sessions
agent-browser state save auth.json         # Save cookies/storage
agent-browser state load auth.json         # Restore state
```

### Authentication Vault (LLM never sees passwords)
```bash
echo "pass" | agent-browser auth save github \
  --url https://github.com/login \
  --username user --password-stdin
agent-browser auth login github            # Perform login
agent-browser auth list                    # List saved
```

### Network Control
```bash
agent-browser network route <url> --abort      # Block requests
agent-browser network route <url> --body '{}'  # Mock response
agent-browser network requests --filter api    # View requests
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
agent-browser set media dark
agent-browser set offline on
```

### JavaScript Evaluation
```bash
agent-browser eval "document.title"
agent-browser eval "document.querySelectorAll('.item').length"
```

### Semantic Locators (Alternative to Refs)
```bash
agent-browser find role button click --name "Submit"
agent-browser find text "Sign In" click
agent-browser find label "Email" fill "user@test.com"
agent-browser find placeholder "Search" type "query"
agent-browser find testid "submit-btn" click
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

## Environment Variables

```bash
AGENT_BROWSER_HEADED=1                # Show browser window
AGENT_BROWSER_COLOR_SCHEME=dark       # Dark mode
AGENT_BROWSER_ALLOWED_DOMAINS="*.com" # Domain allowlist
AGENT_BROWSER_MAX_OUTPUT=50000        # Max output tokens
AGENT_BROWSER_DEFAULT_TIMEOUT=25000   # Playwright timeout
```

## Common Workflows

### Scrape Data
```bash
agent-browser open https://news.ycombinator.com
agent-browser snapshot -i
# Read the snapshot, identify story refs
agent-browser get text @e1
agent-browser get attr @e1 href
```

### Fill and Submit Form
```bash
agent-browser open https://example.com/login
agent-browser snapshot -i
agent-browser fill @e2 "username"
agent-browser fill @e3 "password"
agent-browser click @e1  # submit button
agent-browser wait --url "**/dashboard"
agent-browser snapshot -i
```

### Visual Regression Test
```bash
agent-browser open https://myapp.com
agent-browser screenshot baseline.png
# ... make changes ...
agent-browser diff screenshot --baseline baseline.png
```

### E2E Test Flow
```bash
agent-browser open https://myapp.com
agent-browser snapshot -i
agent-browser click @e1      # Navigate
agent-browser wait --load networkidle
agent-browser snapshot -i    # Re-snapshot after nav
agent-browser screenshot     # Capture proof
```

## Gotchas

1. **Always re-snapshot after navigation** — refs are invalidated
2. **Use `fill` for inputs** (clears first), `type` to append
3. **Chain commands with `&&`** — daemon persists browser between calls
4. **Use `-i` flag on snapshots** — full DOM is too verbose for agents
5. **If element missing, check frames:** `agent-browser frame "#iframe"` then re-snapshot
6. **For Electron apps,** some inputs need `keyboard type "text"` instead of `fill`
