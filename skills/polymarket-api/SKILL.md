---
name: polymarket-api
description: Expert knowledge for Polymarket API integration. Use when working with Polymarket markets, events, trading, positions, authentication, CLOB API, Gamma API, or Data API. Covers market data fetching, order placement, wallet positions, and price calculations.
---

# Polymarket API Expert

You are an expert at working with Polymarket APIs. This skill provides comprehensive knowledge of the Gamma, CLOB, and Data APIs used in this codebase.

## API Endpoints & Base URLs

| API | Base URL | Purpose |
|-----|----------|---------|
| **Gamma API** | `https://gamma-api.polymarket.com` | Market data, events, trending |
| **CLOB API** | `https://clob.polymarket.com` | Order book, trading, auth |
| **Data API** | `https://data-api.polymarket.com` | User positions, trade history |

### Proxy Configuration
- **Development**: Vite proxy `/api/polymarket` → Gamma API
- **Production**: Vercel serverless at `/api/polymarket/*`

---

## Gamma API (Market Data)

### GET /events
```javascript
// Endpoint: https://gamma-api.polymarket.com/events
// Proxy: /api/polymarket/events

Query Parameters:
- limit (number): max events (default 50-200)
- active (boolean): filter active markets
- closed (boolean): include closed markets
- order (string): 'volume24hr' | 'endDate'
- ascending (boolean): sort direction
- tag_slug (string): category filter

Response:
{
  "id": string,
  "slug": string,
  "title": string,
  "description": string,
  "image": string,
  "icon": string,
  "endDate": ISO8601,
  "volume24hr": number,
  "markets": [{
    "id": string,
    "slug": string,
    "question": string,
    "groupItemTitle": string,
    "outcomePrices": "[price1, price2]", // JSON string!
    "volume": number,
    "volume24hr": number,
    "liquidity": number,
    "active": boolean|string,
    "closed": boolean|string
  }]
}
```

### GET /markets/{slug}
```javascript
// Endpoint: https://gamma-api.polymarket.com/markets/{slug}

Response:
{
  "id": string,
  "slug": string,
  "question": string,
  "outcomes": ["Yes", "No"],
  "outcomePrices": "[price1, price2]",
  "volume": number,
  "liquidity": number,
  "endDate": ISO8601,
  "active": boolean,
  "closed": boolean
}
```

---

## Data API (User Positions)

### GET /positions
```javascript
// Endpoint: https://data-api.polymarket.com/positions?user={address}

Response: [{
  "id": string,
  "market": string,
  "outcome": string,
  "size": number,
  "avgPrice": number,
  "curPrice": number,
  "currentValue": number,
  "pnl": number,
  "pnlPercent": number,
  "title": string,
  "slug": string,
  "icon": string
}]
```

### GET /trades
```javascript
// Endpoint: https://data-api.polymarket.com/trades?user={address}&limit={limit}

Response: [{
  "side": "BUY"|"SELL",
  "price": number,
  "size": number,
  "conditionId": string,
  "outcome": "Yes"|"No",
  "title": string,
  "eventSlug": string
}]
```

---

## CLOB API (Trading & Authentication)

### Authentication Flow

**EIP-712 Domain:**
```javascript
{
  name: 'ClobAuthDomain',
  version: '1',
  chainId: 137  // Polygon mainnet
}
```

**Auth Message:**
```javascript
{
  address: string,
  timestamp: string,
  nonce: uint256,
  message: 'This message attests that I control the given wallet'
}
```

### GET /auth/derive-api-key
```javascript
// Headers required:
{
  'POLY_ADDRESS': address,
  'POLY_SIGNATURE': signature,
  'POLY_TIMESTAMP': timestamp,
  'POLY_NONCE': nonce
}

Response: { apiKey, secret, passphrase }
```

### POST /auth/api-key
- Same headers as derive-api-key
- Returns 409 if credentials exist (fallback to derive)

