// One in-flight write, one replaceable desired output. A stop overwrites all queued motion.
export class LatestWriter {
  private pending: number | null = null;
  private running = false;
  private closed = false;
  constructor(
    private write: (duty: number) => Promise<void>,
    private onError: (e: unknown) => void,
  ) {}
  request(duty: number) {
    if (this.closed) return;
    this.pending = duty;
    if (!this.running) void this.drain();
  }
  get idle() {
    return !this.running && this.pending === null;
  }
  close() {
    this.closed = true;
    this.pending = null;
  }
  private async drain() {
    this.running = true;
    try {
      while (!this.closed && this.pending !== null) {
        const duty = this.pending;
        this.pending = null;
        await this.write(duty);
      }
    } catch (e) {
      this.pending = null;
      this.closed = true;
      this.onError(e);
    } finally {
      this.running = false;
    }
  }
}
