/**
 * Server-sent events reader shared by the web and mobile clients.
 *
 * `EventSource` can neither `POST` nor send a bearer token, so the clients
 * read the event stream from a `fetch` response body instead. The parser
 * follows the WHATWG "event stream interpretation" rules: lines end with
 * CRLF, LF or CR, `:` starts a comment, `data` lines are joined with LF,
 * a blank line dispatches the event and an event left unterminated when
 * the stream ends is dropped.
 *
 * The stream types are structural so the module runs on any `fetch` with a
 * `ReadableStream` body (browsers, Node, `expo/fetch`).
 */

/** One dispatched event. `event` defaults to `message`. */
export interface ServerSentEvent {
  readonly event: string;
  readonly data: string;
  /** Last event ID seen on the stream, `''` when none was sent. */
  readonly id: string;
}

/** The subset of `ReadableStreamDefaultReader<Uint8Array>` the reader uses. */
export interface ByteStreamReader {
  read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array | undefined }>;
  cancel(reason?: unknown): Promise<void>;
  releaseLock(): void;
}

/** The subset of `ReadableStream<Uint8Array>` the reader uses. */
export interface ByteStream {
  getReader(): ByteStreamReader;
}

const BOM = '﻿';

/** Incremental parser: feed it decoded text, it returns the events completed so far. */
export class ServerSentEventParser {
  #buffer = '';
  #started = false;
  /** The previous chunk ended with CR: a leading LF in the next one belongs to it. */
  #pendingCr = false;
  #event = '';
  #data: string[] = [];
  #id = '';

  public push(chunk: string): ServerSentEvent[] {
    let text = chunk;
    if (this.#pendingCr && text.startsWith('\n')) text = text.slice(1);
    this.#pendingCr = false;
    if (!this.#started && text !== '') {
      this.#started = true;
      if (text.startsWith(BOM)) text = text.slice(1);
    }
    this.#buffer += text;

    const events: ServerSentEvent[] = [];
    let start = 0;
    for (let i = 0; i < this.#buffer.length; i += 1) {
      const char = this.#buffer[i];
      if (char !== '\n' && char !== '\r') continue;
      const line = this.#buffer.slice(start, i);
      if (char === '\r') {
        if (i + 1 === this.#buffer.length) this.#pendingCr = true;
        else if (this.#buffer[i + 1] === '\n') i += 1;
      }
      start = i + 1;
      const event = this.#line(line);
      if (event !== null) events.push(event);
    }
    this.#buffer = this.#buffer.slice(start);
    return events;
  }

  #line(line: string): ServerSentEvent | null {
    if (line === '') return this.#dispatch();
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.#event = value;
    else if (field === 'data') this.#data.push(value);
    else if (field === 'id' && !value.includes('\0')) this.#id = value;
    return null;
  }

  #dispatch(): ServerSentEvent | null {
    const data = this.#data;
    const event = this.#event;
    this.#data = [];
    this.#event = '';
    if (data.length === 0) return null;
    return { event: event === '' ? 'message' : event, data: data.join('\n'), id: this.#id };
  }
}

/**
 * Yields the events of a UTF-8 event stream body. Leaving the loop early
 * (`break`, `return`, a thrown error) cancels the body; abort the request's
 * own `AbortSignal` to stop a read that is waiting for data.
 */
export async function* readServerSentEvents(
  body: ByteStream,
): AsyncGenerator<ServerSentEvent, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new ServerSentEventParser();
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        yield* parser.push(decoder.decode());
        return;
      }
      if (value !== undefined) yield* parser.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
