# Desktop Automation MCP Options for Claude Code (Windows)

Researched 2026-02-18. For controlling native Windows apps (not just browsers) from Claude Code / spawned tasks.

## Key Caveat

All of these need **access to the desktop session** — they can't work headless over SSH. Options for spawned tasks:
- Run tasks locally (not via SSH) when they need desktop access
- Use a persistent MCP server in the desktop session, connect via HTTP/SSE
- Use Windows Task Scheduler / PsExec to run in the interactive session

---

## Recommended: mcp-pyautogui (hathibelagal-dev) — Least Security Risk

- **GitHub**: https://github.com/hathibelagal-dev/mcp-pyautogui
- **Library**: PyAutoGUI (pure Python, no native compilation)
- **Transport**: stdio only — no network ports
- **Tools**: 14 — click, right_click, double_click, move_to, drag_to, type_text, press_key, hotkey, scroll, take_screenshot, get_mouse_position, get_screen_size, pixel_color, get_os
- **No shell execution, no file access** — smallest blast radius
- **No telemetry**
- **Install**: `pip install mcp-pyautogui`
- **Requires**: Python 3.11+

```json
"mcp-pyautogui": {
  "command": "mcp-pyautogui",
  "args": [""]
}
```

---

## Alternative: mcp-pyautogui-server (hetaoBackend) — Similar, Slightly More Features

- **GitHub**: https://github.com/hetaoBackend/mcp-pyautogui-server
- **Library**: PyAutoGUI
- **Extras**: image-on-screen location, pixel detection
- **Install**: `pip install mcp-pyautogui-server` or `uvx mcp-pyautogui-server`
- **Requires**: Python 3.12+

```json
"mcp-pyautogui-server": {
  "command": "uvx",
  "args": ["mcp-pyautogui-server"]
}
```

---

## Feature-Rich: Windows-MCP (CursorTouch) — Most Capable but More Risk

- **GitHub**: https://github.com/CursorTouch/Windows-MCP
- **Library**: UIAutomation + PyAutoGUI
- **Tools**: 15+ — click, type, scroll, app launch, shell exec, screenshots, accessibility tree reading
- **Reads UI without vision model** — uses native Windows UI Automation
- **Install**: `uvx windows-mcp`
- **Requires**: Python 3.13+, `uv`

```json
"windows-mcp": {
  "command": "uvx",
  "args": ["windows-mcp"],
  "env": { "ANONYMIZED_TELEMETRY": "false" }
}
```

**Concerns:**
- Telemetry enabled by default
- Has shell execution built in (wider attack surface)
- Needs English as default Windows language

---

## Node.js Option: CoDriver MCP — Most Mature, Multi-Monitor

- **GitHub**: https://github.com/ViktorTrn/codriver-mcp
- **Library**: robotjs + PowerShell UI Automation
- **Tools**: 12 — screenshots, mouse/keyboard, window management, accessibility tree, OCR, multi-monitor, drag-and-drop
- **107 unit tests**
- **Install**: git clone + `npm install && npm run build`
- **Requires**: Node 20+, VS Build Tools

```json
"codriver": {
  "command": "node",
  "args": ["C:/path/to/codriver-mcp/dist/index.js"]
}
```

**Concerns:**
- Native compilation (robotjs) — trusting compiled C++
- Supports remote HTTP mode on port 3100 — network exposure risk if misconfigured

---

## Others (Less Recommended)

| Name | Risk Level | Notes |
|------|-----------|-------|
| MCPControl | HIGH | SSE on localhost:3232, any local process can connect |
| pywinauto-mcp | MEDIUM | Most features (OCR, face recognition), complex setup |
| total-pc-control | MEDIUM | nut.js, needs cmake-js + native build |
| mcp-desktop-automation | LOW-MED | Deprecated RobotJS, 1MB screenshot limit |
| mcp-windows-desktop-automation | UNKNOWN | AutoIt, only 4 commits, very new |

---

## Security Notes

- **Prompt injection is the main risk** — untrusted content could manipulate the AI into clicking/typing anything
- Only enable desktop automation MCP when needed
- Don't run it on tasks that process untrusted input
- Audit source code before installing (`pip download` + inspect)
- Prefer stdio transport over HTTP/SSE
- Prefer tools without shell execution capability
