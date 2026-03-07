#!/bin/bash
set -e

PLIST_NAME="ai.max.agent.plist"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_NAME"
PROJECT_DIR="$HOME/max/projects/agent-max"
LOG_DIR="$HOME/max/logs"

mkdir -p "$LOG_DIR"

cat > "$PLIST_PATH" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>ai.max.agent</string>

    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>${PROJECT_DIR}/dist/index.js</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${PROJECT_DIR}</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>${HOME}</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>

    <key>ThrottleInterval</key>
    <integer>10</integer>

    <key>StandardOutPath</key>
    <string>${LOG_DIR}/launchagent-stdout.log</string>

    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/launchagent-stderr.log</string>
</dict>
</plist>
EOF

# Fix node path — use whatever node is available
NODE_PATH=$(which node)
sed -i '' "s|/usr/local/bin/node|${NODE_PATH}|g" "$PLIST_PATH"

echo "Plist written to $PLIST_PATH"
echo "Node path: $NODE_PATH"

# Load the agent
launchctl bootout gui/$(id -u) "$PLIST_PATH" 2>/dev/null || true
launchctl bootstrap gui/$(id -u) "$PLIST_PATH"

echo "LaunchAgent loaded. Max will auto-start on boot and restart on crash."
echo "To stop:  launchctl bootout gui/\$(id -u) $PLIST_PATH"
echo "To check: launchctl list | grep ai.max.agent"
