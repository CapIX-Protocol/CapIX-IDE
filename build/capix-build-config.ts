/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Capix Network. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *
 *  capix-build-config — deterministic platform packaging configuration
 *  (architecture §11.7).
 *
 *  Build model:
 *    - Uses the pinned editor baseline plus the checked-out Capix overlay.
 *      The baseline commit is immutable and the overlay source SHA is recorded
 *      in every platform's provenance file.
 *    - Customer artifacts are explicitly UNSIGNED portable archives. Signing
 *      and notarization are not release gates until Capix enables a signed
 *      channel; the archive name and release notes must state this clearly.
 *    - Fail-closed: compile / extension tests / runtime registration / branding /
 *      package / SBOM / provenance / notice failures prevent publication.
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
			target: "tar.gz",
			signingRequired: false,
			notarizationRequired: false,
		},
		"darwin-x64": {
			electronArch: "x64",
			target: "tar.gz",
			signingRequired: false,
			notarizationRequired: false,
		},
		"linux-x64": {
			electronArch: "x64",
			target: "tar.gz",
			signingRequired: false,
		},
		"win32-x64": {
			electronArch: "x64",
			target: "zip",
			signingRequired: false,
			timestampingRequired: false,
		},
	},

	// These are the gates enforced by the current unsigned portable channel.
	failClosed: {
		compile: true,
		test: true,
		runtimeRegistration: true,
		branding: true,
		package: true,
		sign: false,
		notarize: false,
		sbom: true,
		provenance: true,
		thirdPartyNotices: true,
	},

	// Artifacts
	artifacts: {
		sbom: true,
		checksums: ["sha256"],
		provenance: true,
		thirdPartyNotices: true,
	},

	// The Capix overlay is checked out; bootstrap hydrates an immutable baseline.
	buildFromCheckedOutCommit: false,
	upstreamBaselinePinned: true,
	releaseChannel: "unsigned-portable",
} as const;

export type BuildConfig = typeof BUILD_CONFIG;
