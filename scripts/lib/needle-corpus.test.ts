// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { needleDrift } = require("./needle-corpus.js");

const REGISTRY = "scripts/guard-fire-needles.json";

let root: string;

function registry(needleText: string) {
	return JSON.stringify({
		guards: { "guard-x.sh": { needles: [{ id: "n1", text: needleText }] } },
		candidates: {},
	});
}

function seed(guardText: string, needleText: string) {
	fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
	fs.writeFileSync(path.join(root, "scripts", "guard-x.sh"), guardText);
	fs.writeFileSync(path.join(root, REGISTRY), registry(needleText));
}

const headOf =
	(bodies: Record<string, string | null>) =>
	(rel: string): string | null => {
		if (!(rel in bodies)) throw new Error(`unexpected HEAD read of ${rel}`);
		return bodies[rel];
	};

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "needle-corpus-"));
});

afterEach(() => {
	vi.restoreAllMocks();
	fs.rmSync(root, { recursive: true, force: true });
});

describe("which literals a registry keys", () => {
	const keyed = (reg: Record<string, unknown>) => {
		fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
		fs.writeFileSync(path.join(root, "scripts", "guard-x.sh"), "x");
		fs.writeFileSync(path.join(root, REGISTRY), JSON.stringify(reg));
		const { broken, failOpen } = needleDrift({
			root,
			landing: [REGISTRY],
			readHead: headOf({ [REGISTRY]: "{}" }),
		});
		expect(failOpen).toBe(null);
		return broken.map(({ key, id, text }: Record<string, string>) => ({
			key,
			id,
			text,
		}));
	};

	it("flattens an array `text` into one entry per literal", () => {
		const texts = keyed({
			guards: { "g.sh": { needles: [{ id: "n", text: ["a", "b"] }] } },
			candidates: {},
		});
		expect(texts.map((t: { text: string }) => t.text)).toEqual(["a", "b"]);
	});

	it("reads candidates as well as guards, both being asserted", () => {
		const texts = keyed({
			guards: {},
			candidates: { "c.sh": { needles: [{ id: "n", text: "only here" }] } },
		});
		expect(texts).toEqual([{ key: "c.sh", id: "n", text: "only here" }]);
	});

	it("skips an entry with no needles rather than throwing on it", () => {
		expect(keyed({ guards: { "g.sh": { silent: "prints nothing" } } })).toEqual(
			[],
		);
	});
});

