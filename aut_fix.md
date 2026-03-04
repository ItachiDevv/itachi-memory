│ Plan to implement                                                                                                                                                                    ││                                                                                                                                                                                      ││ Fix Session Single-Turn + LLM Chatter in Telegram Topics                                                                                                                             ││                                                                                                                                                                                      ││ Context                                                                                                                                                                              │
│                                                                                                                                                                                      │
│ The /session flow is broken. When user browses to a project and starts a session:                                                                                                    │
│ 1. Session spawns with useless prompt "Work in ~/Documents/Crypto/elizapets"                                                                                                         │
│ 2. Claude says "What would you like me to do?" and immediately exits (9s, because -p = single-turn)                                                                                  │
│ 3. User sends follow-up → no active session → LLM personality responds as "itachi.retard"                                                                                            │
│ 4. LLM creates a task in the wrong project (itachi-memory instead of elizapets)                                                                                                      │
│                                                                                                                                                                                      │
│ Root cause: -p (print mode) in the SSH command makes every session single-turn. --output-format stream-json --input-format stream-json already controls I/O format — -p is           │
│ orthogonal and forces "process one prompt, exit".                                                                                                                                    │
│                                                                                                                                                                                      │
│ Changes                                                                                                                                                                              │
│                                                                                                                                                                                      │
│ 1. Remove -p from stream-json SSH command                                                                                                                                            │
│                                                                                                                                                                                      │
│ File: interactive-session.ts:409                                                                                                                                                     │
│                                                                                                                                                                                      │
│ BEFORE: cd ${repoPath} && ${engineCommand}${dsFlag} -p --verbose --output-format stream-json --input-format stream-json                                                              │
│ AFTER:  cd ${repoPath} && ${engineCommand}${dsFlag} --output-format stream-json --input-format stream-json                                                                           │
│                                                                                                                                                                                      │
│ Without -p, Claude stays running and reads additional JSON messages from stdin. The topic-input-relay already pipes follow-up messages via handle.write(wrapStreamJsonInput(text))   │
│ (line 258). Multi-turn just works.                                                                                                                                                   │
│                                                                                                                                                                                      │
│ Also remove --verbose (only documented as "required with -p").                                                                                                                       │
│                                                                                                                                                                                      │
│ 2. Fix useless "Work in " prompt                                                                                                                                                     │
│                                                                                                                                                                                      │
│ File: callback-handler.ts:911 (session flow) and callback-handler.ts:416 (browse flow)                                                                                               │
│                                                                                                                                                                                      │
│ Replace generic prompt with one that gives Claude context and a concrete task:                                                                                                       │
│ // Line 911 (session flow)                                                                                                                                                           │
│ const prompt = `You are in the ${projectName} project at ${repoPath}. Briefly describe what you see and wait for instructions.`;                                                     │
│                                                                                                                                                                                      │
│ // Line 416 (browse flow fallback)                                                                                                                                                   │
│ prompt: session.prompt || `You are in ${session.currentPath}. Briefly describe what you see and wait for instructions.`,                                                             │
│                                                                                                                                                                                      │
│ 3. Suppress [Session success] on per-turn result messages                                                                                                                            │
│                                                                                                                                                                                      │
│ File: interactive-session.ts — the result NDJSON handler                                                                                                                             │
│                                                                                                                                                                                      │
│ In multi-turn mode, Claude sends a result message after each turn but the process stays running. Currently this renders as [Session success] Cost: $X Duration: Ys after every turn. │
│  Only show this on actual process exit (already handled by onExit).                                                                                                                  │
│                                                                                                                                                                                      │
│ Fix: In the stream-json stdout handler, suppress result-type chunks from being sent to Telegram. The onExit handler already sends the session-ended message.                         │
│                                                                                                                                                                                      │
│ 4. Auto-respawn safety net (already coded, uncommitted)                                                                                                                              │
│                                                                                                                                                                                      │
│ Files: active-sessions.ts, topic-input-relay.ts, interactive-session.ts                                                                                                              │
│                                                                                                                                                                                      │
│ Already implemented earlier this session:                                                                                                                                            │
│ - closedSessionMeta map stores session params (target, project, engine, path) for 1 hour after exit                                                                                  │
│ - respawnSessionFromMeta() auto-spawns new session if follow-up arrives in a closed session topic                                                                                    │
│ - suppressNextLLMMessage() blocks LLM chatter during respawn                                                                                                                         │
│                                                                                                                                                                                      │
│ This stays as a safety net for crashed/timed-out sessions.                                                                                                                           │
│                                                                                                                                                                                      │
│ Files to modify                                                                                                                                                                      │
│                                                                                                                                                                                      │
│ ┌────────────────────────┬──────────┬──────────────────────────────────────────────────────────────────────────────────┐                                                             │
│ │          File          │ Line(s)  │                                      Change                                      │                                                             │
│ ├────────────────────────┼──────────┼──────────────────────────────────────────────────────────────────────────────────┤                                                             │
│ │ interactive-session.ts │ 409      │ Remove -p --verbose, keep --output-format stream-json --input-format stream-json │                                                             │
│ ├────────────────────────┼──────────┼──────────────────────────────────────────────────────────────────────────────────┤                                                             │
│ │ interactive-session.ts │ ~475-505 │ Skip sending result chunks to Telegram (show only on process exit)               │                                                             │
│ ├────────────────────────┼──────────┼──────────────────────────────────────────────────────────────────────────────────┤                                                             │
│ │ callback-handler.ts    │ 911      │ Better initial prompt for session flow                                           │                                                             │
│ ├────────────────────────┼──────────┼──────────────────────────────────────────────────────────────────────────────────┤                                                             │
│ │ callback-handler.ts    │ 416      │ Better initial prompt for browse flow                                            │                                                             │
│ └────────────────────────┴──────────┴──────────────────────────────────────────────────────────────────────────────────┘                                                             │
│                                                                                                                                                                                      │
│ Already done (uncommitted):                                                                                                                                                          │
│                                                                                                                                                                                      │
│ ┌────────────────────────┬──────────────────────────────────────────────────────────────────────┐                                                                                    │
│ │          File          │                                Change                                │                                                                                    │
│ ├────────────────────────┼──────────────────────────────────────────────────────────────────────┤                                                                                    │
│ │ active-sessions.ts     │ closedSessionMeta + getClosedSessionMeta() + markSessionClosed(meta) │                                                                                    │
│ ├────────────────────────┼──────────────────────────────────────────────────────────────────────┤                                                                                    │
│ │ topic-input-relay.ts   │ respawnSessionFromMeta() + LLM suppression on follow-up              │                                                                                    │
│ ├────────────────────────┼──────────────────────────────────────────────────────────────────────┤                                                                                    │
│ │ interactive-session.ts │ Pass metadata to markSessionClosed() in onExit + handoff             │                                                                                    │
│ └────────────────────────┴──────────────────────────────────────────────────────────────────────┘                                                                                    │
│                                                                                                                                                                                      │
│ Verification                                                                                                                                                                         │
│                                                                                                                                                                                      │
│ 1. bun test src/__tests__/ — all 997 tests pass                                                                                                                                      │
│ 2. Commit + push + deploy to Hetzner                                                                                                                                                 │
│ 3. Telegram test: /session windows → browse → elizapets → pick engine                                                                                                                │
│ 4. Verify: Claude gives project overview, session stays alive (no [Session success] yet)                                                                                             │
│ 5. Send follow-up "yo make a random comment in the .md file" → verify piped to same session                                                                                          │
│ 6. Verify: no "itachi.retard" chatter, correct project context                                                                                                                       │
╰─────────────────────────────────────────────────────────────────────────