// Build-time compatibility fix for @tanstack/ai-mcp 0.6.0's HTTP-to-stdio bridge.
// Keep serveMCPStdio and the TanStack server; do not patch users' node_modules.
// Both distributed entry points bundle this fix. See docs/stdio-compat.md.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const upstreamSha256 = '7d9a287675a78d51cea84ba38681887037c674c78e5740f0db5f29dd38129e7e';

export function patchStdio(upstream) {
  let source = upstream;
  if (createHash('sha256').update(source).digest('hex') !== upstreamSha256) {
    throw new Error('TanStack stdio source changed. Review/remove the compatibility fix before upgrading ai-mcp.');
  }
  const replace = (before, after) => {
    if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before)) {
      throw new Error('TanStack stdio compatibility fix no longer matches its upstream source.');
    }
    source = source.replace(before, after);
  };

  replace(
    'const sideMessages = /* @__PURE__ */ new Set();',
    `const sideMessages = /* @__PURE__ */ new Set();
  const activeRequests = new Map();`
  );
  replace(
    'aborts.add(controller);\n\t\ttry {',
    `aborts.add(controller);
    if (isJSONRPCRequest(message)) activeRequests.set(message.id, controller);
    try {`
  );
  replace(
    'const text = await response.text();',
    `const contentType = response.headers.get("content-type");
      if (response.ok && mediaType(contentType) === "text/event-stream" && response.body !== null) {
        await pumpStream(response.body, controller);
        return;
      }
      const text = await response.text();`
  );
  replace(
    '\t\t\tconst contentType = response.headers.get("content-type");\n\t\t\tconst outbound',
    '\t\t\tconst outbound'
  );
  replace(
    '} finally {\n\t\t\taborts.delete(controller);\n\t\t}',
    `} finally {
      aborts.delete(controller);
      if (isJSONRPCRequest(message)) activeRequests.delete(message.id);
    }`
  );
  replace(
    'if (isJSONRPCRequest(message)) {\n\t\t\ttail',
    `if (message.method === "notifications/cancelled") {
      activeRequests.get(message.params?.requestId)?.abort();
    }
    if (isJSONRPCRequest(message) && message.method !== "subscriptions/listen") {
      tail`
  );
  replace(
    'pumpLegacyStream(response.body, controller).finally(stopStream);',
    `pumpStream(response.body, controller)
      .catch((error) => { if (!closed) console.error(errorText(error)); })
      .finally(stopStream);`
  );
  const pumpStart = source.indexOf('async function pumpLegacyStream(body, controller) {');
  const pumpEnd = source.indexOf('\n\tconst started = transport.start();', pumpStart);
  if (pumpStart === -1 || pumpEnd === -1) throw new Error('TanStack SSE pump was not found.');
  replace(
    source.slice(pumpStart, pumpEnd),
    `async function pumpStream(body, controller) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    const cancel = () => { reader.cancel().catch(() => undefined); };
    controller.signal.addEventListener("abort", cancel, { once: true });
    if (controller.signal.aborted) cancel();
    try {
      while (!closed && !controller.signal.aborted) {
        const read = await reader.read();
        if (read.done) return;
        pending += decoder.decode(read.value, { stream: true });
        const events = pending.split(/\\r?\\n\\r?\\n/);
        pending = events.pop() ?? "";
        for (const event of events) {
          for (const message of sseMessages(event + "\\n\\n")) {
            if (closed || controller.signal.aborted) return;
            const version = message.result?.protocolVersion;
            if (legacyProtocol === undefined && typeof version === "string" && !isModernVersion(version)) {
              legacyProtocol = version;
              await ensureLegacyStream();
            }
            await transport.send(message);
          }
        }
      }
    } finally {
      controller.signal.removeEventListener("abort", cancel);
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }`
  );
  return source;
}

export const stdioCompatPlugin = {
  name: 'tanstack-stdio-compat',
  setup(build) {
    build.onLoad(
      { filter: /[/\\]@tanstack[/\\]ai-mcp[/\\]dist[/\\]esm[/\\]server[/\\]stdio\.js$/ },
      async ({ path }) => ({
        contents: patchStdio(await readFile(path, 'utf8')),
        loader: 'js',
      })
    );
  },
};
