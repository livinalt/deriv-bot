require("dotenv").config();
const WebSocket = require("ws");
const fs = require("fs");
const { google } = require("googleapis");

// ============================================================
//  CONFIGURATION — edit these values before running
// ============================================================
const CONFIG = {
  // PAT token from home.deriv.com → Settings → API Token
  API_TOKEN: process.env.DERIV_API_TOKEN || "YOUR_PAT_TOKEN_HERE",

  // App ID from developers.deriv.com → Dashboard → Apps
  APP_ID: process.env.DERIV_APP_ID || "",

  // "demo" or "real"
  ACCOUNT_TYPE: process.env.DERIV_ACCOUNT_TYPE || "demo",

  // VIX 75 symbol on Deriv
  SYMBOL: "R_75",

  // Candle timeframe: 60 = 1min, 300 = 5min
  CANDLE_INTERVAL: 60,

  // Strategy parameters
  EMA_FAST: 9,
  EMA_SLOW: 21,
  RSI_PERIOD: 14,
  RSI_LOWER: 30,
  RSI_UPPER: 70,
  RSI_MIDLINE: 50,

  // Risk management
  ACCOUNT_BALANCE: 10,
  RISK_PERCENT: 5,
  MULTIPLIER: 50,
  REWARD_RATIO: 2,
  MAX_DAILY_LOSSES: 2,
  MAX_TRADES_PER_SESSION: 6,

  // Telegram
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || "",

  // Google Sheets
  GOOGLE_SHEET_ID: process.env.GOOGLE_SHEET_ID || "",
  GOOGLE_SERVICE_ACCOUNT_EMAIL: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "",
  GOOGLE_PRIVATE_KEY: (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
};

// ============================================================
//  STATE
// ============================================================
let ws = null;
let authorized = false;
let candles = [];
let inTrade = false;
let dailyLosses = 0;
let consecutiveLosses = 0;
let tradeCount = 0;
let currentBalance = CONFIG.ACCOUNT_BALANCE;

// ============================================================
//  INDICATOR CALCULATIONS
// ============================================================

function calcEMA(prices, period) {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcRSI(prices, period) {
  if (prices.length < period + 1) return null;
  let gains = 0;
  let losses = 0;

  // Initial average gain/loss
  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  // Smoothed RSI
  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? Math.abs(diff) : 0)) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function getSignal(closes) {
  const minCandles = Math.max(CONFIG.EMA_SLOW, CONFIG.RSI_PERIOD + 1) + 2;
  if (closes.length < minCandles) {
    return { signal: "WAIT", reason: `Need ${minCandles} candles, have ${closes.length}` };
  }

  // Current and previous EMAs
  const emaFastNow = calcEMA(closes, CONFIG.EMA_FAST);
  const emaSlowNow = calcEMA(closes, CONFIG.EMA_SLOW);
  const emaFastPrev = calcEMA(closes.slice(0, -1), CONFIG.EMA_FAST);
  const emaSlowPrev = calcEMA(closes.slice(0, -1), CONFIG.EMA_SLOW);

  // Current and previous RSI
  const rsiNow = calcRSI(closes, CONFIG.RSI_PERIOD);
  const rsiPrev = calcRSI(closes.slice(0, -1), CONFIG.RSI_PERIOD);

  if (!emaFastNow || !emaSlowNow || !rsiNow || !emaFastPrev || !emaSlowPrev || !rsiPrev) {
    return { signal: "WAIT", reason: "Indicators not ready" };
  }

  // EMA crossover detection
  const crossUp = emaFastPrev <= emaSlowPrev && emaFastNow > emaSlowNow;
  const crossDown = emaFastPrev >= emaSlowPrev && emaFastNow < emaSlowNow;

  // RSI momentum confirmation
  const rsiRising = rsiNow > rsiPrev;
  const rsiFalling = rsiNow < rsiPrev;

  // BUY: EMA cross up + RSI below 50 and rising (ideally bouncing from 30 zone)
  if (crossUp && rsiNow < CONFIG.RSI_MIDLINE && rsiRising) {
    const nearOversold = rsiPrev <= CONFIG.RSI_LOWER + 10;
    return {
      signal: "BUY",
      reason: `EMA cross UP | RSI ${rsiNow.toFixed(1)} rising${nearOversold ? " (near oversold)" : ""}`,
      emaFast: emaFastNow,
      emaSlow: emaSlowNow,
      rsi: rsiNow,
    };
  }

  // SELL: EMA cross down + RSI above 50 and falling (ideally dropping from 70 zone)
  if (crossDown && rsiNow > CONFIG.RSI_MIDLINE && rsiFalling) {
    const nearOverbought = rsiPrev >= CONFIG.RSI_UPPER - 10;
    return {
      signal: "SELL",
      reason: `EMA cross DOWN | RSI ${rsiNow.toFixed(1)} falling${nearOverbought ? " (near overbought)" : ""}`,
      emaFast: emaFastNow,
      emaSlow: emaSlowNow,
      rsi: rsiNow,
    };
  }

  return {
    signal: "HOLD",
    reason: `EMA fast=${emaFastNow.toFixed(2)} slow=${emaSlowNow.toFixed(2)} RSI=${rsiNow.toFixed(1)}`,
  };
}

// ============================================================
//  TRADE EXECUTION
// ============================================================

function calcStakeAndLimits() {
  const riskAmount = (CONFIG.RISK_PERCENT / 100) * currentBalance;
  const stopLoss = parseFloat(riskAmount.toFixed(2));
  const takeProfit = parseFloat((riskAmount * CONFIG.REWARD_RATIO).toFixed(2));
  // Deriv minimum stake for multipliers — adjust if needed
  const stake = Math.max(0.35, parseFloat(riskAmount.toFixed(2)));
  return { stake, stopLoss, takeProfit };
}

function placeTrade(direction, reason) {
  if (inTrade) {
    log("⏳ Already in a trade. Skipping.");
    return;
  }
  if (consecutiveLosses >= CONFIG.MAX_DAILY_LOSSES) {
    log("🛑 Hit max consecutive losses. Done for the day.");
    return;
  }
  if (tradeCount >= CONFIG.MAX_TRADES_PER_SESSION) {
    log("🛑 Hit max trades for the session.");
    return;
  }

  const { stake, stopLoss, takeProfit } = calcStakeAndLimits();

  if (stake > currentBalance) {
    log("💀 Stake exceeds balance. Cannot trade.");
    return;
  }

  const contractType = direction === "BUY" ? "MULTUP" : "MULTDOWN";

  const request = {
    buy: 1,
    price: stake,
    parameters: {
      contract_type: contractType,
      symbol: CONFIG.SYMBOL,
      amount: stake,
      multiplier: CONFIG.MULTIPLIER,
      basis: "stake",
      limit_order: {
        stop_loss: stopLoss,
        take_profit: takeProfit,
      },
    },
  };

  log(`\n🚀 PLACING ${direction} TRADE`);
  log(`   Stake: $${stake} | SL: $${stopLoss} | TP: $${takeProfit} | Multiplier: x${CONFIG.MULTIPLIER}`);

  lastTradeEntry = { direction, stake, stopLoss, takeProfit, entryReason: reason || "" };
  ws.send(JSON.stringify(request));
  inTrade = true;
  tradeCount++;
}

// ============================================================
//  WEBSOCKET HANDLERS (New Deriv API — OTP-based)
// ============================================================

const API_BASE = "https://api.derivws.com";

function authHeaders() {
  return {
    "Authorization": `Bearer ${CONFIG.API_TOKEN}`,
    "Deriv-App-ID": CONFIG.APP_ID,
    "Content-Type": "application/json",
  };
}

async function getAccountId() {
  log("🔍 Looking up your Options trading account...");
  const res = await fetch(`${API_BASE}/trading/v1/options/accounts`, {
    method: "GET",
    headers: authHeaders(),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Get accounts failed (${res.status}): ${err}`);
  }
  const json = await res.json();
  const accounts = json.data || [];

  // Find matching account type (demo or real)
  let account = accounts.find((a) => a.account_type === CONFIG.ACCOUNT_TYPE && a.status === "active");

  if (!account && accounts.length > 0) {
    account = accounts[0]; // fallback to first available
    log(`⚠️  No ${CONFIG.ACCOUNT_TYPE} account found. Using: ${account.account_id} (${account.account_type})`);
  }

  if (!account) {
    // Try to create a demo account
    log("📝 No account found. Creating one...");
    const createRes = await fetch(`${API_BASE}/trading/v1/options/accounts`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ account_type: CONFIG.ACCOUNT_TYPE }),
    });
    if (!createRes.ok) {
      const err = await createRes.text();
      throw new Error(`Create account failed (${createRes.status}): ${err}`);
    }
    const createJson = await createRes.json();
    account = createJson.data;
    if (Array.isArray(account)) account = account[0];
    log(`✅ Account created: ${account.account_id}`);
  }

  log(`✅ Account: ${account.account_id} | Type: ${account.account_type} | Balance: $${account.balance || "?"}`);
  if (account.balance) currentBalance = parseFloat(account.balance);
  return account.account_id;
}

async function getOTP(accountId) {
  log("🔑 Requesting OTP...");
  const res = await fetch(`${API_BASE}/trading/v1/options/accounts/${accountId}/otp`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OTP request failed (${res.status}): ${err}`);
  }
  const json = await res.json();
  return json.data.url;
}

async function connect() {
  try {
    const accountId = await getAccountId();
    const wsUrl = await getOTP(accountId);
    log(`Connecting to WebSocket...`);
    ws = new WebSocket(wsUrl);

    ws.on("open", () => {
      log("✅ Connected & authenticated");
      authorized = true;
      subscribeCandles();
      subscribeBalance();
    });

    ws.on("message", (data) => {
      const msg = JSON.parse(data);
      handleMessage(msg);
    });

    ws.on("close", () => {
      log("❌ Disconnected. Reconnecting in 10s...");
      authorized = false;
      setTimeout(connect, 10000);
    });

    ws.on("error", (err) => {
      log(`WebSocket error: ${err.message}`);
    });
  } catch (err) {
    log(`❌ Connection failed: ${err.message}`);
    log("   Retrying in 15s...");
    setTimeout(connect, 15000);
  }
}

function handleMessage(msg) {
  // ---- Balance updates ----
  if (msg.msg_type === "balance") {
    currentBalance = parseFloat(msg.balance.balance);
  }

  // ---- Candle data ----
  if (msg.msg_type === "ohlc") {
    const c = msg.ohlc;
    const candle = {
      open: parseFloat(c.open),
      high: parseFloat(c.high),
      low: parseFloat(c.low),
      close: parseFloat(c.close),
      epoch: c.open_time,
    };
    processCandle(candle);
  }

  // ---- Candle history ----
  if (msg.msg_type === "candles") {
    log(`📊 Loaded ${msg.candles.length} historical candles`);
    candles = msg.candles.map((c) => ({
      open: parseFloat(c.open),
      high: parseFloat(c.high),
      low: parseFloat(c.low),
      close: parseFloat(c.close),
      epoch: c.epoch,
    }));
  }

  // ---- Buy response ----
  if (msg.msg_type === "buy") {
    if (msg.error) {
      log(`❌ Trade failed: ${msg.error.message}`);
      inTrade = false;
      return;
    }
    log(`✅ Trade opened | Contract ID: ${msg.buy.contract_id} | Entry: $${msg.buy.buy_price}`);
    lastTradeEntry = {
      ...lastTradeEntry,
      stake: msg.buy.buy_price,
      multiplier: CONFIG.MULTIPLIER,
      contractId: msg.buy.contract_id,
    };
    logTradeOpen(lastTradeEntry);
    // Subscribe to contract updates
    ws.send(
      JSON.stringify({
        proposal_open_contract: 1,
        contract_id: msg.buy.contract_id,
        subscribe: 1,
      })
    );
  }

  // ---- Open contract updates ----
  if (msg.msg_type === "proposal_open_contract") {
    const c = msg.proposal_open_contract;
    if (c && c.is_sold) {
      const profit = parseFloat(c.profit);
      inTrade = false;
      const result = profit >= 0 ? "WIN" : "LOSS";

      // Determine exit reason
      let exitReason = "unknown";
      if (c.exit_tick_display_value) {
        const sellPrice = parseFloat(c.sell_price);
        const buyPrice = parseFloat(c.buy_price);
        if (c.status === "sold") {
          if (profit >= 0 && profit >= lastTradeEntry.takeProfit * 0.9) {
            exitReason = "Take profit hit";
          } else if (profit < 0 && Math.abs(profit) >= lastTradeEntry.stopLoss * 0.9) {
            exitReason = "Stop loss hit";
          } else {
            exitReason = "Manual close or margin";
          }
        }
      }
      if (c.status === "cancelled") exitReason = "Cancelled by Deriv";
      if (c.status === "lost") exitReason = "Stop loss hit";
      if (c.status === "won") exitReason = "Take profit hit";

      if (profit >= 0) {
        log(`💰 Trade WON: +$${profit.toFixed(2)} | Reason: ${exitReason}`);
        consecutiveLosses = 0;
      } else {
        log(`💸 Trade LOST: -$${Math.abs(profit).toFixed(2)} | Reason: ${exitReason}`);
        consecutiveLosses++;
      }
      // Log to trade journal
      logTrade({
        ...lastTradeEntry,
        result,
        profit: profit.toFixed(2),
        balance: currentBalance,
        exitReason,
      });
      log(`   Balance: $${currentBalance} | Consecutive losses: ${consecutiveLosses} | Trades today: ${tradeCount}`);
    }
  }

  // ---- Errors ----
  if (msg.error && msg.msg_type !== "buy" && msg.msg_type !== "authorize") {
    log(`⚠️  API error: ${msg.error.message}`);
  }
}

function subscribeCandles() {
  // Request historical candles first
  ws.send(
    JSON.stringify({
      ticks_history: CONFIG.SYMBOL,
      style: "candles",
      granularity: CONFIG.CANDLE_INTERVAL,
      count: 100,
      end: "latest",
      subscribe: 1,
    })
  );
  log(`📡 Subscribed to ${CONFIG.SYMBOL} ${CONFIG.CANDLE_INTERVAL}s candles`);
}

function subscribeBalance() {
  ws.send(JSON.stringify({ balance: 1, subscribe: 1 }));
}

// ============================================================
//  CANDLE PROCESSING
// ============================================================

let lastCandleEpoch = 0;

function processCandle(candle) {
  // Only act on completed candles (new epoch)
  if (candle.epoch === lastCandleEpoch) {
    // Update current candle in-place
    if (candles.length > 0) {
      candles[candles.length - 1] = candle;
    }
    return;
  }

  // New candle — push and analyze
  lastCandleEpoch = candle.epoch;
  candles.push(candle);

  // Keep last 200 candles max
  if (candles.length > 200) candles.shift();

  const closes = candles.map((c) => c.close);
  const result = getSignal(closes);

  const time = new Date().toLocaleTimeString();
  log(`[${time}] ${result.reason}`);

  if (result.signal === "BUY" || result.signal === "SELL") {
    log(`\n🔔 SIGNAL: ${result.signal}`);
    placeTrade(result.signal, result.reason);
  }
}

// ============================================================
//  UTILITIES
// ============================================================

const LOG_FILE = "trades.csv";
const CONSOLE_LOG_FILE = "bot.log";

// Create CSV header if file doesn't exist
if (!fs.existsSync(LOG_FILE)) {
  fs.writeFileSync(LOG_FILE, "date,time,direction,stake,stop_loss,take_profit,multiplier,contract_id,result,profit,balance,entry_reason,exit_reason\n");
}

let lastTradeEntry = {};

// ---- TELEGRAM ----
async function sendTelegram(message) {
  if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) return;
  try {
    const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CONFIG.TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "HTML",
      }),
    });
    if (!res.ok) console.error("Telegram error:", await res.text());
  } catch (err) {
    console.error("Telegram send failed:", err.message);
  }
}

