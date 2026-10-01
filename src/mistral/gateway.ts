import { Mistral } from '@mistralai/mistralai';
import type { MistralUsage } from '../spend.ts';

export type WebReference = { url: string; title: string };

export type JsonSchemaSpec = { name: string; schema: Record<string, unknown> };

export type SearchResult = {
  /** The model's answer, text chunks joined. */
  text: string;
  /** Pages the web search tool returned, with a URL. */
  references: WebReference[];
  /** Tool executions seen in the response. */
  toolCalls: number;
  usage: MistralUsage;
};

export type JsonResult = { text: string; usage: MistralUsage };

/** The two kinds of Mistral calls the generator makes. Faked in tests. */
export type MistralGateway = {
  searchAndAnswer(options: {
    model: string;
    tool: 'web_search' | 'web_search_premium';
    instructions: string;
    input: string;
    jsonSchema?: JsonSchemaSpec;
  }): Promise<SearchResult>;
  completeJson(options: {
    model: string;
    system: string;
    user: string;
    jsonSchema: JsonSchemaSpec;
  }): Promise<JsonResult>;
};

type Chunk = { type?: string; text?: string; url?: string | null; title?: string };
type Entry = { type?: string; content?: string | Chunk[] };
type ConversationLike = {
  outputs: Entry[];
  usage: {
    promptTokens?: number;
    completionTokens?: number;
    connectorTokens?: number | null;
    connectors?: Record<string, number> | null;
  };
};

/**
 * Pulls the answer text, the web references and the usage out of a Conversations API response.
 * Kept separate from the SDK call so it can be tested on recorded responses.
 */
export function readConversation(response: ConversationLike, model: string): SearchResult {
  let text = '';
  const references: WebReference[] = [];
  let toolCalls = 0;
  for (const entry of response.outputs) {
    if (entry.type === 'tool.execution') toolCalls++;
    if (entry.type !== 'message.output' || entry.content === undefined) continue;
    if (typeof entry.content === 'string') {
      text += entry.content;
      continue;
    }
    for (const chunk of entry.content) {
      if (chunk.type === 'text' && chunk.text) text += chunk.text;
      if (chunk.type === 'tool_reference' && chunk.url) {
        references.push({ url: chunk.url, title: chunk.title ?? chunk.url });
      }
    }
  }
  const connectors = response.usage.connectors ?? {};
  const webSearchCalls = Object.entries(connectors)
    .filter(([name]) => name.startsWith('web_search'))
    .reduce((sum, [, count]) => sum + count, 0);
  return {
    text,
    references,
    toolCalls,
    usage: {
      model,
      promptTokens: response.usage.promptTokens ?? 0,
      completionTokens: response.usage.completionTokens ?? 0,
      connectorTokens: response.usage.connectorTokens ?? 0,
      webSearchCalls,
    },
  };
}

function responseFormat(spec: JsonSchemaSpec) {
  return {
    type: 'json_schema' as const,
    jsonSchema: { name: spec.name, schemaDefinition: spec.schema, strict: true },
  };
}

export function createMistralGateway(apiKey: string): MistralGateway {
  const client = new Mistral({ apiKey });
  return {
    async searchAndAnswer({ model, tool, instructions, input, jsonSchema }) {
      const response = await client.beta.conversations.start({
        model,
        inputs: input,
        instructions,
        tools: [{ type: tool }],
        store: false,
        completionArgs: {
          temperature: 0.4,
          ...(jsonSchema ? { responseFormat: responseFormat(jsonSchema) } : {}),
        },
      });
      return readConversation(response as unknown as ConversationLike, model);
    },

    async completeJson({ model, system, user, jsonSchema }) {
      const response = await client.chat.complete({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        responseFormat: responseFormat(jsonSchema),
        temperature: 0.2,
      });
      const content = response.choices[0]?.message?.content;
      const text =
        typeof content === 'string'
          ? content
          : (content ?? []).map((chunk) => ('text' in chunk ? chunk.text : '')).join('');
      return {
        text,
        usage: {
          model,
          promptTokens: response.usage.promptTokens ?? 0,
          completionTokens: response.usage.completionTokens ?? 0,
          connectorTokens: 0,
          webSearchCalls: 0,
        },
      };
    },
  };
}

/** Parses model output as JSON, tolerating a Markdown code fence around it. */
export function parseJsonOutput(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return JSON.parse(fenced ? fenced[1]! : trimmed);
}
