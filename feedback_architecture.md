---
name: feedback_architecture
description: System is overengineered and barely usable - needs architecture redesign focused on core value
type: feedback
---

Core value proposition (what the system SHOULD be):
1. Claude wrapper with persistent memory (better than other models)
2. Eliza brain that constantly learns from sessions and gets smarter
3. Telegram interface to give tasks via natural language (NO commands)

Current problems:
- Way too many Telegram commands, most broken
- Eliza brain is not actually learning/training effectively
- System is 10x more complex than it needs to be
- Basic functionalities don't work reliably
- Changes keep breaking things instead of improving them

KEY DESIGN DECISIONS:
- User is Itachisan, bot is Itachi. NEVER call user "Newman" — that was the old identity name in Supabase but Itachisan is the preferred name.
- Task execution must be INTERACTIVE, not fire-and-forget. Claude should enter plan mode, use ultrathink, and route questions back through Itachi to Itachisan on Telegram.
- Itachi should give its own recommendations alongside options, not just relay raw Claude questions.
- Primary dev machine: hoodie-prometh (Windows). Mac is secondary. surface-win is backup compute.
- SSH is handled via Termius now, not the custom SSH wrapper.

Architecture redesign needed before adding more features.
