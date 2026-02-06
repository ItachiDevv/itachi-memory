# /recall - Search Memories

Search the Itachi Memory System for relevant past context.

## Usage
/recall <query>

## Instructions

When the user runs `/recall <query>`:

1. Make a GET request to the memory API:
   ```
   curl -s "http://swoo0o4okwk8ocww4g4ks084.77.42.84.38.sslip.io/api/memory/search?query=<URL-encoded-query>&project=<current-project>&limit=5"
   ```

2. If results are found, display them in a formatted list:
   - Show each memory's category, summary, files, and similarity score
   - Order by relevance (similarity)

3. If no results found, tell the user "No memories found for that query."

4. Use the context from memories to inform your subsequent responses in this session.
