# Itachi Todo

## 1) RLM session-hook leakage + learning gaps
- This was my attempt at improving the RLM - Analyze it yourself as well, to make sure that it actually improves it, and think if there are better ways to do it, or more alternatives. We want the entire itachi memory system to improve with RLM, I spend almost all my time using the computer with itachi, itachig, and itachic, not the bot, so we need intense RLM for that whole system. 
- [ ] **Add responses + outcomes to session hooks**  
  Current understanding: the RLM training signal is using *prompts* but not sufficiently incorporating **responses** and/or **success signals** when session hooks run. This can cause leakage (the system doesn't learn what actually worked).
- [ ] **Run this across vector search as well**  
  Ensure the same enrichment (prompt + response + outcome) is indexed/queried through the vector memory workflow.
- [ ] **Learn from successful executions**  
  Persist what was done successfully (tool calls, commands, results, confirmations) so future runs can reuse proven steps.
- [ ] **Unify memory workflow across agents**  
  Make **itachi**, **itachic**, and **itachig** share the same memory + session-hook workflow (consistent schema + ingestion + retrieval).

---

## 2) Hallucinating tasks / claiming work completed - Give bot autonomy 

- Why Doesn't this agent have autonomy? Why can't it just actually do the tasks that I ask? 
- Can we give itachi his own Linux environment to do work on in the VPS? (This would include installing itachi, itachic, and itachig hooks and whatnot )
- Reference Todo1TgLogs.md in the root folder for the logs of the telegram chat that specifically frustrated me, and the screenshots are included below 
- [ ] Investigate + fix cases where the bot claims it is "doing tasks" without actually performing them.  
- 
  Evidence: attached screenshots below.

### Attached screenshots
![alt text](image-4.png)
![alt text](image-3.png)
![alt text](image-2.png)
![alt text](image-1.png)


---

## 3) Topic management not working

- [ ] **Topic routing / management**  
  In Telegram, **itachi** responds to *my session responses* (topic/thread confusion).  
  Fix: ensure messages are attributed to the correct topic/thread/session and only the intended handler responds.

---

## 4) Model switching mid-session

- [ ] **Switch between models on the go (mid-session)**  
  Add the ability to switch models mid-session and continue the same task context.
- [ ] **Auto handoff when nearing usage limits**  
  When a model is about to run out of usage, automatically generate a **handoff markdown (MD)** and pass execution to another model to continue.
- [ ] **Use the Itachi MCP for handoffs** *(if applicable)*  
  Potentially use the Itachi MCP we built to orchestrate the model swap + context handoff.

---

## 5) Telegram hook: add item to todo list

- [ ] Add a Telegram command/hook (e.g. `/todo add ...`) that appends an item to this todo list (or a canonical todo store).

---

## 6) Gemini-specific: auto switch models

- [ ] Auto switch models when out of usage  
  Example: switch to **Gemini 3** when **3.1 Pro** runs out of usage.

---

## 7) Mid-session commands (Telegram)

- [ ] Add mid-session controls in Telegram (e.g., an **ESC/stop** equivalent) to interrupt/cancel the current task cleanly.

---

## 8) Link skills to subagents

- [ ] Link skills to subagents (agent teams)  
  Note: could increase usage; consider lightweight routing, shared skill registry, or caching.