### Authenticated Endpoints
All require HMAC-SHA256 signature:
```javascript
Headers: {
  'POLY_ADDRESS': address,
  'POLY_SIGNATURE': hmacSignature,
  'POLY_TIMESTAMP': timestamp,
  'POLY_API_KEY': apiKey,
  'POLY_PASSPHRASE': passphrase
}
```

- **GET /orders** - User's open orders
- **GET /trades** - User's trade history
- **GET /balance-allowance?asset_type=COLLATERAL** - Balance info

### GET /book (Public)
```javascript
// Endpoint: https://clob.polymarket.com/book?token_id={tokenId}

Response: {
  "bids": [{ "price": string, "size": string }],
  "asks": [{ "price": string, "size": string }]
}
```

---

## HMAC-SHA256 Signature Generation

```javascript
const generateL2Signature = async (secret, timestamp, method, path, body = '') => {
  const message = timestamp + method + path + body;
  const keyData = Uint8Array.from(atob(secret), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const signature = await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(message)
  );
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
};
```

---

## Data Structures

### Market Object (Normalized)
```javascript
{
  id: string,
  slug: string,
  title: string,
  description: string,
  image: string,
  icon: string,
  endDate: ISO8601,
  volume24hr: number,
  liquidity: number,
  markets: [{
    id: string,
    slug: string,
    question: string,
    shortName: string,      // extracted display name
    outcomePrices: number[], // [yesPrice, noPrice]
    yesPrice: number,       // 0-1 (represents 0-100%)
    liquidity: number,
    volume: number
  }],
  isMultiMarket: boolean,
  totalMarkets: number
}
```

### Position Object
```javascript
{
  id: string,
  conditionId: string,
  outcome: "YES"|"NO",
  size: number,       // shares held
  avgPrice: number,   // entry price
  currentPrice: number,
  costBasis: number,
  pnl: number,
  pnlPercent: number
}
```

### Order Payload
```javascript
{
  tokenID: string,
  side: "BUY"|"SELL",
  price: string,
  size: string,
  feeRateBps: number,  // 100 = 1%
  nonce: number,
  expiration: number   // Unix timestamp
}
```

---

## Price & Payout Calculations

```javascript
// Calculate shares from amount
shares = amount / price;

// Potential payout (if outcome wins)
potentialPayout = shares * 1.0;  // $1 per share max
profit = potentialPayout - amount;
roi = (profit / amount) * 100;

// Example: Buy YES at $0.65
// Invest $100 → get 153.85 shares
// If YES wins: $153.85 payout ($53.85 profit, 53.85% ROI)
// If YES loses: $0 (lose $100)

// Cost with fees
fee = amount * (feePercent / 100);  // default 1%
totalCost = amount + fee;
```

---

## Utility Functions

### Format Volume
```javascript
const formatVolume = (volume) => {
  const num = parseFloat(volume) || 0;
  if (num >= 1000000) return `$${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `$${(num / 1000).toFixed(0)}K`;
  return `$${num.toFixed(0)}`;
};
```

### Parse Outcome Prices
```javascript
const parseOutcomePrices = (pricesStr) => {
  try {
    const prices = JSON.parse(pricesStr);
    return prices.map(p => parseFloat(p));
  } catch {
    return [0.5, 0.5];  // fallback
  }
};
```

### Address Validation
```javascript
const isValidEthAddress = (addr) => /^0x[a-fA-F0-9]{40}$/.test(addr);
const isSolanaFormat = (addr) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);
const formatAddress = (addr) => `${addr.slice(0,6)}...${addr.slice(-4)}`;
```

---

## Category Tags

```javascript
const CATEGORIES = [
  { label: 'All', slug: null },
  { label: 'Crypto', slug: 'crypto' },
  { label: 'Politics', slug: 'politics' },
  { label: 'Finance', slug: 'finance' },
  { label: 'Sports', slug: 'sports' },
  { label: 'Tech', slug: 'tech' },
  { label: 'Business', slug: 'business' },
  { label: 'Culture', slug: 'pop-culture' },
  { label: 'Science', slug: 'science' },
  { label: 'World', slug: 'world' },
];
```

---

## Market Filtering Best Practices

```javascript
// Skip markets that shouldn't be displayed
const shouldSkip = (market) => {
  // Closed markets
  if (market.closed === true || market.closed === 'true') return true;

  // Inactive markets
  if (market.active === false || market.active === 'false') return true;

  // Essentially resolved (extreme odds)
  const yesPrice = parseFloat(market.outcomePrices?.[0]) || 0.5;
  if (yesPrice <= 0.02 || yesPrice >= 0.98) return true;

  return false;
};
```

---

## Error Handling Patterns

```javascript
// Standard API error response
{
  error: "Polymarket API error",
  status: number,
  details: string
}

