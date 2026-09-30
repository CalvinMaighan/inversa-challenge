/**
 * `bun run dev`: Axum API + Next web together, prefixed output, one Ctrl-C stops both.
 * Data lives in ./data (fill it with `bun run data`). Without FIREWORKS_API_KEY the agent runs in mock mode.
 */
import type { Subprocess } from "bun";

const root = new URL("..", import.meta.url).pathname;

const env = {
  ...process.env,
  INVERSA_DATA_DIR: process.env.INVERSA_DATA_DIR ?? `${root}data`,
  NEXT_PUBLIC_INVERSA_WS_URL: process.env.NEXT_PUBLIC_INVERSA_WS_URL ?? "ws://127.0.0.1:4041/v1/graphql",
  AGENT_HARNESS: process.env.AGENT_HARNESS ?? (process.env.FIREWORKS_API_KEY ? "live" : "mock"),
};

const procs: { name: string; color: string; proc: Subprocess }[] = [];

function start(name: string, color: string, cmd: string[], cwd: string) {
  const proc = Bun.spawn(cmd, { cwd, env, stdout: "pipe", stderr: "pipe" });
  procs.push({ name, color, proc });
  const prefix = `\x1b[${color}m[${name}]\x1b[0m `;
  for (const stream of [proc.stdout, proc.stderr]) {
    void (async () => {
      const decoder = new TextDecoder();
      let buf = "";
      for await (const chunk of stream as ReadableStream<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) process.stdout.write(prefix + line + "\n");
      }
      if (buf) process.stdout.write(prefix + buf + "\n");
    })();
  }
  void proc.exited.then((code) => {
    process.stdout.write(`${prefix}exited with ${code}\n`);
    shutdown(code ?? 1);
  });
}

let stopping = false;
function shutdown(code: number) {
  if (stopping) return;
  stopping = true;
  for (const { proc } of procs) proc.kill("SIGTERM");
  setTimeout(() => process.exit(code), 500);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log(`data: ${env.INVERSA_DATA_DIR} · agent: ${env.AGENT_HARNESS} · web: http://localhost:3050`);
start("api", "36", ["cargo", "run", "--release", "--manifest-path", "api/Cargo.toml"], root);
start("web", "35", ["bun", "run", "dev"], `${root}apps/web`);
