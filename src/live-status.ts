export interface LiveFrame {
  line: string;
  key?: string;
}

export interface LiveStatusOptions {
  enabled?: boolean;
  intervalMs?: number;
  render: () => LiveFrame;
  stream?: NodeJS.WriteStream;
}

export class LiveStatus {
  private readonly stream: NodeJS.WriteStream;
  private readonly enabled: boolean;
  private readonly tty: boolean;
  private readonly intervalMs: number;
  private readonly render: () => LiveFrame;
  private timer: NodeJS.Timeout | null = null;
  private lastLine = "";
  private lastKey = "";
  private wroteLine = false;

  constructor(options: LiveStatusOptions) {
    this.stream = options.stream ?? process.stdout;
    this.enabled = options.enabled !== false;
    this.tty = Boolean(this.stream.isTTY);
    this.intervalMs = options.intervalMs ?? 1000;
    this.render = options.render;
  }

  start(): void {
    if (!this.enabled || this.timer) return;
    this.refresh();
    this.timer = setInterval(() => this.refresh(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.tty && this.wroteLine) {
      try {
        this.stream.write("\n");
      } catch {
        // stream closed
      }
      this.wroteLine = false;
    }
  }

  refresh(): void {
    if (!this.enabled) return;
    let frame: LiveFrame;
    try {
      frame = this.render();
    } catch {
      return;
    }
    if (!frame.line) return;
    if (this.tty) {
      if (frame.line === this.lastLine) return;
      try {
        this.stream.write(`\r${frame.line}\x1b[K`);
        this.lastLine = frame.line;
        this.wroteLine = true;
      } catch {
        // stream closed
      }
      return;
    }
    const key = frame.key ?? frame.line;
    if (key === this.lastKey) return;
    this.lastKey = key;
    try {
      this.stream.write(`${frame.line}\n`);
    } catch {
      // stream closed
    }
  }

  note(message: string): void {
    if (!this.enabled) return;
    const text = message.trim();
    if (!text) return;
    try {
      if (this.tty && this.wroteLine) {
        this.stream.write("\r\x1b[K");
        this.lastLine = "";
        this.wroteLine = false;
      }
      this.stream.write(`${text}\n`);
      if (this.tty) this.refresh();
    } catch {
      // stream closed
    }
  }
}

export function formatLiveDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "-";
  if (ms <= 0) return "0s";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${Math.max(1, seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
