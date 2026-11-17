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
// ============================================================
// PART 2: CUSTOMER REGISTRATION AND LOGIN
// ============================================================

// ------------------------------------------------------------
// CUSTOMER REGISTRATION
// ------------------------------------------------------------

app.post('/api/auth/register', async (req, res) => {
    try {
        const {
            name,
            fullName,
            email,
            password,
            country = 'KE',
            phone = ''
        } = req.body;

        const customerName = String(fullName || name || '').trim();
        const customerEmail = String(email || '').trim().toLowerCase();

        if (!customerName || !customerEmail || !password) {
            return res.status(400).json({
                error: 'Name, email and password are required.'
            });
        }

        if (customerName.length < 2 || customerName.length > 100) {
            return res.status(400).json({
                error: 'Name must be between 2 and 100 characters.'
            });
        }

        const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

        if (!emailPattern.test(customerEmail)) {
            return res.status(400).json({
                error: 'Enter a valid email address.'
            });
        }

        if (String(password).length < 8) {
            return res.status(400).json({
                error: 'Password must contain at least 8 characters.'
            });
        }

        if (String(password).length > 128) {
            return res.status(400).json({
                error: 'Password is too long.'
            });
        }

        if (country !== 'KE') {
            return res.status(400).json({
                error: 'Registration is currently available for Kenya only.'
            });
        }

        const normalizedPhone = phone ? normalizePhone(phone) : null;

        if (phone && !normalizedPhone) {
            return res.status(400).json({
                error: 'Enter a valid Kenyan phone number.'
            });
        }

        const existingUser = await query(
            'SELECT id FROM users WHERE email = $1 LIMIT 1',
            [customerEmail]
        );

        if (existingUser.rows.length) {
            return res.status(409).json({
                error: 'An account with this email already exists.'
            });
        }

        const passwordHash = await bcrypt.hash(password, 12);

        const result = await withTransaction(async (client) => {
            let user;

            // Generate a referral code and retry if a collision occurs.
            for (let attempt = 0; attempt < 5; attempt++) {
                const referralCode = generateReferralCode();

                try {
                    const insertedUser = await client.query(
                        `INSERT INTO users (
                            full_name,
                            email,
                            password_hash,
                            country,
                            phone,
                            referral_code,
                            kyc_status,
                            two_factor_enabled,
                            account_status
                        )
                        VALUES ($1, $2, $3, $4, $5, $6,
                                'not_submitted', FALSE, 'ACTIVE')
                        RETURNING *`,
                        [
                            customerName,
                            customerEmail,
                            passwordHash,
                            country,
                            normalizedPhone,
                            referralCode
                        ]
                    );

                    user = insertedUser.rows[0];
                    break;
                } catch (error) {
                    if (error.code === '23505' &&
                        error.constraint &&
                        error.constraint.includes('referral')) {
                        continue;
                    }

                    throw error;
                }
            }

            if (!user) {
                throw new Error('Could not generate a unique referral code.');
            }

            // Create DEMO wallet.
            const demoWallet = await client.query(
                `INSERT INTO wallets (
                    user_id,
                    account_type,
                    balance,
                    reserved_balance,
                    currency
                )
                VALUES ($1, 'DEMO', 1000.00, 0.00, 'USD')
                RETURNING *`,
                [user.id]
            );

            // Create LIVE wallet.
            await client.query(
                `INSERT INTO wallets (
                    user_id,
                    account_type,
                    balance,
                    reserved_balance,
                    currency
                )
                VALUES ($1, 'LIVE', 0.00, 0.00, 'USD')`,
                [user.id]
            );

            // Record the initial demo wallet credit.
            await client.query(
                `INSERT INTO wallet_ledger (
                    user_id,
                    wallet_id,
                    account_type,
                    entry_type,
                    amount,
                    balance_after,
                    idempotency_key,
                    description
                )
                VALUES (
                    $1, $2, 'DEMO', 'INITIAL_DEMO',
                    1000.00, 1000.00, $3,
                    'Initial demo wallet funding'
                )`,
                [
                    user.id,
                    demoWallet.rows[0].id,
                    `INITIAL_DEMO_${user.id}`
                ]
            );

            return user;
        });

        const token = createToken(result);
        const safeUser = await formatUser(result);

        return res.status(201).json({
            message: 'Account created successfully.',
            token,
            user: safeUser,
            rules: PLATFORM_RULES
        });

    } catch (error) {
        console.error('Registration error:', error.message);

        if (error.code === '23505') {
            return res.status(409).json({
                error: 'An account with these details already exists.'
            });
        }

        return res.status(500).json({
            error: 'Could not create your account.'
        });
    }
});

// ------------------------------------------------------------
// CUSTOMER LOGIN
// ------------------------------------------------------------

