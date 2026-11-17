Jim// ============================================================
// GTN BINARY OPTIONS - POSTGRESQL BACKEND
// Part 1: Server setup, security and market engine
// ============================================================

require('dotenv').config();

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const { pool, query, testConnection } = require('./database/db');

const app = express();
const server = http.createServer(app);

const wss = new WebSocket.Server({ server });

const PORT = Number(process.env.PORT || 4000);

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    throw new Error(
        'JWT_SECRET must be configured with at least 32 characters.'
    );
}

const JWT_SECRET = process.env.JWT_SECRET;

const KES_PER_USD = Number(process.env.KES_PER_USD || 130);

if (!Number.isFinite(KES_PER_USD) || KES_PER_USD <= 0) {
    throw new Error('KES_PER_USD must be a valid positive number.');
}

const PLATFORM_RULES = {
    PAYOUT_RATE: 0.80,
    MIN_DEPOSIT_USD: 5,
    MIN_WITHDRAW_USD: 10,
    MIN_STAKE_USD: 5,
    KES_PER_USD
};

// ============================================================
// MIDDLEWARE
// ============================================================

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/frontend.html');
});

// ============================================================
// GENERAL HELPERS
// ============================================================

function generateReference(prefix = 'GTN') {
    return `${prefix}-${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
}

function generateReferralCode() {
    return 'GTN' + crypto.randomBytes(5).toString('hex').toUpperCase();
}

function toNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

function roundMoney(value) {
    return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function createToken(user) {
    return jwt.sign(
        {
            sub: user.id,
            email: user.email
        },
        JWT_SECRET,
        { expiresIn: '7d' }
    );
}

function normalizePhone(phone) {
    if (!phone) return null;

    let cleaned = String(phone).replace(/\D/g, '');

    if (cleaned.startsWith('0')) {
        cleaned = '254' + cleaned.substring(1);
    } else if (cleaned.startsWith('7') || cleaned.startsWith('1')) {
        cleaned = '254' + cleaned;
    }

    if (!/^254[71]\d{8}$/.test(cleaned)) {
        return null;
    }

    return cleaned;
}

// ============================================================
// POSTGRESQL TRANSACTION HELPER
// ============================================================

async function withTransaction(callback) {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const result = await callback(client);

        await client.query('COMMIT');

        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

// ============================================================
// AUTHENTICATION MIDDLEWARE
// ============================================================

async function authenticate(req, res, next) {
    try {
        const header = req.headers.authorization;

        if (!header || !header.startsWith('Bearer ')) {
            return res.status(401).json({
                error: 'Authentication required.'
            });
        }

        const token = header.split(' ')[1];

        const decoded = jwt.verify(token, JWT_SECRET);

        const result = await query(
            `SELECT *
             FROM users
             WHERE id = $1
             LIMIT 1`,
            [decoded.sub]
        );

        if (!result.rows.length) {
            return res.status(401).json({
                error: 'User account not found.'
            });
        }

        const user = result.rows[0];

        if (user.account_status !== 'ACTIVE') {
            return res.status(403).json({
                error: 'Your account is suspended.'
            });
        }

        req.user = user;

        next();
    } catch (error) {
        if (error.name === 'TokenExpiredError' ||
            error.name === 'JsonWebTokenError') {
            return res.status(401).json({
                error: 'Invalid or expired session.'
            });
        }

        console.error('Authentication error:', error.message);

        return res.status(500).json({
            error: 'Authentication failed.'
        });
    }
}

// ============================================================
// USER RESPONSE FORMAT
// ============================================================

async function getUserWallets(userId) {
    const result = await query(
        `SELECT account_type, balance, reserved_balance
         FROM wallets
         WHERE user_id = $1`,
        [userId]
    );

    const wallets = {
        DEMO: { balance: 1000, reservedBalance: 0 },
        LIVE: { balance: 0, reservedBalance: 0 }
    };

    for (const wallet of result.rows) {
        wallets[wallet.account_type] = {
            balance: toNumber(wallet.balance),
            reservedBalance: toNumber(wallet.reserved_balance)
        };
    }

    return wallets;
}

async function formatUser(user) {
    const wallets = await getUserWallets(user.id);

    return {
        id: user.id,
        fullName: user.full_name,
        email: user.email,
        country: user.country,
        phone: user.phone,
        demoBalance: wallets.DEMO.balance,
        liveBalance: wallets.LIVE.balance,
        referralCode: user.referral_code,
        referredBy: user.referred_by,
        referralsCount: 0,
        referralEarnings: 0,
        kycStatus: user.kyc_status,
        twoFactorEnabled: user.two_factor_enabled,
        accountStatus: user.account_status,
        createdAt: user.created_at
    };
}

// ============================================================
// SYNTHETIC INDICES ENGINE
// ============================================================

const markets = {
    VOL_10_1S: {
        symbol: 'VOL_10_1S',
        name: 'Volatility 10 (1s) Index',
        price: 1000,
        volatility: 0.0008
    },

    VOL_25: {
        symbol: 'VOL_25',
        name: 'Volatility 25 Index',
        price: 2500,
        volatility: 0.0015
    },

    VOL_50: {
        symbol: 'VOL_50',
        name: 'Volatility 50 Index',
        price: 5000,
        volatility: 0.0025
    },

    VOL_75: {
        symbol: 'VOL_75',
        name: 'Volatility 75 Index',
        price: 7500,
        volatility: 0.0035
    },

    VOL_100: {
        symbol: 'VOL_100',
        name: 'Volatility 100 Index',
        price: 10000,
        volatility: 0.0045
    }
};

const marketHistory = {};

for (const symbol of Object.keys(markets)) {
    marketHistory[symbol] = [];
}

function generateMarketTick() {
    const tickPayload = {};

    for (const symbol of Object.keys(markets)) {
        const market = markets[symbol];

        const movement =
            (Math.random() - 0.5) *
            market.price *
            market.volatility;

        market.price = Math.max(1, market.price + movement);

        const tick = {
            symbol,
            name: market.name,
            price: Number(market.price.toFixed(2)),
            timestamp: new Date().toISOString()
        };

        marketHistory[symbol].push(tick);

        if (marketHistory[symbol].length > 100) {
            marketHistory[symbol].shift();
        }

        tickPayload[symbol] = tick;
    }

    return tickPayload;
}

function broadcastTick(data) {
    const message = JSON.stringify({
        type: 'TICK',
        data
    });

    for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    }
}

wss.on('connection', (socket) => {
    socket.send(JSON.stringify({
        type: 'MARKET_HISTORY',
        data: marketHistory
    }));
});

setInterval(() => {
    const ticks = generateMarketTick();
    broadcastTick(ticks);
}, 1000);

// ============================================================
// MARKET HELPERS
// ============================================================

function getMarketPrice(symbol) {
    const market = markets[symbol];

    if (!market) {
        throw new Error('Invalid market symbol.');
    }

    return Number(market.price.toFixed(2));
}

function getMarketHistory(symbol) {
    return marketHistory[symbol] || [];
}

function isValidAccountType(accountType) {
    return ['DEMO', 'LIVE'].includes(accountType);
}

function isValidContractType(contractType) {
    return [
        'RISE',
        'FALL',
        'EVEN',
        'ODD',
        'OVER',
        'UNDER',
        'MATCH',
        'DIFF'
    ].includes(contractType);
}

// ============================================================
// END OF PART 1
// More backend sections will follow.
// ============================================================Balance: 1000.00,
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
