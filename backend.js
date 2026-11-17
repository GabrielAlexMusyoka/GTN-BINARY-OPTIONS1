const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/frontend.html');
});

const JWT_SECRET = process.env.JWT_SECRET || 'gtn_gold_obsidian_secret_2026';
const PORT = process.env.PORT || 4000;

// Platform Financial Rules
const PLATFORM_RULES = {
  PAYOUT_RATE: 0.80,       // 80% fixed profit
  MIN_DEPOSIT_USD: 5.00,   // $5.00 min live deposit
  MIN_WITHDRAW_USD: 10.00, // $10.00 min live withdrawal
  MIN_STAKE_USD: 5.00,     // $5.00 min trade stake
  KES_PER_USD: 129.98
};

// In-Memory Data Store (Replace with PostgreSQL / MongoDB in production)
const db = {
  users: new Map(),
  trades: [],
  transactions: [],
  kycSubmissions: new Map()
};
const depositVerificationLocks = new Map();

function formatKenyaPhone(user) {
  if (user.country !== 'KE') throw new Error('M-Pesa payouts are currently available for Kenyan accounts only.');
  let digits = String(user.phone || '').replace(/\D/g, '');
  if (digits.startsWith('0')) digits = digits.slice(1);
  if (!digits.startsWith('254')) digits = `254${digits}`;
  if (!/^254[17]\d{8}$/.test(digits)) throw new Error('Add a valid Kenyan mobile number to your account before making a payment.');
  return digits;
}

function paymentConfigError() {
  if (!process.env.FLW_SECRET_KEY) {
    const error = new Error('Payments are not configured. Set FLW_SECRET_KEY in the server environment.');
    error.status = 503;
    return error;
  }
  if ((process.env.FLW_ENV || 'sandbox').toLowerCase() !== 'sandbox') {
    const error = new Error('Live payments are disabled in this in-memory build. Use Flutterwave sandbox credentials.');
    error.status = 503;
    return error;
  }
  if (!process.env.FLW_SECRET_KEY.startsWith('FLWSECK_TEST-')) {
    const error = new Error('Use a Flutterwave sandbox secret key beginning with FLWSECK_TEST-.');
    error.status = 503;
    return error;
  }
  return null;
}

