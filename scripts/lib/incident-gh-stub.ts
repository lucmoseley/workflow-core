/**
 * `gh` over one tracker's incident tickets (`tickets.json`), logging every
 * call to `calls.log`. A create appends to `tickets.json`, so a second run
 * sees the first's ticket. The similar-title list holds the tickets among
 * enough unrelated titles that an earlier incident's scores above the cut.
 */
export const INCIDENT_GH_STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const f = (n) => path.join(process.env.STUB_DIR, n);
const a = process.argv.slice(2);
const read = (n) => JSON.parse(fs.readFileSync(f(n), "utf8"));
const say = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0); };
fs.appendFileSync(f("calls.log"), a.join(" ") + "\\n");
if (fs.existsSync(f("down"))) { process.stderr.write("HTTP 502\\n"); process.exit(1); }
if (a[0] === "api" && a[1] === "repos/acme/wfc/labels") say([[{ name: "takes:triage" }]]);
if (a[0] === "issue" && a[1] === "list" && a.includes("--search")) say(read("tickets.json"));
if (a[0] === "issue" && a[1] === "list") say([
	...read("tickets.json"),
	...Array.from({ length: 100 }, (_, i) => ({ number: i + 1, title: "Fix widget " + i, state: "CLOSED" })),
]);
if (a[0] === "issue" && a[1] === "create") {
	const tickets = read("tickets.json");
	const number = 900 + tickets.length;
	const title = a[a.indexOf("--title") + 1];
	const labels = a.flatMap((x, i) => (a[i - 1] === "--label" ? [x] : []));
	fs.writeFileSync(f("created-" + number + ".json"), JSON.stringify({ title, labels, body: fs.readFileSync(0, "utf8") }));
	fs.writeFileSync(f("tickets.json"), JSON.stringify([...tickets, { number, title, state: "OPEN" }]));
	process.stdout.write("https://github.com/acme/wfc/issues/" + number + "\\n");
	process.exit(0);
}
process.stderr.write("gh stub: unsupported: " + a.join(" ") + "\\n");
process.exit(1);
`;
