#!/bin/bash
# Deploy script for status.luischav.es

set -e

# Load environment variables
if [ -f .env ]; then
  export $(cat .env | xargs)
else
  echo "Error: .env file not found"
  exit 1
fi

if [ -z "$API_URL" ]; then
  echo "Error: API_URL not set in .env"
  exit 1
fi

echo "Deploying Status Page..."

# Deploy worker
echo "1. Deploying worker..."
npx wrangler deploy

# Create temp directory and copy public folder
echo "2. Preparing frontend..."
TEMP_DIR=$(mktemp -d)
cp -r public/* "$TEMP_DIR/"

# Replace API_BASE placeholder in temp copy
sed -i '' "s|__API_BASE__|${API_URL}|g" "$TEMP_DIR/index.html"

# Deploy frontend from temp directory
echo "3. Deploying frontend..."
npx wrangler pages deploy "$TEMP_DIR" --project-name=status-page --commit-dirty=true

# Clean up temp directory
rm -rf "$TEMP_DIR"

echo "Done! Site live at https://status-page.pages.dev"
echo "Custom domain: https://status.luischav.es (if DNS configured)"
