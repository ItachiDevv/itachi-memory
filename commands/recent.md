# /recent - Show Recent Changes

Show recent memories from the Itachi Memory System.

## Usage
/recent [limit]

## Instructions

When the user runs `/recent` (optionally with a limit number):

1. Default limit is 10 if not specified.

2. Make a GET request to the memory API (use `$ITACHI_API_URL` env var):
   ```
   curl -s "$ITACHI_API_URL/api/memory/recent?project=<current-project>&limit=<limit>"
   ```

3. Display results in a formatted table or list:
   - Category, summary, files affected, and timestamp
   - Most recent first

4. If no results found, tell the user "No recent memories found for this project."
