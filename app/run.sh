#!/bin/sh
exec python -m uvicorn vbot.main:app --host 0.0.0.0 --port "${PORT:-8080}" --no-access-log
