# Migrating to Gemini 3 from Gemini 2.5

## Key Changes

### Thinking Configuration

**Before (2.5):**
```typescript
config: {
  thinkingConfig: {
    thinkingBudget: 2000,  // Token count
  },
}
```

**After (3):**
```typescript
config: {
  thinkingConfig: {
    thinkingLevel: "high",  // "low" | "high" (Pro/Flash)
                            // Flash also: "minimal" | "medium"
  },
}
```

**Important:** Don't use both `thinking_budget` and `thinking_level` in same request (400 error).

### Temperature Settings

**Before:** Often set temperature low (0.1-0.3) for deterministic outputs.

**After:** Keep at default `1.0`. Lower values may cause:
- Looping behavior
- Degraded performance on math/reasoning tasks
- Unexpected outputs

### Prompting Style

**Before:** Complex prompt engineering, chain-of-thought instructions.

**After:** Simple, direct prompts. Gemini 3 may over-analyze verbose prompts.

```typescript
// Bad (2.5 style)
"Let's think step by step. First, consider... Then, analyze..."

// Good (3 style)
"Analyze this code for security vulnerabilities."
```

### PDF/Document Resolution

**Before:** Default resolution optimized for 2.5.

**After:** Default OCR resolution changed. For dense documents:

```typescript
// v1alpha required
const ai = new GoogleGenAI({ apiVersion: "v1alpha" });

const response = await ai.models.generateContent({
  model: "gemini-3-pro-preview",
  contents: [{
    parts: [
      { text: "Extract all text" },
      {
        inlineData: { mimeType: "application/pdf", data: pdfBase64 },
        mediaResolution: { level: "media_resolution_high" },
      },
    ],
  }],
});
```

### Token Consumption

| Media Type | Change in Gemini 3 |
|------------|-------------------|
| PDFs | May increase (higher default resolution) |
| Video | May decrease (more aggressive compression) |

If requests exceed context window, explicitly reduce media resolution.

### Image Segmentation

**Not available** in Gemini 3. For pixel-level masks:
- Continue using Gemini 2.5 Flash (thinking off)
- Or use Gemini Robotics-ER 1.5

### Tool Support Changes

**Not migrating to Gemini 3:**
- Maps Grounding
- Computer Use

**New in Gemini 3:**
- Structured outputs + built-in tools combination
- Multimodal function responses

### Function Calling

**New:** Thought signatures are required for function calling.

If migrating conversation traces from 2.5:
```typescript
thoughtSignature: "context_engineering_is_the_way_to_go"
```

## Migration Checklist

1. [ ] Update model ID to `gemini-3-*-preview`
2. [ ] Replace `thinkingBudget` with `thinkingLevel`
3. [ ] Remove explicit temperature settings (use default 1.0)
4. [ ] Simplify verbose/chain-of-thought prompts
5. [ ] Test PDF processing with new resolution defaults
6. [ ] Check for Maps Grounding / Computer Use usage (not supported)
7. [ ] Update any custom function calling to handle thought signatures
8. [ ] Monitor token usage changes

## Side-by-Side Comparison

### Basic Generation

```typescript
// Gemini 2.5
const response = await ai.models.generateContent({
  model: "gemini-2.5-flash",
  contents: "...",
  config: {
    temperature: 0.1,
    thinkingConfig: { thinkingBudget: 1000 },
  },
});

// Gemini 3
const response = await ai.models.generateContent({
  model: "gemini-3-flash-preview",
  contents: "...",
  config: {
    thinkingConfig: { thinkingLevel: "medium" },
  },
});
```

### Structured Output

```typescript
// Gemini 2.5
const response = await ai.models.generateContent({
  model: "gemini-2.5-pro",
  contents: "...",
  config: {
    responseMimeType: "application/json",
    responseSchema: schema,  // Different property name
  },
});

// Gemini 3
const response = await ai.models.generateContent({
  model: "gemini-3-pro-preview",
  contents: "...",
  config: {
    responseMimeType: "application/json",
    responseJsonSchema: schema,  // Updated property name
  },
});
```

## Performance Expectations

| Aspect | Gemini 2.5 | Gemini 3 |
|--------|------------|----------|
| Complex reasoning | Good | Excellent |
| Simple tasks | Fast | Similar |
| Code generation | Good | Excellent |
| Multimodal | Good | Improved |
| Latency (high thinking) | Medium | Higher |
| Latency (low thinking) | Fast | Similar |
