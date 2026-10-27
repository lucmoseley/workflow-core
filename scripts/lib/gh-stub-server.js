#!/usr/bin/env node
/*
 * gh-stub-server.js — one long-lived process answering a test's stateful `gh`
 * stub, so each call costs a bash start, not a node start (#2877).
 * `gh-stub.ts`'s `serveGhStub` starts it; `buildServerClient` writes the bash
 * `gh` each call runs.
 *
 * argv[2] is the handler: a function body called once per gh call with
 * (argv, env, cwd, stdin, out, err, exit, require). `out` and `err` append to
 * the call's streams; `exit(code)` ends the call, as falling off the end ends
 * it with 0, and a thrown error with 1. The port is printed on stdout, and the
 * server exits once its stdin closes.
 *
 * The wire, every field NUL-terminated. A request is cwd, argc, the args, the
 * environment's `K=V` entries, an empty field, then "1" and stdin's text or
 * "0" alone. The answer is the exit status, stdout and stderr.
 *
 * What it does not reproduce: a NUL in stdin is cut there, and one in an
 * answer is refused. `exit` throws, so a handler's own catch-all swallows it;
 * `process` is the server's, so `process.exit` ends every later call. Calls
 * are answered one at a time, so a handler that itself runs gh deadlocks. An
 * environment name bash cannot hold is not forwarded.
 */

const fs = require("node:fs");
const net = require("node:net");
const vm = require("node:vm");

/** The client's exit where the server never answered: sysexits' EX_SOFTWARE. */
const NO_ANSWER = 70;

/**
 * The bash `gh` that hands its call to the server on `port`. It forwards
 * stdin only where an argument names it (`-`, `…@-`).
 * @param {number} port
 */
const buildServerClient = (port) => `#!/bin/bash
unreachable() { echo "gh stub: no answer from the server on port ${port}" >&2; exit ${NO_ANSWER}; }
trap '' PIPE
{ exec 3<>/dev/tcp/127.0.0.1/${port}; } 2>/dev/null || unreachable
piped=0
for x in "$@"; do [[ $x == - || $x == *@- ]] && piped=1; done
{
	printf '%s\\0' "$PWD" "$#" "$@"
	for n in $(compgen -e); do printf '%s=%s\\0' "$n" "\${!n}"; done
	printf '\\0%s\\0' "$piped"
	if [[ $piped == 1 ]]; then IFS= read -r -d '' body; printf '%s\\0' "$body"; fi
} >&3
IFS= read -r -d '' status <&3 || unreachable
IFS= read -r -d '' out <&3
IFS= read -r -d '' err <&3
printf '%s' "$out"
printf '%s' "$err" >&2
exit "$status"
`;

class Exit {
	/** @param {number} code */
	constructor(code) {
		this.code = code;
	}
}

/**
 * The request in `fields`, or null while it is still arriving.
 * @param {string[]} fields
 */
function parseRequest(fields) {
	if (fields.length < 2) return null;
	const argc = Number(fields[1]);
	if (fields.length < 2 + argc) return null;
	const end = fields.indexOf("", 2 + argc);
	if (end < 0 || fields.length < end + 2) return null;
	const piped = fields[end + 1] === "1";
	if (piped && fields.length < end + 3) return null;
	/** @type {Record<string, string>} */
	const env = {};
	for (const kv of fields.slice(2 + argc, end)) {
		const at = kv.indexOf("=");
		env[kv.slice(0, at)] = kv.slice(at + 1);
	}
	return {
		cwd: fields[0],
		argv: fields.slice(2, 2 + argc),
		env,
		stdin: piped ? fields[end + 2] : "",
	};
}

/**
 * @param {Function} handler
 * @param {NonNullable<ReturnType<typeof parseRequest>>} req
 */
function answer(handler, req) {
	let stdout = "";
	let stderr = "";
	let status = 0;
	try {
		handler(
			req.argv,
			req.env,
			req.cwd,
			req.stdin,
			(/** @type {string} */ s) => {
				stdout += s;
			},
			(/** @type {string} */ s) => {
				stderr += s;
			},
			(/** @type {number} */ code) => {
				throw new Exit(code);
			},
			require,
		);
	} catch (e) {
		if (e instanceof Exit) status = e.code;
		else {
			status = 1;
			stderr += `${e instanceof Error ? e.stack : String(e)}\n`;
		}
	}
	if (`${stdout}${stderr}`.includes("\0"))
		return "1\0\0gh stub: the handler answered a NUL, which the wire cannot carry\n\0";
	return `${status}\0${stdout}\0${stderr}\0`;
}

/** @param {string} handlerFile */
function serve(handlerFile) {
	const handler = vm.compileFunction(
		fs.readFileSync(handlerFile, "utf8"),
		["argv", "env", "cwd", "stdin", "out", "err", "exit", "require"],
		{ filename: handlerFile },
	);
	const server = net.createServer((sock) => {
		let text = "";
		sock.setEncoding("utf8");
		sock.on("data", (chunk) => {
			text += chunk;
			const req = parseRequest(text.split("\0").slice(0, -1));
			if (req) sock.end(answer(handler, req));
		});
		sock.on("error", () => {
			// A caller killed mid-call drops only its own connection, never the server.
		});
	});
	server.listen(0, "127.0.0.1", () => {
		const at = server.address();
		if (at === null || typeof at === "string")
			throw new Error("gh-stub-server: no TCP port");
		process.stdout.write(`${at.port}\n`);
	});
	process.stdin.on("end", () => process.exit(0));
	process.stdin.resume();
}

if (require.main === module) {
	const handlerFile = process.argv[2];
	if (!handlerFile) throw new Error("gh-stub-server: no handler file given");
	serve(handlerFile);
}

module.exports = { buildServerClient };
