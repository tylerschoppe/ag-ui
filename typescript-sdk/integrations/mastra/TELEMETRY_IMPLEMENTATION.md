# Mastra Telemetry Metadata Implementation

This document outlines the implementation for adding telemetry metadata support to the AG-UI Mastra integration.

## Overview

The goal is to allow users to pass telemetry metadata to Mastra agents for tracking user interactions, without breaking the existing ease-of-use that the AG-UI integration provides.

This implementation leverages existing Mastra integration patterns:
- **RuntimeContext** is already a core part of the Mastra integration
- **setContext** pattern is already used in registerCopilotKit
- **Mastra-specific handling** already exists for memory, agent types, etc.
- **Native Mastra telemetry API** is the target for this integration

## Implementation Approach

We're using **Option A: Auto-extract from RuntimeContext** which:
- Automatically extracts telemetry metadata from RuntimeContext
- Allows override via forwardedProps when needed
- Maintains backward compatibility
- Requires minimal code changes

## Code Changes

### 1. Add Telemetry Type Definitions

Add to the top of `src/mastra.ts`:

```typescript
export interface MastraTelemetryConfig {
  metadata?: Record<string, any>;
  isEnabled?: boolean;
}

export interface MastraForwardedProps {
  telemetry?: MastraTelemetryConfig;
  [key: string]: any; // Allow other Mastra options
}
```

### 2. Update streamMastraAgent Method

Replace the existing `streamMastraAgent` method in `src/mastra.ts`:

```typescript
/**
 * Streams in process or remote mastra agent.
 * @param input - The input for the mastra agent.
 * @param options - The options for the mastra agent.
 * @returns The stream of the mastra agent.
 */
private async streamMastraAgent(
  { threadId, runId, messages, tools, forwardedProps }: RunAgentInput,
  {
    onTextPart,
    onFinishMessagePart,
    onToolCallPart,
    onToolResultPart,
    onError,
    onRunFinished,
  }: MastraAgentStreamOptions,
): Promise<void> {
  const clientTools = tools.reduce(
    (acc, tool) => {
      acc[tool.name as string] = {
        id: tool.name,
        description: tool.description,
        inputSchema: tool.parameters,
      };
      return acc;
    },
    {} as Record<string, any>,
  );
  
  const resourceId = this.resourceId ?? threadId;
  const convertedMessages = convertAGUIMessagesToMastra(messages);
  const runtimeContext = this.runtimeContext;

  // Extract telemetry from forwardedProps OR auto-extract from RuntimeContext
  let telemetryConfig: MastraTelemetryConfig | undefined = 
    (forwardedProps as MastraForwardedProps)?.telemetry;
  
  if (!telemetryConfig && this.runtimeContext) {
    // Check for telemetry metadata in RuntimeContext
    const telemetryMetadata = this.runtimeContext.get("telemetry-metadata");
    const userId = this.runtimeContext.get("user-id");
    const sessionId = this.runtimeContext.get("session-id");
    
    if (telemetryMetadata || userId || sessionId) {
      const autoMetadata: Record<string, any> = {};
      
      // Use explicit telemetry-metadata if available
      if (telemetryMetadata) {
        Object.assign(autoMetadata, telemetryMetadata);
      }
      
      // Add common fields from context if not already in telemetry-metadata
      if (userId && !autoMetadata.userId) {
        autoMetadata.userId = userId;
      }
      if (sessionId && !autoMetadata.sessionId) {
        autoMetadata.sessionId = sessionId;
      }
      
      if (Object.keys(autoMetadata).length > 0) {
        telemetryConfig = {
          metadata: autoMetadata,
          isEnabled: true
        };
      }
    }
  }

  if (this.isLocalMastraAgent(this.agent)) {
    // Local agent - use the agent's stream method directly
    try {
      const response = await this.agent.stream(convertedMessages, {
        threadId,
        resourceId,
        runId,
        clientTools,
        runtimeContext,
        // Include telemetry if we have it
        ...(telemetryConfig && { telemetry: telemetryConfig }),
        // Pass through any other forwardedProps as-is
        ...(forwardedProps && Object.fromEntries(
          Object.entries(forwardedProps).filter(([key]) => key !== 'telemetry')
        )),
      });

      // For local agents, the response should already be a stream
      // Process it using the agent's built-in streaming mechanism
      if (response && typeof response === "object") {
        // If the response has a toDataStreamResponse method, use it
        if (
          "toDataStreamResponse" in response &&
          typeof response.toDataStreamResponse === "function"
        ) {
          const dataStreamResponse = response.toDataStreamResponse();
          if (dataStreamResponse && dataStreamResponse.body) {
            await processDataStream({
              stream: dataStreamResponse.body,
              onTextPart,
              onToolCallPart,
              onToolResultPart,
              onFinishMessagePart,
            });
            await onRunFinished?.();
          } else {
            throw new Error("Invalid data stream response from local agent");
          }
        } else {
          // If it's already a readable stream, process it directly
          await processDataStream({
            stream: response as any,
            onTextPart,
            onToolCallPart,
            onToolResultPart,
            onFinishMessagePart,
          });
          await onRunFinished?.();
        }
      } else {
        throw new Error("Invalid response from local agent");
      }
    } catch (error) {
      onError?.(error as Error);
    }
  } else {
    // Remote agent - use the remote agent's stream method
    try {
      const response = await this.agent.stream({
        threadId,
        resourceId,
        runId,
        messages: convertedMessages,
        clientTools,
        // Include telemetry if we have it
        ...(telemetryConfig && { telemetry: telemetryConfig }),
        // Pass through any other forwardedProps as-is
        ...(forwardedProps && Object.fromEntries(
          Object.entries(forwardedProps).filter(([key]) => key !== 'telemetry')
        )),
      });

      // Remote agents should have a processDataStream method
      if (response && typeof response.processDataStream === "function") {
        await response.processDataStream({
          onTextPart,
          onToolCallPart,
          onToolResultPart,
          onFinishMessagePart,
        });
        await onRunFinished?.();
      } else {
        throw new Error("Invalid response from remote agent");
      }
    } catch (error) {
      onError?.(error as Error);
    }
  }
}
```

