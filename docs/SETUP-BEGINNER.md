# Itachi Memory System - Beginner's Setup Guide

## What is This?

You know how when you use Claude Code (the AI coding assistant in your terminal), every time you start a new conversation it forgets everything from before? **Itachi fixes that.**

After you install Itachi, Claude will:
- **Remember** what you worked on yesterday, last week, or last month
- **Know** what files you've been editing across all your projects
- **Share** that memory across all your computers (so your laptop and desktop stay in sync)
- Give you special commands like `/recall` to search through everything you've ever worked on

Think of it like giving Claude a notebook that it writes in every time you work together, and reads from every time you start a new session.

---

## Before You Start

You need a few programs installed on your computer. Don't worry — these are all standard developer tools.

### On a Mac

1. Open **Terminal** (press Cmd+Space, type "Terminal", press Enter)

2. Install Homebrew (a package manager for Mac) if you don't have it:
   ```bash
   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
   ```
   Follow any instructions it gives you after installing.

3. Install the required tools:
   ```bash
   brew install node git gh
   ```

4. Verify they installed:
   ```bash
   node --version    # Should show v20 or higher
   git --version     # Should show a version number
   gh --version      # Should show a version number
   ```

### On Windows

1. Open **PowerShell** (press Windows key, type "PowerShell", click it)

2. Install the required tools (one at a time, press Enter after each):
   ```powershell
   winget install OpenJS.NodeJS.LTS
   winget install Git.Git
   winget install GitHub.cli
   ```