async function flutterwaveRequest(path, body) {
  const configError = paymentConfigError();
  if (configError) throw configError;
  const apiBase = (process.env.FLW_API_BASE || 'https://api.flutterwave.com/v3').replace(/\/+$/, '');
  const response = await fetch(`${apiBase}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
      'Content-Type': 'application/json'
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const result = await response.json();
  if (!response.ok || result.status === 'error') {
    const error = new Error(result.message || `Flutterwave request failed (${response.status}).`);
    error.status = 502;
    throw error;
  }
  return result;
}

function findTransactionByReference(reference) {
  return db.transactions.find(tx => tx.reference === reference);
}

async function verifyFlutterwaveDeposit(tx, providerTransactionId) {
  const activeVerification = depositVerificationLocks.get(tx.reference);
  if (activeVerification) return activeVerification;
  if (tx.status === 'COMPLETED') return tx;

  const verification = verifyFlutterwaveDepositOnce(tx, providerTransactionId);
  depositVerificationLocks.set(tx.reference, verification);
  try {
    return await verification;
  } finally {
    depositVerificationLocks.delete(tx.reference);
  }
}

async function verifyFlutterwaveDepositOnce(tx, providerTransactionId) {
  const result = await flutterwaveRequest(`/transactions/${encodeURIComponent(providerTransactionId)}/verify`);
  const payment = result.data;
  if (!payment || String(payment.tx_ref) !== tx.reference) throw new Error('Flutterwave transaction reference did not match.');
  if (String(payment.currency).toUpperCase() !== tx.currency) throw new Error('Flutterwave transaction currency did not match.');

  const status = String(payment.status || '').toLowerCase();
  if (status === 'successful' || status === 'success') {
    if (Number(payment.amount) < tx.providerAmount) throw new Error('Flutterwave confirmed an amount lower than the requested deposit.');
    if (tx.status !== 'COMPLETED') {
      const user = db.users.get(tx.userEmail);
      if (!user) throw new Error('The account for this payment could not be found.');
      user.liveBalance = Number((user.liveBalance + tx.amount).toFixed(2));
      tx.status = 'COMPLETED';
      tx.providerTransactionId = String(payment.id);
      tx.completedAt = new Date().toISOString();
    }
  } else if (['failed', 'cancelled', 'canceled'].includes(status)) {
    tx.status = 'FAILED';
  }
  return tx;
}

async function verifyFlutterwaveTransfer(tx, transferId) {
  const result = await flutterwaveRequest(`/transfers/${encodeURIComponent(transferId)}`);
  const transfer = result.data;
  if (!transfer || String(transfer.reference) !== tx.reference) throw new Error('Flutterwave transfer reference did not match.');

  const status = String(transfer.status || '').toUpperCase();
  if (['SUCCESSFUL', 'SUCCESS', 'COMPLETED'].includes(status)) {
    tx.status = 'COMPLETED';
    tx.completedAt = new Date().toISOString();
  } else if (['FAILED', 'REVERSED'].includes(status) && tx.status !== 'FAILED') {
    const user = db.users.get(tx.userEmail);
    if (user && !tx.refunded) {
      user.liveBalance = Number((user.liveBalance + tx.amount).toFixed(2));
      tx.refunded = true;
    }
    tx.status = 'FAILED';
  }
  return tx;
}

// Synthetic Volatility Indices Engine
const markets = {
  'VOL_10_1S': { name: 'Volatility 10 (1s) Index', price: 9450.34, vol: 0.35, history: [] },
  'VOL_25':    { name: 'Volatility 25 Index',      price: 4120.80, vol: 0.65, history: [] },
  'VOL_50':    { name: 'Volatility 50 Index',      price: 6890.15, vol: 1.10, history: [] },
  'VOL_75':    { name: 'Volatility 75 Index',      price: 12450.90, vol: 1.85, history: [] },
  'VOL_100':   { name: 'Volatility 100 Index',     price: 3210.45, vol: 2.40, history: [] }
};

// Seed initial price history
Object.keys(markets).forEach(sym => {
  for (let i = 0; i < 60; i++) {
    const delta = (Math.random() - 0.5) * markets[sym].vol;
    markets[sym].price = Number((markets[sym].price + delta).toFixed(2));
    markets[sym].history.push({ time: Date.now() - (60 - i) * 1000, price: markets[sym].price });
  }
});

// Tick Generator (1 tick per second)
setInterval(() => {
  const tickPayload = {};
  Object.keys(markets).forEach(sym => {
    const m = markets[sym];
    const delta = (Math.random() - 0.5) * m.vol;
    m.price = Number(Math.max(10, m.price + delta).toFixed(2));
    const lastDigit = Number(m.price.toFixed(2).slice(-1));
    const point = { time: Date.now(), price: m.price, lastDigit };
    m.history.push(point);
    if (m.history.length > 100) m.history.shift();
    tickPayload[sym] = point;
  });

  // Settle active trades on new tick
  settlePendingTrades(tickPayload);

  // Broadcast live prices to connected clients
  const msg = JSON.stringify({ type: 'TICK', data: tickPayload });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}, 1000);

function settlePendingTrades(tickPayload) {
  const now = Date.now();
  db.trades.forEach(trade => {
    if (trade.status !== 'OPEN' || now < trade.expiresAt) return;
    const tick = tickPayload[trade.symbol];
    if (!tick) return;

    const entry = trade.entryPrice;
    const exit = tick.price;
    const digit = tick.lastDigit;
    let won = false;

    if (trade.contractType === 'RISE') won = exit > entry;
    if (trade.contractType === 'FALL') won = exit < entry;
    if (trade.contractType === 'EVEN') won = digit % 2 === 0;
    if (trade.contractType === 'ODD')  won = digit % 2 !== 0;
    if (trade.contractType === 'OVER') won = digit > trade.barrier;
    if (trade.contractType === 'UNDER') won = digit < trade.barrier;
    if (trade.contractType === 'MATCH') won = digit === trade.barrier;
    if (trade.contractType === 'DIFF')  won = digit !== trade.barrier;

    trade.exitPrice = exit;
    trade.exitDigit = digit;
    trade.status = won ? 'WON' : 'LOST';
    trade.profit = won ? Number((trade.stake * PLATFORM_RULES.PAYOUT_RATE).toFixed(2)) : -trade.stake;

    if (won) {
      const user = db.users.get(trade.userEmail);
      if (user) {
        const totalReturn = Number((trade.stake + trade.profit).toFixed(2));
        if (trade.accountType === 'LIVE') user.liveBalance = Number((user.liveBalance + totalReturn).toFixed(2));
        else user.demoBalance = Number((user.demoBalance + totalReturn).toFixed(2));
      }
    }
  });
}

// Auth Middleware
function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'Missing token' });
  try {
    req.user = jwt.verify(header.split(' ')[1], JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// 1. Register Endpoint
app.post('/api/auth/register', async (req, res) => {
  const { fullName, email, country, phone, password, referralCode } = req.body;
  if (!fullName || !email || !password || password.length < 6) {
    return res.status(400).json({ error: 'Valid name, email, and 6+ char password required.' });
  }
  if (db.users.has(email.toLowerCase())) {
    return res.status(409).json({ error: 'Account with this email already exists.' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const myRefCode = crypto.randomBytes(4).toString('hex').toUpperCase();

  const user = {
    id: crypto.randomUUID(),
    fullName,
    email: email.toLowerCase(),
    country: country || 'KE',
    phone: phone || '+254700000000',
    passwordHash,
    demoBalance: 1000.00,
    liveBalance: 0.00,
    referralCode: myRefCode,
    referredBy: referralCode || null,
    referralsCount: 0,
    referralEarnings: 0.00,
    kycStatus: 'unverified',
    twoFactorEnabled: false,
    createdAt: new Date().toISOString()
  };

  db.users.set(user.email, user);
  const token = jwt.sign({ email: user.email, id: user.id }, JWT_SECRET, { expiresIn: '7d' });
  const { passwordHash: _, ...safeUser } = user;
  res.json({ token, user: safeUser, rules: PLATFORM_RULES });
});

// 2. Login Endpoint
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const user = db.users.get((email || '').toLowerCase());
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }
  const token = jwt.sign({ email: user.email, id: user.id }, JWT_SECRET, { expiresIn: '7d' });
  const { passwordHash: _, ...safeUser } = user;
  res.json({ token, user: safeUser, rules: PLATFORM_RULES });
});

// 3. Place Trade Endpoint
app.post('/api/trades/place', authenticate, (req, res) => {
  const user = db.users.get(req.user.email);
  const { symbol, accountType, contractType, stake, durationSec, barrier } = req.body;

  const amt = Number(stake);
  if (isNaN(amt) || amt < PLATFORM_RULES.MIN_STAKE_USD) {
    return res.status(400).json({ error: `Minimum trade stake is $${PLATFORM_RULES.MIN_STAKE_USD.toFixed(2)}` });
  }

  const balanceField = accountType === 'LIVE' ? 'liveBalance' : 'demoBalance';
  if (user[balanceField] < amt) {
    return res.status(400).json({ error: `Insufficient ${accountType} balance.` });
  }

  const market = markets[symbol] || markets['VOL_10_1S'];
  user[balanceField] = Number((user[balanceField] - amt).toFixed(2));

  const trade = {
    id: 'TRD-' + crypto.randomBytes(3).toString('hex').toUpperCase(),
    userEmail: user.email,
    symbol,
    marketName: market.name,
    accountType,
    contractType,
    barrier: barrier !== undefined ? Number(barrier) : 5,
    stake: amt,
    payoutRate: PLATFORM_RULES.PAYOUT_RATE,
    entryPrice: market.price,
    exitPrice: null,
    status: 'OPEN',
    profit: 0,
    createdAt: Date.now(),
    expiresAt: Date.now() + (Number(durationSec || 2) * 1000)
  };

  db.trades.unshift(trade);
  res.json({ trade, balance: user[balanceField] });
});

// 4. Live deposits through Flutterwave (M-Pesa prompt or hosted card checkout)
app.post('/api/cashier/deposit', authenticate, async (req, res) => {
  const user = db.users.get(req.user.email);
  const amount = Number(req.body.amount);
  const method = String(req.body.method || '').toUpperCase();
  if (!Number.isFinite(amount) || amount < PLATFORM_RULES.MIN_DEPOSIT_USD) {
    return res.status(400).json({ error: `Minimum deposit is $${PLATFORM_RULES.MIN_DEPOSIT_USD.toFixed(2)}` });
  }
  if (method !== 'MPESA' && method !== 'CARD') {
    return res.status(400).json({ error: 'Choose M-Pesa or credit/debit card.' });
  }
  if (method === 'MPESA' && user.country !== 'KE') {
    return res.status(400).json({ error: 'M-Pesa deposits are currently available for Kenyan accounts only.' });
  }
  const configError = paymentConfigError();
  if (configError) return res.status(configError.status).json({ error: configError.message });

  const reference = `GTN-DEP-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
  const isMpesa = method === 'MPESA';
  const providerAmount = isMpesa ? Math.round(amount * PLATFORM_RULES.KES_PER_USD) : amount;
  const tx = {
    id: 'DEP-' + crypto.randomBytes(3).toString('hex').toUpperCase(),
    reference,
    userEmail: user.email,
    type: 'DEPOSIT',
    accountType: 'LIVE',
    method,
    amount,
    providerAmount,
    currency: isMpesa ? 'KES' : 'USD',
    status: 'PENDING',
    timestamp: new Date().toISOString()
  };

  try {
    let response;
    if (isMpesa) {
      const phone = formatKenyaPhone(user);
      response = await flutterwaveRequest('/charges?type=mpesa', {
        amount: providerAmount,
        currency: 'KES',
        email: user.email,
        tx_ref: reference,
        phone_number: phone,
        fullname: user.fullName
      });
    } else {
      const baseUrl = process.env.APP_BASE_URL || `http://localhost:${PORT}`;
      response = await flutterwaveRequest('/payments', {
        tx_ref: reference,
        amount: providerAmount,
        currency: 'USD',
        redirect_url: `${baseUrl}/api/cashier/flutterwave/callback`,
        payment_options: 'card',
        customer: { email: user.email, name: user.fullName, phonenumber: user.phone },
        meta: { user_email: user.email, account_type: 'LIVE' },
        customizations: { title: 'GTN Binary Options', description: 'Live account deposit' }
      });
    }
    const data = response.data || {};
    tx.providerTransactionId = data.id ? String(data.id) : null;
    db.transactions.unshift(tx);
    if (isMpesa) {
      return res.status(202).json({ transaction: tx, message: 'Payment prompt initiated.' });
    }
    if (!data.link) {
      tx.status = 'FAILED';
      return res.status(502).json({ error: 'Flutterwave did not return a secure card checkout link.' });
    }
    return res.status(201).json({ transaction: tx, checkoutUrl: data.link });
  } catch (error) {
    console.error('Flutterwave deposit initiation failed:', error.message);
    return res.status(error.status || 502).json({ error: error.message || 'Could not start the payment. Please try again.' });
  }
});

