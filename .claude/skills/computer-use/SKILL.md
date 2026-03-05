---
name: computer-use
description: "Use when the user needs to control native desktop applications, automate non-browser apps (Telegram Desktop, Finder, File Explorer, system settings), take desktop screenshots, or perform any task requiring mouse/keyboard control of the OS desktop. NOT for web browsers (use agent-browser instead)."
---

# computer-use — Local Desktop Automation via Claude's Computer Use Tool

Control any native desktop application through Claude's computer_use API. Takes screenshots, clicks, types, scrolls — works with ANY app visible on screen.

**When to use this vs agent-browser:**
- **agent-browser** — websites and Electron apps (faster, cheaper, accessibility tree)
- **computer-use** — native desktop apps like Telegram Desktop, Finder, System Settings, etc.

## Architecture

Two components needed:
1. **Local input layer** — takes screenshots, executes mouse/keyboard actions on the OS
2. **Claude API** — receives screenshots, decides what actions to take (computer_use tool)

### Community Implementation: ashbuilds/computer-use

A Node.js/TypeScript port using `robotjs` + `screenshot-desktop`:

```bash
git clone https://github.com/ashbuilds/computer-use.git
cd computer-use
pnpm install
pnpm run build
```

**Windows prerequisites:**
```bash
npm install --global windows-build-tools
```

**macOS prerequisites:**
```bash
brew install opencv@4 cairo pango
```

**Linux prerequisites:**
```bash
sudo apt-get install -y libxtst-dev libpng-dev libxss-dev xvfb
```

### Core Dependencies
- `robotjs` — mouse and keyboard control (native addon)
- `screenshot-desktop` — screen capture
- `sharp` — image compression
- `@anthropic-ai/sdk` — Claude API client

## Claude API Setup

### Beta Header Required

Computer use requires a beta header:

```typescript
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

const response = await client.beta.messages.create({
  model: "claude-sonnet-4-6",  // or claude-opus-4-6
  max_tokens: 1024,
  tools: [
    {
      type: "computer_20251124",
      name: "computer",
      display_width_px: 1920,
      display_height_px: 1080,
      display_number: 1
    },
    {
      type: "bash_20250124",
      name: "bash"
    }
  ],
  messages: [{ role: "user", content: "Open Telegram Desktop and send a message" }],
  betas: ["computer-use-2025-11-24"]
});
```

### Tool Versions

| Model | Tool Version | Beta Flag |
|-------|-------------|-----------|
| Claude Opus 4.6, Sonnet 4.6, Opus 4.5 | `computer_20251124` | `computer-use-2025-11-24` |
| Sonnet 4.5, Haiku 4.5, older | `computer_20250124` | `computer-use-2025-01-24` |

## Available Actions

### Mouse Operations
```typescript
// Move cursor
await tool.execute({ action: 'mouse_move', coordinate: [100, 200] });

// Click
await tool.execute({ action: 'left_click', coordinate: [100, 200] });
await tool.execute({ action: 'right_click', coordinate: [100, 200] });
await tool.execute({ action: 'middle_click', coordinate: [100, 200] });
await tool.execute({ action: 'double_click', coordinate: [100, 200] });
await tool.execute({ action: 'triple_click', coordinate: [100, 200] });

// Drag
await tool.execute({ action: 'left_click_drag', start_coordinate: [100, 200], coordinate: [300, 400] });

// Scroll
await tool.execute({ action: 'scroll', coordinate: [500, 500], delta_x: 0, delta_y: -3 });
```

### Keyboard Operations
```typescript
// Type text
await tool.execute({ action: 'type', text: 'Hello, World!' });

// Key press (single key or combo)
await tool.execute({ action: 'key', text: 'Return' });
await tool.execute({ action: 'key', text: 'ctrl+c' });
await tool.execute({ action: 'key', text: 'alt+tab' });
await tool.execute({ action: 'key', text: 'super' });  // Windows key
```

### Screen Operations
```typescript
// Screenshot (returns base64 image)
await tool.execute({ action: 'screenshot' });

// Zoom into region for detailed inspection (computer_20251124 only)
await tool.execute({ action: 'zoom', start_coordinate: [100, 100], coordinate: [300, 300] });

// Get cursor position
await tool.execute({ action: 'cursor_position' });
```

### Window Operations (ashbuilds/computer-use extension)
```typescript
// Focus window by title
await tool.execute({ action: 'focus_window', windowTitle: 'Telegram' });

// Move/resize window
await tool.execute({ action: 'move_window', windowTitle: 'Telegram', coordinate: [0, 0] });
await tool.execute({ action: 'resize_window', windowTitle: 'Telegram', size: [800, 600] });

// Minimize/maximize
await tool.execute({ action: 'minimize_window', windowTitle: 'Telegram' });
await tool.execute({ action: 'maximize_window', windowTitle: 'Telegram' });
```

