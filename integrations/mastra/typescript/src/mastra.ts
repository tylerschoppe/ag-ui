import type {
  AgentConfig,
  BaseEvent,
  Message,
  MessagesSnapshotEvent,
  RunAgentInput,
  RunFinishedEvent,
  RunStartedEvent,
  StateSnapshotEvent,
  TextMessageChunkEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  ToolCallStartEvent,
} from "@ag-ui/client";
import { AbstractAgent, EventType } from "@ag-ui/client";
import type { StorageThreadType } from "@mastra/core";
import { Agent as LocalMastraAgent } from "@mastra/core/agent";
import { RuntimeContext } from "@mastra/core/runtime-context";
import { randomUUID } from "@ag-ui/client";
import { Observable } from "rxjs";
import { MastraClient } from "@mastra/client-js";
type RemoteMastraAgent = ReturnType<MastraClient["getAgent"]>;
import {
  convertAGUIMessagesToMastra,
  GetLocalAgentsOptions,
  getLocalAgents,
  getRemoteAgents,
  GetRemoteAgentsOptions,
  GetLocalAgentOptions,
  getLocalAgent,
  GetNetworkOptions,
  getNetwork,
} from "./utils";
import { loadAgentState } from "./server/loadAgentState.js";

export interface MastraAgentConfig extends AgentConfig {
  agent: LocalMastraAgent | RemoteMastraAgent;
  resourceId?: string;
  runtimeContext?: RuntimeContext;
}

interface MastraAgentStreamOptions {
  onTextPart?: (text: string) => void;
  onFinishMessagePart?: () => void;
  onToolCallPart?: (streamPart: { toolCallId: string; toolName: string; args: any }) => void;
  onToolResultPart?: (streamPart: { toolCallId: string; result: any }) => void;
  onError?: (error: Error) => void;
  onRunFinished?: () => Promise<void>;
}

export class MastraAgent extends AbstractAgent {
  agent: LocalMastraAgent | RemoteMastraAgent;
  resourceId?: string;
  runtimeContext?: RuntimeContext;

  constructor({ agent, resourceId, runtimeContext, ...rest }: MastraAgentConfig) {
    super(rest);
    this.agent = agent;
    this.resourceId = resourceId;
    this.runtimeContext = runtimeContext ?? new RuntimeContext();
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    let messageId = randomUUID();

    return new Observable<BaseEvent>((subscriber) => {
      const run = async () => {
        const runStartedEvent: RunStartedEvent = {
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        };

        subscriber.next(runStartedEvent);

        if (input.threadId && this.isLocalMastraAgent(this.agent)) {
          try {
            const stateSnapshot = await loadAgentState(
              {
                agentId: this.agentId!,
                resourceId: this.resourceId,
                threadId: input.threadId,
                limit: 100,
              },
              this.agent
            );

            if (stateSnapshot.threadsExist && stateSnapshot.messages.length > 0) {
              const messagesSnapshotEvent: MessagesSnapshotEvent = {
                type: EventType.MESSAGES_SNAPSHOT,
                messages: stateSnapshot.messages as Message[],
              };
              subscriber.next(messagesSnapshotEvent);

              console.info(
                `[MastraAgent] Loaded ${stateSnapshot.messages.length} historical messages for thread ${input.threadId}`
              );
            }
          } catch (error) {
            console.error(
              `[MastraAgent] Failed to load thread history for ${input.threadId}:`,
              error
            );
          }
        }

        // Handle local agent memory management (from Mastra implementation)
        if (this.isLocalMastraAgent(this.agent)) {
          const memory = await this.agent.getMemory();

          if (memory && input.state && Object.keys(input.state || {}).length > 0) {
            let thread: StorageThreadType | null = await memory.getThreadById({
              threadId: input.threadId,
            });

            if (!thread) {
              thread = {
                id: input.threadId,
                title: "",
                metadata: {},
                resourceId: this.resourceId ?? input.threadId,
                createdAt: new Date(),
                updatedAt: new Date(),
              };
            }

            const existingMemory = JSON.parse((thread.metadata?.workingMemory as string) ?? "{}");
            const { messages, ...rest } = input.state;
            const workingMemory = JSON.stringify({ ...existingMemory, ...rest });

            // Update thread metadata with new working memory
            await memory.saveThread({
              thread: {
                ...thread,
                metadata: {
                  ...thread.metadata,
                  workingMemory,
                },
              },
            });
          }
        }

        try {
          await this.streamMastraAgent(input, {
            onTextPart: (text) => {
              const event: TextMessageChunkEvent = {
                type: EventType.TEXT_MESSAGE_CHUNK,
                role: "assistant",
                messageId,
                delta: text,
              };
              subscriber.next(event);
            },
            onToolCallPart: (streamPart) => {
              const startEvent: ToolCallStartEvent = {
                type: EventType.TOOL_CALL_START,
                parentMessageId: messageId,
                toolCallId: streamPart.toolCallId,
                toolCallName: streamPart.toolName,
              };
              subscriber.next(startEvent);

              const argsEvent: ToolCallArgsEvent = {
                type: EventType.TOOL_CALL_ARGS,
                toolCallId: streamPart.toolCallId,
                delta: JSON.stringify(streamPart.args),
              };
              subscriber.next(argsEvent);

              const endEvent: ToolCallEndEvent = {
                type: EventType.TOOL_CALL_END,
                toolCallId: streamPart.toolCallId,
              };
              subscriber.next(endEvent);
            },
            onToolResultPart(streamPart) {
              const toolCallResultEvent: ToolCallResultEvent = {
                type: EventType.TOOL_CALL_RESULT,
                toolCallId: streamPart.toolCallId,
                content: JSON.stringify(streamPart.result),
                messageId: randomUUID(),
                role: "tool",
              };

              subscriber.next(toolCallResultEvent);
            },
            onFinishMessagePart: async () => {
              messageId = randomUUID();
            },
            onError: (error) => {
              console.error("error", error);
              // Handle error
              subscriber.error(error);
            },
            onRunFinished: async () => {
              if (this.isLocalMastraAgent(this.agent)) {
                try {
                  const memory = await this.agent.getMemory();
                  if (memory) {
                    const workingMemory = await memory.getWorkingMemory({
                      threadId: input.threadId,
                      memoryConfig: {
                        workingMemory: {
                          enabled: true,
                        },
                      },
                    });

                    if (typeof workingMemory === "string") {
                      const snapshot = JSON.parse(workingMemory);

                      if (snapshot && !("$schema" in snapshot)) {
                        const stateSnapshotEvent: StateSnapshotEvent = {
                          type: EventType.STATE_SNAPSHOT,
                          snapshot,
                        };

                        subscriber.next(stateSnapshotEvent);
                      }
                    }
                  }
                } catch (error) {
                  console.error("Error sending state snapshot", error);
                }
              }

              // Emit run finished event
              subscriber.next({
                type: EventType.RUN_FINISHED,
                threadId: input.threadId,
                runId: input.runId,
              } as RunFinishedEvent);

              // Complete the observable
              subscriber.complete();
            },
          });
        } catch (error) {
          console.error("Stream error:", error);
          subscriber.error(error);
        }
      };

      run();

      return () => {};
    });
  }