function formatTradeOpenMsg(data) {
  return `🚀 <b>NEW TRADE</b>
━━━━━━━━━━━━━━━
Direction: <b>${data.direction}</b>
Stake: $${data.stake}
Stop Loss: $${data.stopLoss}
Take Profit: $${data.takeProfit}
Multiplier: x${CONFIG.MULTIPLIER}
━━━━━━━━━━━━━━━
📊 <b>Entry Reason:</b>
${data.entryReason}
━━━━━━━━━━━━━━━
Balance: $${currentBalance}`;
}

function formatTradeCloseMsg(data) {
  const emoji = data.result === "WIN" ? "💰" : "💸";
  return `${emoji} <b>TRADE ${data.result}</b>
━━━━━━━━━━━━━━━
Direction: ${data.direction}
Profit: <b>${parseFloat(data.profit) >= 0 ? "+" : ""}$${data.profit}</b>
━━━━━━━━━━━━━━━
📊 <b>Entry Reason:</b>
${data.entryReason}

❌ <b>Exit Reason:</b>
${data.exitReason}
━━━━━━━━━━━━━━━
Balance: $${data.balance}
Consecutive Losses: ${consecutiveLosses}
Trades Today: ${tradeCount}/${CONFIG.MAX_TRADES_PER_SESSION}`;
}

