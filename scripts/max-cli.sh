#!/bin/bash
# max-cli — interactive CLI for Agent Max
# Sends prompts to the local A2A server and prints responses.
# Usage: max "what's your status?"   or just: max (interactive mode)

PORT="${MAX_PORT:-8770}"
URL="http://127.0.0.1:${PORT}/tasks"

# Colors
BOLD='\033[1m'
DIM='\033[2m'
CYAN='\033[36m'
GREEN='\033[32m'
RED='\033[31m'
RESET='\033[0m'

send_prompt() {
  local msg="$1"
  local payload
  payload=$(jq -n --arg text "$msg" '{
    jsonrpc: "2.0",
    id: 1,
    method: "tasks/send",
    params: {
      message: {
        role: "user",
        parts: [{ type: "text", text: $text }]
      }
    }
  }')

  local response
  response=$(curl -s -X POST "$URL" \
    -H "Content-Type: application/json" \
    -d "$payload" \
    --max-time 300 2>&1)

  if [ $? -ne 0 ]; then
    echo -e "${RED}Error: Could not connect to Max at ${URL}${RESET}"
    echo -e "${DIM}Is the agent running? Check: launchctl list ai.max.agent${RESET}"
    return 1
  fi

  # Extract response text
  local text
  text=$(echo "$response" | jq -r '.result.artifacts[0].parts[0].text // .error.message // "No response"' 2>/dev/null)

  if [ "$text" = "null" ] || [ -z "$text" ]; then
    echo -e "${RED}Unexpected response:${RESET}"
    echo "$response" | jq . 2>/dev/null || echo "$response"
    return 1
  fi

  echo -e "${GREEN}${text}${RESET}"
}

# Single command mode: max "do something"
if [ $# -gt 0 ]; then
  send_prompt "$*"
  exit $?
fi

# Interactive mode
echo -e "${BOLD}${CYAN}Agent Max CLI${RESET} ${DIM}(port ${PORT})${RESET}"
echo -e "${DIM}Type your message. Ctrl+C to exit.${RESET}"
echo ""

while true; do
  echo -ne "${BOLD}> ${RESET}"
  read -r input
  [ -z "$input" ] && continue
  [ "$input" = "exit" ] || [ "$input" = "quit" ] && break
  echo ""
  send_prompt "$input"
  echo ""
done
