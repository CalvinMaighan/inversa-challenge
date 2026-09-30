import { get, set, subscribe } from "../../src/core";
import { connectThread, type ConnectThreadOptions } from "../../src/threads";

export const CATALOG = { PING: 0, PONG: 0, ECHO: "", COUNT: 0 } as const;

declare const self: {
  addEventListener(type: "message", cb: (ev: MessageEvent) => void): void;
  removeEventListener(type: "message", cb: (ev: MessageEvent) => void): void;
  postMessage(message: unknown): void;
};

export function startEcho(options: ConnectThreadOptions): void {
  const link = connectThread(self, { ...CATALOG }, options);
  subscribe("PING", (v) => {
    if (v !== 0) set("PONG", v);
  });
  subscribe("ECHO", (v) => {
    const s = v as string;
    if (s !== "" && !s.endsWith("!")) set("ECHO", `${s}!`);
  });
  // Report the transport kind, then the snapshot value the host pushed.
  void link.ready.then(() => {
    self.postMessage({
      kind: link.transport && "outgoing" in link.transport ? "sab" : "message",
    });
  });
  subscribe("COUNT", (v) => {
    if (v !== 0) self.postMessage({ count: get("COUNT") });
  });
}
