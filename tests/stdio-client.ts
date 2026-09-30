import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface JsonRpcMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

export class StdioClient {
  readonly child: ChildProcessWithoutNullStreams;
  readonly messages: JsonRpcMessage[] = [];
  readonly exited: Promise<number | null>;
  private nextId = 1;
  private listeners = new Set<() => void>();
  private stderr = '';
  private failure?: Error;

  constructor(args: string[], env: NodeJS.ProcessEnv = {}, cwd?: string) {
    this.child = spawn(process.execPath, args, { env: { PATH: process.env.PATH ?? '', ...env }, cwd });
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk;
    });
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      try {
        this.messages.push(JSON.parse(line) as JsonRpcMessage);
      } catch {
        this.failure = new Error(`Non-JSON protocol output: ${line}`);
      }
      this.wake();
    });
    this.child.on('error', (error) => {
      this.failure = error;
      this.wake();
    });
    this.exited = new Promise((resolve) => {
      this.child.on('exit', (code) => {
        this.failure = new Error(`MCP process exited (${code}): ${this.stderr}`);
        this.wake();
        resolve(code);
      });
    });
  }

  send(method: string, params: Record<string, unknown> = {}): number {
    const id = this.nextId++;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return id;
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<JsonRpcMessage> {
    const id = this.send(method, params);
    return this.waitFor((message) => message.id === id);
  }

  waitFor(predicate: (message: JsonRpcMessage) => boolean, timeout = 5_000): Promise<JsonRpcMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(check);
        reject(new Error(`MCP response timed out: ${this.stderr}`));
      }, timeout);
      const check = () => {
        const found = this.messages.find(predicate);
        if (!found && !this.failure) return;
        clearTimeout(timer);
        this.listeners.delete(check);
        if (found) resolve(found);
        else reject(this.failure);
      };
      this.listeners.add(check);
      check();
    });
  }

  kill(): void {
    this.child.kill();
  }

  private wake(): void {
    for (const listener of this.listeners) listener();
  }
}

export const MODERN_META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'vitest', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};