app.post('/api/auth/login', async (req, res) => {
    try {
        const email = String(req.body.email || '')
            .trim()
            .toLowerCase();

        const password = req.body.password;

        if (!email || !password) {
            return res.status(400).json({
                error: 'Email and password are required.'
            });
        }

        const result = await query(
            `SELECT *
             FROM users
             WHERE email = $1
             LIMIT 1`,
            [email]
        );

        if (!result.rows.length) {
            return res.status(401).json({
                error: 'Invalid email or password.'
            });
        }

        const user = result.rows[0];

        const passwordMatches = await bcrypt.compare(
            password,
            user.password_hash
        );

        if (!passwordMatches) {
            return res.status(401).json({
                error: 'Invalid email or password.'
            });
        }

        if (user.account_status !== 'ACTIVE') {
            return res.status(403).json({
                error: 'Your account is suspended. Contact support.'
            });
        }

        const token = createToken(user);
        const safeUser = await formatUser(user);

        return res.json({
            message: 'Login successful.',
            token,
            user: safeUser,
            rules: PLATFORM_RULES
        });

    } catch (error) {
        console.error('Login error:', error.message);

        return res.status(500).json({
            error: 'Could not log in. Please try again.'
        });
    }
});

// ============================================================
// END OF PART 2
// ============================================================
// ============================================================
// PART 3: WALLET MANAGEMENT AND TRADE EXECUTION
// ============================================================

// ------------------------------------------------------------
// GET WALLET
// ------------------------------------------------------------

async function getWallet(client, userId, accountType, lock = false) {
    const result = await client.query(
        `SELECT *
         FROM wallets
         WHERE user_id = $1
           AND account_type = $2
         ${lock ? 'FOR UPDATE' : ''}`,
        [userId, accountType]
    );

    if (!result.rows.length) {
        throw new Error('Wallet not found.');
    }

    return result.rows[0];
}

// ------------------------------------------------------------
// RECORD WALLET LEDGER ENTRY
// ------------------------------------------------------------