  isLocalMastraAgent(agent: LocalMastraAgent | RemoteMastraAgent): agent is LocalMastraAgent {
    return "getMemory" in agent;
  }

  private async getNewMessages({
    threadId,
    messages,
  }: {
    threadId?: string;
    messages: Message[];
  }): Promise<Message[]> {
    if (!threadId) {
      return messages;
    }

    if (!this.isLocalMastraAgent(this.agent)) {
      return messages;
    }

    try {
      const memory = await this.agent.getMemory();
      if (!memory) {
        return messages;
      }

      let thread;
      try {
        thread = await memory.getThreadById({ threadId });
      } catch (error) {
        return messages;
      }

      if (!thread) {
        return messages;
      }

      const existingMessages = await (thread as any).getMessages({ limit: 1000 });
      const existingIds = new Set(existingMessages.map((m: any) => m.id));

      const newMessages = messages.filter((msg) => !existingIds.has(msg.id));

      console.info(
        `[MastraAgent] Filtered ${messages.length} input messages to ${newMessages.length} new messages for thread ${threadId}`
      );

      return newMessages;
    } catch (error) {
      console.error(`[MastraAgent] Failed to filter messages, sending all:`, error);
      return messages;
    }
  }

  /**
   * Streams in process or remote mastra agent.
   * @param input - The input for the mastra agent.
   * @param options - The options for the mastra agent.
   * @returns The stream of the mastra agent.
   */
  private async streamMastraAgent(
    { threadId, runId, messages, tools, context: inputContext }: RunAgentInput,
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

    const messagesToSend = await this.getNewMessages({ threadId, messages });
    const convertedMessages = convertAGUIMessagesToMastra(messagesToSend);
    this.runtimeContext?.set("ag-ui", { context: inputContext });
    const runtimeContext = this.runtimeContext;

    if (this.isLocalMastraAgent(this.agent)) {
      // Local agent - use the agent's stream method directly
      try {
        const response = await this.agent.stream(convertedMessages, {
          threadId,
          resourceId,
          runId,
          clientTools,
          runtimeContext,
        });

        // For local agents, the response should already be a stream
        // Process it using the agent's built-in streaming mechanism
        if (response && typeof response === "object") {
          for await (const chunk of response.fullStream) {
            switch (chunk.type) {
              case "text-delta": {
                onTextPart?.(chunk.payload.text);
                break;
              }
              case "tool-call": {
                onToolCallPart?.({
                  toolCallId: chunk.payload.toolCallId,
                  toolName: chunk.payload.toolName,
                  args: chunk.payload.args,
                });
                break;
              }
              case "tool-result": {
                onToolResultPart?.({
                  toolCallId: chunk.payload.toolCallId,
                  result: chunk.payload.result,
                });
                break;
              }

              case "error": {
                onError?.(new Error(chunk.payload.error as string));
                break;
              }

              case "finish": {
                onFinishMessagePart?.();
                break;
              }
            }
          }

          await onRunFinished?.();
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
        });

        // Remote agents should have a processDataStream method
        if (response && typeof response.processDataStream === "function") {
          await response.processDataStream({
            onChunk: async (chunk) => {
              switch (chunk.type) {
                case "text-delta": {
                  onTextPart?.(chunk.payload.text);
                  break;
                }
                case "tool-call": {
                  onToolCallPart?.({
                    toolCallId: chunk.payload.toolCallId,
                    toolName: chunk.payload.toolName,
                    args: chunk.payload.args,
                  });
                  break;
                }
                case "tool-result": {
                  onToolResultPart?.({
                    toolCallId: chunk.payload.toolCallId,
                    result: chunk.payload.result,
                  });
                  break;
                }

                case "finish": {
                  onFinishMessagePart?.();
                  break;
                }
              }
            },
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

  static async getRemoteAgents(
    options: GetRemoteAgentsOptions,
  ): Promise<Record<string, AbstractAgent>> {
    return getRemoteAgents(options);
  }

  static getLocalAgents(options: GetLocalAgentsOptions): Record<string, AbstractAgent> {
    return getLocalAgents(options);
  }

  static getLocalAgent(options: GetLocalAgentOptions) {
    return getLocalAgent(options);
  }

  static getNetwork(options: GetNetworkOptions) {
    return getNetwork(options);
  }
}
