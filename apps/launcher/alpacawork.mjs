#!/bin/sh
//usr/bin/true; if [ -n "$ALPACAWORK_RUN_CLI" ]; then case "$1" in backend|skills|deploy) ;; *) exec "$ALPACAWORK_RUN_CLI" "$@";; esac; fi; exec node "$0" "$@"
import { launch } from './launcher.mjs';
await launch();
