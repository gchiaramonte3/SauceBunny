import { parseReply, validateEndpoint, type Command, type Reply } from "./protocol";

type Pending = { kind: Command["type"]; resolve: (reply: Reply) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
type Socket = Pick<WebSocket, "send" | "close" | "readyState" | "onopen" | "onmessage" | "onerror" | "onclose">;
export type SocketFactory = (url: string) => Socket;

export class BridgeClient {
  private socket: Socket | null = null;
  private pending = new Map<string, Pending>();
  private sequence = 0;
  private polling: ReturnType<typeof setInterval> | null = null;
  private pollPending = false;
  private authenticated = false;
  private offset = 0;
  private cancelOpening: ((error: Error) => void) | null = null;
  onSnapshot: (reply: Extract<Reply, { type: "snapshot" }>) => void = () => {};
  onDisconnect: (message: string) => void = () => {};
  constructor(private factory: SocketFactory = url => new WebSocket(url)) {}

  async pair(url: string, token: string): Promise<void> {
    validateEndpoint(url);
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Paste the pairing secret from Sauce Bunny Settings.");
    this.disconnect();
    // Premiere's UXP permission matcher rejects IP-literal manifest domains.
    // Validate the app's exact IPv4 loopback URL before using its localhost
    // alias. The random port/path and explicit pairing secret are unchanged.
    const socket = this.factory(url.replace("ws://127.0.0.1:", "ws://localhost:"));
    this.socket = socket; // Cancellation owns the handle before waiting.
    return new Promise<void>((resolve, reject) => {
      const opening = setTimeout(() => {
        if (this.socket === socket) this.disconnect("Local connection timed out. Check Sauce Bunny pairing and UXP network permissions.");
      }, 8000);
      this.cancelOpening = error => { clearTimeout(opening); reject(error); };
      socket.onopen = () => {
        if (this.socket !== socket) return;
        clearTimeout(opening);
        void this.request({ type: "hello", token }).then(reply => {
          if (this.socket !== socket || reply.type !== "snapshot" || reply.status.phase !== "connected") throw new Error("Pairing was not acknowledged.");
          this.authenticated = true;
          this.cancelOpening = null;
          this.polling = setInterval(() => {
            if (this.pollPending) return;
            this.pollPending = true;
            void this.request({ type: "poll", offset: this.offset }).catch(() => {
              if (this.socket === socket) this.disconnect("Connection lost. Pair again; pending notes remain saved.");
            }).finally(() => { if (this.socket === socket) this.pollPending = false; });
          }, 2000);
          resolve();
        }).catch(error => {
          // A cancelled attempt's hello may settle after the next connection
          // starts. It must not close that newer socket or replace its error.
          if (this.socket !== socket) return;
          this.disconnect(error instanceof Error ? error.message : "Pairing was not acknowledged.");
        });
      };
      socket.onmessage = event => {
        if (this.socket !== socket) return;
        try {
          const reply = parseReply(event.data);
          const entry = this.pending.get(reply.id);
          // A server packet can never invent a Premiere write. It must answer
          // this socket's outstanding, explicit editor-confirm request.
          if (reply.type === "insert" && entry?.kind !== "confirm") throw new Error("Unsolicited marker insertion was blocked.");
          if (entry) {
            clearTimeout(entry.timer);
            this.pending.delete(reply.id);
            if (reply.type === "error") entry.reject(new Error(reply.error)); else entry.resolve(reply);
          }
          if (reply.type === "snapshot") { this.offset = reply.page.offset; this.onSnapshot(reply); }
        } catch (error) { this.disconnect(error instanceof Error ? error.message : "Invalid local response."); }
      };
      socket.onerror = () => {
        if (this.socket !== socket) return;
        clearTimeout(opening);
        const error = new Error("Cannot reach Sauce Bunny. Check the pairing address and UXP network permission; no external connection is used.");
        this.disconnect(error.message);
      };
      socket.onclose = () => {
        clearTimeout(opening);
        if (this.socket === socket) this.disconnect(this.authenticated
          ? "Disconnected. Pending notes remain saved in Sauce Bunny."
          : "The local connection closed before pairing completed.");
      };
    });
  }

  request(command: Command): Promise<Reply> {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1 || (!this.authenticated && command.type !== "hello")) return Promise.reject(new Error("Pair with Sauce Bunny first."));
    if (this.pending.size >= 8) return Promise.reject(new Error("The companion is busy. Try again shortly."));
    const id = `request-${++this.sequence}`;
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Sauce Bunny did not acknowledge the command. Reconcile before retrying a marker."));
      }, 8000);
      this.pending.set(id, { kind: command.type, resolve, reject, timer });
      try { socket.send(JSON.stringify({ v: 1, id, ...command })); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new Error("The local command could not be sent.")); }
    });
  }

  disconnect(message = "Disconnected.") {
    const socket = this.socket;
    this.socket = null; this.authenticated = false;
    this.cancelOpening?.(new Error(message === "Disconnected." ? "Pairing cancelled." : message)); this.cancelOpening = null;
    if (this.polling) clearInterval(this.polling);
    this.polling = null; this.pollPending = false;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(message)); }
    this.pending.clear();
    if (socket) { socket.onclose = null; socket.onopen = null; socket.onmessage = null; socket.onerror = null; socket.close(); }
    this.onDisconnect(message);
  }
}
