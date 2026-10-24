export const RECONNECT_SETTING = "sync-on-reconnect";
export const RECONNECT_DEBOUNCE = 2_000;
const RETRIES = [5_000, 15_000, 30_000];

export type ReconnectResult =
  | { state: "complete" | "stop" | "deferred" }
  | { state: "retry"; retryAt?: number };

interface Conditions {
  enabled: boolean;
  online: boolean;
  visible: boolean;
  available: boolean;
}

/** Only schedules foreground work; it owns no notes, credentials or persistent queue. */
export class ReconnectSync {
  private conditions: Conditions;
  private pending = false;
  private running = false;
  private disposed = false;
  private attempts = 0;
  private due = 0;
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    online: boolean,
    private attempt: () => Promise<ReconnectResult>,
    private status: (text: string) => void,
    private error: (error: unknown) => void,
  ) {
    this.conditions = {
      enabled: false,
      online,
      visible: true,
      available: false,
    };
  }

  update(next: Partial<Conditions>): void {
    if (this.disposed) return;
    const previous = this.conditions;
    this.conditions = { ...previous, ...next };
    if (!this.conditions.enabled) {
      this.cancel();
      return;
    }
    if (!previous.online && this.conditions.online && !this.pending) {
      this.pending = true;
      this.attempts = 0;
      this.due = Date.now() + RECONNECT_DEBOUNCE;
    }
    if (previous.online && !this.conditions.online)
      this.due = Math.max(this.due, Date.now() + RECONNECT_DEBOUNCE);
    if (this.pending && !previous.online && this.conditions.online)
      this.due = Math.max(this.due, Date.now() + RECONNECT_DEBOUNCE);
    this.schedule();
  }

  cancel(): void {
    this.generation++;
    this.pending = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.status("");
  }

  destroy(): void {
    this.disposed = true;
    this.cancel();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.pending || this.running || this.disposed) return;
    const { online, visible, available } = this.conditions;
    if (!online || !visible || !available) {
      this.status(
        "Reconnect sync waiting for a visible, online tab with no unfinished operation or chord.",
      );
      return;
    }
    this.status("Reconnect sync pending. Not yet synced.");
    this.timer = setTimeout(
      () => void this.run(),
      Math.max(0, this.due - Date.now()),
    );
  }

  private async run(): Promise<void> {
    this.timer = undefined;
    const generation = this.generation;
    this.running = true;
    this.attempts++;
    this.status("Automatic reconnect sync in progress.");
    let result: ReconnectResult;
    try {
      result = await this.attempt();
    } catch (error) {
      result = { state: "stop" };
      this.error(error);
    } finally {
      this.running = false;
    }
    if (this.disposed || generation !== this.generation) {
      this.schedule();
      return;
    }
    if (result.state === "complete" || result.state === "stop") {
      this.pending = false;
      this.status(
        result.state === "complete"
          ? ""
          : "Automatic sync stopped. Check drive errors and use Sync now or Reconnect.",
      );
      return;
    }
    const delay = RETRIES[this.attempts - 1];
    if (delay === undefined) {
      this.pending = false;
      this.status(
        "Automatic sync attempts exhausted. Changes remain local until a successful sync; use Sync now.",
      );
      return;
    }
    this.due = Math.max(
      Date.now() + delay,
      result.state === "retry" ? (result.retryAt ?? 0) : 0,
    );
    this.schedule();
  }
}
