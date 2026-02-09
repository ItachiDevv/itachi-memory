# Gemini 3 Complete Documentation

## Model Overview

Gemini 3 is Google's most intelligent model family, built for advanced reasoning, agentic workflows, autonomous coding, and complex multimodal tasks.

### Model IDs and Specifications

| Model ID | Context Window | Knowledge Cutoff | Pricing (per 1M tokens) |
|----------|----------------|------------------|------------------------|
| `gemini-3-pro-preview` | 1M in / 64k out | Jan 2025 | $2/$12 (<200k), $4/$18 (>200k) |
| `gemini-3-flash-preview` | 1M in / 64k out | Jan 2025 | $0.50 in / $3 out |
| `gemini-3-pro-image-preview` | 65k in / 32k out | Jan 2025 | $2 text / $0.134 image |

All models are in preview status.

## API Versions

- **v1beta**: Default, stable features
- **v1alpha**: Required for `media_resolution` parameter

```typescript
// v1alpha for media resolution
const ai = new GoogleGenAI({ apiVersion: "v1alpha" });
```

## Thinking Configuration

Gemini 3 uses dynamic thinking by default. The `thinking_level` parameter controls maximum reasoning depth.

### Thinking Levels

**Pro and Flash:**
- `low`: Minimizes latency/cost. Best for simple tasks, chat, high throughput
- `high`: (Default) Maximizes reasoning depth. Longer time to first token

**Flash only:**
- `minimal`: Matches "no thinking" for most queries. May think minimally for complex coding
- `medium`: Balanced thinking for most tasks

### Configuration

```typescript
// TypeScript
const response = await ai.models.generateContent({
  model: "gemini-3-pro-preview",
  contents: "How does AI work?",
  config: {
    thinkingConfig: {
      thinkingLevel: "low",
    },
  },
});
```

```python
# Python
from google.genai import types

response = client.models.generate_content(
    model="gemini-3-pro-preview",
    contents="How does AI work?",
    config=types.GenerateContentConfig(
        thinking_config=types.ThinkingConfig(thinking_level="low")
    ),
)
```

**Important:** Cannot use both `thinking_level` and legacy `thinking_budget` in same request (400 error).

## Media Resolution

Control multimodal vision processing via `media_resolution` parameter.

### Resolution Levels and Token Counts

| Media Type | Level | Max Tokens | Use Case |
|------------|-------|------------|----------|
| Images | `media_resolution_low` | 280 | Quick classification |
| Images | `media_resolution_medium` | 560 | General analysis |
| Images | `media_resolution_high` | 1120 | Detailed analysis (recommended) |
| PDFs | `media_resolution_medium` | 560 | Document understanding (recommended) |
| PDFs | `media_resolution_high` | 1120 | Rarely improves OCR |
| Video | `media_resolution_low` | 70/frame | Action recognition |
| Video | `media_resolution_medium` | 70/frame | Same as low |
| Video | `media_resolution_high` | 280/frame | Reading text in video |

### Per-Part Resolution

```typescript
const ai = new GoogleGenAI({ apiVersion: "v1alpha" });

const response = await ai.models.generateContent({
  model: "gemini-3-pro-preview",
  contents: [
    {
      parts: [
        { text: "What is in this image?" },
        {
          inlineData: {
            mimeType: "image/jpeg",
            data: base64ImageData,
          },
          mediaResolution: { level: "media_resolution_high" },
        },
      ],
    },
  ],
});
```

## Thought Signatures

Encrypted representations of the model's internal reasoning that maintain context across API calls.

### Validation Rules

| Context | Validation | Behavior |
|---------|------------|----------|
| Function Calling | **Strict** | Missing = 400 error |
| Text/Chat | Not strict | Omitting degrades quality |
| Image Generation | **Strict** | Missing = 400 error |

### Automatic Handling

Official SDKs (Python, Node, Java) handle thought signatures automatically when using standard chat history.

### Manual Handling

**Single Function Call:**
```json
{
  "role": "model",
  "parts": [
    {
      "functionCall": { "name": "get_weather", "args": {...} },
      "thoughtSignature": "<Sig_A>"
    }
  ]
}
```

**Parallel Function Calls:**
Only first `functionCall` has signature. Return parts in exact order received.

**Multi-Step (Sequential):**
Each step generates its own signature. Return ALL accumulated signatures.

**Streaming:**
Signature may arrive in final chunk with empty text. Check all chunks.

### Migration Bypass

When migrating from another model without valid signatures:
```typescript
thoughtSignature: "context_engineering_is_the_way_to_go"
```

## Structured Outputs

### JSON Schema Response

```typescript
const schema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    score: { type: "integer", minimum: 0, maximum: 100 },
    items: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["summary", "score"],
};

const response = await ai.models.generateContent({
  model: "gemini-3-pro-preview",
  contents: "Analyze...",
  config: {
    responseMimeType: "application/json",
    responseJsonSchema: schema,
  },
});
```

### With Built-in Tools

Gemini 3 supports combining structured outputs with Google Search, URL Context, and Code Execution:

```typescript
const response = await ai.models.generateContent({
  model: "gemini-3-pro-preview",
  contents: "Search for latest news about AI",
  config: {
    tools: [{ googleSearch: {} }, { urlContext: {} }],
    responseMimeType: "application/json",
    responseJsonSchema: newsSchema,
  },
});
```

## Image Generation

### Basic Generation

```typescript
const response = await ai.models.generateContent({
  model: "gemini-3-pro-image-preview",
  contents: "Generate a sunset over mountains",
  config: {
    imageConfig: {
      aspectRatio: "16:9",
      imageSize: "4K",
    },
  },
});
```

