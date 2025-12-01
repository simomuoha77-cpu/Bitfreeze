#!/bin/bash
# Safe Bitfreeze restore/update script
# Preserves images and user balances

set -e

echo "Stopping existing Bitfreeze process (if any)..."
pm2 stop bitfreeze 2>/dev/null || true
pm2 delete bitfreeze 2>/dev/null || true

# Go to home folder
cd ~

# Clone or pull from GitHub safely
if [ -d "Bitfreeze" ]; then
  echo "Updating existing Bitfreeze folder..."
  cd Bitfreeze
  git reset --hard
  git pull origin main
else
  echo "Cloning Bitfreeze from GitHub..."
  git clone https://github.com/simomuoha77-cpu/Bitfreeze.git
  cd Bitfreeze
fi

# Install/update dependencies
echo "Installing npm dependencies..."
npm install

# Ensure images folder exists
mkdir -p public/images

echo "Starting Bitfreeze server using pm2..."
pm2 start index.js --name bitfreeze --watch --update-env -f
pm2 save

echo "✅ Restore/update complete. Server running on port 3000"
echo "Open: http://localhost:3000/dashboard.html"
