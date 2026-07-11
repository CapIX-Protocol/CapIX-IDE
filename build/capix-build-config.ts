/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Capix Network. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *
 *  capix-build-config — deterministic platform packaging configuration
 *  (architecture §11.7).
 *
 *  Build model:
 *    - Uses the Code-OSS/VSCodium-style platform build, not `electron-builder`
 *      around incomplete raw output.
 *    - Built from the checked-out source commit; the build NEVER clones upstream
 *      or arbitrary refs at build time. Source SHA, API/schema range,
 *      `capix-server`, workspace agent/image, bundled Capix Code/engine/plugin
 *      versions and signatures are recorded in build provenance.
 *    - Fail-closed: any compile / lint / test / package / sign / notarize /
 *      post-sign clean-install smoke test / SBOM / provenance failure prevents
 *      publication.
 *    - Every release includes checksums (sha256), SBOM, third-party notices and
 *      build provenance.
 *    - Updater uses threshold/TUF-style signed metadata with rollback/freeze
 *      protection; publisher signature and compatibility are verified before
 *      install, the last known-good version is preserved, and rollback is
 *      supported.
 *--------------------------------------------------------------------------------------------*/

export const BUILD_CONFIG = {
	// Platforms
	platforms: {
		"darwin-arm64": {
			electronArch: "arm64",
			target: "dmg",
			signingRequired: true,
			notarizationRequired: true,
		},
		"darwin-x64": {
			electronArch: "x64",
			target: "dmg",
			signingRequired: true,
			notarizationRequired: true,
		},
		"linux-x64": {
			electronArch: "x64",
			target: ["AppImage", "deb", "rpm"],
			signingRequired: true,
		},
		"win32-x64": {
			electronArch: "x64",
			target: "nsis",
			signingRequired: true,
			timestampingRequired: true,
		},
	},

	// Fail-closed: any compile/test/package/sign/notary failure prevents publication
	failClosed: {
		compile: true,
		test: true,
		lint: true,
		package: true,
		sign: true,
		notarize: true,
		postSignSmokeTest: true,
		sbom: true,
		provenance: true,
	},

	// Artifacts
	artifacts: {
		sbom: true,
		checksums: ["sha256"],
		provenance: true,
		thirdPartyNotices: true,
	},

	// Build from checked-out commit, NEVER clone upstream at build time
	buildFromCheckedOutCommit: true,
} as const;

export type BuildConfig = typeof BUILD_CONFIG;
