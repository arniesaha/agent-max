#!/bin/bash
# Rsync Max data to NAS for disaster recovery
# Run via cron every 15 minutes

NAS_USER="${NAS_USER:-}"
NAS_HOST="${NAS_HOST:-}"
NAS_PATH="${NAS_BACKUP_PATH:-/home/$NAS_USER/max-backup/}"
LOCAL_PATH="$HOME/max/data/"
LOG="$HOME/max/logs/rsync.log"

if [ -z "$NAS_USER" ] || [ -z "$NAS_HOST" ]; then
  echo "[$(date -Iseconds)] NAS_USER or NAS_HOST not set, skipping rsync" >> "$LOG"
  exit 1
fi

echo "[$(date -Iseconds)] Starting rsync to NAS..." >> "$LOG"

rsync -az --timeout=30 \
  "$LOCAL_PATH" \
  "${NAS_USER}@${NAS_HOST}:${NAS_PATH}" \
  >> "$LOG" 2>&1

if [ $? -eq 0 ]; then
  echo "[$(date -Iseconds)] Rsync completed successfully" >> "$LOG"
else
  echo "[$(date -Iseconds)] Rsync failed with exit code $?" >> "$LOG"
fi
