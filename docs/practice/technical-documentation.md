# technical-documentation

Researched: 2026-11-09

Scope: code comments and file headers in a Node, Python and shell CLI repo. Three independent sources agree on each bullet unless it says otherwise.

## Code comments

- Do not write a comment that restates what the code, or a search over it, already says. Spencer, "Best practices for writing code comments" (stackoverflow.blog, 2021-12-23, Rule 1: "Comments should not duplicate the code", one with no new information "can become out-of-date"); Google C++ Style Guide, Comments (google.github.io/styleguide/cppguide.html: "Do not state the obvious"; declaration comments are not repeated at the definition); Martin, in Ousterhout and Martin, aposd-vs-clean-code (github.com/johnousterhout/aposd-vs-clean-code: "I look at every comment as potential misinformation"; the best comments say something "surprising and verifiable") [named expert]
- Use a comment for what the code cannot show: why it is so, a constraint, a non-obvious invariant. Ousterhout, aposd-vs-clean-code ("important information that is not obvious from the code"); Google C++ Style Guide ("describe why the code does what it does"); Spencer 2021 (Rule 5: "Explain unidiomatic code in comments") [named expert]
- Who calls a module is a question a reference search answers live; a hand-kept caller list in a header is a second copy of it that drifts with every move. Tool docs show caller lookup as an on-demand query (LispWorks `who-calls`; Embarcadero RAD Studio, Find References). No source states this for caller lists in these words, so it sets no default beyond the first bullet's [unverified]
- Ousterhout disagrees on staleness: he has "not found them be a significant problem" and holds comments easy to keep current. His view weighs against cutting comments that carry design reasons, not against copies of derivable facts. aposd-vs-clean-code [named expert]