describe("needleDrift, on a commit landing the guard alone", () => {
	it("names a literal this commit stopped printing", () => {
		seed("deny 'the NEW wording'", "the OLD wording");
		const { broken, failOpen } = needleDrift({
			root,
			landing: ["scripts/guard-x.sh"],
			readHead: headOf({
				"scripts/guard-x.sh": "deny 'the OLD wording'",
				[REGISTRY]: registry("the OLD wording"),
			}),
		});
		expect(failOpen).toBe(null);
		expect(broken).toEqual([
			{ key: "guard-x.sh", id: "n1", text: "the OLD wording", arriving: false },
		]);
	});

	it("reads the registry from HEAD, so fixing the needle on disk alone does not acquit the commit", () => {
		seed("deny 'the NEW wording'", "the NEW wording");
		const { broken, failOpen } = needleDrift({
			root,
			landing: ["scripts/guard-x.sh"],
			readHead: headOf({
				"scripts/guard-x.sh": "deny 'the OLD wording'",
				[REGISTRY]: registry("the OLD wording"),
			}),
		});
		expect(failOpen).toBe(null);
		expect(broken).toEqual([
			{ key: "guard-x.sh", id: "n1", text: "the OLD wording", arriving: false },
		]);
	});

	it("stays silent where the wording did not move", () => {
		seed("deny 'the OLD wording'", "the OLD wording");
		const { broken, failOpen } = needleDrift({
			root,
			landing: ["scripts/guard-x.sh"],
			readHead: headOf({
				"scripts/guard-x.sh": "deny 'the OLD wording'",
				[REGISTRY]: registry("the OLD wording"),
			}),
		});
		expect(failOpen).toBe(null);
		expect(broken).toEqual([]);
	});

	it("stays silent on a literal that was already missing before this commit", () => {
		seed("deny 'the NEW wording'", "text nothing ever printed");
		const { broken, failOpen } = needleDrift({
			root,
			landing: ["scripts/guard-x.sh"],
			readHead: headOf({
				"scripts/guard-x.sh": "deny 'the OLD wording'",
				[REGISTRY]: registry("text nothing ever printed"),
			}),
		});
		expect(failOpen).toBe(null);
		expect(broken).toEqual([]);
	});

	it("stays silent where another corpus file still prints the literal", () => {
		seed("deny 'the NEW wording'", "the OLD wording");
		fs.writeFileSync(
			path.join(root, "scripts", "guard-y.sh"),
			"deny 'the OLD wording'",
		);
		const { broken, failOpen } = needleDrift({
			root,
			landing: ["scripts/guard-x.sh"],
			readHead: headOf({
				"scripts/guard-x.sh": "deny 'the OLD wording'",
				[REGISTRY]: registry("the OLD wording"),
			}),
		});
		expect(failOpen).toBe(null);
		expect(broken).toEqual([]);
	});

	it("treats a guard this commit ADDS as having printed nothing before it", () => {
		seed("deny 'the NEW wording'", "the NEW wording");
		const { broken, failOpen } = needleDrift({
			root,
			landing: ["scripts/guard-x.sh"],
			readHead: headOf({
				"scripts/guard-x.sh": null,
				[REGISTRY]: registry("the NEW wording"),
			}),
		});
		expect(failOpen).toBe(null);
		expect(broken).toEqual([]);
	});

	it("names a literal lost with a file this commit deletes", () => {
		seed("deny 'something else'", "the OLD wording");
		fs.rmSync(path.join(root, "scripts", "guard-x.sh"));
		fs.writeFileSync(path.join(root, "scripts", "guard-z.sh"), "deny 'else'");
		expect(
			needleDrift({
				root,
				landing: ["scripts/guard-x.sh"],
				readHead: headOf({
					"scripts/guard-x.sh": "deny 'the OLD wording'",
					[REGISTRY]: registry("the OLD wording"),
				}),
			}).broken,
		).toEqual([
			{ key: "guard-x.sh", id: "n1", text: "the OLD wording", arriving: false },
		]);
	});

	it("never counts the registry itself as a printer (mantahostels#2135)", () => {
		seed("deny 'the NEW wording'", "the OLD wording");
		expect(
			needleDrift({
				root,
				landing: ["scripts/guard-x.sh"],
				readHead: headOf({
					"scripts/guard-x.sh": "deny 'the OLD wording'",
					[REGISTRY]: registry("the OLD wording"),
				}),
			}).broken,
		).toHaveLength(1);
	});

	it("never reads HEAD for a landing path outside the corpus dirs", () => {
		seed("deny 'the NEW wording'", "the OLD wording");
		expect(
			needleDrift({
				root,
				landing: ["package.json", "scripts/guard-x.sh"],
				readHead: headOf({
					"scripts/guard-x.sh": "deny 'the OLD wording'",
					[REGISTRY]: registry("the OLD wording"),
				}),
			}).failOpen,
		).toBe(null);
	});
});

describe("needleDrift, given the landing copies", () => {
	it("judges a printer on the copy handed to it, not the one on disk", () => {
		seed("deny 'the OLD wording'", "the OLD wording");
		const { broken, failOpen } = needleDrift({
			root,
			landing: ["scripts/guard-x.sh"],
			readHead: headOf({
				"scripts/guard-x.sh": "deny 'the OLD wording'",
				[REGISTRY]: registry("the OLD wording"),
			}),
			readLanding: () => "deny 'the NEW wording'",
		});
		expect(failOpen).toBe(null);
		expect(broken).toEqual([
			{ key: "guard-x.sh", id: "n1", text: "the OLD wording", arriving: false },
		]);
	});

	it("drops a printer the commit removes, though it is still on disk", () => {
		seed("deny 'the OLD wording'", "the OLD wording");
		const { broken, failOpen } = needleDrift({
			root,
			landing: ["scripts/guard-x.sh"],
			readHead: headOf({
				"scripts/guard-x.sh": "deny 'the OLD wording'",
				[REGISTRY]: registry("the OLD wording"),
			}),
			readLanding: () => null,
		});
		expect(failOpen).toBe(null);
		expect(broken).toEqual([
			{ key: "guard-x.sh", id: "n1", text: "the OLD wording", arriving: false },
		]);
	});

	it("fails open where the landing copy cannot be read, carrying the read error", () => {
		seed("deny 'the NEW wording'", "the OLD wording");
		const { broken, failOpen } = needleDrift({
			root,
			landing: ["scripts/guard-x.sh"],
			readHead: headOf({
				"scripts/guard-x.sh": "deny 'the OLD wording'",
				[REGISTRY]: registry("the OLD wording"),
			}),
			readLanding: () => {
				throw new Error("the index is unreadable");
			},
		});
		expect(broken).toEqual([]);
		expect(failOpen).toContain("the index is unreadable");
	});

	it("reads the landing registry from the same copy", () => {
		seed("deny 'the NEW wording'", "the NEW wording");
		const { broken, failOpen } = needleDrift({
			root,
			landing: [REGISTRY],
			readHead: headOf({
				[REGISTRY]: JSON.stringify({ guards: {}, candidates: {} }),
			}),
			readLanding: () => registry("the OLD wording"),
		});
		expect(failOpen).toBe(null);
		expect(broken).toEqual([
			{ key: "guard-x.sh", id: "n1", text: "the OLD wording", arriving: true },
		]);
	});
});

