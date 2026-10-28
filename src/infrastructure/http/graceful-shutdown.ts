export interface GracefulShutdownOptions {
  readonly stopAcceptingRequests: () => Promise<void>;
  readonly stopBackgroundWork: () => Promise<void>;
  readonly closeDependencies: () => Promise<void>;
  readonly forceCloseRequests: () => void;
  readonly timeoutMs: number;
  readonly onTimeout: () => void;
}

/** Coordinates draining without treating an interrupted external operation as a definitive failure. */
export class GracefulShutdown {
  private draining = false;
  private shutdownPromise: Promise<void> | undefined;

  constructor(private readonly options: GracefulShutdownOptions) {
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
      throw new Error("Graceful shutdown timeout must be a positive integer.");
    }
  }

  isDraining(): boolean {
    return this.draining;
  }

  start(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.draining = true;
    this.shutdownPromise = this.performShutdown();
    return this.shutdownPromise;
  }

  private async performShutdown(): Promise<void> {
    const timeout = setTimeout(() => {
      this.options.onTimeout();
      this.options.forceCloseRequests();
    }, this.options.timeoutMs);
    timeout.unref();
    const workers = Promise.resolve().then(this.options.stopBackgroundWork);
    const server = Promise.resolve().then(this.options.stopAcceptingRequests);
    try {
      await Promise.all([server, workers]);
      await this.options.closeDependencies();
    } finally {
      clearTimeout(timeout);
    }
  }
}
