import { describe, expect, it, vi } from "vitest";
import { createCapixDesktopInstanceGuard } from "../../../src/main/capix-desktop-instance";

describe("CapixIDE desktop instance guard", () => {
  it("quits the second bundle before it can share the webview profile", () => {
    const guard = createCapixDesktopInstanceGuard();
    const quit = vi.fn();
    const on = vi.fn();

    expect(guard({ requestSingleInstanceLock: () => false, quit, on }, () => [])).toBe(false);
    expect(quit).toHaveBeenCalledOnce();
    expect(on).not.toHaveBeenCalled();
  });

  it("focuses the existing healthy window when a second launch is requested", () => {
    const guard = createCapixDesktopInstanceGuard();
    let secondInstance: (() => void) | undefined;
    const restore = vi.fn();
    const show = vi.fn();
    const focus = vi.fn();
    const app = {
      requestSingleInstanceLock: vi.fn(() => true),
      quit: vi.fn(),
      on: vi.fn((_event: "second-instance", listener: () => void) => { secondInstance = listener; }),
    };
    const getWindows = () => [{ isDestroyed: () => false, isMinimized: () => true, restore, show, focus }];

    expect(guard(app, getWindows)).toBe(true);
    expect(guard(app, getWindows)).toBe(true);
    expect(app.requestSingleInstanceLock).toHaveBeenCalledOnce();
    secondInstance?.();
    expect(restore).toHaveBeenCalledOnce();
    expect(show).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
  });
});

