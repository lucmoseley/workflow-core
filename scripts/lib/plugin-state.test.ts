// @vitest-environment node
/*
 * plugin-state.test.ts — the four-record read (#243) and the readings #251
 * corrected on it. Every read case builds its tree through
 * `plugin-state-testkit.ts`, which threads `configDir` explicitly, so this
 * never touches the real registry (#238 user story 48). The `isCoreHost`
 * cases build their own, needing a missing and an unparseable manifest the
 * testkit never writes.
 *
 * The read feeds `check-plugin-gap.js`, a SessionStart hook in
 * `.claude/settings.json`, and `upgrade.js`; loosen a case and a session in a
 * stale adopter repo is told nothing, or told a gap that is not there.
 * Loosen an `isCoreHost` case and an adopter runs the core's own reports.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findPin, isCoreHost, readPluginState } from "./plugin-state.js";
import { adopterFixtures } from "./plugin-state-testkit.js";

const fixture = adopterFixtures("wfc-plugin-state-");

describe("readPluginState (#243)", () => {
	it("reads everything agreeing as no gap", () => {
		const { root, pluginRoot, configDir, marketplace } = fixture({
			pinRef: "v1.1.8",
			installedVersion: "1.1.8",
			supplyTag: "v1.1.8",
		});

		const state = readPluginState({ root, pluginRoot, configDir });
		expect(state.gaps).toEqual({
			supplyBehindPin: false,
			installBehindSupply: false,
		});
		expect(state.pin).toEqual({ marketplace, ref: "v1.1.8", url: null });
		expect(state.contention).toBeNull();
		expect(state.materialisedNotLive).toBe(false);
	});

	it("reads supply behind pin — the supply left on a branch after a hand-rotated pin (#238's incident)", () => {
		const { root, pluginRoot, configDir } = fixture({
			pinRef: "v1.1.11",
			installedVersion: "1.1.8",
			supplyBranch: "main",
		});

		const state = readPluginState({ root, pluginRoot, configDir });
		expect(state.gaps.supplyBehindPin).toBe(true);
		expect(state.gaps.installBehindSupply).toBe(true);
		expect(state.supply.ref).toBe("main");
		expect(state.supply.refKind).toBe("branch");
	});

	it("reads install behind supply alone — supply already rotated, install not yet re-pulled", () => {
		const { root, pluginRoot, configDir } = fixture({
			pinRef: "v1.1.11",
			installedVersion: "1.1.8",
			supplyTag: "v1.1.11",
		});

		const state = readPluginState({ root, pluginRoot, configDir });
		expect(state.gaps).toEqual({
			supplyBehindPin: false,
			installBehindSupply: true,
		});
	});

	it("reads both gaps open", () => {
		const { root, pluginRoot, configDir } = fixture({
			pinRef: "v2.0.0",
			installedVersion: "1.1.8",
			supplyBranch: "main",
		});

		const state = readPluginState({ root, pluginRoot, configDir });
		expect(state.gaps).toEqual({
			supplyBehindPin: true,
			installBehindSupply: true,
		});
	});

	it("returns a defined reading for an absent marketplace clone, never throwing", () => {
		const { root, pluginRoot, configDir } = fixture({ pinRef: "v1.0.0" });
		const state = readPluginState({ root, pluginRoot, configDir });
		expect(state.supply.ref).toBeNull();
		expect(state.gaps.supplyBehindPin).toBe(true);
	});

	it("returns a defined reading for an unreadable installed_plugins.json, never throwing", () => {
		const { root, pluginRoot, configDir } = fixture({
			pinRef: "v1.0.0",
			supplyTag: "v1.0.0",
		});
		fs.writeFileSync(
			path.join(configDir, "plugins", "installed_plugins.json"),
			"{not json",
		);

		const state = readPluginState({ root, pluginRoot, configDir });
		expect(state.installRecord).toBeNull();
		expect(state.runningPlugin).toBeNull();
	});

	it("returns a defined reading for a directory-sourced global record, and reports no pin", () => {
		const { root, pluginRoot, configDir } = fixture({ pinSource: "directory" });
		const state = readPluginState({ root, pluginRoot, configDir });
		expect(state.pin).toBeNull();
		expect(state.directorySourced).toBe(true);
		expect(state.gaps).toEqual({
			supplyBehindPin: false,
			installBehindSupply: false,
		});
	});

	it("reads a url-pinned adopter whose marketplace resolves to a directory source as supply behind pin", () => {
		const { root, pluginRoot, configDir } = fixture({
			pinRef: "v1.0.0",
			marketplaceDir: "/some/shared/checkout",
			marketplaceSource: "directory",
		});
		const state = readPluginState({ root, pluginRoot, configDir });
		expect(state.gaps.supplyBehindPin).toBe(true);
	});

	it("names the supply's current ref as contention where it is not this adopter's pin", () => {
		const { root, pluginRoot, configDir } = fixture({
			pinRef: "v1.1.11",
			installedVersion: "1.1.8",
			supplyTag: "v1.0.0",
		});

		const state = readPluginState({ root, pluginRoot, configDir });
		expect(state.contention).toBe("v1.0.0");
	});

	it("carries the pin's own clone url where the source names one", () => {
		const { root, pluginRoot, configDir } = fixture({
			pinRef: "v1.1.11",
			pinUrl: "https://example.invalid/wfc.git",
			supplyBranch: "main",
		});
		const state = readPluginState({ root, pluginRoot, configDir });
		expect(state.pin?.url).toBe("https://example.invalid/wfc.git");
	});
});

describe("readPluginState's corrected readings (#251)", () => {
	it("declines a branch pin — a ref that is not a tag names no version to be behind", () => {
		const { root, pluginRoot, configDir } = fixture({
			pinRef: "main",
			installedVersion: "1.1.8",
			supplyBranch: "main",
		});
		const state = readPluginState({ root, pluginRoot, configDir });
		expect(state.pin).toBeNull();
		expect(state.pinRefKind).toBe("unfixed");
		expect(state.gaps).toEqual({
			supplyBehindPin: false,
			installBehindSupply: false,
		});
	});

	it("declines a SHA pin for the same reason", () => {
		const { root, pluginRoot, configDir } = fixture({
			pinRef: "d9fec8951f0a4b2c3d4e5f60718293a4b5c6d7e8",
			supplyBranch: "main",
		});
		const state = readPluginState({ root, pluginRoot, configDir });
		expect(state.pin).toBeNull();
		expect(state.pinRefKind).toBe("unfixed");
	});

	it("accepts a semver tag with the v and without it alike", () => {
		const withV = fixture({ pinRef: "v1.1.8", supplyTag: "v1.1.8" });
		expect(readPluginState(withV).pinRefKind).toBe("tag");
		const withoutV = fixture({ pinRef: "1.1.8", supplyTag: "1.1.8" });
		expect(readPluginState(withoutV).pinRefKind).toBe("tag");
	});

	it("reads a marketplace tagged without the v prefix as up to date, not permanently behind", () => {
		const { root, pluginRoot, configDir } = fixture({
			pinRef: "v1.1.8",
			installedVersion: "1.1.8",
			supplyTag: "1.1.8",
		});
		const state = readPluginState({ root, pluginRoot, configDir });
		expect(state.gaps).toEqual({
			supplyBehindPin: false,
			installBehindSupply: false,
		});
	});

	it("calls a supply left on a branch this repo's own broken state, never contention (#238's incident)", () => {
		const { root, pluginRoot, configDir } = fixture({
			pinRef: "v1.1.11",
			installedVersion: "1.1.8",
			supplyBranch: "main",
		});
		const state = readPluginState({ root, pluginRoot, configDir });
		expect(state.contention).toBeNull();
	});

	it("still names a real tag that is not this adopter's pin as contention", () => {
		const { root, pluginRoot, configDir } = fixture({
			pinRef: "v1.1.11",
			supplyTag: "v1.2.0",
		});
		expect(readPluginState({ root, pluginRoot, configDir }).contention).toBe(
			"v1.2.0",
		);
	});

	it("reads a clone at the fallback path that known_marketplaces.json never registered", () => {
		const { root, pluginRoot, configDir, clone } = fixture({
			pinRef: "v1.1.8",
			installedVersion: "1.1.8",
			supplyTag: "v1.1.8",
			unregisteredMarketplace: true,
		});
		expect(fs.existsSync(path.join(clone, ".git"))).toBe(true);

		const state = readPluginState({ root, pluginRoot, configDir });
		expect(state.supply.sourceType).toBe("git");
		expect(state.supply.ref).toBe("v1.1.8");
		expect(state.gaps.supplyBehindPin).toBe(false);
	});

	it("reads materialised but not yet live where disk is current and this process is not", () => {
		const { root, pluginRoot, configDir } = fixture({
			pinRef: "v1.1.11",
			installedVersion: "1.1.11",
			loadedVersion: "1.1.8",
			supplyTag: "v1.1.11",
		});
		const state = readPluginState({ root, pluginRoot, configDir });
		expect(state.gaps).toEqual({
			supplyBehindPin: false,
			installBehindSupply: false,
		});
		expect(state.materialisedNotLive).toBe(true);
		expect(state.loadedVersion).toBe("1.1.8");
		expect(state.runningPlugin?.version).toBe("1.1.11");
	});

	it("reads nothing as materialised but not yet live where the loaded plugin is the installed one", () => {
		const { root, pluginRoot, configDir } = fixture({
			pinRef: "v1.1.8",
			installedVersion: "1.1.8",
			supplyTag: "v1.1.8",
		});
		expect(
			readPluginState({ root, pluginRoot, configDir }).materialisedNotLive,
		).toBe(false);
	});
});

describe("an install already at its pin owes the supply nothing (#747)", () => {
	it("reads no gap and no contention with the supply on another adopter's older tag", () => {
		const { root, pluginRoot, configDir } = fixture({
			pinRef: "v1.3.2",
			installedVersion: "1.3.2",
			supplyTag: "v1.3.1",
		});
		const state = readPluginState({ root, pluginRoot, configDir });
		expect(state.installAtPin).toBe(true);
		expect(state.gaps).toEqual({
			supplyBehindPin: false,
			installBehindSupply: false,
		});
		expect(state.contention).toBeNull();
	});

	it("reads materialised but not yet live there, where this process loaded older bytes", () => {
		const { root, pluginRoot, configDir } = fixture({
			pinRef: "v1.3.2",
			installedVersion: "1.3.2",
			loadedVersion: "1.3.1",
			supplyTag: "v1.3.1",
		});
		const state = readPluginState({ root, pluginRoot, configDir });
		expect(state.materialisedNotLive).toBe(true);
		expect(state.contention).toBeNull();
	});

	it("still reads the supply behind the pin where the install is behind it too", () => {
		const { root, pluginRoot, configDir } = fixture({
			pinRef: "v1.3.2",
			installedVersion: "1.3.1",
			supplyTag: "v1.3.1",
		});
		const state = readPluginState({ root, pluginRoot, configDir });
		expect(state.installAtPin).toBe(false);
		expect(state.gaps.supplyBehindPin).toBe(true);
	});
});

describe("resolveMarketplace on a git source whose installLocation is not the clone path (#251 item 11)", () => {
	it("reads the tree installLocation names, which the second copy in check-hook-liveness.js ignored", () => {
		/* The divergent case itself: that file used to return the
		 * `plugins/marketplaces/<name>` fallback for every non-directory
		 * source, so a registry pointing elsewhere sent the two files to
		 * different trees. */
		const f = fixture({
			pinRef: "v1.1.8",
			installedVersion: "1.1.8",
			supplyTag: "v1.1.8",
			marketplaceDir: "supply-elsewhere",
		});

		const state = readPluginState(f);
		expect(state.supply.dir).toBe(f.supplyDir);
		expect(f.supplyDir).not.toBe(f.clone);
		expect(state.supply.ref).toBe("v1.1.8");
		expect(state.gaps.supplyBehindPin).toBe(false);
	});
});