## Agent Loop Pattern

Claude returns `tool_use` blocks — you execute them locally and return results:

```typescript
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

async function computerUseLoop(task: string) {
  let messages: any[] = [{ role: "user", content: task }];

  while (true) {
    const response = await client.beta.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      tools: [
        {
          type: "computer_20251124",
          name: "computer",
          display_width_px: 1920,
          display_height_px: 1080,
          display_number: 1
        }
      ],
      messages,
      betas: ["computer-use-2025-11-24"]
    });

    // Add assistant response to messages
    messages.push({ role: "assistant", content: response.content });

    // Check if done
    if (response.stop_reason === "end_turn") {
      console.log("Task complete.");
      break;
    }

    // Process tool calls
    const toolResults: any[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        const result = await executeComputerAction(block.input);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result
        });
      }
    }

    messages.push({ role: "user", content: toolResults });
  }
}

async function executeComputerAction(input: any): Promise<any> {
  // Implement using robotjs, screenshot-desktop, etc.
  switch (input.action) {
    case "screenshot":
      const screenshot = await takeScreenshot();
      return [{ type: "image", source: { type: "base64", media_type: "image/png", data: screenshot } }];
    case "left_click":
      robot.moveMouse(input.coordinate[0], input.coordinate[1]);
      robot.mouseClick("left");
      return "Clicked.";
    case "type":
      robot.typeString(input.text);
      return "Typed.";
    case "key":
      // Parse key combo and press
      return "Key pressed.";
    // ... other actions
  }
}
```

## Companion Tools

Computer use works best with these additional tools:

### Bash Tool (`bash_20250124`)
```json
{ "type": "bash_20250124", "name": "bash" }
```
Claude can run shell commands alongside desktop control.

### Text Editor Tool (`text_editor_20250728`)
```json
{ "type": "text_editor_20250728", "name": "str_replace_based_edit_tool" }
```
Claude can view and edit files without using the desktop.

## Common Workflows

### Control Telegram Desktop
```
1. Screenshot to see current state
2. Click on Telegram in taskbar (or Alt+Tab)
3. Screenshot to verify app is focused
4. Click on chat/group
5. Click message input
6. Type message
7. Press Enter to send
8. Screenshot to verify sent
```

### Automate System Settings
```
1. Press Windows key (or Cmd+Space on Mac)
2. Type "settings"
3. Press Enter
4. Screenshot to see settings window
5. Click desired setting category
6. Modify values
```

### File Operations
```
1. Open File Explorer (Win+E) or Finder (Cmd+Space → Finder)
2. Navigate to directory
3. Right-click for context menu
4. Select operation
```

## Security Considerations

1. **Use a dedicated VM or container** — computer use can interact with anything on screen
2. **Don't expose sensitive data** — Claude sees everything in screenshots
3. **Limit internet access** — use domain allowlists
4. **Human confirmation** for destructive actions (financial transactions, deletions, etc.)
5. **Prompt injection risk** — text on screen can influence Claude's behavior. Classifiers auto-flag suspicious content.

## Cost Awareness

Each screenshot → Claude API call costs tokens. A typical computer use session:
- ~10-50 API calls per task
- Each screenshot is ~1000-3000 tokens (depending on resolution)
- Use `display_width_px`/`display_height_px` to control resolution (lower = cheaper)
- **Recommended:** 1024x768 for cost efficiency, 1920x1080 for precision

## Comparison

| Feature | computer-use | agent-browser | Chrome MCP |
|---------|-------------|---------------|------------|
| **Websites** | Works (slow) | Best | Good |
| **Native desktop apps** | **Yes** | No | No |
| **Electron apps** | Yes | Yes (via CDP) | No |
| **Cost per action** | API call + vision | Free | Free |
| **Speed** | Slow (screenshot loop) | Fast (50ms) | Medium |
| **Accuracy** | Good (pixel coords) | Best (refs) | Good (DOM) |
| **Setup complexity** | Medium (native deps) | Low (npm) | Low (extension) |

## Gotchas

1. **robotjs requires native compilation** — may need `windows-build-tools` on Windows
2. **Screenshot resolution matters** — Claude needs to see UI elements clearly
3. **Timing is critical** — add delays after clicks for UI to update before next screenshot
4. **Multi-monitor** — specify `display_number` for the correct monitor
5. **DPI scaling** — coordinate mapping may need adjustment on HiDPI displays
6. **Headless servers** — needs a display (use Xvfb on Linux)
