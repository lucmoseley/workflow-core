import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import { shellQuote } from "./sh-quote.js";

export interface AdopterFixture {
	root: string;
	pluginRoot: string;
	configDir: string;
	marketplace: string;
	clone: string;
	supplyDir: string;
	installPath: string;
}

export interface FixtureOptions {
	pinRef?: string | null;
	pinSource?: "url" | "directory";
	pinUrl?: string;
	installedVersion?: string;
	loadedVersion?: string;
	marketplace?: string;
	pluginName?: string;
	supplyTag?: string;
	supplyBranch?: string;
	marketplaceDir?: string;
	marketplaceSource?: "git" | "directory";
	unregisteredMarketplace?: boolean;
}

export function writeJson(at: string, doc: unknown) {
	fs.mkdirSync(path.dirname(at), { recursive: true });
	fs.writeFileSync(at, JSON.stringify(doc));
}

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
	if (tag) execSync(`git tag ${shellQuote(tag)}`, { cwd: dir });
	if (branch && branch !== "main")
		execSync(`git checkout -q -b ${shellQuote(branch)}`, { cwd: dir });
}

export function adopterFixtures(prefix: string) {
	let made: string[] = [];

	afterEach(() => {
		for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
		made = [];
	});

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
