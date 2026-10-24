#!/usr/bin/env bash
# Reading a `gh api` invocation, shared by the two gh guards (mantahostels#511).
#
# SOURCED, NEVER RUN.
#
# Array locals here are `_ga_`-prefixed, for the reason lib/guard-parse.sh's
# header gives (mantahostels#1813). The api_* output contract below is deliberately
# unprefixed: it is meant to collide.
#
# It requires lib/guard-parse.sh: $QUOTED is what the split leaves behind where
# a quoted span was, and gp_literal is what reads one back.

# The api_* globals below are this file's output contract: it sets them, and the
# guards that source it read them. shellcheck sees only the assignment side.
# shellcheck disable=SC2034

# ga_scan_api <the invocation's words, `api` itself dropped>
#
# Sets, all as raw words with quoted spans still masked:
#   api_method    the --method/-X value, empty where none was given
#   api_endpoint  the first bare word
#   api_fields    every -f/-F/--field/--raw-field value, in order
#   api_opaque    1 where a field's own NAME is masked, so which field it is
#                 cannot be read off the word
#   api_input     1 where the payload arrives whole through --input, so there
#                 are no field words to read at all
#
# A caller reads the field NAMES it cares about off api_fields, and gp_literal
# for the text of one. Only the name decides api_opaque: a masked VALUE — `-f
# title="New"` — is still visibly not the field the caller is looking for.
ga_scan_api() {
  local -a _ga_argv=("$@")
  local i=0 tok val step ch rest after j
  api_method=""
  api_endpoint=""
  api_fields=()
  api_opaque=0
  api_input=0
  while ((i < ${#_ga_argv[@]})); do
    tok="${_ga_argv[i]}"
    val=""
    step=1
    case "$tok" in
      # A flag whose value is the next word consumes two.
      --method)
        api_method="${_ga_argv[i + 1]-}"
        step=2
        ;;
      --method=*) api_method="${tok#*=}" ;;
      --field | --raw-field)
        val="${_ga_argv[i + 1]-}"
        step=2
        ;;
      --field=* | --raw-field=*) val="${tok#*=}" ;;
      # The payload comes from a file or stdin: its fields are unreadable here.
      --input)
        api_input=1
        step=2
        ;;
      --input=*) api_input=1 ;;
      # Every other gh api flag whose value is a SEPARATE WORD. Without these the
      # value is read as the endpoint, the caller's endpoint test then answers
      # no, and the write is allowed through in silence.
      --cache | --header | --hostname | --jq | --preview | --template) step=2 ;;
      --*) ;;
      # A SHORTHAND BUNDLE, read exactly as pflag reads one (mantahostels#2580). pflag walks
      # the letters and the first VALUE-TAKING one ends the walk: what follows
      # it in the bundle is that letter's value, or, where nothing follows, the
      # next word. `-i` is gh api's only boolean shorthand and so the only
      # letter the walk continues past.
      #
      # `-X=PATCH` reaches gh as PATCH, `-X==PATCH` as `=PATCH`, and a lone
      # trailing `-X=` as `=`: pflag drops the separator only when something
      # follows it, which is the `${#after} > 1` test below.
      -?*)
        rest="${tok#-}"
        j=0
        while ((j < ${#rest})); do
          ch="${rest:j:1}"
          after="${rest:j+1}"
          if [[ "$ch" == "i" && "$after" != "="* ]]; then
            ((j++))
            continue
          fi
          if ((${#after} > 1)) && [[ "$after" == "="* ]]; then
            after="${after:1}"
          elif [[ -z "$after" ]]; then
            after="${_ga_argv[i + 1]-}"
            step=2
          fi
          case "$ch" in
            X) api_method="$after" ;;
            f | F) val="$after" ;;
            *) ;;
          esac
          break
        done
        ;;
      *) [[ -n "$api_endpoint" ]] || api_endpoint="$tok" ;;
    esac
    case "$val" in
      "") ;;
      *=*)
        [[ "${val%%=*}" == *"$QUOTED"* ]] && api_opaque=1
        api_fields+=("$val")
        ;;
      # No field name in sight at all: the whole `name=value` is masked.
      *)
        api_opaque=1
        api_fields+=("$val")
        ;;
    esac
    ((i += step))
  done
}