describe("needleDrift, on a commit landing the registry", () => {
	const wasEmpty = JSON.stringify({ guards: {}, candidates: {} });

	it("names a needle this commit adds keyed on text nothing prints", () => {
		seed("deny 'the wording'", "wording that was never printed");
		expect(
			needleDrift({
				root,
				landing: [REGISTRY],
				readHead: headOf({ [REGISTRY]: wasEmpty }),
			}).broken,
		).toEqual([
			{
				key: "guard-x.sh",
				id: "n1",
				text: "wording that was never printed",
				arriving: true,
			},
		]);
	});

	it("stays silent on a needle this commit adds whose text is printed", () => {
		seed("deny 'the wording'", "the wording");
		const { broken, failOpen } = needleDrift({
			root,
			landing: [REGISTRY],
			readHead: headOf({ [REGISTRY]: wasEmpty }),
		});
		expect(failOpen).toBe(null);
		expect(broken).toEqual([]);
	});

	it("allows where HEAD names no registry at all, rather than reading every needle as added", () => {
		seed("deny 'the wording'", "wording that was never printed");
		const { broken, failOpen } = needleDrift({
			root,
			landing: [REGISTRY],
			readHead: headOf({ [REGISTRY]: null }),
		});
		expect(failOpen).toBe(null);
		expect(broken).toEqual([]);
	});

	it("fails open on an unparseable HEAD registry, naming the registry file", () => {
		seed("deny 'the wording'", "wording that was never printed");
		expect(
			needleDrift({
				root,
				landing: [REGISTRY],
				readHead: headOf({ [REGISTRY]: "{ not json" }),
			}).failOpen,
		).toContain("guard-fire-needles.json");
	});
});