app.get('/api/cashier/status/:reference', authenticate, async (req, res) => {
  const tx = findTransactionByReference(req.params.reference);
  if (!tx || tx.userEmail !== req.user.email || tx.type !== 'DEPOSIT') {
    return res.status(404).json({ error: 'Payment not found.' });
  }
  try {
    if (tx.status === 'PENDING' && tx.providerTransactionId) {
      await verifyFlutterwaveDeposit(tx, tx.providerTransactionId);
    }
    return res.json({ id: tx.id, reference: tx.reference, status: tx.status });
  } catch (error) {
    console.error('Flutterwave payment verification failed:', error.message);
    return res.status(error.status || 502).json({ error: error.message });
  }
});

app.get('/api/cashier/flutterwave/callback', async (req, res) => {
  const tx = findTransactionByReference(String(req.query.tx_ref || ''));
  const transactionId = String(req.query.transaction_id || '');
  if (!tx || tx.type !== 'DEPOSIT' || !transactionId) {
    return res.redirect('/?payment=failed');
  }
  try {
    await verifyFlutterwaveDeposit(tx, transactionId);
    return res.redirect(`/?payment=${tx.status === 'COMPLETED' ? 'success' : 'pending'}`);
  } catch (error) {
    console.error('Flutterwave checkout callback verification failed:', error.message);
    return res.redirect('/?payment=failed');
  }
});

