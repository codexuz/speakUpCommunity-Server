#!/bin/sh
set -e

# Start nginx in the background
nginx -g "daemon off;" &

# Start the Node.js app
exec node dist/index.js
