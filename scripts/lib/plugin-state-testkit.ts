/*
 * plugin-state-testkit.ts — the fixture adopter tree the four-record read
 * (#243) and its SessionStart reporter are both exercised against, one
 * builder for both (#251 item 13).
 *
 * Everything lands under `os.tmpdir()` and `configDir` is threaded
 * explicitly, so no case can touch this machine's real registry (#238 user
 * story 48).
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";

export interface AdopterFixture {
	/** the adopter repo root, whose `.claude/settings.json` carries the pin */
	root: string;
	/** the plugin tree this session loaded — `CLAUDE_PLUGIN_ROOT`'s stand-in */
	pluginRoot: string;
	configDir: string;
	marketplace: string;
	/** the default supply path, `<configDir>/plugins/marketplaces/<name>` */
	clone: string;
	/** where the supply clone was actually built — `marketplaceDir` or `clone` */
	supplyDir: string;
	/** the install record's `installPath` for `root` */
	installPath: string;
}

export interface FixtureOptions {
	/** `source.ref`: a tag, a branch name or a SHA — all three are accepted here */
	pinRef?: string | null;
	pinSource?: "url" | "directory";
	/** the pin's clone URL, which the printed `marketplace add` substitutes */
	pinUrl?: string;
	/** the version in the install record and at its `installPath` */
	installedVersion?: string;
	/**
	 * the version of the plugin tree the session loaded. Defaults to
	 * `installedVersion` — set it apart to build *materialised but not yet
	 * live*, where disk is current and this process is not.
	 */
	loadedVersion?: string;
	marketplace?: string;
	pluginName?: string;
	/** a git clone at the supply path, on this tag */
	supplyTag?: string;
	/** a git clone at the supply path, left on this branch */
	supplyBranch?: string;
	/**
	 * where `known_marketplaces.json` points, and as what kind of source.
	 * Setting it moves the supply clone there too. A relative path resolves
	 * under this fixture's own throwaway tree, so the cleanup reaches it; an
	 * absolute one is taken as given, for a directory source that is never
	 * built.
	 */
	marketplaceDir?: string;
	marketplaceSource?: "git" | "directory";
	/** omit the `known_marketplaces.json` entry entirely */
	unregisteredMarketplace?: boolean;
}

export function writeJson(at: string, doc: unknown) {
	fs.mkdirSync(path.dirname(at), { recursive: true });
	fs.writeFileSync(at, JSON.stringify(doc));
}

/** A real git checkout at `dir`, on a tag, a non-default branch, or neither. */
function gitCloneAt(
	dir: string,
	{ tag, branch }: { tag?: string; branch?: string },
) {
	fs.mkdirSync(dir, { recursive: true });
	execSync("git init -q -b main", { cwd: dir });
	execSync(
		"git -c user.email=a@a -c user.name=a commit -q --allow-empty -m x",
		{
			cwd: dir,
		},
	);
	if (tag) execSync(`git tag ${tag}`, { cwd: dir });
	if (branch && branch !== "main")
		execSync(`git checkout -q -b ${branch}`, { cwd: dir });
}

/**
 * Registers the `afterEach` that removes every tree built through the
 * returned builder, and hands back the builder.
 */
export function adopterFixtures(prefix: string) {
	let made: string[] = [];

	afterEach(() => {
		for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
		made = [];
	});

	/**
	 * A fixture adopter root, plugin root and config dir, wired together the
	 * way a real install does: `enabledPlugins`/`extraKnownMarketplaces` in
	 * the root's settings, an install row in the config dir's
	 * `installed_plugins.json`, and that row's `installPath` carrying its own
	 * `plugin.json`.
	 */
	return function fixture(options: FixtureOptions = {}): AdopterFixture {
		const {
			pinRef,
			pinSource = "url",
			pinUrl,
			installedVersion = "1.1.8",
			loadedVersion = installedVersion,
			marketplace = "wc",
			pluginName = "workflow-core",
			supplyTag,
			supplyBranch,
			marketplaceDir,
			marketplaceSource = "git",
			unregisteredMarketplace = false,
		} = options;

		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
		made.push(tmp);
		const root = path.join(tmp, "adopter");
		const pluginRoot = path.join(tmp, "plugin");
		const configDir = path.join(tmp, "config");
		const clone = path.join(configDir, "plugins/marketplaces", marketplace);

		writeJson(path.join(pluginRoot, ".claude-plugin", "plugin.json"), {
			name: pluginName,
			version: loadedVersion,
		});

		const source: Record<string, unknown> =
			pinSource === "directory"
				? { source: "directory", path: "/some/adopter-owned/dir" }
				: { source: "url", url: pinUrl, ref: pinRef };
		writeJson(path.join(root, ".claude", "settings.json"), {
			enabledPlugins: { [`${pluginName}@${marketplace}`]: true },
			extraKnownMarketplaces: { [marketplace]: { source } },
		});

		const installPath = path.join(
			configDir,
			"plugins/cache",
			marketplace,
			installedVersion,
		);
		writeJson(path.join(configDir, "plugins", "installed_plugins.json"), {
			plugins: {
				[`${pluginName}@${marketplace}`]: [
					{ projectPath: root, installPath, version: installedVersion },
				],
			},
		});
		writeJson(path.join(installPath, ".claude-plugin", "plugin.json"), {
			version: installedVersion,
		});

		const supplyDir = marketplaceDir
			? path.resolve(tmp, marketplaceDir)
			: clone;
		if (supplyTag || supplyBranch)
			gitCloneAt(supplyDir, { tag: supplyTag, branch: supplyBranch });

		if (!unregisteredMarketplace) {
			const dir = supplyDir;
			writeJson(path.join(configDir, "plugins", "known_marketplaces.json"), {
				[marketplace]:
					marketplaceSource === "directory"
						? {
								source: { source: "directory", path: dir },
								installLocation: dir,
							}
						: {
								source: { source: "git", url: "https://example.invalid/x.git" },
								installLocation: dir,
							},
			});
		}

		return {
			root,
			pluginRoot,
			configDir,
			marketplace,
			clone,
			supplyDir,
			installPath,
		};
	};
}
