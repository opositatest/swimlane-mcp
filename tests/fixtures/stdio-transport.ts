import { serveMCPStdio } from '@tanstack/ai-mcp/server/stdio';

// Deliberately fragmented, long-lived SSE responses exercise the bridge independently
// from the SDK's current SSE formatting. No real API or credentials are involved.
const encoder = new TextEncoder();
const streams = new Map<number, ReadableStreamDefaultController<Uint8Array>>();
let cancelled = 0;

function event(controller: ReadableStreamDefaultController<Uint8Array>, message: unknown): void {
  const data = JSON.stringify(message, null, 2)
    .split('\n')
    .map((line) => `data: ${line}`)
    .join('\r\n');
  const bytes = encoder.encode(`: heartbeat\r\n\r\nevent: message\r\n${data}\r\n\r\n`);
  // Split inside UTF-8 characters and even between CR and LF.
  for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
}

async function handle(request: Request): Promise<Response> {
  const message = (await request.json()) as { id: number; method: string; params?: { requestId?: number } };
  if (message.method === 'subscriptions/listen') {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streams.set(message.id, controller);
        request.signal.addEventListener(
          'abort',
          () => {
            streams.delete(message.id);
            cancelled++;
            controller.close();
          },
          { once: true }
        );
        event(controller, {
          jsonrpc: '2.0',
          method: 'notifications/subscriptions/acknowledged',
          params: { id: message.id },
        });
      },
      cancel() {
        streams.delete(message.id);
      },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
  }
  if (message.method === 'test/notify') {
    for (const [id, controller] of streams) {
      event(controller, {
        jsonrpc: '2.0',
        method: 'notifications/tools/list_changed',
        params: { id, text: 'café 🏊' },
      });
    }
  }
  if (message.method === 'test/bad-sse') {
    return new Response('data: not JSON\r\n\r\n', { headers: { 'content-type': 'text/event-stream' } });
  }
  if (message.method === 'notifications/cancelled') return new Response(null, { status: 202 });
  return Response.json({ jsonrpc: '2.0', id: message.id, result: { active: streams.size, cancelled } });
}

serveMCPStdio({ fetch: handle });