describe("needleDrift's fail-open paths", () => {
	it("answers with no needles at all where HEAD names no registry and none lands", () => {
		seed("deny 'the NEW wording'", "the OLD wording");
		const { broken, failOpen } = needleDrift({
			root,
			landing: ["scripts/guard-x.sh"],
			readHead: headOf({
				"scripts/guard-x.sh": "deny 'the OLD wording'",
				[REGISTRY]: null,
			}),
		});
		expect(failOpen).toBe(null);
		expect(broken).toEqual([]);
	});

	it("fails open, naming the reason, where git could not read HEAD", () => {
		seed("deny 'the NEW wording'", "the OLD wording");
		const { broken, failOpen } = needleDrift({
			root,
			landing: ["scripts/guard-x.sh"],
			readHead: () => {
				throw new Error("object store unreadable");
			},
		});
		expect(broken).toEqual([]);
		expect(failOpen).toContain("object store unreadable");
	});

	it("fails open on an unparseable working-tree registry, naming the registry file", () => {
		seed("deny 'the NEW wording'", "the OLD wording");
		fs.writeFileSync(path.join(root, REGISTRY), "{ not json");
		expect(
			needleDrift({
				root,
				landing: [REGISTRY],
				readHead: headOf({ [REGISTRY]: registry("the OLD wording") }),
			}).failOpen,
		).toContain("guard-fire-needles.json");
	});

	it.skipIf(process.getuid?.() === 0)(
		"fails open, naming the file, where a corpus file cannot be read (#1983)",
		() => {
			seed("deny 'the OLD wording'", "the OLD wording");
			fs.chmodSync(path.join(root, "scripts", "guard-x.sh"), 0o000);
			const { broken, failOpen } = needleDrift({
				root,
				landing: ["scripts/guard-x.sh"],
				readHead: headOf({
					"scripts/guard-x.sh": "deny 'the OLD wording'",
					[REGISTRY]: registry("the OLD wording"),
				}),
			});
			expect(broken).toEqual([]);
			expect(failOpen).toContain("guard-x.sh");
		},
	);

	it("reads a corpus file gone before its read as absent, not as a fail-open (#1983)", () => {
		seed("deny 'the OLD wording'", "the OLD wording");
		fs.writeFileSync(path.join(root, "scripts", "guard-y.sh"), "deny 'other'");
		const gone = path.join(root, "scripts", "guard-y.sh");
		const read = fs.readFileSync;
		vi.spyOn(fs, "readFileSync").mockImplementation((p, ...rest) => {
			if (p === gone)
				throw Object.assign(new Error(`ENOENT: no such file, open '${p}'`), {
					code: "ENOENT",
				});
			return read(p, ...rest);
		});
		const { broken, failOpen } = needleDrift({
			root,
			landing: ["scripts/guard-x.sh"],
			readHead: headOf({
				"scripts/guard-x.sh": "deny 'the OLD wording'",
				[REGISTRY]: registry("the OLD wording"),
			}),
		});
		expect(failOpen).toBe(null);
		expect(broken).toEqual([]);
	});

	it("does not follow a symlinked directory, nor fail open on one (#1983)", () => {
		seed("deny 'the NEW wording'", "the OLD wording");
		const vendored = path.join(root, ".agents", "skills", "x");
		fs.mkdirSync(vendored, { recursive: true });
		fs.writeFileSync(path.join(vendored, "SKILL.md"), "the OLD wording");
		fs.symlinkSync(vendored, path.join(root, "scripts", "x"), "dir");
		const { broken, failOpen } = needleDrift({
			root,
			landing: ["scripts/guard-x.sh"],
			readHead: headOf({
				"scripts/guard-x.sh": "deny 'the OLD wording'",
				[REGISTRY]: registry("the OLD wording"),
			}),
		});
		expect(failOpen).toBe(null);
		expect(broken).toEqual([
			{ key: "guard-x.sh", id: "n1", text: "the OLD wording", arriving: false },
		]);
	});

	it("reads a symlinked file as a printer, and skips a dangling link (#1983)", () => {
		seed("deny 'the NEW wording'", "the OLD wording");
		const target = path.join(root, ".agents", "guard-z.sh");
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, "deny 'the OLD wording'");
		fs.symlinkSync(target, path.join(root, "scripts", "guard-z.sh"));
		fs.symlinkSync(
			path.join(root, "nowhere"),
			path.join(root, "scripts", "guard-gone.sh"),
		);
		const { broken, failOpen } = needleDrift({
			root,
			landing: ["scripts/guard-x.sh"],
			readHead: headOf({
				"scripts/guard-x.sh": "deny 'the OLD wording'",
				[REGISTRY]: registry("the OLD wording"),
			}),
		});
		expect(failOpen).toBe(null);
		expect(broken).toEqual([]);
	});

	it("fails open on an empty corpus, which is a broken read and not a repo", () => {
		const { broken, failOpen } = needleDrift({
			root,
			landing: ["scripts/guard-x.sh"],
			readHead: headOf({ "scripts/guard-x.sh": "x" }),
		});
		expect(broken).toEqual([]);
		expect(failOpen).toContain("empty");
	});
});

describe("test files are no part of the corpus", () => {
	it("does not let a guard's test rescue a needle the guard stopped printing", () => {
		seed("deny 'the NEW wording'", "the OLD wording");
		fs.writeFileSync(
			path.join(root, "scripts", "guard-x.test.ts"),
			'expect(why).toContain("the OLD wording");',
		);
		const { broken, failOpen } = needleDrift({
			root,
			landing: ["scripts/guard-x.sh"],
			readHead: headOf({
				"scripts/guard-x.sh": "deny 'the OLD wording'",
				[REGISTRY]: registry("the OLD wording"),
			}),
		});
		expect(failOpen).toBe(null);
		expect(broken).toEqual([
			{ key: "guard-x.sh", id: "n1", text: "the OLD wording", arriving: false },
		]);
	});

	it("does not read a test file this commit lands as a printer that was there before", () => {
		seed("deny 'something else'", "the OLD wording");
		fs.writeFileSync(
			path.join(root, "scripts", "guard-x.test.ts"),
			'expect(why).toContain("the NEW wording");',
		);
		const { broken, failOpen } = needleDrift({
			root,
			landing: ["scripts/guard-x.test.ts"],
			readHead: headOf({
				"scripts/guard-x.test.ts": 'toContain("the OLD wording")',
				[REGISTRY]: registry("the OLD wording"),
			}),
		});
		expect(failOpen).toBe(null);
		expect(broken).toEqual([]);
	});
});