app.post('/api/cashier/flutterwave/webhook', async (req, res) => {
  const expectedHash = process.env.FLW_WEBHOOK_HASH || '';
  const receivedHash = req.get('verif-hash') || '';
  if (!expectedHash || receivedHash.length !== expectedHash.length ||
      !crypto.timingSafeEqual(Buffer.from(receivedHash), Buffer.from(expectedHash))) {
    return res.status(401).json({ error: 'Invalid Flutterwave webhook signature.' });
  }

  const data = req.body.data || {};
  try {
    if (String(req.body.event || '').toLowerCase().startsWith('charge.') && data.tx_ref) {
      const tx = findTransactionByReference(String(data.tx_ref));
      if (tx && tx.type === 'DEPOSIT' && data.id) await verifyFlutterwaveDeposit(tx, data.id);
    } else if (String(req.body.event || '').toLowerCase().startsWith('transfer.')) {
      const tx = db.transactions.find(item => item.providerTransactionId === String(data.id) && item.type === 'WITHDRAWAL');
      if (tx) await verifyFlutterwaveTransfer(tx, data.id);
    }
    return res.sendStatus(200);
  } catch (error) {
    console.error('Flutterwave webhook processing failed:', error.message);
    return res.status(500).json({ error: 'Webhook processing failed.' });
  }
});

