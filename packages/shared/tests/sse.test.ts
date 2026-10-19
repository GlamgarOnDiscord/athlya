/**
 * Server-sent events parser and body reader (task 21.2 clients).
 */

import { describe, expect, it } from 'vitest';

import { readServerSentEvents, ServerSentEventParser, type ByteStream } from '../src/sse.js';

function streamOf(chunks: readonly (string | Uint8Array)[]): {
  readonly body: ByteStream;
  readonly cancelled: () => boolean;
} {
  const encoder = new TextEncoder();
  let index = 0;
  let cancelled = false;
  const body: ByteStream = {
    getReader: () => ({
      read: () => {
        const chunk = chunks[index];
        index += 1;
        if (chunk === undefined) return Promise.resolve({ done: true, value: undefined });
        return Promise.resolve({
          done: false,
          value: typeof chunk === 'string' ? encoder.encode(chunk) : chunk,
        });
      },
      cancel: () => {
        cancelled = true;
        return Promise.resolve();
      },
      releaseLock: () => undefined,
    }),
  };
  return { body, cancelled: () => cancelled };
}

async function collect(body: ByteStream) {
  const events = [];
  for await (const event of readServerSentEvents(body)) events.push(event);
  return events;
}

describe('ServerSentEventParser', () => {
  it('dispatches an event on a blank line', () => {
    const parser = new ServerSentEventParser();
    expect(parser.push('event: partial\ndata: {"a":1}\n')).toEqual([]);
    expect(parser.push('\n')).toEqual([{ event: 'partial', data: '{"a":1}', id: '' }]);
  });

  it('defaults the event name to message and joins data lines with LF', () => {
    const parser = new ServerSentEventParser();
    expect(parser.push('data: one\ndata:two\ndata\n\n')).toEqual([
      { event: 'message', data: 'one\ntwo\n', id: '' },
    ]);
  });

  it('accepts CRLF and CR line endings, including a CRLF split across chunks', () => {
    const parser = new ServerSentEventParser();
    expect(parser.push('event: a\r\ndata: 1\r\r')).toEqual([{ event: 'a', data: '1', id: '' }]);
    expect(parser.push('data: 2\r')).toEqual([]);
    expect(parser.push('\n\r')).toEqual([{ event: 'message', data: '2', id: '' }]);
    expect(parser.push('\ndata: 3\n\n')).toEqual([{ event: 'message', data: '3', id: '' }]);
  });

  it('ignores comments, unknown fields and events without data', () => {
    const parser = new ServerSentEventParser();
    expect(parser.push(': keep-alive\nretry: 10\nevent: x\n\nfoo: bar\ndata: y\n\n')).toEqual([
      { event: 'message', data: 'y', id: '' },
    ]);
  });

  it('keeps the last event id and strips a leading byte order mark', () => {
    const parser = new ServerSentEventParser();
    expect(parser.push('﻿id: 7\ndata: a\n\ndata: b\n\n')).toEqual([
      { event: 'message', data: 'a', id: '7' },
      { event: 'message', data: 'b', id: '7' },
    ]);
  });

  it('only strips one space after the colon', () => {
    const parser = new ServerSentEventParser();
    expect(parser.push('data:  two spaces\n\n')).toEqual([
      { event: 'message', data: ' two spaces', id: '' },
    ]);
  });
});

describe('readServerSentEvents', () => {
  it('reassembles events and multi-byte characters split across chunks', async () => {
    const bytes = new TextEncoder().encode('event: done\ndata: "café"\n\n');
    const split = bytes.indexOf(0xc3) + 1;
    const { body } = streamOf([
      'event: partial\nda',
      'ta: 1\n\n',
      bytes.slice(0, split),
      bytes.slice(split),
    ]);
    expect(await collect(body)).toEqual([
      { event: 'partial', data: '1', id: '' },
      { event: 'done', data: '"café"', id: '' },
    ]);
  });

  it('drops an event left unterminated at the end of the stream', async () => {
    const { body, cancelled } = streamOf(['data: complete\n\ndata: cut']);
    expect(await collect(body)).toEqual([{ event: 'message', data: 'complete', id: '' }]);
    expect(cancelled()).toBe(false);
  });

  it('cancels the body when the consumer stops early', async () => {
    const { body, cancelled } = streamOf(['data: 1\n\n', 'data: 2\n\n']);
    for await (const event of readServerSentEvents(body)) {
      expect(event.data).toBe('1');
      break;
    }
    expect(cancelled()).toBe(true);
  });
});
