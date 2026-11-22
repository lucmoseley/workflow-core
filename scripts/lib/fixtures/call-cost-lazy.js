const mode = process.argv[2];
if (mode === "rare") require("./call-cost-rare.js");
if (mode === "fail") process.exitCode = 3;
if (mode === "noisy") process.stderr.write("stray\n");
if (mode === "throw") throw new Error("boom");
