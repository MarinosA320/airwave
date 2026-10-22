#!/bin/sh
# Downloads the XPMP2 library (MIT licence, by TwinFan) that the plugin is built on.
set -e
cd "$(dirname "$0")"
[ -d lib/XPMP2 ] || git clone --depth 1 --branch v3.7.0 https://github.com/TwinFan/XPMP2 lib/XPMP2
