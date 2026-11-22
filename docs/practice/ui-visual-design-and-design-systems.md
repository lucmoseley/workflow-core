# ui-visual-design-and-design-systems

Researched: 2026-10-24

## Real content in prototypes

- Fill candidates with real content and real data from the system, never lorem ipsum or invented names. Placeholder text hides lengths and shapes the real content has, and testers judge a fake setup less reliably. GDS Design Notes, "Prototyping tips" (2015-03-19: "Don't use Lorem Ipsum"; "We lose reliable insight by suspending reality"); NN/g, Laubheimer, "A Downside of Fake Copy in UI Prototypes" (2017); 37signals, Getting Real §11.4 "Use real words" ("Dummy text is a veil between you and reality") [named expert]
- Prototype at the fidelity of the real thing once details matter: a prototype made in the real medium looks and behaves like the live service, so it tests better. GOV.UK Service Manual, "Making prototypes" [standard or field body]; GDS Design Notes (refined prototypes need real data) [named expert]
- Show the decision-maker 3 to 5 candidates, then merge the best ideas rather than crown one. NN/g, Fessenden and Nielsen, "Parallel and iterative design" (2024 update) [named expert]; GOV.UK Service Manual, "Making prototypes" ("make and test multiple prototypes and discard the ones that do not test well") [standard or field body]. Tohidi, Buxton, Baecker and Sellen, CHI 2006, has no free full text and is unread.

## Host context and states

- Capture the real host surface at its real size before designing, and draw every candidate inside that capture, not on a blank canvas. For a tmux pane, `tmux display -p '#{pane_width}x#{pane_height}'` gives the size and `capture-pane -p -e` gives the content with its colour attributes. tmux 3.4 man page (what the commands do) [standard or field body]; the default to design in context rests on GOV.UK and GDS above.
- Draw each state the surface can be in, not only the happy one: at least ideal, empty, loading, partial and error, plus any attention state the brief names. Animated states are shown moving, or as a frame strip. 37signals, Getting Real §9.3 "Three state solution" (regular, blank, error); Scott Hurff, "How to fix a bad user interface" (UI Stack: ideal, empty, error, partial, loading) [named expert]; WCAG 2.2 SC 1.4.11 (each state's indicator must meet 3:1) [standard or field body]
- Motion: anything that moves, blinks or scrolls on its own for more than 5 seconds next to other content needs a way to pause, stop or hide it. Nothing flashes more than three times a second. WCAG 2.2 SC 2.2.2 and SC 2.3.1 [standard or field body]

## Contrast and colour

- Text needs 4.5:1 against its background (3:1 for large text). UI components and state indicators need 3:1 against adjacent colours. A toggle passes when its track contrasts with the background outside it and its knob contrasts with the track. Ratios are not rounded: 2.999:1 fails. Hover tints are exempt. WCAG 2.2 SC 1.4.3 and SC 1.4.11, with Understanding SC 1.4.11 [standard or field body]
- These ratios bind terminal and other non-web software "directly as written". Appearance left to the platform's defaults and not changed by the author is exempt. W3C, WCAG2ICT Group Note (2025-12-11) [standard or field body]
- Never signal state by colour alone; pair it with a glyph, a word or a shape change. WCAG 2.2 SC 1.4.1 [standard or field body]; Apple HIG, "Toggles" ("Avoid relying solely on different colors") [named expert]
- Treat the host palette as a constraint. The 16 ANSI colours are named slots whose hex values come from the user's terminal theme, so measure contrast against the resolved values of the theme in use, and against a light and a dark theme when the theme is unknown. 256-colour and truecolor values are fixed, but the terminal downsamples them where it lacks support. Lip Gloss README (4-bit, 8-bit and 24-bit profiles, downsampling, light/dark detection); Textual App API (`ansi_color`, ANSI names mapped to hex by a theme) (what these tools do) [standard or field body]; the default to measure against the real theme rests on WCAG2ICT above.
- Honour the colour opt-outs: no colour when output is not a TTY, when `NO_COLOR` is set and not empty, when `TERM=dumb`, or when `--no-color` is passed; no animation when stdout is not a TTY. clig.dev, Command Line Interface Guidelines (Prasad, Firshman, Tashian, Parish) [named expert]; no-color.org (a convention spec) [standard or field body]

## Requirements traceability

- Before drawing anything, list the must-have controls and requirements, one ID each, phrased as "it's done when…". Check every candidate against every row before review, and show the decision-maker the filled matrix with the candidates. GOV.UK Service Manual, "Writing user stories" (acceptance criteria as a checklist) [standard or field body]; NASA Software Engineering Handbook SWE-052/SWE-059 (bidirectional traceability matrix, unique IDs, made at the start, checked at each key review) [standard or field body]; NN/g, Gibbons, "Design critiques" (2016: without agreed objectives, feedback is "subjective and baseless") [named expert]

## Standard control geometry

- Take control sizes from a published spec, not by eye, and name the spec in the candidate. Material 3 switch: track 52×32 dp, 2 dp outline, fully rounded; handle 16 dp off, 24 dp on or with an icon, 28 dp pressed; 16 dp icon; 40 dp state layer. A 24 dp handle in a 32 dp track sits 4 dp from the edge. material-web `tokens/versions/latest/_md-comp-switch.scss`, for the figures; the m3.material.io spec page needs JavaScript and was unread [standard or field body]. The default to take a published component's geometry over drawing your own: GOV.UK Design System, "Get started" (use its components and patterns so services are consistent and tested) [standard or field body]; W3C WAI-ARIA APG (build a widget to its pattern) [standard or field body]
- Material 3 badge: small dot 6 dp, large badge 16 dp high, fully rounded. Linear progress: 4 dp track and indicator. Circular progress: 48 dp across, 4 dp stroke. material-web `_md-comp-badge.scss` and the progress-indicator token files [standard or field body]
- Switch behaviour: on or off only, never mixed. Space toggles it (Enter is optional), and its label stays the same in both states. W3C WAI-ARIA APG, "Switch pattern" [standard or field body]. Apple HIG gives no switch dimensions. On iOS a switch goes only in a list row; macOS offers a mini switch for rows in a grouped form. Apple HIG, "Toggles" (Apple's own controls) [standard or field body]
- In a character grid, map a spec's proportions to cells rather than copying dp figures: a terminal cell is roughly twice as tall as it is wide. A one-row switch such as `[ ●]`/`[● ]` with an on/off word keeps the shape and the non-colour cue. This is our own derivation and sets no default [unverified]

## Terminal and TUI practice

- No standard or field body covers full-screen TUI design. clig.dev, the nearest authority, excludes full-screen programs, so treat its rules as the nearest analogue. clig.dev [named expert]
- Respond within 100 ms. Show progress for long work, with an estimated time or a moving element, so a stalled bar does not look like a crash. Keep parallel progress lines from interleaving, and print the hidden logs on error. clig.dev [named expert]
- Use symbols and emoji only where they make states distinct. clig.dev [named expert]
- Textual themes: generate a theme from base colours and use `$text`, which picks black or white for best contrast on unknown backgrounds. Lip Gloss/Bubble Tea: query the background with `HasDarkBackground` or `BackgroundColorMsg` and choose light or dark colours to match. Textual "Design" guide; Lip Gloss README (each framework's own behaviour) [standard or field body]

## Tools

- Using Textual 8.2.8 or Lip Gloss v2.0.6 (both read 2026-10-26) to prototype candidates is untested here and sets no default [unverified]