async function recordLedger(client, {
    userId,
    walletId,
    accountType,
    entryType,
    amount,
    balanceAfter,
    idempotencyKey,
    description
}) {
    await client.query(
        `INSERT INTO wallet_ledger (
            user_id,
            wallet_id,
            account_type,
            entry_type,
            amount,
            balance_after,
            idempotency_key,
            description
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
            userId,
            walletId,
            accountType,
            entryType,
            amount,
            balanceAfter,
            idempotencyKey,
            description
        ]
    );
}

// ------------------------------------------------------------
// CONTRACT RESULT CALCULATION
// ------------------------------------------------------------

function getContractResult(contractType, entryPrice, exitPrice, barrier) {
    const entry = Number(entryPrice);
    const exit = Number(exitPrice);

    const exitInteger = Math.floor(Math.abs(exit));
    const exitDigit = exitInteger % 10;

    switch (contractType) {
        case 'RISE':
            return exit > entry;

        case 'FALL':
            return exit < entry;

        case 'EVEN':
            return exitDigit % 2 === 0;

        case 'ODD':
            return exitDigit % 2 !== 0;

        case 'OVER':
            return exitDigit > barrier;

        case 'UNDER':
            return exitDigit < barrier;

        case 'MATCH':
            return exitDigit === barrier;

        case 'DIFF':
            return exitDigit !== barrier;

        default:
            throw new Error('Invalid contract type.');
    }
}

// ------------------------------------------------------------
// PLACE TRADE
// ------------------------------------------------------------

app.post('/api/trades/place', authenticate, async (req, res) => {
    try {
        const userId = req.user.id;

        const {
            accountType = 'DEMO',
            symbol = 'VOL_10_1S',
            contractType,
            type,
            stake,
            amount,
            duration = 2,
            barrier
        } = req.body;

        const selectedAccount = String(accountType).toUpperCase();
        const selectedContract = String(
            contractType || type || ''
        ).toUpperCase();

        const selectedSymbol = String(symbol).toUpperCase();

        const tradeStake = roundMoney(
            Number(stake !== undefined ? stake : amount)
        );

        const tradeDuration = Number(duration);
        const selectedBarrier = Number(barrier);

        if (!isValidAccountType(selectedAccount)) {
            return res.status(400).json({
                error: 'Invalid account type.'
            });
        }

        if (!isValidContractType(selectedContract)) {
            return res.status(400).json({
                error: 'Invalid contract type.'
            });
        }

        if (!markets[selectedSymbol]) {
            return res.status(400).json({
                error: 'Invalid market symbol.'
            });
        }

        if (
            !Number.isFinite(tradeStake) ||
            tradeStake < PLATFORM_RULES.MIN_STAKE_USD
        ) {
            return res.status(400).json({
                error: `Minimum trade stake is $${PLATFORM_RULES.MIN_STAKE_USD}.`
            });
        }

        if (
            !Number.isInteger(tradeDuration) ||
            tradeDuration < 2 ||
            tradeDuration > 3600
        ) {
            return res.status(400).json({
                error: 'Trade duration must be between 2 and 3600 seconds.'
            });
        }

        if (
            ['OVER', 'UNDER', 'MATCH', 'DIFF'].includes(selectedContract) &&
            (!Number.isInteger(selectedBarrier) ||
                selectedBarrier < 0 ||
                selectedBarrier > 9)
        ) {
            return res.status(400).json({
                error: 'Barrier must be a whole number from 0 to 9.'
            });
        }

        const entryPrice = getMarketPrice(selectedSymbol);
        const tradeId = crypto.randomUUID();
        const reference = generateReference('TRADE');

        const trade = await withTransaction(async (client) => {
            const wallet = await getWallet(
                client,
                userId,
                selectedAccount,
                true
            );

            const currentBalance = toNumber(wallet.balance);
            const reservedBalance = toNumber(wallet.reserved_balance);

            const availableBalance = roundMoney(
                currentBalance - reservedBalance
            );

            if (availableBalance < tradeStake) {
                throw new Error('INSUFFICIENT_FUNDS');
            }

            const newBalance = roundMoney(
                currentBalance - tradeStake
            );

            await client.query(
                `UPDATE wallets
                 SET balance = $1,
                     updated_at = NOW()
                 WHERE id = $2`,
                [newBalance, wallet.id]
            );

            await recordLedger(client, {
                userId,
                walletId: wallet.id,
                accountType: selectedAccount,
                entryType: 'TRADE_STAKE',
                amount: -tradeStake,
                balanceAfter: newBalance,
                idempotencyKey: `TRADE_STAKE_${tradeId}`,
                description: `Stake for ${selectedContract} trade`
            });

            const expiresAt = new Date(
                Date.now() + tradeDuration * 1000
            );

            const insertedTrade = await client.query(
                `INSERT INTO trades (
                    id,
                    user_id,
                    wallet_id,
                    account_type,
                    symbol,
                    contract_type,
                    stake,
                    entry_price,
                    barrier,
                    duration_seconds,
                    status,
                    opened_at,
                    expires_at
                )
                VALUES (
                    $1, $2, $3, $4, $5, $6,
                    $7, $8, $9, $10,
                    'OPEN', NOW(), $11
                )
                RETURNING *`,
                [
                    tradeId,
                    userId,
                    wallet.id,
                    selectedAccount,
                    selectedSymbol,
                    selectedContract,
                    tradeStake,
                    entryPrice,
                    barrier === undefined ? null : selectedBarrier,
                    tradeDuration,
                    expiresAt
                ]
            );

            await client.query(
                `INSERT INTO transactions (
                    user_id,
                    reference,
                    type,
                    amount,
                    currency,
                    status,
                    provider,
                    provider_reference,
                    description
                )
                VALUES (
                    $1, $2, 'TRADE', $3, 'USD',
                    'COMPLETED', 'GTN', $2, $4
                )`,
                [
                    userId,
                    reference,
                    tradeStake,
                    `${selectedContract} trade stake`
                ]
            );

            return insertedTrade.rows[0];
        });

        return res.status(201).json({
            message: 'Trade placed successfully.',
            trade: {
                id: trade.id,
                symbol: trade.symbol,
                contractType: trade.contract_type,
                accountType: trade.account_type,
                stake: toNumber(trade.stake),
                entryPrice: toNumber(trade.entry_price),
                barrier: trade.barrier,
                duration: trade.duration_seconds,
                status: trade.status,
                openedAt: trade.opened_at,
                expiresAt: trade.expires_at
            }
        });

    } catch (error) {
        if (error.message === 'INSUFFICIENT_FUNDS') {
            return res.status(400).json({
                error: 'Insufficient available wallet balance.'
            });
        }

        console.error('Trade placement error:', error.message);

        return res.status(500).json({
            error: 'Could not place trade.'
        });
    }
});

// ------------------------------------------------------------
// SETTLE EXPIRED TRADES
// ------------------------------------------------------------

let settlementRunning = false;

async function settleExpiredTrades() {
    if (settlementRunning) return;

    settlementRunning = true;

    try {
        const expired = await query(
            `SELECT id
             FROM trades
             WHERE status = 'OPEN'
               AND expires_at <= NOW()
             ORDER BY expires_at ASC
             LIMIT 50`
        );

        for (const item of expired.rows) {
            await withTransaction(async (client) => {
                const tradeResult = await client.query(
                    `SELECT *
                     FROM trades
                     WHERE id = $1
                       AND status = 'OPEN'
                       AND expires_at <= NOW()
                     FOR UPDATE`,
                    [item.id]
                );

                if (!tradeResult.rows.length) return;

                const trade = tradeResult.rows[0];

                const wallet = await getWallet(
                    client,
                    trade.user_id,
                    trade.account_type,
                    true
                );

                const exitPrice = getMarketPrice(trade.symbol);

                const won = getContractResult(
                    trade.contract_type,
                    trade.entry_price,
                    exitPrice,
                    trade.barrier === null ? 0 : Number(trade.barrier)
                );

                const stake = toNumber(trade.stake);

                const profit = won
                    ? roundMoney(stake * PLATFORM_RULES.PAYOUT_RATE)
                    : 0;

                const payout = won
                    ? roundMoney(stake + profit)
                    : 0;

                const newBalance = roundMoney(
                    toNumber(wallet.balance) + payout
                );

                if (won) {
                    await client.query(
                        `UPDATE wallets
                         SET balance = $1,
                             updated_at = NOW()
                         WHERE id = $2`,
                        [newBalance, wallet.id]
                    );

                    await recordLedger(client, {
                        userId: trade.user_id,
                        walletId: wallet.id,
                        accountType: trade.account_type,
                        entryType: 'TRADE_WIN',
                        amount: payout,
                        balanceAfter: newBalance,
                        idempotencyKey: `TRADE_WIN_${trade.id}`,
                        description: `Winning ${trade.contract_type} trade payout`
                    });
                }

                await client.query(
                    `UPDATE trades
                     SET status = 'CLOSED',
                         result = $1,
                         exit_price = $2,
                         profit = $3,
                         payout = $4,
                         closed_at = NOW()
                     WHERE id = $5`,
                    [
                        won ? 'WIN' : 'LOSS',
                        exitPrice,
                        profit,
                        payout,
                        trade.id
                    ]
                );

                await client.query(
                    `INSERT INTO transactions (
                        user_id,
                        reference,
                        type,
                        amount,
                        currency,
                        status,
                        provider,
                        provider_reference,
                        description
                    )
                    VALUES (
                        $1, $2, $3, $4, 'USD',
                        'COMPLETED', 'GTN', $2, $5
                    )`,
                    [
                        trade.user_id,
                        generateReference('SETTLEMENT'),
                        won ? 'TRADE_WIN' : 'TRADE_LOSS',
                        won ? payout : stake,
                        won
                            ? 'Winning trade payout'
                            : 'Losing trade stake'
                    ]
                );
            });
        }

    } catch (error) {
        console.error('Trade settlement error:', error.message);
    } finally {
        settlementRunning = false;
    }
}

setInterval(settleExpiredTrades, 1000);

// ============================================================
// END OF PART 3
// ============================================================
// ============================================================
// PART 4: PESAPAL DEPOSITS
// ============================================================

const PESAPAL_ENVIRONMENT =
    process.env.PESAPAL_ENVIRONMENT || 'sandbox';

const PESAPAL_BASE_URL =
    PESAPAL_ENVIRONMENT === 'live'
        ? 'https://pay.pesapal.com/v3'
        : 'https://cybqa.pesapal.com/pesapalv3';

let pesapalToken = null;
let pesapalTokenExpiresAt = 0;

// ------------------------------------------------------------
// PESAPAL CONFIGURATION
// ------------------------------------------------------------

function validatePesapalConfig() {
    if (
        !process.env.PESAPAL_CONSUMER_KEY ||
        !process.env.PESAPAL_CONSUMER_SECRET ||
        !process.env.PESAPAL_CALLBACK_URL ||
        !process.env.PESAPAL_IPN_ID
    ) {
        throw new Error('Pesapal configuration is incomplete.');
    }
}

// ------------------------------------------------------------
// PESAPAL AUTHENTICATION
// ------------------------------------------------------------

async function getPesapalToken() {
    validatePesapalConfig();

    if (
        pesapalToken &&
        Date.now() < pesapalTokenExpiresAt
    ) {
        return pesapalToken;
    }

    const response = await fetch(
        `${PESAPAL_BASE_URL}/api/Auth/RequestToken`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({
                consumer_key: process.env.PESAPAL_CONSUMER_KEY,
                consumer_secret: process.env.PESAPAL_CONSUMER_SECRET
            })
        }
    );

    const data = await response.json();

    if (!response.ok || !data.token) {
        throw new Error(
            data.message || 'Pesapal authentication failed.'
        );
    }

    pesapalToken = data.token;

    // Refresh before Pesapal's maximum five-minute token lifetime.
    pesapalTokenExpiresAt = Date.now() + (4 * 60 * 1000);

    return pesapalToken;
}

// ------------------------------------------------------------
// PESAPAL API REQUEST
// ------------------------------------------------------------

async function pesapalRequest(path, options = {}) {
    const token = await getPesapalToken();

    const response = await fetch(
        `${PESAPAL_BASE_URL}${path}`,
        {
            ...options,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                ...(options.headers || {})
            }
        }
    );

    const data = await response.json();

    if (!response.ok) {
        throw new Error(
            data.message || 'Pesapal request failed.'
        );
    }

    return data;
}

// ------------------------------------------------------------
// VERIFY PAYMENT WITH PESAPAL
// ------------------------------------------------------------

async function getPesapalPaymentStatus(trackingId) {
    const data = await pesapalRequest(
        `/api/Transactions/GetTransactionStatus?orderTrackingId=${encodeURIComponent(trackingId)}`,
        { method: 'GET' }
    );

    return data;
}

// ------------------------------------------------------------
// CREDIT A VERIFIED DEPOSIT
// ------------------------------------------------------------

async function creditVerifiedDeposit(trackingId) {
    return withTransaction(async (client) => {
        const depositResult = await client.query(
            `SELECT *
             FROM deposits
             WHERE pesapal_tracking_id = $1
             FOR UPDATE`,
            [trackingId]
        );

        if (!depositResult.rows.length) {
            throw new Error('DEPOSIT_NOT_FOUND');
        }

        const deposit = depositResult.rows[0];

        if (deposit.status === 'COMPLETED') {
            return {
                alreadyCredited: true,
                deposit
            };
        }

        const walletResult = await client.query(
            `SELECT *
             FROM wallets
             WHERE user_id = $1
               AND account_type = 'LIVE'
             FOR UPDATE`,
            [deposit.user_id]
        );

        if (!walletResult.rows.length) {
            throw new Error('LIVE_WALLET_NOT_FOUND');
        }

        const wallet = walletResult.rows[0];

        const usdAmount = toNumber(deposit.usd_amount);

        const newBalance = roundMoney(
            toNumber(wallet.balance) + usdAmount
        );

        await client.query(
            `UPDATE wallets
             SET balance = $1,
                 updated_at = NOW()
             WHERE id = $2`,
            [newBalance, wallet.id]
        );

        await recordLedger(client, {
            userId: deposit.user_id,
            walletId: wallet.id,
            accountType: 'LIVE',
            entryType: 'DEPOSIT',
            amount: usdAmount,
            balanceAfter: newBalance,
            idempotencyKey: `PESAPAL_DEPOSIT_${deposit.id}`,
            description: 'Verified Pesapal M-Pesa deposit'
        });

        await client.query(
            `UPDATE deposits
             SET status = 'COMPLETED',
                 provider_status = 'COMPLETED',
                 credited_at = NOW()
             WHERE id = $1`,
            [deposit.id]
        );

        await client.query(
            `UPDATE transactions
             SET status = 'COMPLETED'
             WHERE reference = $1`,
            [deposit.reference]
        );

        return {
            alreadyCredited: false,
            balance: newBalance,
            deposit
        };
    });
}

// ------------------------------------------------------------
// CREATE DEPOSIT CHECKOUT
// ------------------------------------------------------------

app.post('/api/cashier/deposit', authenticate, async (req, res) => {
    let reference;

    try {
        const user = req.user;

        const amount = roundMoney(Number(req.body.amount));

        const phone = normalizePhone(
            req.body.phone || user.phone
        );

        const method = String(
            req.body.method || 'MPESA'
        ).toUpperCase();

        if (method !== 'MPESA') {
            return res.status(400).json({
                error: 'Only M-Pesa deposits are supported.'
            });
        }

        if (user.country !== 'KE') {
            return res.status(400).json({
                error: 'M-Pesa deposits are currently available for Kenyan accounts only.'
            });
        }

        if (
            !Number.isFinite(amount) ||
            amount < PLATFORM_RULES.MIN_DEPOSIT_USD
        ) {
            return res.status(400).json({
                error: `Minimum deposit is $${PLATFORM_RULES.MIN_DEPOSIT_USD}.`
            });
        }

        if (!phone) {
            return res.status(400).json({
                error: 'Enter a valid Kenyan M-Pesa phone number.'
            });
        }

        validatePesapalConfig();

        const kesAmount = roundMoney(
            amount * KES_PER_USD
        );

        reference = generateReference('GTNDEP');

        // Save the pending deposit before requesting checkout.
        await withTransaction(async (client) => {
            await client.query(
                `INSERT INTO deposits (
                    user_id,
                    reference,
                    usd_amount,
                    kes_amount,
                    exchange_rate,
                    phone,
                    status,
                    provider_status
                )
                VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', 'PENDING')`,
                [
                    user.id,
                    reference,
                    amount,
                    kesAmount,
                    KES_PER_USD,
                    phone
                ]
            );

            await client.query(
                `INSERT INTO transactions (
                    user_id,
                    reference,
                    type,
                    amount,
                    currency,
                    status,
                    provider,
                    provider_reference,
                    description
                )
                VALUES (
                    $1, $2, 'DEPOSIT', $3, 'USD',
                    'PENDING', 'PESAPAL', $2,
                    'Pending M-Pesa deposit'
                )`,
                [user.id, reference, amount]
            );
        });

        const checkout = await pesapalRequest(
            '/api/Transactions/SubmitOrderRequest',
            {
                method: 'POST',
                body: JSON.stringify({
                    id: reference,
                    currency: 'KES',
                    amount: kesAmount,
                    description: 'GTN LIVE wallet deposit',
                    callback_url: process.env.PESAPAL_CALLBACK_URL,
                    notification_id: process.env.PESAPAL_IPN_ID,
                    billing_address: {
                        email_address: user.email,
                        phone_number: phone,
                        country_code: 'KE',
                        first_name: user.full_name.split(' ')[0] || 'GTN',
                        last_name: user.full_name.split(' ').slice(1).join(' ') || 'Customer'
                    }
                })
            }
        );

        if (!checkout.order_tracking_id || !checkout.redirect_url) {
            throw new Error('Pesapal did not return a valid checkout URL.');
        }

        await query(
            `UPDATE deposits
             SET pesapal_tracking_id = $1,
                 pesapal_merchant_reference = $2
             WHERE reference = $3`,
            [
                checkout.order_tracking_id,
                checkout.merchant_reference || reference,
                reference
            ]
        );

        return res.status(201).json({
            message: 'Deposit checkout created.',
            reference,
            amount,
            kesAmount,
            currency: 'KES',
            status: 'PENDING',
            checkoutUrl: checkout.redirect_url
        });

    } catch (error) {
        console.error('Deposit creation error:', error.message);

        if (reference) {
            await query(
                `UPDATE deposits
                 SET status = 'FAILED',
                     provider_status = 'SUBMISSION_FAILED'
                 WHERE reference = $1
                   AND pesapal_tracking_id IS NULL`,
                [reference]
            ).catch(() => {});

            await query(
                `UPDATE transactions
                 SET status = 'FAILED'
                 WHERE reference = $1`,
                [reference]
            ).catch(() => {});
        }

        return res.status(502).json({
            error: 'Could not start the deposit. Please try again.'
        });
    }
});