### 3. Add Telemetry Helper Functions

Add to `src/utils.ts`:

```typescript
export function setTelemetryMetadata(
  runtimeContext: RuntimeContext,
  metadata: Record<string, any>
): void {
  runtimeContext.set("telemetry-metadata", metadata);
}

export function addTelemetryField(
  runtimeContext: RuntimeContext,
  key: string,
  value: any
): void {
  const existingMetadata = runtimeContext.get("telemetry-metadata") || {};
  runtimeContext.set("telemetry-metadata", {
    ...existingMetadata,
    [key]: value
  });
}

export function getTelemetryMetadata(
  runtimeContext: RuntimeContext
): Record<string, any> | undefined {
  return runtimeContext.get("telemetry-metadata");
}
```

### 4. Update Exports

Add the new exports to `src/index.ts`:

```typescript
export * from "./mastra";
export * from "./utils";
export type { MastraTelemetryConfig, MastraForwardedProps } from "./mastra";
```

## Usage Examples

### CopilotKit with Automatic Telemetry

```typescript
import { Mastra } from "@mastra/core/mastra";
import { registerCopilotKit, setTelemetryMetadata } from "@ag-ui/mastra";
import { weatherAgent } from "./agents/weather-agent";

export const mastra = new Mastra({
  agents: { weatherAgent },
  server: {
    apiRoutes: [
      registerCopilotKit({
        path: "/copilotkit",
        resourceId: "weatherAgent",
        setContext: (c, runtimeContext) => {
          const userId = c.req.header("X-User-ID") || "anonymous";
          const sessionId = c.req.header("X-Session-ID") || "unknown";
          
          runtimeContext.set("user-id", userId);
          runtimeContext.set("session-id", sessionId);
          
          // Set telemetry - this gets auto-injected into Mastra calls!
          setTelemetryMetadata(runtimeContext, {
            userId,
            sessionId,
            endpoint: c.req.url,
            timestamp: new Date().toISOString()
          });
        }
      })
    ]
  }
});
```

### Direct Agent Usage

```typescript
import { MastraAgent, setTelemetryMetadata } from "@ag-ui/mastra";
import { RuntimeContext } from "@mastra/core/runtime-context";

const runtimeContext = new RuntimeContext();
setTelemetryMetadata(runtimeContext, {
  userId: "user-12345",
  feature: "weather-query"
});

const agent = new MastraAgent({
  agentId: "weather",
  agent: weatherAgent,
  runtimeContext
});

// Telemetry automatically included from RuntimeContext!
await agent.run({
  threadId: "thread-123",
  runId: "run-456",
  messages: [{ role: "user", content: "What's the weather?" }],
  tools: [],
  context: [],
  state: {}
});
```

### Override with forwardedProps

```typescript
// Override RuntimeContext telemetry with specific telemetry
await agent.run({
  threadId: "thread-123",
  runId: "run-456",
  messages: [{ role: "user", content: "What's the weather?" }],
  tools: [],
  context: [],
  state: {},
  forwardedProps: {
    telemetry: {
      metadata: {
        userId: "different-user",
        priority: "high"
      }
    },
    // Other Mastra options still work via forwardedProps
    temperature: 0.9
  } as MastraForwardedProps
});
```

## How It Works

1. **RuntimeContext Priority**: The implementation first checks `forwardedProps.telemetry`
2. **Auto-extraction**: If no telemetry in forwardedProps, it looks for:
   - `telemetry-metadata` key in RuntimeContext
   - Common fields like `user-id` and `session-id`
3. **Mastra Integration**: The telemetry config gets passed to Mastra's native telemetry system
4. **Pass-through**: Other forwardedProps options continue to work normally

## What Mastra Receives

```typescript
// Mastra gets called with:
await weatherAgent.generate(
  'What is the weather in Tokyo?',
  {
    telemetry: {
      metadata: {
        userId: 'user-12345',
        sessionId: 'session-abc',
        endpoint: '/copilotkit', 
        timestamp: '2024-01-15T10:30:00.000Z'
      }
    }
  }
);
```

## Benefits

- **Automatic**: Telemetry flows from RuntimeContext seamlessly  
- **Override-able**: forwardedProps telemetry takes precedence
- **Pass-through**: Other forwardedProps options still work normally
- **Clean**: Simple, focused implementation
- **Backward Compatible**: No breaking changes
- **Follows Mastra Patterns**: Leverages existing RuntimeContext and setContext patterns
- **Type Safe**: Proper TypeScript definitions for better developer experience

## Testing

After implementation, test with:

```bash
cd integrations/mastra
pnpm test
```

Make sure to add tests for:
- Telemetry extraction from RuntimeContext
- forwardedProps telemetry override behavior
- Pass-through of other forwardedProps options