### Grounded Generation

Use Google Search to verify facts before generating:

```typescript
const response = await ai.models.generateContent({
  model: "gemini-3-pro-image-preview",
  contents: "Generate infographic of current weather in Tokyo",
  config: {
    tools: [{ googleSearch: {} }],
    imageConfig: {
      aspectRatio: "16:9",
      imageSize: "4K",
    },
  },
});
```

### Conversational Editing

Multi-turn editing preserves context via thought signatures:

```typescript
// Turn 1: Generate
const response1 = await ai.models.generateContent({
  model: "gemini-3-pro-image-preview",
  contents: "Generate a cyberpunk city",
});

// Turn 2: Edit (include signatures from turn 1)
const response2 = await ai.models.generateContent({
  model: "gemini-3-pro-image-preview",
  contents: [
    { role: "user", parts: [{ text: "Generate a cyberpunk city" }] },
    response1.candidates[0].content,  // Includes signatures
    { role: "user", parts: [{ text: "Make it daytime" }] },
  ],
});
```

### Aspect Ratios

- `1:1` - Square
- `3:4` - Portrait
- `4:3` - Standard
- `9:16` - Vertical/mobile
- `16:9` - Widescreen

### Image Sizes

- `2K` - Standard resolution
- `4K` - High resolution

## Function Calling

### Declaration

```typescript
const functionDeclaration = {
  name: "get_weather",
  description: "Get current weather for a location",
  parameters: {
    type: "object",
    properties: {
      location: {
        type: "string",
        description: "City name",
      },
      unit: {
        type: "string",
        enum: ["celsius", "fahrenheit"],
        description: "Temperature unit",
      },
    },
    required: ["location"],
  },
};
```

### Handling Responses

```typescript
const response = await ai.models.generateContent({
  model: "gemini-3-flash-preview",
  contents: "What's the weather in Paris?",
  config: {
    tools: [{ functionDeclarations: [functionDeclaration] }],
  },
});

if (response.functionCalls?.length) {
  const call = response.functionCalls[0];

  // Execute function
  const result = await getWeather(call.args.location);

  // Send result back
  const response2 = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: [
      { role: "user", parts: [{ text: "What's the weather in Paris?" }] },
      response.candidates[0].content,
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: call.name,
              response: result,
            },
          },
        ],
      },
    ],
    config: {
      tools: [{ functionDeclarations: [functionDeclaration] }],
    },
  });
}
```

### Multimodal Function Responses

Return images or other media in function responses:

```typescript
const functionResponsePart = {
  functionResponse: {
    name: "get_image",
    response: { image_ref: { $ref: "product.jpg" } },
    parts: [
      {
        inlineData: {
          mimeType: "image/jpeg",
          displayName: "product.jpg",
          data: base64ImageData,
        },
      },
    ],
  },
};
```

## Built-in Tools

### Google Search

```typescript
config: {
  tools: [{ googleSearch: {} }],
}
```

### URL Context

```typescript
config: {
  tools: [{ urlContext: {} }],
}
```

### Code Execution

```typescript
config: {
  tools: [{ codeExecution: {} }],
}
```

### File Search

```typescript
config: {
  tools: [{ fileSearch: {} }],
}
```

**Not supported in Gemini 3:**
- Maps Grounding
- Computer Use
- Combining built-in tools with custom function calling

## REST API

### Basic Request

```bash
curl "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:generateContent" \
  -H "x-goog-api-key: $GEMINI_API_KEY" \
  -H 'Content-Type: application/json' \
  -X POST \
  -d '{
    "contents": [{
      "parts": [{"text": "Hello"}]
    }]
  }'
```

### With Config

```bash
curl "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:generateContent" \
  -H "x-goog-api-key: $GEMINI_API_KEY" \
  -H 'Content-Type: application/json' \
  -X POST \
  -d '{
    "contents": [{
      "parts": [{"text": "Analyze..."}]
    }],
    "generationConfig": {
      "thinkingConfig": {
        "thinkingLevel": "low"
      },
      "responseMimeType": "application/json",
      "responseJsonSchema": {
        "type": "object",
        "properties": {
          "result": {"type": "string"}
        }
      }
    }
  }'
```

## Context Caching

Cache frequently used context for cost savings:

```python
cache = client.caches.create(
    model="gemini-3-pro-preview",
    contents=[large_context],
    ttl="3600s",
)

response = client.models.generate_content(
    model="gemini-3-pro-preview",
    contents="Question about the context",
    config={"cached_content": cache.name},
)
```

## Batch API

For high-volume, non-interactive workloads:

```python
batch = client.batches.create(
    model="gemini-3-pro-preview",
    requests=[...],
)
```

## OpenAI Compatibility

For users using OpenAI compatibility layer:
- `reasoning_effort` (OAI) maps to `thinking_level` (Gemini)
- `reasoning_effort: medium` maps to `thinking_level: high` on Flash

## FAQ

**Q: Knowledge cutoff?**
A: January 2025. Use Google Search for recent information.

**Q: Free tier?**
A: Flash has free tier. Pro requires paid plan (free in AI Studio).

**Q: Will `thinking_budget` still work?**
A: Yes, for backwards compatibility. Migrate to `thinking_level`. Don't use both.

**Q: Batch API supported?**
A: Yes.

**Q: Context caching supported?**
A: Yes.

**Q: Image segmentation?**
A: Not supported in Gemini 3. Use Gemini 2.5 Flash or Robotics-ER 1.5.
