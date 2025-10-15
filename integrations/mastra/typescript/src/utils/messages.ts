import type { Message } from "@ag-ui/client";
import type { CoreMessage } from "@mastra/core";

export interface AGUIMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  toolCalls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
  toolCallId?: string;
}

export interface MastraMemoryMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string | string[] | Array<{ type: string; text?: string; [key: string]: any }>;
  createdAt: Date;
  metadata?: Record<string, any>;
}

export function mastraMsgToAGUI(mastraMessage: MastraMemoryMessage): AGUIMessage {
  const { id, role, content, metadata } = mastraMessage;

  let textContent = "";
  let toolCalls: AGUIMessage["toolCalls"] = undefined;
  let toolCallId: string | undefined = undefined;

  if (typeof content === "string") {
    textContent = content;
  } else if (Array.isArray(content)) {
    const textParts: string[] = [];

    for (const part of content) {
      if (typeof part === "string") {
        textParts.push(part);
      } else if (part && typeof part === "object") {
        if (part.type === "text" && part.text) {
          textParts.push(part.text);
        } else if (part.type === "tool-call") {
          if (!toolCalls) toolCalls = [];
          toolCalls.push({
            id: part.toolCallId || part.id || `tool-${Date.now()}`,
            type: "function",
            function: {
              name: part.toolName || part.name || "unknown",
              arguments: JSON.stringify(part.args || part.arguments || {}),
            },
          });
        } else if (part.type === "tool-result") {
          toolCallId = part.toolCallId || part.id;
          textContent = typeof part.result === "string"
            ? part.result
            : JSON.stringify(part.result);
        }
      }
    }

    textContent = textParts.join("");
  } else if (content && typeof content === "object") {
    textContent = JSON.stringify(content);
  }

  const aguiMessage: AGUIMessage = {
    id,
    role,
    content: textContent,
  };

  if (toolCalls && toolCalls.length > 0) {
    aguiMessage.toolCalls = toolCalls;
  }

  if (toolCallId) {
    aguiMessage.toolCallId = toolCallId;
  }

  return aguiMessage;
}

export function mastraMsgsToAGUI(mastraMessages: MastraMemoryMessage[]): AGUIMessage[] {
  const aguiMessages: AGUIMessage[] = [];

  for (const mastraMsg of mastraMessages) {
    try {
      aguiMessages.push(mastraMsgToAGUI(mastraMsg));
    } catch (error) {
      console.error(`Failed to convert message ${mastraMsg.id}:`, error);
    }
  }

  return aguiMessages;
}
