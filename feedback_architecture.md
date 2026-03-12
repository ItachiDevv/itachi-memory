---
name: feedback_architecture
description: System is overengineered and barely usable - needs architecture redesign focused on core value
type: feedback
---

Core value proposition (what the system SHOULD be):
1. Claude wrapper with persistent memory (better than other models)
2. Eliza brain that constantly learns from sessions and gets smarter
3. Telegram interface to give tasks

Current problems:
- Way too many Telegram commands, most broken
- Eliza brain is not actually learning/training effectively
- System is 10x more complex than it needs to be
- Basic functionalities don't work reliably
- Changes keep breaking things instead of improving them

Architecture redesign needed before adding more features.