// ---- GOOGLE SHEETS ----
let sheetsAPI = null;

async function initGoogleSheets() {
  if (!CONFIG.GOOGLE_SHEET_ID || !CONFIG.GOOGLE_SERVICE_ACCOUNT_EMAIL || !CONFIG.GOOGLE_PRIVATE_KEY) {
    log("⚠️  Google Sheets not configured — skipping");
    return;
  }
  try {
    const auth = new google.auth.JWT(
      CONFIG.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      null,
      CONFIG.GOOGLE_PRIVATE_KEY,
      ["https://www.googleapis.com/auth/spreadsheets"]
    );
    await auth.authorize();
    sheetsAPI = google.sheets({ version: "v4", auth });

    // Check if header row exists, if not create it
    const res = await sheetsAPI.spreadsheets.values.get({
      spreadsheetId: CONFIG.GOOGLE_SHEET_ID,
      range: "Sheet1!A1:M1",
    });
    if (!res.data.values || res.data.values.length === 0) {
      await sheetsAPI.spreadsheets.values.update({
        spreadsheetId: CONFIG.GOOGLE_SHEET_ID,
        range: "Sheet1!A1:M1",
        valueInputOption: "RAW",
        requestBody: {
          values: [["Date", "Time", "Direction", "Stake", "Stop Loss", "Take Profit", "Multiplier", "Contract ID", "Result", "Profit", "Balance", "Entry Reason", "Exit Reason"]],
        },
      });
    }
    log("✅ Google Sheets connected");
  } catch (err) {
    log(`❌ Google Sheets init failed: ${err.message}`);
    sheetsAPI = null;
  }
}

