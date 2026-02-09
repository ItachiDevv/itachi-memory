---
name: google-gemini
description: Google Gemini AI API integration for TypeScript/JavaScript and Python. Use when building with Gemini models (gemini-3-pro-preview, gemini-3-flash-preview, gemini-3-pro-image-preview), implementing structured JSON outputs, function calling, multimodal content (images/video/PDF), thinking modes, streaming responses, or migrating from other LLM APIs.
---

# Google Gemini API

## Quick Start

```typescript
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const response = await ai.models.generateContent({
  model: "gemini-3-pro-preview",
  contents: "Your prompt here",
});

console.log(response.text);
```

```python
from google import genai

client = genai.Client()  # Uses GEMINI_API_KEY env var

response = client.models.generate_content(
    model="gemini-3-pro-preview",
    contents="Your prompt here",
)

print(response.text)
```

## Models

| Model ID | Best For | Context | Pricing (per 1M tokens) |
|----------|----------|---------|------------------------|
| `gemini-3-pro-preview` | Complex reasoning, agentic workflows | 1M in / 64k out | $2-4 in / $12-18 out |
| `gemini-3-flash-preview` | Pro-level intelligence, faster/cheaper | 1M in / 64k out | $0.50 in / $3 out |
| `gemini-3-pro-image-preview` | Image generation/editing | 65k in / 32k out | $2 text / $0.134 img |

## Structured JSON Output

Force valid JSON responses with schema validation.

```typescript
const schema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    score: { type: "integer", minimum: 0, maximum: 100 },
    tags: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "score"],
};

const response = await ai.models.generateContent({
  model: "gemini-3-pro-preview",
  contents: "Analyze this code...",
  config: {
    responseMimeType: "application/json",
    responseJsonSchema: schema,
  },
});

const result = JSON.parse(response.text);
```

**With Zod (recommended):**

```typescript
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

const AnalysisSchema = z.object({
  summary: z.string(),
  score: z.number().int().min(0).max(100),
  tags: z.array(z.string()),
});

const response = await ai.models.generateContent({
  model: "gemini-3-pro-preview",
  contents: "Analyze...",
  config: {
    responseMimeType: "application/json",
    responseJsonSchema: zodToJsonSchema(AnalysisSchema),
  },
});

const result = AnalysisSchema.parse(JSON.parse(response.text));
```

## Thinking Levels

Control reasoning depth for latency/quality tradeoff.

```typescript
const response = await ai.models.generateContent({
  model: "gemini-3-pro-preview",
  contents: "Complex reasoning task...",
  config: {
    thinkingConfig: {
      thinkingLevel: "high",  // "low" | "high" (Pro/Flash)
                              // Flash also: "minimal" | "medium"
    },
  },
});
```

| Level | Use Case |
|-------|----------|
| `low` | Simple tasks, chat, high throughput |
| `medium` | Balanced (Flash only) |
| `high` | Complex reasoning, default |
| `minimal` | Matches "no thinking" (Flash only) |

**Important:** Keep temperature at default `1.0` for Gemini 3. Lower values can cause loops.

## Multimodal Content

### Images

```typescript
import * as fs from "node:fs";

const imageData = fs.readFileSync("image.jpg").toString("base64");

const response = await ai.models.generateContent({
  model: "gemini-3-pro-preview",
  contents: [
    {
      parts: [
        { text: "What is in this image?" },
        {
          inlineData: {
            mimeType: "image/jpeg",
            data: imageData,
          },
        },
      ],
    },
  ],
});
```

### Media Resolution Control

```typescript
// Use v1alpha for media_resolution
const ai = new GoogleGenAI({ apiVersion: "v1alpha" });

const response = await ai.models.generateContent({
  model: "gemini-3-pro-preview",
  contents: [
    {
      parts: [
        { text: "Extract text from this document" },
        {
          inlineData: { mimeType: "application/pdf", data: pdfBase64 },
          mediaResolution: { level: "media_resolution_medium" },
        },
      ],
    },
  ],
});
```

| Media Type | Recommended | Max Tokens |
|------------|-------------|------------|
| Images | `media_resolution_high` | 1120 |
| PDFs | `media_resolution_medium` | 560 |
| Video | `media_resolution_low` | 70/frame |
| Video (OCR) | `media_resolution_high` | 280/frame |

## Function Calling