describe("findPin counts only the marketplaces the settings themselves name (#474)", () => {
	const none = { marketplace: null, ref: null, source: null };
	it.each([
		["an inherited key", "constructor", { wc: { source: { ref: "v1.1.8" } } }],
		["a string", "wc", "wc"],
		["an array's index", "0", [{ source: { ref: "v1.1.8" } }]],
	])("reads no pin, rather than throwing, from %s", (_, marketplace, known) => {
		const settings = {
			enabledPlugins: { [`workflow-core@${marketplace}`]: true },
			extraKnownMarketplaces: known,
		};
		/* Malformed on purpose: the file is the CLI's, not typed input. */
		const malformed = settings as unknown as Parameters<typeof findPin>[0];
		expect(findPin(malformed, "workflow-core")).toEqual(none);
	});
});

describe("isCoreHost tells workflow-core from an adopter (#1509)", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const dir of roots.splice(0))
			fs.rmSync(dir, { recursive: true, force: true });
	});
	function hostWith(manifest: string | null) {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "wfc-core-host-"));
		roots.push(root);
		if (manifest !== null) {
			fs.mkdirSync(path.join(root, ".claude-plugin"));
			fs.writeFileSync(
				path.join(root, ".claude-plugin", "plugin.json"),
				manifest,
			);
		}
		return root;
	}

	it("answers true where the host's manifest names workflow-core", () => {
		expect(
			isCoreHost(hostWith(JSON.stringify({ name: "workflow-core" }))),
		).toBe(true);
	});

	it.each([
		["another plugin's manifest", JSON.stringify({ name: "fantasy-books" })],
		["a manifest naming nothing", JSON.stringify({})],
		["an unparseable manifest", "{"],
		["no manifest", null],
	])("answers false for %s", (_, manifest) => {
		expect(isCoreHost(hostWith(manifest))).toBe(false);
	});
});