async function appendToSheet(data) {
  if (!sheetsAPI) return;
  try {
    const now = new Date();
    const date = now.toISOString().split("T")[0];
    const time = now.toTimeString().split(" ")[0];
    await sheetsAPI.spreadsheets.values.append({
      spreadsheetId: CONFIG.GOOGLE_SHEET_ID,
      range: "Sheet1!A:M",
      valueInputOption: "RAW",
      requestBody: {
        values: [[
          date, time, data.direction || "", data.stake || "", data.stopLoss || "",
          data.takeProfit || "", data.multiplier || "", data.contractId || "",
          data.result || "OPEN", data.profit || 0, data.balance || currentBalance,
          data.entryReason || "", data.exitReason || "",
        ]],
      },
    });
  } catch (err) {
    console.error("Google Sheets append failed:", err.message);
  }
}

// ---- COMBINED LOGGER ----
async function logTrade(data) {
  // 1. Local CSV (backup)
  const now = new Date();
  const date = now.toISOString().split("T")[0];
  const time = now.toTimeString().split(" ")[0];
  const entryReason = `"${(data.entryReason || "").replace(/"/g, "'")}"`;
  const exitReason = `"${(data.exitReason || "").replace(/"/g, "'")}"`;
  const row = `${date},${time},${data.direction || ""},${data.stake || ""},${data.stopLoss || ""},${data.takeProfit || ""},${data.multiplier || ""},${data.contractId || ""},${data.result || "OPEN"},${data.profit || 0},${data.balance || currentBalance},${entryReason},${exitReason}\n`;
  fs.appendFileSync(LOG_FILE, row);

  // 2. Google Sheets
  await appendToSheet(data);

  // 3. Telegram (trade closed)
  await sendTelegram(formatTradeCloseMsg(data));
}

