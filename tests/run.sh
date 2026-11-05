#!/bin/sh
# Runs the tests with Apple's JavaScriptCore; no dependencies to install.
set -e
JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc
cd "$(dirname "$0")"
"$JSC" -m data.test.js
"$JSC" -m browser.test.js
