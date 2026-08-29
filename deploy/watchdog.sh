#!/usr/bin/env bash
# =============================================================================
# NiftyCasino feed watchdog — one probe, one log line, optional one alert.
#
#   deploy/watchdog.sh                      (cron/systemd timer, every 5 minutes)
#   WATCHDOG_BASE_URL=https://cas.example.com deploy/watchdog.sh
#   WATCHDOG_DEEP=1 deploy/watchdog.sh      (also require E1, the chart feed)
#
# What it checks: GET /api/nse/health, which warms the Akamai session and then
# asks NSE E3 (/api/marketStatus) — the same front door the game's feed uses. A
# pass means the VM's egress IP is not blocked and the handshake works. `?deep=1`
# additionally requires E1 to answer with index rows (costlier; run it at most
# once an hour if you want both).
#
# The route ALWAYS answers 200 and puts the verdict in the body (`ok`), so this
# script has to look at the JSON, not the status code — and it does that with
# grep, not jq, so the only dependency is curl.
#
# Alerting: WATCHDOG_ALERT_URL (ntfy, Slack webhook, anything that accepts a
# POST) is OPTIONAL. Unset, the script only writes to its log + journald, and
# `systemctl status niftycasino-watchdog` shows the failure. A cooldown file
# stops a dead feed from paging you every 5 minutes.
#
# Exit codes: 0 = feed ok. 1 = feed not ok (systemd marks the unit failed).
# =============================================================================
set -u

# --- configuration (all overridable from the environment) --------------------
BASE_URL="${WATCHDOG_BASE_URL:-http://127.0.0.1:3000}"
# The probe can legitimately take ~30s (a 15s Akamai handshake + an 8s E3 call,
# then one session-reset retry) — a 20s timeout would fail a healthy feed.
TIMEOUT_SECS="${WATCHDOG_TIMEOUT_SECS:-60}"
DEEP="${WATCHDOG_DEEP:-0}"
LOG_FILE="${WATCHDOG_LOG:-/var/log/niftycasino/watchdog.log}"
ALERT_URL="${WATCHDOG_ALERT_URL:-}"
# Do not re-alert within this window (a stuck feed is one page, not 12/hour).
COOLDOWN_MINS="${WATCHDOG_COOLDOWN_MINS:-60}"
STATE_DIR="${WATCHDOG_STATE_DIR:-/var/lib/niftycasino-watchdog}"
CURL_BIN="${WATCHDOG_CURL:-curl}"

log_line() {
	# One line, ISO-8601 UTC, grep-friendly. Also goes to the journal via stdout.
	printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$1"
	if [ -n "$LOG_FILE" ]; then
		mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true
		printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$1" >>"$LOG_FILE" 2>/dev/null || true
	fi
}

send_alert() {
	[ -n "$ALERT_URL" ] || return 0
	mkdir -p "$STATE_DIR" 2>/dev/null || true
	local stamp_file="$STATE_DIR/last-alert"
	local now
	now="$(date +%s)"
	if [ -f "$stamp_file" ] && [ -r "$stamp_file" ]; then
		local last
		last="$(cat "$stamp_file" 2>/dev/null || echo 0)"
		if [ "$((now - last))" -lt "$((COOLDOWN_MINS * 60))" ]; then
			log_line "alert suppressed (cooldown ${COOLDOWN_MINS}m): $1"
			return 0
		fi
	fi
	echo "$now" >"$stamp_file" 2>/dev/null || true
	# The alert body is the probe's own detail — never raw upstream JSON.
	"$CURL_BIN" -sS --max-time 10 -H 'Content-Type: text/plain' \
		--data-binary "niftycasino feed DOWN on $(hostname): $1" "$ALERT_URL" >/dev/null 2>&1 \
		|| log_line "alert delivery failed (url set, but the POST did not go out)"
}

# --- the probe ---------------------------------------------------------------
PROBE_URL="${BASE_URL%/}/api/nse/health"
[ "$DEEP" = "1" ] && PROBE_URL="${PROBE_URL}?deep=1"

BODY="$("$CURL_BIN" -sS --max-time "$TIMEOUT_SECS" "$PROBE_URL" 2>&1)"
CURL_EXIT=$?

if [ $CURL_EXIT -ne 0 ]; then
	# 28 = our own --max-time: the app is up but the probe hung (feed + retry path).
	log_line "FAIL curl_exit=$CURL_EXIT url=$PROBE_URL detail=$BODY"
	send_alert "health probe failed: curl exit $CURL_EXIT ($BODY)"
	exit 1
fi

# The route answers {"ok":false,...} for every failure and never throws, so a
# plain substring check is enough (and has no dependency on a JSON parser).
if printf '%s' "$BODY" | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then
	log_line "ok $BODY"
	exit 0
fi

log_line "FAIL body=$BODY"
send_alert "$BODY"
exit 1
