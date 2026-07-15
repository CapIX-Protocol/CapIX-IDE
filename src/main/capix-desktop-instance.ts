export interface CapixDesktopApp {
	requestSingleInstanceLock(additionalData?: Record<string, unknown>): boolean;
	quit(): void;
	on(event: "second-instance", listener: () => void): unknown;
}

export interface CapixDesktopWindow {
	isDestroyed(): boolean;
	isMinimized(): boolean;
	restore(): void;
	show(): void;
	focus(): void;
}

/**
 * Create the process-local half of the CapixIDE desktop-instance guard.
 * Electron owns the cross-process lock; this closure keeps repeated bootstrap
 * calls in the owning process idempotent.
 */
export function createCapixDesktopInstanceGuard(): (
	app: CapixDesktopApp,
	getWindows: () => CapixDesktopWindow[],
) => boolean {
	let claimed = false;
	return (app, getWindows) => {
		if (claimed) return true;
		if (!app.requestSingleInstanceLock({ product: "capix-ide" })) {
			app.quit();
			return false;
		}
		claimed = true;
		app.on("second-instance", () => {
			const window = getWindows().find(candidate => !candidate.isDestroyed());
			if (!window) return;
			if (window.isMinimized()) window.restore();
			window.show();
			window.focus();
		});
		return true;
	};
}