3. **Close PowerShell and open a new one** (newly installed programs aren't available until you restart the terminal)

4. Verify they installed:
   ```powershell
   node --version    # Should show v20 or higher
   git --version     # Should show a version number
   gh --version      # Should show a version number
   ```

---

## Installation

### Step 1: Download the Code

Open your terminal and type these commands one at a time:

**Mac:**
```bash
cd ~/documents
git clone https://github.com/ItachiDevv/itachi-memory.git
cd itachi-memory
```

**Windows:**
```powershell
cd ~\documents
git clone https://github.com/ItachiDevv/itachi-memory.git
cd itachi-memory
```

> **What does this do?** `git clone` downloads the Itachi code from GitHub to your computer. `cd` changes into that folder.

### Step 2: Run the Installer

**Mac:**
```bash
bash setup.sh
```

**Windows:**
```powershell
powershell -ExecutionPolicy Bypass -File setup.ps1
```

The installer will now walk you through everything. Here's what to expect:

---

### Step 3: The Installer Will Ask You Things

Don't panic! Here's a guide for each question:

#### "Passphrase:"

This is like a password that encrypts your data when syncing between computers.

- **First time ever setting up Itachi?** Make up a passphrase and write it down somewhere safe. You'll need it when setting up other computers.
- **Already set up on another computer?** Enter the **same passphrase** you used before. This is how the two computers share data.

#### "API Keys" (there will be several)

The installer will show a list of API keys like:
```
GitHub Personal Access Token [ghp_...] [(not set)]:
Vercel Token [(not set)]:
OpenAI API Key [(not set)]:
```

- If this is your **second computer**, these will mostly be filled in automatically from sync. Just press **Enter** to keep each one.
- If this is your **first computer**, paste in any API keys you have. Don't have one? Just press **Enter** to skip it. You can add them later.
- **Don't worry** if you skip most of them. The only important one is `ITACHI_API_KEY` which should be provided to you.

#### "Orchestrator" Questions

Near the end, it'll ask about setting up an "orchestrator." This is an advanced feature that lets you assign tasks to Claude via Telegram.

**If you're not sure, choose option 3 (Skip).** You can always set this up later.

---

### Step 4: Open a New Terminal Window

This is important! The installer set up some things that only work in a **new** terminal window.

- **Mac:** Close Terminal and open it again. Or run: `source ~/.zshrc`
- **Windows:** Close PowerShell and open a new one.

### Step 5: Try It Out!

In your new terminal:

```bash
itachi --version
```

If you see a version number, it's working! Now navigate to any coding project and start a session:

```bash
cd ~/documents/some-project
itachi
```

This opens Claude Code, but now with memory superpowers.

---

## How to Use It

### Starting Claude (With Memory)

Instead of typing `claude`, type `itachi`:

```bash
itachi                   # Start a new session
itachi --continue        # Pick up where you left off
```

### Searching Your Memory

Inside a Claude session, type:

```
/recall login page
```

This searches through everything you've ever worked on and finds relevant memories. Try things like:
- `/recall database changes`
- `/recall that bug we fixed last week`
- `/recall authentication`

### Seeing Recent Changes

```
/recent
```

Shows the last 10 things you worked on. Want more?

```
/recent 20
```

### Setting Up a New Project

The first time you use Itachi in a new project folder:

```
/itachi-init
```

This adds some helpful documentation to the project so Claude knows it's being tracked.

---

## What Just Got Installed?

Here's a plain-English explanation of what the installer put on your computer:

| What | Why |
|------|-----|
| **Hook scripts** (in `~/.claude/hooks/`) | Small programs that run automatically when Claude starts, when you edit files, and when you finish. They send data to the memory server. |
| **Commands** (in `~/.claude/commands/`) | The `/recall` and `/recent` commands you can use inside Claude. |
| **Skills** (in `~/.claude/skills/`) | Extra abilities for Claude — like `/github` for GitHub operations, `/vercel` for deployments, etc. |
| **The `itachi` command** | A shortcut that loads all your API keys and then starts Claude. |
| **Your passphrase** (in `~/.itachi-key`) | The encryption key used to sync data between machines. |
| **Your API keys** (in `~/.itachi-api-keys`) | All your API credentials stored in one file. |
| **A daily sync job** | Runs at 3AM to keep your skills and commands in sync across computers. |

---

## Troubleshooting

### "itachi: command not found"

Did you open a **new** terminal window after installing? The command won't work in the same window where you ran setup.

If it still doesn't work:

**Mac:**
```bash
sudo cp ~/documents/itachi-memory/bin/itachi /usr/local/bin/itachi
chmod +x /usr/local/bin/itachi
```

**Windows:**
```powershell
copy "$HOME\documents\itachi-memory\bin\itachi.cmd" "$env:APPDATA\npm\itachi.cmd"
```

### /recall Says "Error" or Returns Nothing

Your memory server might not be reachable. Test it:

**Mac:**
```bash
curl -s "$ITACHI_API_URL/health"
```

**Windows:**
```powershell
Invoke-RestMethod "$env:ITACHI_API_URL/health"
```

If it returns an error, the server might be down. Contact the team.

### Claude Doesn't Seem to Have Memory

Make sure you're using `itachi` to start sessions, not `claude`. The `itachi` command loads all the necessary environment variables.

### Something Broke and You Want to Start Over

Just re-run the installer. It's safe to run multiple times:

**Mac:** `bash setup.sh`
**Windows:** `powershell -ExecutionPolicy Bypass -File setup.ps1`

It won't delete your passphrase or API keys — it just updates everything else to the latest version.

### I Want to Turn It Off Temporarily

**Mac:**
```bash
export ITACHI_DISABLED=1
claude    # Use claude directly, memory hooks won't run
```

**Windows:**
```powershell
$env:ITACHI_DISABLED = "1"
claude    # Use claude directly, memory hooks won't run
```

---

## Updating Itachi

When improvements are released:

```bash
cd ~/documents/itachi-memory    # Go to where you installed it
git pull                         # Download the latest code
bash setup.sh                    # Re-run the installer (Mac/Linux)
```

Or on Windows:
```powershell
cd ~\documents\itachi-memory
git pull
powershell -ExecutionPolicy Bypass -File setup.ps1
```

---

## Glossary

| Term | Meaning |
|------|---------|
| **Claude Code** | An AI coding assistant that runs in your terminal |
| **Hook** | A script that runs automatically at certain moments (like when Claude starts or edits a file) |
| **MCP Server** | A local program that gives Claude extra tools to use during a conversation |
| **Orchestrator** | A background program that can run Claude tasks automatically (advanced feature) |
| **Passphrase** | A secret phrase used to encrypt your data when syncing between computers |
| **API Key** | A password-like string that lets programs access online services (GitHub, OpenAI, etc.) |
| **Supabase** | The cloud database where all memories are stored |
| **Terminal** | The text-based interface where you type commands (Terminal on Mac, PowerShell on Windows) |
| **`git clone`** | A command that downloads code from GitHub to your computer |
| **`git pull`** | A command that updates your local code with the latest changes from GitHub |
| **Environment variable** | A setting stored in your terminal session, like `ITACHI_API_URL=http://...` |
