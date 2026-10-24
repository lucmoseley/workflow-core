# Starting a new repo

`/new-repo` takes an idea to a new private repo on the workflow core, ready for its first session. You type it in a workflow-core session you are watching.

## What it does

For an empty repo, you end with a private GitHub repo under your account, cloned into your home folder; the workflow core adopted in it, pinned to the core's newest release so it can upgrade itself; its first wayfinder map, holding your idea word for word with the destination left for the first session; the Project section of its CLAUDE.md filled from the one-liner you approved; three launch aliases in ~/.bashrc, one per plan; and all of it committed and pushed. No modules are on.

For a copied repo, the same, starting from a copy of a source repo — someone else's repo you build on. Only its default branch, renamed main, and its tags come across, never a fork, so your copy is private even when the source repo is public. The source repo stays reachable for pulling, never for pushing. Its own agent instructions are set aside where no session loads them, with a ticket on the map to decide what comes back; its own pre-commit checks keep running after the core's; its documents are registered as the source repo's. Where its tests are found, their gate starts on. Its licence and any workflows that will run in your repo are reported.

## One-time setup per machine

Two settings, both already in place on this machine:

- An allow rule in workflow-core's local settings file, letting the new-repo script run without a permission prompt.
- A trusted-repos line in each Claude config's settings, telling auto mode that your private repos and their origin remotes are yours, so a session in the new repo may push.

A new machine, or a new Claude config folder, needs both again: ask a workflow-core session to add them.

## What you approve

It asks, one at a time: your idea, in your own words, asked once and kept as written; the repo name; a source repo to copy, or none; a spec already written on another tracker, or none; and other trackers holding rulings for this repo, pre-filled with any your idea names.

It then drafts two things for you to approve or change: the Project one-liner and the first map's title. Last, it asks the alias prefix as a question of its own, pre-filled with the repo name's initials, so design-vault gives dv1, dv2 and dv3. A prefix clashing with anything you already type is refused, and it asks again.

Then comes one confirmation: a dry run that makes every check first and shows what will happen — the private repo, the push, the exact block for ~/.bashrc, and the modules. Nothing is written until you say yes. After the yes no permission prompt follows; it runs to the end. ~/.bashrc is backed up before the block goes in, checked after, and restored from the backup if the check fails.

## What you get

A report with one line per step, each done, skipped, repaired or STOPPED. Then the ~/.bashrc block with its line range — written, or kept as it was where you already had one; a line telling you to open a new terminal tab and which alias to type there, the one for the plan you are on; and the first prompt, ready to paste into that new session. That session fills the map in.

An empty repo starts with no modules and no test command. Once its first test, roadmap, manual or site lands, its next commit is refused until the matching switch is set, so no gate waits on anyone remembering it.

## When it stops part-way

Nothing is undone. A re-run carries on from where it stopped, skipping whatever is already there — a step you finished by hand included.

Read the script's own report. The STOPPED line says what went wrong, and the lines under it say what to do and give the command to paste. The exit code says which kind of stop it is:

- **0** — finished
- **1** — stopped, a plain re-run should finish it
- **2** — refused until you act by hand

On a 2, do the manual step the report names first, then re-run. Once the repo is cloned the re-run is `--resume <name>`, the name being the repo's: it reuses the answers you gave and refuses any argument that differs from them, so the map and the aliases cannot change half-way. A stop before the clone saved nothing, so the report gives the full command to re-run instead. Where no re-run can finish, the report says to start again with `/new-repo`.

Where the new repo's own checks refuse its first commit, open a new tab, type the new alias, fix it in that session under that repo's own rules, then re-run from workflow-core.

## Changing modules later

A module switches on extra rules and gates. Each needs documents or tests a new repo does not have yet, which is why an empty repo starts with them off. A copied repo starts with each one on whose subject it already holds. Once a subject lands, a commit is refused until its switch is set.

- **roadmap** — the roadmap page and its digest, changed only through the roadmap-edit skill. On once the roadmap page exists.
- **governance** — the document map's figure registry and the operating manual. On once the manual or a figure-registry entry exists.
- **suites** — the test-suite rules: a push warns unless its commit has a green run. On for a copied repo holding tests or a test command. Any test file also needs its test command declared, whatever this module says.
- **site** — the rendered pages and their copy checks, gating a commit that touches them. On once the brand sheet and the site's pages both exist.
- **mutation** — a commit changing a line on a declared sensitive path is refused while a planted bug on that line survives every test. Never on by itself: switch it on only where those paths are tested in-process by vitest.
- **landing** — sessions push to a landing branch, and main moves only to a commit the full suite passed. Off until a release turns it on.

To switch one on, ask a session in that repo to. It adds the module to the repo's workflow-core settings and re-runs the core's setup, which reads them.

## What it does not do

- Upgrade a repo already on the core to a newer release — #207.
- Move a repo carrying its own copy of the machinery onto the core — the fantasy-books route, #83 to #87.
- Write a PRODUCT.md, a DESIGN.md or a roadmap.
- Bring issues or a spec across from another tracker: the map cites the spec, and the first session decides what to transfer.
- Delete anything it made, on a stop or ever, save putting ~/.bashrc back as it was when its check fails. Deleting a repo it made, and its ~/.bashrc block, is yours to do by hand.
