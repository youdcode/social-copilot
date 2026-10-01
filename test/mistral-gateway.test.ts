import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseJsonOutput, readConversation } from '../src/mistral/gateway.ts';

// Shape of the web search example in the Mistral docs, as the SDK returns it (camelCase).
const response = {
  outputs: [
    { type: 'tool.execution', name: 'web_search' },
    {
      type: 'message.output',
      content: [
        { type: 'text', text: 'The last winner was Spain' },
        { type: 'tool_reference', tool: 'web_search', title: 'UEFA Euro Winners', url: 'https://www.marca.com/en/winners.html' },
        { type: 'text', text: ', who beat England.' },
        { type: 'tool_reference', tool: 'web_search', title: 'No URL', url: null },
      ],
    },
  ],
  usage: { promptTokens: 188, completionTokens: 55, connectorTokens: 7112, connectors: { web_search: 1 } },
};

describe('readConversation', () => {
  test('joins text chunks, keeps references that have a URL, and reads usage', () => {
    const result = readConversation(response, 'mistral-medium-3-5');
    assert.equal(result.text, 'The last winner was Spain, who beat England.');
    assert.deepEqual(result.references, [{ url: 'https://www.marca.com/en/winners.html', title: 'UEFA Euro Winners' }]);
    assert.equal(result.toolCalls, 1);
    assert.deepEqual(result.usage, {
      model: 'mistral-medium-3-5',
      promptTokens: 188,
      completionTokens: 55,
      connectorTokens: 7112,
      webSearchCalls: 1,
    });
  });

  test('accepts plain string content and missing usage fields', () => {
    const result = readConversation({ outputs: [{ type: 'message.output', content: '{"a":1}' }], usage: {} }, 'm');
    assert.equal(result.text, '{"a":1}');
    assert.equal(result.usage.webSearchCalls, 0);
  });
});

describe('parseJsonOutput', () => {
  test('reads bare JSON and JSON inside a code fence', () => {
    assert.deepEqual(parseJsonOutput(' {"a": 1} '), { a: 1 });
    assert.deepEqual(parseJsonOutput('```json\n{"a": 2}\n```'), { a: 2 });
  });
});
