#!/bin/sh
set -e

echo "Applying database migrations..."
until npx prisma migrate deploy; do
  echo "Database not ready yet, retrying in 2s..."
  sleep 2
done

echo "Starting API server..."
exec node dist/server.js
