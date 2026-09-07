#!/bin/bash
cd "$(dirname "$0")"
echo "Starting Knowledge Server..."
node server.js
echo "Server stopped."