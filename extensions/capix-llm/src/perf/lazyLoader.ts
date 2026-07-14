export class LazyLoader {
  private loaded = new Set<string>();
  private loading = new Map<string, Promise<void>>();

  async whenVisible(viewId: string, loader: () => Promise<void>): Promise<void> {
    if (this.loaded.has(viewId)) {
      return;
    }

    const inflight = this.loading.get(viewId);
    if (inflight) {
      return inflight;
    }

    const promise = loader().then(() => {
      this.loaded.add(viewId);
      this.loading.delete(viewId);
    });
    this.loading.set(viewId, promise);
    return promise;
  }

  unloadIfHidden(viewId: string): void {
    this.loaded.delete(viewId);
    this.loading.delete(viewId);
  }

  isLoaded(viewId: string): boolean {
    return this.loaded.has(viewId);
  }
}