// Graceful fallbacks
try {
  const data = await fetchMarkets();
  return data;
} catch (error) {
  console.error('Market fetch failed:', error);
  return [];  // Return empty array, not throw
}
```

---

## Credential Storage

```javascript
// Key format: poly_creds_{address.toLowerCase()}
const storeCreds = (address, creds) => {
  localStorage.setItem(
    `poly_creds_${address.toLowerCase()}`,
    JSON.stringify({ ...creds, storedAt: Date.now() })
  );
};

// TTL: 7 days
const CREDS_TTL = 7 * 24 * 60 * 60 * 1000;
```

---

## Key Files in This Codebase

| Purpose | Path |
|---------|------|
| Market data | `/src/services/marketService.js` |
| Positions | `/src/services/positionService.js` |
| Authentication | `/src/services/polymarketAuth.js` |
| Trading | `/src/services/tradingService.js` |
| Wallet tracking | `/src/services/walletService.js` |
| Caching | `/src/services/cacheService.js` |
| API proxy (events) | `/api/polymarket/events.js` |
| API proxy (markets) | `/api/polymarket/markets/[slug].js` |
| Market display | `/src/components/features/markets/MarketCard.jsx` |

---

## Common Patterns

### Fetching Markets with Proxy
```javascript
const fetchMarkets = async (category = null, limit = 50) => {
  const params = new URLSearchParams({
    limit: String(limit),
    active: 'true',
    closed: 'false',
    order: 'volume24hr',
    ascending: 'false'
  });

  if (category) params.append('tag_slug', category);

  const response = await fetch(`/api/polymarket/events?${params}`);
  if (!response.ok) throw new Error(`API error: ${response.status}`);
  return response.json();
};
```

### Multi-Market Event Handling
```javascript
// Events with multiple outcomes (e.g., "Who will win the election?")
const processMultiMarket = (event) => {
  const sortedMarkets = event.markets
    .filter(m => !shouldSkip(m))
    .sort((a, b) => {
      const priceA = parseFloat(a.outcomePrices?.[0]) || 0;
      const priceB = parseFloat(b.outcomePrices?.[0]) || 0;
      return priceB - priceA;  // Highest YES price first
    })
    .slice(0, 4);  // Top 4 only

  return {
    ...event,
    markets: sortedMarkets,
    isMultiMarket: event.markets.length > 1,
    totalMarkets: event.markets.length
  };
};
```

### Position Calculation from Trades
```javascript
const calculatePosition = (trades) => {
  let netSize = 0, totalCost = 0, totalBought = 0;

  for (const trade of trades) {
    const size = parseFloat(trade.size);
    const price = parseFloat(trade.price);

    if (trade.side === 'BUY') {
      netSize += size;
      totalCost += size * price;
      totalBought += size;
    } else {
      netSize -= size;
      totalCost -= size * price;
    }
  }

  return {
    size: netSize,
    avgPrice: totalBought > 0 ? totalCost / totalBought : 0,
    costBasis: totalCost
  };
};
```