// ------------------------------------------------------------
// CHECK DEPOSIT STATUS
// ------------------------------------------------------------

app.get(
    '/api/cashier/status/:reference',
    authenticate,
    async (req, res) => {
        try {
            const result = await query(
                `SELECT *
                 FROM deposits
                 WHERE reference = $1
                   AND user_id = $2
                 LIMIT 1`,
                [req.params.reference, req.user.id]
            );

            if (!result.rows.length) {
                return res.status(404).json({
                    error: 'Deposit not found.'
                });
            }

            const deposit = result.rows[0];

            if (
                deposit.status !== 'COMPLETED' &&
                deposit.pesapal_tracking_id
            ) {
                const status = await getPesapalPaymentStatus(
                    deposit.pesapal_tracking_id
                );

                const statusCode = Number(status.status_code);
                const description = String(
                    status.payment_status_description || ''
                ).toUpperCase();

                if (statusCode === 1 || description === 'COMPLETED') {
                    const paidKes = Number(status.amount);

                    if (
                        !Number.isFinite(paidKes) ||
                        roundMoney(paidKes) !== roundMoney(deposit.kes_amount)
                    ) {
                        throw new Error('PAYMENT_AMOUNT_MISMATCH');
                    }

                    await creditVerifiedDeposit(
                        deposit.pesapal_tracking_id
                    );

                } else if (statusCode === 2) {
                    await withTransaction(async (client) => {
                        await client.query(
                            `UPDATE deposits
                             SET status = 'FAILED',
                                 provider_status = 'FAILED'
                             WHERE id = $1
                               AND status = 'PENDING'`,
                            [deposit.id]
                        );

                        await client.query(
                            `UPDATE transactions
                             SET status = 'FAILED'
                             WHERE reference = $1
                               AND status = 'PENDING'`,
                            [deposit.reference]
                        );
                    });
                } else if (statusCode === 3) {
                    await query(
                        `UPDATE deposits
                         SET provider_status = 'REVERSED'
                         WHERE id = $1`,
                        [deposit.id]
                    );
                }
            }

            const refreshed = await query(
                `SELECT reference, usd_amount, kes_amount, status
                 FROM deposits
                 WHERE id = $1`,
                [deposit.id]
            );

            return res.json({
                deposit: refreshed.rows[0]
            });

        } catch (error) {
            console.error('Deposit status error:', error.message);

            return res.status(502).json({
                error: 'Could not verify payment status.'
            });
        }
    }
);

