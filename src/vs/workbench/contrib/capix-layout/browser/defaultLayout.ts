/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Capix Network. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *
 *  capix-layout/defaultLayout — first-run workbench layout for CapixIDE.
 *
 *  Docks the Capix Code chat surface in the secondary side bar (right side),
 *  Cursor-style, exactly once per profile. A user who later moves the panel
 *  keeps their arrangement — the contribution only ever runs on a profile
 *  where it has not been applied before.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { IPaneCompositePartService } from '../../../services/panecomposite/browser/panecomposite.js';
import { IViewContainersRegistry, IViewDescriptorService, ViewContainerExtensions, ViewContainerLocation } from '../../../common/views.js';

/** Applied-once marker, scoped to the profile so fresh profiles get the default too. */
const APPLIED_KEY = 'capix.layout.defaultApplied.v2';

/** VS Code prefixes extension-contributed view containers with `workbench.view.extension.`. */
const CAPIX_CODE_CONTAINER_ID = 'workbench.view.extension.capix-code';

/** How long to keep looking for the container after restore (extension scan is async). */
const RETRY_INTERVAL_MS = 1500;
const RETRY_BUDGET_MS = 60000;

export class CapixDefaultLayoutContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.capixDefaultLayout';

	private finished = false;

	constructor(
		@IViewDescriptorService private readonly viewDescriptorService: IViewDescriptorService,
		@IPaneCompositePartService private readonly paneCompositeService: IPaneCompositePartService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		this.applyOnce();
	}

	private applyOnce(): void {
		// Layout polish must never break startup.
		try {
			if (this.storageService.getBoolean(APPLIED_KEY, StorageScope.PROFILE, false)) {
				return;
			}

			// Fast path: react the moment the container registers. NOTE: the
			// registry event payload is { viewContainer, viewContainerLocation },
			// not the container itself.
			const listener = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry).onDidRegister(e => {
				try {
					if (e && e.viewContainer && e.viewContainer.id === CAPIX_CODE_CONTAINER_ID) {
						this.tryDock();
					}
				} catch {
					// ignore and let the retry loop handle it
				}
			});
			this._register(listener);

			// Robust path: poll until the container exists and stays docked.
			// Extension-contributed containers appear after the workbench has
			// restored, and other layout contributions may still be settling —
			// a short retry window absorbs all ordering races.
			let waited = 0;
			const tick = () => {
				if (this.finished) {
					return;
				}
				waited += RETRY_INTERVAL_MS;
				if (this.tryDock()) {
					return;
				}
				if (waited < RETRY_BUDGET_MS) {
					const handle = setTimeout(tick, RETRY_INTERVAL_MS);
					this._register({ dispose: () => clearTimeout(handle) });
				} else {
					// Give up quietly; a missing container is not a startup error.
					this.finished = true;
					listener.dispose();
				}
			};
			const handle = setTimeout(tick, RETRY_INTERVAL_MS);
			this._register({ dispose: () => clearTimeout(handle) });
		} catch {
			// A default-layout nicety must never take down the workbench.
		}
	}

	/** Returns true when the container is confirmed docked (or already was). */
	private tryDock(): boolean {
		try {
			const container = this.viewDescriptorService.getViewContainerById(CAPIX_CODE_CONTAINER_ID);
			if (!container) {
				return false;
			}
			if (this.viewDescriptorService.getViewContainerLocation(container) !== ViewContainerLocation.AuxiliaryBar) {
				this.viewDescriptorService.moveViewContainerToLocation(container, ViewContainerLocation.AuxiliaryBar, undefined, 'capix.defaultLayout');
			}
			// Re-read the location: only declare success once it stuck.
			if (this.viewDescriptorService.getViewContainerLocation(container) !== ViewContainerLocation.AuxiliaryBar) {
				return false;
			}
			void this.paneCompositeService.openPaneComposite(CAPIX_CODE_CONTAINER_ID, ViewContainerLocation.AuxiliaryBar, false);
			this.storageService.store(APPLIED_KEY, true, StorageScope.PROFILE, StorageTarget.USER);
			this.finished = true;
			return true;
		} catch {
			return false;
		}
	}
}

registerWorkbenchContribution2(CapixDefaultLayoutContribution.ID, CapixDefaultLayoutContribution, WorkbenchPhase.AfterRestored);
