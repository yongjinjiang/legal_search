export class LlmServiceError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export type LlmMessage = { role: "system" | "user"; content: string };
export type CompletionOptions = { maxOutputTokens: number; timeoutMs: number; outputFormat?: "json" };

/** The only surface the guide and the research summary depend on. Provider choice is a server
 *  configuration detail; no model name is referenced from UI or retrieval code. */
export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  complete(messages: LlmMessage[], options: CompletionOptions): Promise<string>;
}