// ------------------------------------------------------------
// PESAPAL IPN NOTIFICATION
// ------------------------------------------------------------

async function handlePesapalNotification(req, res) {
    try {
        const trackingId =
            req.query.OrderTrackingId ||
            req.body.OrderTrackingId;

        if (!trackingId) {
            return res.status(400).json({
                error: 'Missing Pesapal tracking ID.'
            });
        }

        const status = await getPesapalPaymentStatus(trackingId);

        const statusCode = Number(status.status_code);
        const description = String(
            status.payment_status_description || ''
        ).toUpperCase();

        if (statusCode === 1 || description === 'COMPLETED') {
            const depositResult = await query(
                `SELECT *
                 FROM deposits
                 WHERE pesapal_tracking_id = $1`,
                [trackingId]
            );

            if (depositResult.rows.length) {
                const deposit = depositResult.rows[0];
                const paidKes = Number(status.amount);

                if (
                    Number.isFinite(paidKes) &&
                    roundMoney(paidKes) === roundMoney(deposit.kes_amount)
                ) {
                    await creditVerifiedDeposit(trackingId);
                }
            }
        }

        return res.status(200).json({
            orderNotificationType:
                req.query.OrderNotificationType ||
                req.body.OrderNotificationType ||
                'IPNCHANGE',
            orderTrackingId: trackingId,
            orderMerchantReference:
                req.query.OrderMerchantReference ||
                req.body.OrderMerchantReference ||
                '',
            status: 200
        });

    } catch (error) {
        console.error('Pesapal IPN error:', error.message);

        return res.status(500).json({
            error: 'Could not process payment notification.'
        });
    }
}