async function logTradeOpen(data) {
  await sendTelegram(formatTradeOpenMsg(data));
}

function log(msg) {
  console.log(msg);
  const timestamp = new Date().toISOString();
  fs.appendFileSync(CONSOLE_LOG_FILE, `[${timestamp}] ${msg}\n`);
}

// Reset daily counters at midnight
function scheduleDailyReset() {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  const ms = tomorrow - now;

  setTimeout(() => {
    log("\n🔄 Daily reset — counters cleared");
    consecutiveLosses = 0;
    tradeCount = 0;
    scheduleDailyReset();
  }, ms);
}

// ============================================================
//  START
// ============================================================

log("═══════════════════════════════════════════");
log("  DERIV VIX 75 BOT — RSI + EMA Strategy");
log("═══════════════════════════════════════════");
log(`Symbol: ${CONFIG.SYMBOL}`);
log(`Account type: ${CONFIG.ACCOUNT_TYPE}`);
log(`API: New Deriv OTP-based WebSocket`);
log(`Timeframe: ${CONFIG.CANDLE_INTERVAL}s`);
log(`Risk: ${CONFIG.RISK_PERCENT}% ($${((CONFIG.RISK_PERCENT / 100) * CONFIG.ACCOUNT_BALANCE).toFixed(2)}) per trade`);
log(`Multiplier: x${CONFIG.MULTIPLIER}`);
log(`Max daily trades: ${CONFIG.MAX_TRADES_PER_SESSION}`);
log(`Stop after ${CONFIG.MAX_DAILY_LOSSES} consecutive losses`);
log("═══════════════════════════════════════════\n");

if (!CONFIG.API_TOKEN || CONFIG.API_TOKEN === "YOUR_PAT_TOKEN_HERE") {
  log("⚠️  STOP: Set DERIV_API_TOKEN in .env file!");
  log("   Get PAT from: home.deriv.com → Settings → API Token");
  process.exit(1);
}
if (!CONFIG.APP_ID) {
  log("⚠️  STOP: Set DERIV_APP_ID in .env file!");
  log("   Get it from: developers.deriv.com → Dashboard → Apps");
  process.exit(1);
}

scheduleDailyReset();
initGoogleSheets().then(() => {
  connect();
});
