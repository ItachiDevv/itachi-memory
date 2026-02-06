# X (Twitter) API — Posts, Users, Search & Streaming

Expert-level knowledge of the X API v2 for posting tweets, searching, managing users, direct messages, and streaming. Use when integrating with X/Twitter, posting content, searching tweets, or building bots.

## Authentication

### OAuth 2.0 Bearer Token (App-only)
```bash
# Read-only access to public data
export X_BEARER_TOKEN="AAAA..."
curl -H "Authorization: Bearer $X_BEARER_TOKEN" \
  "https://api.x.com/2/tweets/1234567890"
```

### OAuth 1.0a (User Context)
```bash
# Read + write access on behalf of a user
export X_API_KEY="..."
export X_API_SECRET="..."
export X_ACCESS_TOKEN="..."
export X_ACCESS_TOKEN_SECRET="..."
```

### OAuth 2.0 PKCE (User Context, modern)
- Authorization Code Flow with PKCE
- Scopes: `tweet.read`, `tweet.write`, `users.read`, `dm.read`, `dm.write`, `offline.access`

## API Tiers & Rate Limits

| Tier | Price | Key Capabilities |
|------|-------|------------------|
| Free | $0 | Post tweets (1,500/mo), 1 app, basic read |
| Basic | $100/mo | 10K reads/mo, 3K posts/mo, 1 app |
| Pro | $5,000/mo | 1M reads/mo, 300K posts/mo, 3 apps, full-archive search |

## Posts (Tweets)

### Create Tweet
```bash
POST https://api.x.com/2/tweets
Authorization: OAuth 1.0a or OAuth 2.0 PKCE (tweet.write)

# Simple text tweet
{ "text": "Hello from the API!" }

# Reply to tweet
{ "text": "Reply text", "reply": { "in_reply_to_tweet_id": "1234567890" } }

# Quote tweet
{ "text": "Check this out", "quote_tweet_id": "1234567890" }

# Tweet with media
{ "text": "Photo!", "media": { "media_ids": ["1234567890"] } }

# Tweet with poll
{
  "text": "Favorite color?",
  "poll": { "options": ["Red", "Blue", "Green"], "duration_minutes": 1440 }
}
```

### Delete Tweet
```bash
DELETE https://api.x.com/2/tweets/{id}
```

### Lookup Tweets
```bash
# Single tweet
GET https://api.x.com/2/tweets/{id}?tweet.fields=created_at,public_metrics,author_id

# Multiple tweets
GET https://api.x.com/2/tweets?ids=1234,5678&tweet.fields=created_at,public_metrics

# Tweet fields: id, text, created_at, author_id, public_metrics, entities, attachments
# Expansions: author_id, referenced_tweets.id, attachments.media_keys
```

### Like / Unlike
```bash
POST https://api.x.com/2/users/{user_id}/likes
{ "tweet_id": "1234567890" }

DELETE https://api.x.com/2/users/{user_id}/likes/{tweet_id}
```

### Retweet / Undo
```bash
POST https://api.x.com/2/users/{user_id}/retweets
{ "tweet_id": "1234567890" }

DELETE https://api.x.com/2/users/{user_id}/retweets/{tweet_id}
```

### Bookmark
```bash
POST https://api.x.com/2/users/{user_id}/bookmarks
{ "tweet_id": "1234567890" }

GET https://api.x.com/2/users/{user_id}/bookmarks
```

## Users

### Lookup
```bash
# By ID
GET https://api.x.com/2/users/{id}?user.fields=name,username,description,public_metrics,profile_image_url

# By username
GET https://api.x.com/2/users/by/username/{username}

# Multiple IDs
GET https://api.x.com/2/users?ids=1234,5678

# Authenticated user
GET https://api.x.com/2/users/me
```

### Followers / Following
```bash
GET https://api.x.com/2/users/{id}/followers?max_results=100
GET https://api.x.com/2/users/{id}/following?max_results=100

# Follow user
POST https://api.x.com/2/users/{user_id}/following
{ "target_user_id": "1234567890" }

# Unfollow
DELETE https://api.x.com/2/users/{user_id}/following/{target_user_id}
```

### Block / Mute
```bash
POST https://api.x.com/2/users/{user_id}/blocking
{ "target_user_id": "1234567890" }

POST https://api.x.com/2/users/{user_id}/muting
{ "target_user_id": "1234567890" }
```

## Timelines

```bash
# User tweets
GET https://api.x.com/2/users/{id}/tweets?max_results=10&tweet.fields=created_at,public_metrics

# User mentions
GET https://api.x.com/2/users/{id}/mentions?max_results=10

# Reverse chronological (home timeline, requires user auth)
GET https://api.x.com/2/users/{id}/reverse_chronological
```

## Search