app.get('/api/payments/pesapal/ipn', handlePesapalNotification);
app.post('/api/payments/pesapal/ipn', handlePesapalNotification);

// ============================================================
// END OF PART 4
// ============================================================
// ============================================================
// PART 5: WITHDRAWALS, ACCOUNT PROFILE AND CUSTOMER STATE
// ============================================================

// ------------------------------------------------------------
// CUSTOMER WITHDRAWAL REQUEST
// ------------------------------------------------------------

app.post('/api/cashier/withdraw', authenticate, async (req, res) => {
    try {
        const userId = req.user.id;

        const amount = roundMoney(Number(req.body.amount));
        const phone = normalizePhone(
            req.body.phone || req.user.phone
        );

        if (
            !Number.isFinite(amount) ||
            amount < PLATFORM_RULES.MIN_WITHDRAW_USD
        ) {
            return res.status(400).json({
                error: `Minimum withdrawal is $${PLATFORM_RULES.MIN_WITHDRAW_USD}.`
            });
        }

        if (!phone) {
            return res.status(400).json({
                error: 'Enter a valid Kenyan M-Pesa phone number.'
            });
        }

        const kesAmount = roundMoney(amount * KES_PER_USD);
        const reference = generateReference('GTNWTH');

        const withdrawal = await withTransaction(async (client) => {
            const wallet = await getWallet(
                client,
                userId,
                'LIVE',
                true
            );

            const balance = toNumber(wallet.balance);
            const reserved = toNumber(wallet.reserved_balance);

            const available = roundMoney(balance - reserved);

            if (available < amount) {
                throw new Error('INSUFFICIENT_FUNDS');
            }

            const newReserved = roundMoney(reserved + amount);

            await client.query(
                `UPDATE wallets
                 SET reserved_balance = $1,
                     updated_at = NOW()
                 WHERE id = $2`,
                [newReserved, wallet.id]
            );

            const inserted = await client.query(
                `INSERT INTO withdrawals (
                    user_id,
                    wallet_id,
                    reference,
                    amount,
                    kes_amount,
                    exchange_rate,
                    phone,
                    status
                )
                VALUES (
                    $1, $2, $3, $4, $5, $6, $7, 'PENDING'
                )
                RETURNING *`,
                [
                    userId,
                    wallet.id,
                    reference,
                    amount,
                    kesAmount,
                    KES_PER_USD,
                    phone
                ]
            );

            await recordLedger(client, {
                userId,
                walletId: wallet.id,
                accountType: 'LIVE',
                entryType: 'WITHDRAWAL_RESERVE',
                amount: 0,
                balanceAfter: balance,
                idempotencyKey: `WITHDRAWAL_RESERVE_${inserted.rows[0].id}`,
                description: 'Funds reserved for withdrawal request'
            });

            await client.query(
                `INSERT INTO transactions (
                    user_id,
                    reference,
                    type,
                    amount,
                    currency,
                    status,
                    provider,
                    provider_reference,
                    description
                )
                VALUES (
                    $1, $2, 'WITHDRAWAL', $3, 'USD',
                    'PENDING', 'MANUAL_MPESA', $2,
                    'Pending manual M-Pesa withdrawal'
                )`,
                [userId, reference, amount]
            );

            return inserted.rows[0];
        });

        return res.status(201).json({
            message: 'Withdrawal request submitted for review.',
            withdrawal: {
                id: withdrawal.id,
                reference: withdrawal.reference,
                amount: toNumber(withdrawal.amount),
                kesAmount: toNumber(withdrawal.kes_amount),
                phone: withdrawal.phone,
                status: withdrawal.status,
                timestamp: withdrawal.created_at
            },
            liveBalance: await getLiveBalance(userId)
        });

    } catch (error) {
        if (error.message === 'INSUFFICIENT_FUNDS') {
            return res.status(400).json({
                error: 'Insufficient available LIVE wallet balance.'
            });
        }

        console.error('Withdrawal error:', error.message);

        return res.status(500).json({
            error: 'Could not submit withdrawal request.'
        });
    }
});

