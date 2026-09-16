# Deriv VIX 75 Trading Bot

## Setup (5 minutes)

### Step 1: Get your API token
1. Log into [Deriv](https://app.deriv.com)
2. Go to **Settings → API Token**
3. Tick **Trade** and **Read** scopes
4. Copy the token

### Step 2: Get an App ID
1. Go to [api.deriv.com](https://api.deriv.com/)
2. Register a free app
3. Copy the app_id (or use `1089` for testing)

### Step 3: Install & run
```bash
# Install Node.js if you don't have it: https://nodejs.org

# Clone/download this folder, then:
cd deriv-bot
npm install

# Edit bot.js — replace YOUR_API_TOKEN_HERE with your token
# Optionally change APP_ID from 1089 to your registered app_id

# Run on DEMO account first!
node bot.js
```

### Step 4: Switch to demo
Use a **demo account** API token first. On Deriv, switch to your demo account before generating the token.

## What the bot does
- Connects to Deriv via WebSocket
- Watches VIX 75 (1-minute candles)
- Calculates EMA 9/21 crossover + RSI 14
- Places multiplier trades (x50) with auto stop-loss and take-profit
- Stops after 2 consecutive losses or 4 trades per day

## Risk warning
This bot can lose money. No strategy guarantees profit. Test extensively on demo before using real funds.
