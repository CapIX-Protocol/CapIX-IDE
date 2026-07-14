export class VirtualList<T> {
  private readonly items: T[];
  private readonly itemHeight: number;
  private readonly containerHeight: number;
  private readonly bufferSize: number;

  constructor(items: T[], itemHeight: number, containerHeight: number) {
    this.items = items;
    this.itemHeight = itemHeight;
    this.containerHeight = containerHeight;
    this.bufferSize = Math.max(1, Math.ceil(containerHeight / itemHeight));
  }

  getVisibleItems(scrollTop: number): { item: T; offset: number }[] {
    const startIndex = Math.max(0, Math.floor(scrollTop / this.itemHeight) - this.bufferSize);
    const visibleCount = Math.ceil(this.containerHeight / this.itemHeight) + this.bufferSize * 2;
    const endIndex = Math.min(this.items.length, startIndex + visibleCount);

    const visible: { item: T; offset: number }[] = [];
    for (let i = startIndex; i < endIndex; i++) {
      visible.push({ item: this.items[i], offset: i * this.itemHeight });
    }
    return visible;
  }

  getTotalHeight(): number {
    return this.items.length * this.itemHeight;
  }
}