// ------------------------------------------------------------
// GET LIVE WALLET BALANCE
// ------------------------------------------------------------

async function getLiveBalance(userId) {
    const result = await query(
        `SELECT balance
         FROM wallets
         WHERE user_id = $1
           AND account_type = 'LIVE'
         LIMIT 1`,
        [userId]
    );

    return result.rows.length
        ? toNumber(result.rows[0].balance)
        : 0;
}

// ------------------------------------------------------------
// ACCOUNT PROFILE AND KYC
// ------------------------------------------------------------

app.post('/api/account/kyc', authenticate, async (req, res) => {
    try {
        const result = await query(
            `UPDATE users
             SET kyc_status = 'pending_review',
                 updated_at = NOW()
             WHERE id = $1
             RETURNING kyc_status`,
            [req.user.id]
        );

        return res.json({
            message: 'KYC submitted for review.',
            kycStatus: result.rows[0].kyc_status
        });

    } catch (error) {
        console.error('KYC update error:', error.message);

        return res.status(500).json({
            error: 'Could not update KYC status.'
        });
    }
});

// ------------------------------------------------------------
// CUSTOMER STATE
// ------------------------------------------------------------

app.get('/api/state', authenticate, async (req, res) => {
    try {
        const userId = req.user.id;

        const userResult = await query(
            `SELECT *
             FROM users
             WHERE id = $1
             LIMIT 1`,
            [userId]
        );

        const user = await formatUser(userResult.rows[0]);

        const tradesResult = await query(
            `SELECT *
             FROM trades
             WHERE user_id = $1
             ORDER BY opened_at DESC
             LIMIT 50`,
            [userId]
        );

        const transactionsResult = await query(
            `SELECT *
             FROM transactions
             WHERE user_id = $1
             ORDER BY created_at DESC
             LIMIT 30`,
            [userId]
        );

        const trades = tradesResult.rows.map((trade) => ({
            id: trade.id,
            symbol: trade.symbol,
            contractType: trade.contract_type,
            accountType: trade.account_type,
            stake: toNumber(trade.stake),
            entryPrice: toNumber(trade.entry_price),
            exitPrice: trade.exit_price === null
                ? null
                : toNumber(trade.exit_price),
            barrier: trade.barrier,
            duration: trade.duration_seconds,
            status: trade.status,
            result: trade.result,
            profit: toNumber(trade.profit),
            payout: toNumber(trade.payout),
            openedAt: trade.opened_at,
            closedAt: trade.closed_at,
            expiresAt: trade.expires_at
        }));

        const transactions = transactionsResult.rows.map((tx) => ({
            id: tx.id,
            reference: tx.reference,
            type: tx.type,
            accountType: tx.account_type || 'LIVE',
            method: tx.provider === 'MANUAL_MPESA' ||
                    tx.provider === 'PESAPAL'
                ? 'MPESA'
                : tx.provider,
            amount: toNumber(tx.amount),
            currency: tx.currency,
            status: tx.status,
            timestamp: tx.created_at
        }));

        return res.json({
            user,
            trades,
            transactions,
            rules: PLATFORM_RULES
        });

    } catch (error) {
        console.error('Customer state error:', error.message);

        return res.status(500).json({
            error: 'Could not load account information.'
        });
    }
});

// ============================================================
// END OF PART 5
// ============================================================
