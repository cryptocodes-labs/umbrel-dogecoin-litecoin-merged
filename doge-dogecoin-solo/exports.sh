#!/usr/bin/env bash
# Sourced by umbrelOS before this app starts, and before docker-compose.yml is
# rendered.
#
# WHY THIS FILE EXISTS
#
# umbrelOS regenerates app-data/<app>/docker-compose.yml from the app store on
# every install and every update. Anything typed into the running copy — the
# payout address, the merged-mining switch, the Litecoin RPC password — is
# therefore lost the next time the app updates. The failure is quiet in the
# worst way: the app comes back up mining only Dogecoin, or refuses to start,
# hours after the person who changed the setting has stopped watching.
#
# umbrelOS does NOT create or overwrite app-data/<app>/.env. So that file is
# where device-specific settings belong, and this script is what carries them
# into the environment that renders the compose file. The compose file reads
# them as ${PAYOUT_ADDRESS:-} and friends.
#
# It is also the only place a Litecoin RPC password can live without ending up
# in a git repository.
#
# Example ~/umbrel/app-data/doge-dogecoin-solo/.env:
#
#     PAYOUT_ADDRESS=D...
#     MERGED_MINING=1
#     LTC_PAYOUT_ADDRESS=L...
#     LTC_RPC_PASSWORD=...
#
# Since 1.4.0 the alarm settings live here too, and all of them have working
# defaults — this list is only for changing them:
#
#     ALARM_AFTER_SECONDS=180     how long a node may be unreachable before
#                                 the dashboard goes red and the phone rings
#     STARTUP_GRACE_SECONDS=300   how long the pool may take to come up at all
#     ALARM_REPEAT_HOURS=6        how rarely a standing alarm is repeated
#     STALL_RESTART_MINUTES=15    exit-and-restart after a silent wedge; 0 off
#     AUX_LONGPOLL=0              stop following dogecoin's tip by longpoll and
#                                 go back to polling it alone
#
# Keys not listed in ALLOWED below are ignored on purpose. This file is sourced
# into umbrelOS's own shell while it starts apps: a stray PATH= or
# APP_DOGECOIN_NODE_RPC_PASS= line in a hand-edited .env must not be able to
# reach into that shell, and `set -a; . .env` would let it.

_solo_env_file=""
for _candidate in \
  "${APP_DATA_DIR:-}/.env" \
  "${UMBREL_ROOT:-}/app-data/doge-dogecoin-solo/.env" \
  "${HOME:-/home/umbrel}/umbrel/app-data/doge-dogecoin-solo/.env" \
  "/home/umbrel/umbrel/app-data/doge-dogecoin-solo/.env"; do
  # The leading /.env case: an unset APP_DATA_DIR must not match "/.env".
  #
  # -r as well as -f, deliberately. umbrelOS sources this under
  # `set -euo pipefail`, and a redirect that cannot open the file makes the
  # `while` fail, which under -e exits the shell that is starting the apps —
  # so a .env left root-owned 600 while the start script runs as `umbrel`
  # would not just skip this app's settings, it could take down the app start
  # itself. Unreadable is treated exactly like absent.
  if [ "${_candidate}" != "/.env" ] && [ -f "${_candidate}" ] && [ -r "${_candidate}" ]; then
    _solo_env_file="${_candidate}"
    break
  fi
done

if [ -n "${_solo_env_file}" ]; then
  while IFS= read -r _line || [ -n "${_line}" ]; do
    # Tolerate CRLF: a file written on Windows or pasted through a terminal
    # otherwise yields an address with a trailing carriage return, which fails
    # base58 validation with a message that points nowhere near the cause.
    _line="${_line%$'\r'}"
    # A UTF-8 BOM, which the same editors that produce CRLF also produce, would
    # otherwise make the first key "﻿PAYOUT_ADDRESS" — not in the
    # allowlist, so silently dropped, and the app then refuses to start
    # complaining about an address the user can plainly see in the file.
    _line="${_line#$'\xef\xbb\xbf'}"
    # Leading whitespace first, so an indented `export FOO=bar` is recognised
    # rather than silently ignored.
    _line="${_line#"${_line%%[![:space:]]*}"}"
    case "${_line}" in
      ''|'#'*) continue ;;
      export\ *) _line="${_line#export }" ;;
    esac
    _key="${_line%%=*}"
    _value="${_line#*=}"
    # A line without '=' leaves key and value identical; skip it.
    [ "${_key}" = "${_line}" ] && continue
    _key="${_key#"${_key%%[![:space:]]*}"}"
    _key="${_key%"${_key##*[![:space:]]}"}"
    # Surrounding whitespace is trimmed from the VALUE too, before quotes are
    # stripped. An earlier version left it verbatim on the theory that a value
    # with a space in it is a typo the app should reject loudly. That holds for
    # the addresses — they are checksum-validated and a bad one stops the app —
    # but not for the switch: MERGED_MINING is compared with === '1', so a
    # trailing space on that line started the app cheerfully Dogecoin-only with
    # no error anywhere. Silently mining one chain instead of two is the exact
    # failure this whole file exists to prevent.
    #
    # Whitespace INSIDE a value survives, so a pasted address with a space in
    # the middle still fails validation loudly, as intended.
    _value="${_value#"${_value%%[![:space:]]*}"}"
    _value="${_value%"${_value##*[![:space:]]}"}"
    case "${_value}" in
      \"*\") _value="${_value#\"}"; _value="${_value%\"}" ;;
      \'*\') _value="${_value#\'}"; _value="${_value%\'}" ;;
    esac
    case "${_key}" in
      PAYOUT_ADDRESS|MINING_PROFILE|MERGED_MINING|POLL_INTERVAL_SECONDS|LTC_RPC_HOST|LTC_RPC_PORT|LTC_RPC_USER|LTC_RPC_PASSWORD|LTC_PAYOUT_ADDRESS|PEP_RPC_HOST|PEP_RPC_PORT|PEP_RPC_USER|PEP_RPC_PASSWORD|PEP_PAYOUT_ADDRESS|SOQ_RPC_HOST|SOQ_RPC_PORT|SOQ_RPC_USER|SOQ_RPC_PASSWORD|SOQ_PAYOUT_ADDRESS|PEER_POOLS|ALARM_AFTER_SECONDS|STARTUP_GRACE_SECONDS|ALARM_REPEAT_HOURS|STALL_RESTART_MINUTES|AUX_LONGPOLL)
        export "${_key}=${_value}"
        ;;
      *) : ;;
    esac
  done < "${_solo_env_file}"
fi

unset _solo_env_file _candidate _line _key _value
