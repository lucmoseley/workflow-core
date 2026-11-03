// @vitest-environment node
/*
 * The check-wsl-currency core (#4082). Loosened, a machine behind upstream
 * reads as current, or an unread version as a pass.
 */
import { describe, expect, it } from "vitest";

const { judgeCurrency } = require("./wsl-currency.js") as {
	judgeCurrency: (ports: object) => { state: string; lines: string[] };
};

const stable = (...tags: string[]) =>
	tags.map((tagName) => ({
		tag_name: tagName,
		prerelease: false,
		draft: false,
	}));

const judge = (ports: object = {}) =>
	judgeCurrency({
		readKernelRelease: () => "6.18.33.2-microsoft-standard-WSL2\n",
		readInstalled: () => ({ version: "2.7.11.0" }),
		readLatest: () => ({ tag_name: "3.0.3" }),
		readReleases: () =>
			stable("3.0.3", "3.0.1", "2.7.14", "2.7.13", "2.7.12", "2.7.11"),
		...ports,
	});

const notRead = () => {
	throw new Error("read where the case needs no read");
};

describe("not WSL", () => {
	it("is decided on the kernel release alone, reading nothing else", () => {
		expect(
			judge({
				readKernelRelease: () => "6.8.0-45-generic\n",
				readInstalled: notRead,
				readLatest: notRead,
				readReleases: notRead,
			}),
		).toEqual({ state: "NOT_WSL", lines: [] });
	});
});

describe("unread", () => {
	const line = (ports: object) => {
		const { state, lines } = judge(ports);
		expect(state).toBe("UNREAD");
		return lines.join(" ");
	};

	it("names a kernel release that will not read, never reading it as not WSL", () => {
		expect(line({ readKernelRelease: () => ({ why: "EACCES" }) })).toContain(
			"the kernel release: EACCES",
		);
	});

	it("names each read that failed, with its reason", () => {
		const text = line({
			readInstalled: () => ({ why: "exited 1" }),
			readLatest: () => ({ why: "HTTP 404" }),
			readReleases: () => ({ why: "HTTP 500" }),
		});
		expect(text).toContain("wsl.exe --version: exited 1");
		expect(text).toContain("the latest release: HTTP 404");
		expect(text).toContain("the release list: HTTP 500");
	});

	it("names a latest with no tag, and an empty release list", () => {
		expect(line({ readLatest: () => ({}) })).toContain(
			"the latest release: gh answered with no tag",
		);
		expect(line({ readReleases: () => [] })).toContain(
			"the release list: gh answered with none",
		);
	});

	it("names versions that will not compare", () => {
		expect(line({ readLatest: () => ({ tag_name: "nightly" }) })).toContain(
			"2.7.11.0 against nightly",
		);
	});
});

describe("behind", () => {
	it("names both versions and the count, then the commands, in order", () => {
		const { state, lines } = judge();
		expect(state).toBe("BEHIND");
		expect(lines.slice(0, 3)).toEqual([
			"WSL 2.7.11.0 is 5 stable releases behind 3.0.3.",
			"To update, first in WSL: node scripts/refill-loop.js set --pause",
			"Then in Windows PowerShell: wsl --update",
		]);
		expect(lines[3]).toContain("by itself when its download finishes");
		expect(lines[3]).toContain("ends every session");
	});

	it("says one release in the singular", () => {
		expect(
			judge({
				readLatest: () => ({ tag_name: "2.7.12" }),
				readReleases: () => stable("2.7.12", "2.7.11"),
			}).lines[0],
		).toBe("WSL 2.7.11.0 is 1 stable release behind 2.7.12.");
	});

	it("leaves pre-releases, drafts and unversioned tags out of the count", () => {
		expect(
			judge({
				readReleases: () => [
					{ tag_name: "3.0.5", prerelease: true, draft: false },
					{ tag_name: "3.0.4", prerelease: false, draft: true },
					...stable("nightly", "3.0.3"),
				],
			}).lines[0],
		).toBe("WSL 2.7.11.0 is 1 stable release behind 3.0.3.");
	});

	it("compares numerically: 2.10.0 is above 2.9.0", () => {
		expect(
			judge({
				readInstalled: () => ({ version: "2.9.0.0" }),
				readLatest: () => ({ tag_name: "2.10.0" }),
				readReleases: () => stable("2.10.0", "2.9.0"),
			}).lines[0],
		).toBe("WSL 2.9.0.0 is 1 stable release behind 2.10.0.");
	});
});

describe("current", () => {
	it("names both, the missing fourth component reading 0", () => {
		expect(judge({ readInstalled: () => ({ version: "3.0.3.0" }) })).toEqual({
			state: "CURRENT",
			lines: ["WSL 3.0.3.0 is current: the latest stable release is 3.0.3."],
		});
	});

	it("holds ahead on a pre-release", () => {
		expect(judge({ readInstalled: () => ({ version: "3.0.5.0" }) }).state).toBe(
			"CURRENT",
		);
	});
});
