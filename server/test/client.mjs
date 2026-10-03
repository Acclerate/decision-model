/** 极简 MCP stdio 测试客户端：spawn server，newline-delimited JSON-RPC。 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export class McpClient {
  constructor({ command = process.execPath, args = [], env = {} } = {}) {
    this.proc = spawn(command, args, {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, ...env },
    });
    this.pending = new Map();
    this.nextId = 1;
    createInterface({ input: this.proc.stdout }).on("line", (raw) => {
      const line = raw.trim();
      if (!line) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(msg.id);
      msg.error
        ? entry.reject(new Error(`${msg.error.code}: ${msg.error.message}`))
        : entry.resolve(msg.result);
    });
  }

  request(method, params = {}, timeoutMs = 30_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  notify(method, params = {}) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  close() {
    try {
      this.proc.stdin.end();
    } catch { /* 已关闭 */ }
    this.proc.kill();
  }
}