```bash
# Recent search (last 7 days)
GET https://api.x.com/2/tweets/search/recent?query=from:elonmusk&max_results=10&tweet.fields=created_at,public_metrics

# Full-archive search (Pro tier only)
GET https://api.x.com/2/tweets/search/all?query=...

# Count tweets matching query
GET https://api.x.com/2/tweets/counts/recent?query=...
```

### Query Operators
```
keyword               # Contains keyword
"exact phrase"        # Exact match
from:username         # From user
to:username           # To user
@username             # Mentioning user
#hashtag              # Contains hashtag
url:"example.com"     # Contains URL
has:media             # Has media attachment
has:images            # Has images
has:videos            # Has videos
has:links             # Has links
is:retweet            # Is a retweet
is:reply              # Is a reply
is:quote              # Is a quote tweet
lang:en               # Language
-is:retweet           # NOT a retweet (exclude)
(cat OR dog)          # Boolean OR
```

## Direct Messages

```bash
# Send DM
POST https://api.x.com/2/dm_conversations/with/{participant_id}/messages
{ "text": "Hello!" }

# Send DM to group
POST https://api.x.com/2/dm_conversations
{
  "conversation_type": "Group",
  "participant_ids": ["user1", "user2"],
  "message": { "text": "Group chat" }
}

# Get DM events
GET https://api.x.com/2/dm_events?dm_event.fields=created_at,text,sender_id

# Get conversations
GET https://api.x.com/2/dm_conversations/{id}/dm_events
```

## Media Upload

```bash
# Step 1: Upload media (v1.1 endpoint, still used)
POST https://upload.x.com/1.1/media/upload.json
Content-Type: multipart/form-data
media_data=<base64-encoded>

# Step 2: Use media_id in tweet
POST https://api.x.com/2/tweets
{ "text": "Photo!", "media": { "media_ids": ["returned_media_id"] } }
```

## Filtered Stream (Real-time)

```bash
# Add rules
POST https://api.x.com/2/tweets/search/stream/rules
{
  "add": [
    { "value": "cat has:images", "tag": "cats with images" },
    { "value": "from:elonmusk", "tag": "elon tweets" }
  ]
}

# Get rules
GET https://api.x.com/2/tweets/search/stream/rules

# Connect to stream (SSE)
GET https://api.x.com/2/tweets/search/stream?tweet.fields=created_at,author_id

# Delete rules
POST https://api.x.com/2/tweets/search/stream/rules
{ "delete": { "ids": ["rule-id-1"] } }
```

## Pagination

All list endpoints use cursor-based pagination:
```bash
GET /2/users/{id}/followers?max_results=100&pagination_token=<next_token>

# Response includes:
{
  "data": [...],
  "meta": {
    "next_token": "abc123",   # Use as pagination_token
    "result_count": 100
  }
}
```

## Fields & Expansions

Customize response data:
```bash
# Tweet fields
tweet.fields=created_at,public_metrics,entities,author_id,conversation_id

# User fields
user.fields=name,username,description,public_metrics,profile_image_url,verified

# Expansions (include related objects)
expansions=author_id,referenced_tweets.id,attachments.media_keys

# Media fields (requires media expansion)
media.fields=url,preview_image_url,type,width,height
```

## Rate Limit Headers

Every response includes:
```
x-rate-limit-limit: 300          # Max requests in window
x-rate-limit-remaining: 299      # Remaining requests
x-rate-limit-reset: 1234567890   # Unix timestamp when window resets
```

Handle 429 responses:
```typescript
if (response.status === 429) {
  const resetTime = response.headers.get('x-rate-limit-reset');
  const waitMs = (parseInt(resetTime) * 1000) - Date.now();
  await new Promise(r => setTimeout(r, waitMs));
  // Retry request
}
```

## Node.js Example (twitter-api-v2)

```typescript
import { TwitterApi } from 'twitter-api-v2';

// App-only client
const appClient = new TwitterApi(process.env.X_BEARER_TOKEN!);

// User client (OAuth 1.0a)
const userClient = new TwitterApi({
  appKey: process.env.X_API_KEY!,
  appSecret: process.env.X_API_SECRET!,
  accessToken: process.env.X_ACCESS_TOKEN!,
  accessSecret: process.env.X_ACCESS_TOKEN_SECRET!,
});

// Post tweet
const { data } = await userClient.v2.tweet('Hello from Node.js!');

// Search
const results = await appClient.v2.search('AI agents', {
  max_results: 10,
  'tweet.fields': 'created_at,public_metrics'
});

// Get user
const user = await appClient.v2.userByUsername('elonmusk');
```

## Env Vars Used

- `X_API_KEY` — App API key (consumer key)
- `X_API_SECRET` — App API secret (consumer secret)
- `X_ACCESS_TOKEN` — User access token (OAuth 1.0a)
- `X_ACCESS_TOKEN_SECRET` — User access token secret
- `X_BEARER_TOKEN` — App-only bearer token
