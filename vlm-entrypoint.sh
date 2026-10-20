#!/usr/bin/env bash
# Compatibility shim. The launcher is vif-vlm-launcher.py, bind-mounted beside
# this file; everything, including the knobs this file used to document, now
# lives there. Kept so existing entrypoints and overrides keep working.
exec python3 /vif-vlm-launcher.py "$@"