// 5. M-Pesa payout to the account's registered Kenyan phone number
app.post('/api/cashier/withdraw', authenticate, async (req, res) => {
  const user = db.users.get(req.user.email);
  const amount = Number(req.body.amount);
  if (!Number.isFinite(amount) || amount < PLATFORM_RULES.MIN_WITHDRAW_USD) {
    return res.status(400).json({ error: `Minimum withdrawal is $${PLATFORM_RULES.MIN_WITHDRAW_USD.toFixed(2)}` });
  }
  if (user.liveBalance < amount) {
    return res.status(400).json({ error: 'Insufficient Live Account balance.' });
  }
  const configError = paymentConfigError();
  if (configError) return res.status(configError.status).json({ error: configError.message });

  let phone;
  try {
    phone = formatKenyaPhone(user);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  const reference = `GTN-WDR-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
  const kesAmount = Math.round(amount * PLATFORM_RULES.KES_PER_USD);
  try {
    const response = await flutterwaveRequest('/transfers', {
      account_bank: 'MPS',
      account_number: phone,
      amount: kesAmount,
      currency: 'KES',
      narration: 'GTN account withdrawal',
      reference,
      beneficiary_name: user.fullName
    });
    const transfer = response.data || {};
    if (!transfer.id || ['FAILED', 'REVERSED'].includes(String(transfer.status || '').toUpperCase())) {
      return res.status(502).json({ error: 'Flutterwave did not accept the M-Pesa payout.' });
    }
    user.liveBalance = Number((user.liveBalance - amount).toFixed(2));
    const tx = {
      id: 'WDR-' + crypto.randomBytes(3).toString('hex').toUpperCase(),
      reference,
      userEmail: user.email,
      type: 'WITHDRAWAL',
      accountType: 'LIVE',
      method: 'MPESA',
      amount,
      providerAmount: kesAmount,
      currency: 'KES',
      destination: phone,
      providerTransactionId: String(transfer.id),
      status: 'PENDING',
      timestamp: new Date().toISOString()
    };
    db.transactions.unshift(tx);
    return res.status(202).json({ transaction: tx, liveBalance: user.liveBalance });
  } catch (error) {
    console.error('Flutterwave M-Pesa payout failed:', error.message);
    return res.status(error.status || 502).json({ error: error.message || 'Could not start the M-Pesa payout.' });
  }
});

// 6. Account Profile & KYC Update
app.post('/api/account/kyc', authenticate, (req, res) => {
  const user = db.users.get(req.user.email);
  user.kycStatus = 'pending_review';
  res.json({ kycStatus: user.kycStatus });
});

app.get('/api/state', authenticate, (req, res) => {
  const user = db.users.get(req.user.email);
  const { passwordHash: _, ...safeUser } = user;
  res.json({
    user: safeUser,
    trades: db.trades.filter(t => t.userEmail === user.email).slice(0, 50),
    transactions: db.transactions.filter(tx => tx.userEmail === user.email).slice(0, 30).map(tx => ({
      id: tx.id,
      type: tx.type,
      accountType: tx.accountType,
      method: tx.method,
      amount: tx.amount,
      status: tx.status,
      timestamp: tx.timestamp
    }))
  });
});

server.listen(PORT, () => {
  console.log(`GTN Binary Options Backend running on http://localhost:${PORT}`);
});