```typescript
const getWeatherDeclaration = {
  name: "get_weather",
  description: "Get current weather for a location",
  parameters: {
    type: "object",
    properties: {
      location: { type: "string", description: "City name" },
    },
    required: ["location"],
  },
};

const response = await ai.models.generateContent({
  model: "gemini-3-flash-preview",
  contents: "What's the weather in Tokyo?",
  config: {
    tools: [{ functionDeclarations: [getWeatherDeclaration] }],
  },
});

// Handle function call
if (response.functionCalls?.length) {
  const call = response.functionCalls[0];
  // Execute your function, then send result back
}
```

## Thought Signatures

Gemini 3 uses encrypted thought signatures to maintain reasoning across API calls. **SDKs handle this automatically** when using standard chat history.

**Manual handling (if needed):**

```typescript
// Save signature from response
const signature = response.candidates[0].content.parts[0].thoughtSignature;

// Include in next request
const history = [
  { role: "user", parts: [{ text: "First question" }] },
  {
    role: "model",
    parts: [{ text: "Answer...", thoughtSignature: signature }],
  },
  { role: "user", parts: [{ text: "Follow-up" }] },
];
```

**Migration bypass:** If migrating from another model without valid signatures:
```typescript
thoughtSignature: "context_engineering_is_the_way_to_go"
```

## Built-in Tools

```typescript
const response = await ai.models.generateContent({
  model: "gemini-3-pro-preview",
  contents: "Find latest news about AI",
  config: {
    tools: [
      { googleSearch: {} },     // Web search
      { urlContext: {} },       // URL content
      { codeExecution: {} },    // Run Python code
    ],
    responseMimeType: "application/json",
    responseJsonSchema: mySchema,  // Works with tools!
  },
});
```

**Supported tools:** Google Search, URL Context, Code Execution, File Search
**Not supported in Gemini 3:** Maps Grounding, Computer Use

## Image Generation

```typescript
const response = await ai.models.generateContent({
  model: "gemini-3-pro-image-preview",
  contents: "Generate a cyberpunk city at sunset",
  config: {
    tools: [{ googleSearch: {} }],  // Optional: ground in real data
    imageConfig: {
      aspectRatio: "16:9",  // "1:1" | "3:4" | "4:3" | "9:16" | "16:9"
      imageSize: "4K",      // "2K" | "4K"
    },
  },
});

// Extract image
for (const part of response.candidates[0].content.parts) {
  if (part.inlineData) {
    const buffer = Buffer.from(part.inlineData.data, "base64");
    fs.writeFileSync("output.png", buffer);
  }
}
```

## Streaming

```typescript
const stream = await ai.models.generateContentStream({
  model: "gemini-3-flash-preview",
  contents: "Write a story...",
});

for await (const chunk of stream) {
  process.stdout.write(chunk.text || "");
}
```

## Error Handling

```typescript
try {
  const response = await ai.models.generateContent({ ... });
} catch (error) {
  if (error.status === 429) {
    // Rate limited - implement backoff
  } else if (error.status === 400) {
    // Bad request - check parameters
    // Common: mixing thinking_level and thinking_budget
  }
}
```

## Best Practices

1. **Prompting:** Be concise and direct. Gemini 3 may over-analyze verbose prompts.

2. **Context:** Place instructions at the end after data. Start with "Based on the information above..."

3. **Verbosity:** Gemini 3 prefers direct answers. Add "Explain thoroughly" if needed.

4. **Temperature:** Keep at `1.0` (default). Don't lower for deterministic output.

5. **Structured output:** Always use `responseMimeType` + `responseJsonSchema` for JSON.

6. **Caching:** Context caching is supported for repeated prompts.

7. **Batch API:** Supported for high-volume processing.

## Common Patterns

### Repository Analysis (from project)

```typescript
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const response = await ai.models.generateContent({
  model: "gemini-3-pro-preview",
  contents: buildAnalysisPrompt(repoData),
  config: {
    responseMimeType: "application/json",
    responseJsonSchema: ANALYSIS_SCHEMA,
  },
});

const analysis = JSON.parse(response.text);
```

### Social Alignment (Flash for cost efficiency)

```typescript
const response = await ai.models.generateContent({
  model: "gemini-3-flash-preview",
  contents: systemPrompt + "\n\n" + userPrompt,
  config: {
    responseMimeType: "application/json",
    responseJsonSchema: ALIGNMENT_SCHEMA,
    // Default high thinking is appropriate for comparison tasks
  },
});
```

## Resources

- See `references/gemini3-full-docs.md` for complete API documentation
- See `references/migration-guide.md` for Gemini 2.5 to 3 migration
