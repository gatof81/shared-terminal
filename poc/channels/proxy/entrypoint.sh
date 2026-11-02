#!/bin/sh
set -eu
case "${PHASE:-}" in setup|test) ;; *) echo "PHASE debe ser setup o test" >&2; exit 1 ;; esac
cp "/etc/tinyproxy/filter.$PHASE" /tmp/filter
echo "poc-proxy phase=$PHASE allow:" >&2
cat /tmp/filter >&2
exec tinyproxy -d -c /etc/tinyproxy/tinyproxy.conf
