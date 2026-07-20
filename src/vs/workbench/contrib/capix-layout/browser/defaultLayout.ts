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
const APPLIED_KEY = 'capix.layout.defaultApplied.v1';

/** VS Code prefixes extension-contributed view containers with `workbench.view.extension.`. */
const CAPIX_CODE_CONTAINER_ID = 'workbench.view.extension.capix-code';

export class CapixDefaultLayoutContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.capixDefaultLayout';

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
			if (this.dock()) {
				return;
			}
			// Extension-contributed containers register after the workbench has
			// restored; wait for the Capix Code container exactly once.
			const listener = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry).onDidRegister(container => {
				if (container.id === CAPIX_CODE_CONTAINER_ID) {
					listener.dispose();
					this.dock();
				}
			});
			this._register(listener);
		} catch {
			// A default-layout nicety must never take down the workbench.
		}
	}

	private dock(): boolean {
		try {
			const container = this.viewDescriptorService.getViewContainerById(CAPIX_CODE_CONTAINER_ID);
			if (!container) {
				return false;
			}
			if (this.viewDescriptorService.getViewContainerLocation(container) !== ViewContainerLocation.AuxiliaryBar) {
				this.viewDescriptorService.moveViewContainerToLocation(container, ViewContainerLocation.AuxiliaryBar, undefined, 'capix.defaultLayout');
			}
			void this.paneCompositeService.openPaneComposite(CAPIX_CODE_CONTAINER_ID, ViewContainerLocation.AuxiliaryBar, false);
			this.storageService.store(APPLIED_KEY, true, StorageScope.PROFILE, StorageTarget.USER);
			return true;
		} catch {
			return false;
		}
	}
}

registerWorkbenchContribution2(CapixDefaultLayoutContribution.ID, CapixDefaultLayoutContribution, WorkbenchPhase.AfterRestored);