# Did the call give gh a body to send? gh's own default: POST where any field or
# --input was passed, GET otherwise.
ga_defaults_to_post() {
  ((api_input)) || ((${#api_fields[@]}))
}

# Is this endpoint one issue — not a comment, a label set or any other
# sub-resource, whose bodies are a different thing?
ga_is_issue_endpoint() {
  [[ "$(ga_path "$1")" =~ ^repos/[^/]+/[^/]+/issues/[0-9]+$ ]]
}

# Is this endpoint the issue COLLECTION, which is what a creation POSTs to?
ga_is_issue_collection_endpoint() {
  [[ "$(ga_path "$1")" =~ ^repos/[^/]+/[^/]+/issues$ ]]
}

# The owner/repo a `repos/<owner>/<repo>/…` endpoint names, on stdout. Empty
# where both are gh's placeholders (`{owner}`, `:owner`), which gh fills from
# the cwd's repo; status 1 where only one is, a repo the caller cannot know.
ga_endpoint_repo() {
  local p owner repo
  p="$(ga_path "$1")"
  p="${p#repos/}"
  owner="${p%%/*}" repo="${p#*/}"
  repo="${repo%%/*}" p="$owner/$repo"
  [[ "$owner" =~ ^(\{owner\}|:owner)$ && "$repo" =~ ^(\{repo\}|:repo)$ ]] && return 0
  [[ "$p" == *'{'* || "$p" =~ :(owner|repo) ]] && return 1
  printf '%s' "$p"
}

# Is this the GraphQL endpoint? `gh api graphql` is the spelling gh documents;
# the URL forms are what a copied curl example carries.
ga_is_graphql_endpoint() {
  [[ "$1" == "graphql" || "$1" == */graphql ]]
}

# ga_scan_graphql — run after ga_scan_api, over the same $api_fields.
#
# GraphQL names what it writes in the query TEXT rather than in a field name or
# an endpoint, so a guard has to read that text back out of the span the parser
# blanked. Sets:
#   api_query         every `query=` field's text, concatenated
#   api_query_hidden  1 where some of that text could not be read
#
# Only a field NAMED query is read (mantahostels#284): a value elsewhere in the call that
# cannot be read is a variable the query already names, and treating it as
# hidden would fire on a fully visible read query.
ga_scan_graphql() {
  api_query=""
  api_query_hidden=0
  local val field unreadable
  for val in ${api_fields+"${api_fields[@]}"}; do
    if field="$(gp_literal "$val")"; then unreadable=0; else unreadable=1; fi
    case "$field" in
      # `@file` and `@-` are gh's own file and stdin spellings.
      query=@*) api_query_hidden=1 ;;
      query=*)
        api_query+="${field#query=} "
        ((unreadable)) && api_query_hidden=1
        ;;
      *[=]*) ;;
      # No field name at all: the whole `name=value` is out of sight.
      *) ((unreadable)) && api_query_hidden=1 ;;
    esac
  done
}

# ga_mutation_args <mutation-name> — print the named mutation's OWN arguments,
# read out of $api_query: the text from its opening bracket to the first close.
# Non-zero where the query names no such mutation.
#
# Whitespace goes first, GraphQL ignoring it. Scoping to the arguments is what
# separates a write from a read: the same token after that bracket closes is a
# selection on the result, not an input field.
#
# Safe in a command substitution: it reads $api_query and sets nothing.
ga_mutation_args() {
  local squashed="${api_query//[[:space:]]/}" args open="$1("
  [[ "$squashed" == *"$open"* ]] || return 1
  args="${squashed#*"$open"}"
  printf '%s' "${args%%)*}"
}

# An endpoint reduced to its path, so the three spellings gh accepts — bare,
# leading-slash and full URL — compare equal.
ga_path() {
  local e="${1#https://api.github.com}"
  e="${e#http://api.github.com}"
  printf '%s' "${e#/}"
}
