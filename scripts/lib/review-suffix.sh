#!/usr/bin/env bash
review_suffix() {
  local sid="${1//[^A-Za-z0-9_-]/_}"
  sid="${sid:0:8}"
  printf '%s' "${sid:+-$sid}"
}
