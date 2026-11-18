// ============================================================
// GTN BINARY OPTIONS PLATFORM
// Complete PostgreSQL Backend
// File: backend.js
// Requirements: Node.js 18+
// ============================================================

require('dotenv').config();

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('./database/db');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json({ limit: '2mb' }));

const PORT = Number(process.env.PORT || 4000);
const JWT_SECRET = process.env.JWT_SECRET;
const KES_PER_USD = Number(process.env.KES_PER_USD || 130);

if (!JWT_SECRET || JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET must contain at least 32 characters.');
}

if (!Number.isFinite(KES_PER_USD) || KES_PER_USD <= 0) {
    throw new Error('KES_PER_USD must be a valid positive number.');
}

const PAYOUT_RATE = 0.80;
const MIN_TRADE = 5;
const MIN_DEPOSIT = 5;
const MIN_WITHDRAWAL = 10;

const SYMBOLS = [
    'VOL_10_1S',
    'VOL_25',
    'VOL_50',
    'VOL_75',
    'VOL_100'
];

const prices = {};
const priceHistory = {};

for (const symbol of SYMBOLS) {
    prices[symbol] = 100 + Math.random() * 100;
    priceHistory[symbol] = [];
}

// ============================================================
// GENERAL HELPERS
// ============================================================

function makeReference(prefix = 'GTN') {
    return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function money(value) {
    return Number(Number(value || 0).toFixed(2));
}

function generateReferralCode() {
    return crypto.randomBytes(5).toString('hex').toUpperCase();
}

function asyncHandler(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}

function signToken(user) {
    return jwt.sign(
        {
            id: user.id,
            email: user.email,
            role: 'CUSTOMER'
        },
        JWT_SECRET,
        { expiresIn: '7d' }
    );
}

function auth(req, res, next) {
    const header = req.headers.authorization;

    if (!header || !header.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Authentication required.' });
    }

    try {
        req.user = jwt.verify(header.substring(7), JWT_SECRET);
        next();
    } catch {
        return res.status(401).json({ error: 'Invalid or expired token.' });
    }
}

function adminAuth(req, res, next) {
    const header = req.headers.authorization;

    if (!header || !header.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Admin authentication required.' });
    }

    try {
        const decoded = jwt.verify(header.substring(7), JWT_SECRET);

        if (decoded.role !== 'ADMIN' && decoded.role !== 'SUPER_ADMIN') {
            return res.status(403).json({ error: 'Administrator access required.' });
        }

        req.admin = decoded;
        next();
    } catch {
        return res.status(401).json({ error: 'Invalid or expired admin token.' });
    }
}

function superAdminOnly(req, res, next) {
    if (req.admin.role !== 'SUPER_ADMIN') {
        return res.status(403).json({ error: 'Super administrator access required.' });
    }

    next();
}

async function getWallet(client, userId, accountType) {
    const result = await client.query(
        `SELECT * FROM wallets
         WHERE user_id = $1 AND account_type = $2
         FOR UPDATE`,
        [userId, accountType]
    );

    return result.rows[0];
}

async function logAdminAction(client, adminId, action, targetType, targetId, details = {}) {
    await client.query(
        `INSERT INTO admin_activity_logs
         (admin_id, action, target_type, target_id, details)
         VALUES ($1, $2, $3, $4, $5)`,
        [adminId, action, targetType, targetId, JSON.stringify(details)]
    );
}

async function insertLedger(client, data) {
    await client.query(
        `INSERT INTO wallet_ledger (
            wallet_id,
            user_id,
            entry_type,
            amount,
            balance_before,
            balance_after,
            reserved_before,
            reserved_after,
            reference,
            idempotency_key,
            description
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
            data.walletId,
            data.userId,
            data.entryType,
            data.amount,
            data.balanceBefore,
            data.balanceAfter,
            data.reservedBefore,
            data.reservedAfter,
            data.reference || null,
            data.idempotencyKey,
            data.description || null
        ]
    );
}

async function insertTransaction(client, data) {
    const result = await client.query(
        `INSERT INTO transactions (
            user_id,
            wallet_id,
            type,
            amount,
            status,
            reference,
            description
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        RETURNING *`,
        [
            data.userId,
            data.walletId,
            data.type,
            data.amount,
            data.status,
            data.reference,
            data.description || null
        ]
    );

    return result.rows[0];
}

function broadcast(payload) {
    const message = JSON.stringify(payload);

    for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    }
}

// ============================================================
// MARKET ENGINE
// ============================================================

function generateTick(symbol) {
    const previous = prices[symbol];

    const volatility = symbol === 'VOL_10_1S'
        ? 0.0005
        : symbol === 'VOL_25'
            ? 0.001
            : symbol === 'VOL_50'
                ? 0.002
                : symbol === 'VOL_75'
                    ? 0.003
                    : 0.004;

    const movement = (Math.random() - 0.5) * previous * volatility * 2;

    const current = Math.max(1, previous + movement);

    prices[symbol] = current;

    const tick = {
        symbol,
        price: Number(current.toFixed(4)),
        timestamp: new Date().toISOString(),
        digit: Math.abs(
            Math.floor(current * 10000) % 10
        )
    };

    priceHistory[symbol].push(tick);

    if (priceHistory[symbol].length > 500) {
        priceHistory[symbol].shift();
    }

    broadcast({
        type: 'TICK',
        data: tick
    });

    return tick;
}

setInterval(() => {
    for (const symbol of SYMBOLS) {
        generateTick(symbol);
    }
}, 1000);

app.get('/api/markets', (req, res) => {
    res.json({
        markets: SYMBOLS.map(symbol => ({
            symbol,
            price: prices[symbol]
        }))
    });
});

app.get('/api/markets/:symbol/history', (req, res) => {
    const symbol = req.params.symbol;

    if (!SYMBOLS.includes(symbol)) {
        return res.status(404).json({ error: 'Market not found.' });
    }

    res.json({
        symbol,
        history: priceHistory[symbol]
    });
});

wss.on('connection', socket => {
    socket.send(JSON.stringify({
        type: 'MARKETS',
        data: SYMBOLS.map(symbol => ({
            symbol,
            price: prices[symbol]
        }))
    }));
});

// ============================================================
// CUSTOMER REGISTRATION
// ============================================================

app.post('/api/auth/register', asyncHandler(async (req, res) => {
    const {
        fullName,
        name,
        email,
        phone,
        password,
        referredBy
    } = req.body;

    const customerName = String(fullName || name || '').trim();
    const customerEmail = String(email || '').trim().toLowerCase();

    if (!customerName || !customerEmail || !phone || !password) {
        return res.status(400).json({
            error: 'Full name, email, phone and password are required.'
        });
    }

    if (password.length < 8) {
        return res.status(400).json({
            error: 'Password must contain at least 8 characters.'
        });
    }

    const client = await db.pool.connect();

    try {
        await client.query('BEGIN');

        const existing = await client.query(
            'SELECT id FROM users WHERE email = $1 OR phone = $2',
            [customerEmail, phone]
        );

        if (existing.rows.length) {
            await client.query('ROLLBACK');

            return res.status(409).json({
                error: 'Email or phone number already registered.'
            });
        }

        let referralCode = generateReferralCode();

        for (let attempt = 0; attempt < 5; attempt++) {
            const check = await client.query(
                'SELECT id FROM users WHERE referral_code = $1',
                [referralCode]
            );

            if (!check.rows.length) break;

            referralCode = generateReferralCode();
        }

        let referrerId = null;

        if (referredBy) {
            const referrer = await client.query(
                'SELECT id FROM users WHERE referral_code = $1',
                [String(referredBy).trim()]
            );

            if (referrer.rows.length) {
                referrerId = referrer.rows[0].id;
            }
        }

        const passwordHash = await bcrypt.hash(password, 12);

        const userResult = await client.query(
            `INSERT INTO users (
                full_name,
                email,
                phone,
                password_hash,
                referral_code,
                referred_by,
                country,
                account_status
            )
            VALUES ($1,$2,$3,$4,$5,$6,'KE','ACTIVE')
            RETURNING id, full_name, email, phone, referral_code`,
            [
                customerName,
                customerEmail,
                phone,
                passwordHash,
                referralCode,
                referrerId
            ]
        );

        const user = userResult.rows[0];

        const demoWallet = await client.query(
            `INSERT INTO wallets (
                user_id,
                account_type,
                currency,
                balance,
                reserved_balance
            )
            VALUES ($1,'DEMO','USD',1000,0)
            RETURNING *`,
            [user.id]
        );

        await client.query(
            `INSERT INTO wallets (
                user_id,
                account_type,
                currency,
                balance,
                reserved_balance
            )
            VALUES ($1,'LIVE','USD',0,0)`,
            [user.id]
        );

        await insertLedger(client, {
            walletId: demoWallet.rows[0].id,
            userId: user.id,
            entryType: 'INITIAL_DEMO',
            amount: 1000,
            balanceBefore: 0,
            balanceAfter: 1000,
            reservedBefore: 0,
            reservedAfter: 0,
            reference: makeReference('DEMO'),
            idempotencyKey: `INITIAL_DEMO_${user.id}`,
            description: 'Initial demo wallet funding'
        });

        if (referrerId) {
            await client.query(
                `UPDATE users
                 SET referrals_count = referrals_count + 1
                 WHERE id = $1`,
                [referrerId]
            );
        }

        await client.query('COMMIT');

        res.status(201).json({
            message: 'Registration successful.',
            token: signToken(user),
            user
        });

    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}));

// ============================================================
// CUSTOMER LOGIN
// ============================================================

app.post('/api/auth/login', asyncHandler(async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!email || !password) {
        return res.status(400).json({
            error: 'Email and password are required.'
        });
    }

    const result = await db.query(
        `SELECT id, full_name, email, phone,
                password_hash, referral_code, account_status
         FROM users
         WHERE email = $1`,
        [email]
    );

    if (!result.rows.length) {
        return res.status(401).json({ error: 'Invalid login details.' });
    }

    const user = result.rows[0];

    if (user.account_status === 'SUSPENDED') {
        return res.status(403).json({
            error: 'Your account has been suspended.'
        });
    }

    const validPassword = await bcrypt.compare(
        password,
        user.password_hash
    );

    if (!validPassword) {
        return res.status(401).json({ error: 'Invalid login details.' });
    }

    delete user.password_hash;

    res.json({
        message: 'Login successful.',
        token: signToken(user),
        user
    });
}));

// ============================================================
// CUSTOMER STATE
// ============================================================

app.get('/api/state', auth, asyncHandler(async (req, res) => {
    const userResult = await db.query(
        `SELECT id, full_name, email, phone,
                referral_code, referrals_count,
                referral_earnings, kyc_status,
                account_status
         FROM users WHERE id = $1`,
        [req.user.id]
    );

    if (!userResult.rows.length) {
        return res.status(404).json({ error: 'User not found.' });
    }

    const wallets = await db.query(
        `SELECT id, account_type, currency,
                balance, reserved_balance
         FROM wallets
         WHERE user_id = $1`,
        [req.user.id]
    );

    const trades = await db.query(
        `SELECT * FROM trades
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT 100`,
        [req.user.id]
    );

    const transactions = await db.query(
        `SELECT * FROM transactions
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT 100`,
        [req.user.id]
    );

    res.json({
        user: userResult.rows[0],
        wallets: wallets.rows.map(wallet => ({
            ...wallet,
            balance: money(wallet.balance),
            reserved_balance: money(wallet.reserved_balance)
        })),
        trades: trades.rows,
        transactions: transactions.rows
    });
}));

// ============================================================
// TRADE CONTRACT EVALUATION
// ============================================================

function evaluateTrade(trade, exitPrice) {
    const exitDigit = Math.abs(
        Math.floor(Number(exitPrice) * 10000) % 10
    );

    const entryDigit = Number(trade.entry_digit);

    switch (trade.contract_type) {
        case 'RISE':
            return exitPrice > Number(trade.entry_price);

        case 'FALL':
            return exitPrice < Number(trade.entry_price);

        case 'EVEN':
            return exitDigit % 2 === 0;

        case 'ODD':
            return exitDigit % 2 !== 0;

        case 'OVER':
            return exitDigit > Number(trade.barrier);

        case 'UNDER':
            return exitDigit < Number(trade.barrier);

        case 'MATCH':
            return exitDigit === Number(trade.barrier);

        case 'DIFF':
            return exitDigit !== Number(trade.barrier);

        default:
            return false;
    }
}

// ============================================================
// PLACE TRADE
// ============================================================

app.post('/api/trades/place', auth, asyncHandler(async (req, res) => {
    const {
        symbol,
        market,
        accountType,
        account_type,
        contractType,
        contract_type,
        type,
        stake,
        amount,
        duration,
        durationSec,
        barrier
    } = req.body;

    const selectedSymbol = symbol || market;
    const selectedAccount = String(
        accountType || account_type || 'DEMO'
    ).toUpperCase();

    const selectedContract = String(
        contractType || contract_type || type || ''
    ).toUpperCase();

    const tradeStake = Number(stake ?? amount);
    const tradeDuration = Number(durationSec ?? duration);

    const validContracts = [
        'RISE', 'FALL', 'EVEN', 'ODD',
        'OVER', 'UNDER', 'MATCH', 'DIFF'
    ];

    if (!SYMBOLS.includes(selectedSymbol)) {
        return res.status(400).json({ error: 'Invalid market.' });
    }

    if (!['DEMO', 'LIVE'].includes(selectedAccount)) {
        return res.status(400).json({ error: 'Invalid account type.' });
    }

    if (!validContracts.includes(selectedContract)) {
        return res.status(400).json({ error: 'Invalid contract type.' });
    }

    if (!Number.isFinite(tradeStake) || tradeStake < MIN_TRADE) {
        return res.status(400).json({
            error: `Minimum trade amount is $${MIN_TRADE}.`
        });
    }

    if (!Number.isInteger(tradeDuration) ||
        tradeDuration < 5 ||
        tradeDuration > 3600) {
        return res.status(400).json({
            error: 'Trade duration must be between 5 and 3600 seconds.'
        });
    }

    let selectedBarrier = null;

    if (['OVER', 'UNDER', 'MATCH', 'DIFF'].includes(selectedContract)) {
        selectedBarrier = Number(barrier);

        if (!Number.isInteger(selectedBarrier) ||
            selectedBarrier < 0 ||
            selectedBarrier > 9) {
            return res.status(400).json({
                error: 'Barrier must be a digit from 0 to 9.'
            });
        }
    }

    const client = await db.pool.connect();

    try {
        await client.query('BEGIN');

        const userResult = await client.query(
            `SELECT account_status
             FROM users WHERE id = $1 FOR UPDATE`,
            [req.user.id]
        );

        if (!userResult.rows.length ||
            userResult.rows[0].account_status !== 'ACTIVE') {
            throw new Error('Account is unavailable.');
        }

        const wallet = await getWallet(
            client,
            req.user.id,
            selectedAccount
        );

        if (!wallet) {
            throw new Error('Wallet not found.');
        }

        const balanceBefore = money(wallet.balance);
        const reservedBefore = money(wallet.reserved_balance);

        if (balanceBefore < tradeStake) {
            throw new Error('Insufficient wallet balance.');
        }

        const entryPrice = prices[selectedSymbol];

        const entryDigit = Math.abs(
            Math.floor(entryPrice * 10000) % 10
        );

        const reference = makeReference('TRADE');

        const updatedWallet = await client.query(
            `UPDATE wallets
             SET balance = balance - $1,
                 updated_at = NOW()
             WHERE id = $2
             RETURNING balance`,
            [tradeStake, wallet.id]
        );

        const balanceAfter = money(updatedWallet.rows[0].balance);

        const tradeResult = await client.query(
            `INSERT INTO trades (
                user_id,
                wallet_id,
                symbol,
                account_type,
                contract_type,
                stake,
                entry_price,
                entry_digit,
                barrier,
                payout_rate,
                status,
                created_at,
                expires_at
            )
            VALUES (
                $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
                'OPEN',NOW(),NOW() + ($11 * INTERVAL '1 second')
            )
            RETURNING *`,
            [
                req.user.id,
                wallet.id,
                selectedSymbol,
                selectedAccount,
                selectedContract,
                tradeStake,
                entryPrice,
                entryDigit,
                selectedBarrier,
                PAYOUT_RATE,
                tradeDuration
            ]
        );

        await insertLedger(client, {
            walletId: wallet.id,
            userId: req.user.id,
            entryType: 'TRADE_STAKE',
            amount: -tradeStake,
            balanceBefore,
            balanceAfter,
            reservedBefore,
            reservedAfter: reservedBefore,
            reference,
            idempotencyKey: `TRADE_STAKE_${tradeResult.rows[0].id}`,
            description: 'Trade stake'
        });

        await insertTransaction(client, {
            userId: req.user.id,
            walletId: wallet.id,
            type: 'TRADE',
            amount: tradeStake,
            status: 'COMPLETED',
            reference,
            description: `${selectedContract} ${selectedSymbol}`
        });

        await client.query('COMMIT');

        res.status(201).json({
            message: 'Trade placed successfully.',
            trade: tradeResult.rows[0],
            balance: balanceAfter
        });

    } catch (error) {
        await client.query('ROLLBACK');

        res.status(400).json({
            error: error.message || 'Unable to place trade.'
        });
    } finally {
        client.release();
    }
}));

// ============================================================
// TRADE SETTLEMENT WORKER
// ============================================================

async function settleExpiredTrades() {
    const client = await db.pool.connect();

    try {
        await client.query('BEGIN');

        const expired = await client.query(
            `SELECT *
             FROM trades
             WHERE status = 'OPEN'
               AND expires_at <= NOW()
             ORDER BY expires_at ASC
             FOR UPDATE SKIP LOCKED
             LIMIT 50`
        );

        for (const trade of expired.rows) {
            const exitPrice = prices[trade.symbol];

            if (exitPrice === undefined) continue;

            const won = evaluateTrade(trade, exitPrice);

            const stake = money(trade.stake);
            const profit = won
                ? money(stake * Number(trade.payout_rate))
                : 0;

            const payout = won
                ? money(stake + profit)
                : 0;

            const walletResult = await client.query(
                `SELECT * FROM wallets
                 WHERE id = $1
                 FOR UPDATE`,
                [trade.wallet_id]
            );

            if (!walletResult.rows.length) continue;

            const wallet = walletResult.rows[0];

            const balanceBefore = money(wallet.balance);
            const reservedBefore = money(wallet.reserved_balance);

            const balanceAfter = money(balanceBefore + payout);

            await client.query(
                `UPDATE wallets
                 SET balance = $1,
                     updated_at = NOW()
                 WHERE id = $2`,
                [balanceAfter, wallet.id]
            );

            await client.query(
                `UPDATE trades
                 SET exit_price = $1,
                     exit_digit = $2,
                     profit = $3,
                     status = $4,
                     settled_at = NOW()
                 WHERE id = $5`,
                [
                    exitPrice,
                    Math.abs(Math.floor(exitPrice * 10000) % 10),
                    won ? profit : -stake,
                    won ? 'WON' : 'LOST',
                    trade.id
                ]
            );

            if (won) {
                await insertLedger(client, {
                    walletId: wallet.id,
                    userId: trade.user_id,
                    entryType: 'TRADE_WIN',
                    amount: payout,
                    balanceBefore,
                    balanceAfter,
                    reservedBefore,
                    reservedAfter: reservedBefore,
                    reference: `TRADE-${trade.id}`,
                    idempotencyKey: `TRADE_WIN_${trade.id}`,
                    description: 'Winning trade payout'
                });

                await insertTransaction(client, {
                    userId: trade.user_id,
                    walletId: wallet.id,
                    type: 'TRADE_WIN',
                    amount: payout,
                    status: 'COMPLETED',
                    reference: `TRADE-${trade.id}`,
                    description: 'Winning trade payout'
                });
            } else {
                await insertTransaction(client, {
                    userId: trade.user_id,
                    walletId: wallet.id,
                    type: 'TRADE_LOSS',
                    amount: stake,
                    status: 'COMPLETED',
                    reference: `TRADE-${trade.id}`,
                    description: 'Losing trade'
                });
            }
        }

        await client.query('COMMIT');

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Trade settlement error:', error.message);
    } finally {
        client.release();
    }
}

setInterval(settleExpiredTrades, 1000);
// ============================================================
// PART 2: PESAPAL DEPOSITS AND PAYMENT VERIFICATION
// ============================================================

const PESAPAL_BASE_URL =
    process.env.PESAPAL_ENVIRONMENT === 'live'
        ? 'https://pay.pesapal.com/v3'
        : 'https://cybqa.pesapal.com/pesapalv3';

let pesapalToken = null;
let pesapalTokenExpiry = 0;

// ------------------------------------------------------------
// PESAPAL CONFIGURATION CHECK
// ------------------------------------------------------------

function checkPesapalConfiguration() {
    const required = [
        'PESAPAL_CONSUMER_KEY',
        'PESAPAL_CONSUMER_SECRET',
        'PESAPAL_CALLBACK_URL',
        'PESAPAL_IPN_ID'
    ];

    const missing = required.filter(
        key => !process.env[key]
    );

    if (missing.length) {
        throw new Error(
            `Missing Pesapal configuration: ${missing.join(', ')}`
        );
    }
}

// ------------------------------------------------------------
// PESAPAL AUTHENTICATION
// ------------------------------------------------------------

async function getPesapalToken() {
    checkPesapalConfiguration();

    if (
        pesapalToken &&
        Date.now() < pesapalTokenExpiry
    ) {
        return pesapalToken;
    }

    const response = await fetch(
        `${PESAPAL_BASE_URL}/api/Auth/RequestToken`,
        {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                consumer_key: process.env.PESAPAL_CONSUMER_KEY,
                consumer_secret: process.env.PESAPAL_CONSUMER_SECRET
            })
        }
    );

    const data = await response.json();

    if (
        !response.ok ||
        !data.token
    ) {
        console.error('Pesapal authentication failed:', data);

        throw new Error('Unable to authenticate with Pesapal.');
    }

    pesapalToken = data.token;

    // Pesapal tokens last for a maximum of five minutes.
    // Refresh slightly early.
    pesapalTokenExpiry = Date.now() + (4 * 60 * 1000);

    return pesapalToken;
}

// ------------------------------------------------------------
// PESAPAL API REQUEST HELPER
// ------------------------------------------------------------

async function pesapalRequest(endpoint, options = {}) {
    const token = await getPesapalToken();

    const response = await fetch(
        `${PESAPAL_BASE_URL}${endpoint}`,
        {
            ...options,
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
                ...(options.headers || {})
            }
        }
    );

    const data = await response.json();

    if (!response.ok) {
        console.error('Pesapal API error:', data);

        throw new Error(
            data?.error?.message ||
            data?.message ||
            'Pesapal request failed.'
        );
    }

    return data;
}

// ------------------------------------------------------------
// RECORD PAYMENT EVENT
// ------------------------------------------------------------

async function recordPaymentLog(
    client,
    depositId,
    eventType,
    payload,
    processed = false,
    processingError = null
) {
    await client.query(
        `INSERT INTO payment_logs (
            deposit_id,
            provider,
            event_type,
            payload,
            processed,
            processing_error
        )
        VALUES ($1,'PESAPAL',$2,$3,$4,$5)`,
        [
            depositId,
            eventType,
            JSON.stringify(payload || {}),
            processed,
            processingError
        ]
    );
}

// ------------------------------------------------------------
// CUSTOMER DEPOSIT REQUEST
// ------------------------------------------------------------

app.post(
    '/api/cashier/deposit',
    auth,
    asyncHandler(async (req, res) => {
        const usdAmount = Number(
            req.body.amount ?? req.body.usdAmount
        );

        const phone = String(
            req.body.phone || req.body.phoneNumber || ''
        ).trim();

        if (
            !Number.isFinite(usdAmount) ||
            usdAmount < MIN_DEPOSIT ||
            usdAmount > 100000
        ) {
            return res.status(400).json({
                error: `Deposit must be at least $${MIN_DEPOSIT}.`
            });
        }

        if (!/^\+?[0-9]{9,15}$/.test(phone)) {
            return res.status(400).json({
                error: 'Enter a valid phone number.'
            });
        }

        checkPesapalConfiguration();

        const kesAmount = money(
            usdAmount * KES_PER_USD
        );

        const client = await db.pool.connect();

        let deposit;

        try {
            await client.query('BEGIN');

            const userResult = await client.query(
                `SELECT id, full_name, email, phone, account_status
                 FROM users
                 WHERE id = $1
                 FOR UPDATE`,
                [req.user.id]
            );

            if (
                !userResult.rows.length ||
                userResult.rows[0].account_status !== 'ACTIVE'
            ) {
                throw new Error('Your account is unavailable.');
            }

            const user = userResult.rows[0];

            const walletResult = await client.query(
                `SELECT *
                 FROM wallets
                 WHERE user_id = $1
                   AND account_type = 'LIVE'
                 FOR UPDATE`,
                [req.user.id]
            );

            if (!walletResult.rows.length) {
                throw new Error('LIVE wallet not found.');
            }

            const wallet = walletResult.rows[0];

            const reference = makeReference('GTNDEP');

            const transaction = await insertTransaction(client, {
                userId: req.user.id,
                walletId: wallet.id,
                type: 'DEPOSIT',
                amount: usdAmount,
                status: 'PENDING',
                reference,
                description: 'Pesapal deposit'
            });

            const depositResult = await client.query(
                `INSERT INTO deposits (
                    user_id,
                    wallet_id,
                    transaction_id,
                    reference,
                    usd_amount,
                    kes_amount,
                    exchange_rate,
                    phone,
                    status
                )
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PENDING')
                RETURNING *`,
                [
                    req.user.id,
                    wallet.id,
                    transaction.id,
                    reference,
                    usdAmount,
                    kesAmount,
                    KES_PER_USD,
                    phone
                ]
            );

            deposit = depositResult.rows[0];

            await recordPaymentLog(
                client,
                deposit.id,
                'DEPOSIT_CREATED',
                {
                    usdAmount,
                    kesAmount,
                    phone,
                    reference
                }
            );

            await client.query('COMMIT');

            // Pesapal request happens after the database
            // transaction commits. This avoids holding a
            // database lock during an external network call.

            const names = String(user.full_name || '')
                .trim()
                .split(/\s+/);

            const firstName = names.shift() || 'Customer';
            const lastName = names.join(' ') || '';

            const order = await pesapalRequest(
                '/api/Transactions/SubmitOrderRequest',
                {
                    method: 'POST',
                    body: JSON.stringify({
                        id: reference,
                        currency: 'KES',
                        amount: kesAmount,
                        description: `GTN wallet deposit ${reference}`,
                        callback_url: process.env.PESAPAL_CALLBACK_URL,
                        notification_id: process.env.PESAPAL_IPN_ID,
                        billing_address: {
                            email_address: user.email,
                            phone_number: phone,
                            country_code: 'KE',
                            first_name: firstName,
                            middle_name: '',
                            last_name: lastName,
                            line_1: 'Kenya',
                            line_2: '',
                            city: '',
                            state: '',
                            postal_code: '',
                            zip_code: ''
                        }
                    })
                }
            );

            if (
                !order.order_tracking_id ||
                !order.redirect_url
            ) {
                throw new Error(
                    'Pesapal did not return a valid checkout URL.'
                );
            }

            const updateClient = await db.pool.connect();

            try {
                await updateClient.query(
                    `UPDATE deposits
                     SET pesapal_tracking_id = $1,
                         pesapal_merchant_reference = $2,
                         status = 'PROCESSING',
                         updated_at = NOW()
                     WHERE id = $3`,
                    [
                        order.order_tracking_id,
                        order.merchant_reference || reference,
                        deposit.id
                    ]
                );

                await recordPaymentLog(
                    updateClient,
                    deposit.id,
                    'PESAPAL_ORDER_CREATED',
                    order,
                    true
                );

            } finally {
                updateClient.release();
            }

            return res.status(201).json({
                message: 'Deposit request created.',
                reference,
                amountUSD: usdAmount,
                amountKES: kesAmount,
                exchangeRate: KES_PER_USD,
                checkoutUrl: order.redirect_url,
                redirect_url: order.redirect_url
            });

        } catch (error) {
            if (client) {
                try {
                    await client.query('ROLLBACK');
                } catch {}
            }

            // If the deposit record already exists, mark it
            // failed when Pesapal order creation fails.
            if (deposit?.id) {
                await db.query(
                    `UPDATE deposits
                     SET status = 'FAILED',
                         provider_status = $1,
                         updated_at = NOW()
                     WHERE id = $2
                       AND status IN ('PENDING','PROCESSING')`,
                    [
                        error.message,
                        deposit.id
                    ]
                ).catch(console.error);

                await db.query(
                    `UPDATE transactions
                     SET status = 'FAILED'
                     WHERE id = $1`,
                    [deposit.transaction_id]
                ).catch(console.error);
            }

            console.error('Deposit creation failed:', error.message);

            return res.status(400).json({
                error: 'Unable to create deposit. Please try again.'
            });

        } finally {
            client.release();
        }
    })
);

// ------------------------------------------------------------
// FETCH PESAPAL TRANSACTION STATUS
// ------------------------------------------------------------

async function getPesapalTransactionStatus(orderTrackingId) {
    if (!orderTrackingId) {
        throw new Error('Pesapal tracking ID is missing.');
    }

    const endpoint =
        '/api/Transactions/GetTransactionStatus' +
        `?orderTrackingId=${encodeURIComponent(orderTrackingId)}`;

    return pesapalRequest(endpoint, {
        method: 'GET'
    });
}

// ------------------------------------------------------------
// VERIFY AND CREDIT A DEPOSIT
// ------------------------------------------------------------

async function verifyAndCreditDeposit(
    orderTrackingId,
    merchantReference
) {
    if (!orderTrackingId || !merchantReference) {
        throw new Error('Payment reference information is incomplete.');
    }

    // Always obtain payment status directly from Pesapal.
    // Never trust the callback or IPN status by itself.

    const payment = await getPesapalTransactionStatus(
        orderTrackingId
    );

    const client = await db.pool.connect();

    try {
        await client.query('BEGIN');

        const depositResult = await client.query(
            `SELECT *
             FROM deposits
             WHERE reference = $1
             FOR UPDATE`,
            [merchantReference]
        );

        if (!depositResult.rows.length) {
            throw new Error('Deposit record not found.');
        }

        const deposit = depositResult.rows[0];

        if (
            deposit.pesapal_tracking_id &&
            deposit.pesapal_tracking_id !== orderTrackingId
        ) {
            throw new Error('Payment tracking ID mismatch.');
        }

        if (
            deposit.pesapal_merchant_reference &&
            deposit.pesapal_merchant_reference !== merchantReference
        ) {
            throw new Error('Merchant reference mismatch.');
        }

        await recordPaymentLog(
            client,
            deposit.id,
            'PESAPAL_STATUS_CHECK',
            payment,
            true
        );

        const paymentStatus = String(
            payment.payment_status_description || ''
        ).toUpperCase();

        const paidAmount = Number(payment.amount);
        const paidCurrency = String(
            payment.currency || ''
        ).toUpperCase();

        const expectedAmount = Number(deposit.kes_amount);

        // Check the amount and currency before crediting.
        if (
            !Number.isFinite(paidAmount) ||
            Math.abs(paidAmount - expectedAmount) > 0.01 ||
            paidCurrency !== 'KES'
        ) {
            await recordPaymentLog(
                client,
                deposit.id,
                'PAYMENT_VALIDATION_FAILED',
                {
                    paidAmount,
                    expectedAmount,
                    paidCurrency
                },
                false,
                'Amount or currency mismatch'
            );

            await client.query('COMMIT');

            throw new Error('Payment amount or currency mismatch.');
        }

        // A completed deposit must never be credited twice.
        if (deposit.status === 'COMPLETED') {
            await client.query('COMMIT');

            return {
                alreadyCredited: true,
                status: 'COMPLETED'
            };
        }

        if (paymentStatus === 'REVERSED') {
            await client.query(
                `UPDATE deposits
                 SET provider_status = 'REVERSED',
                     updated_at = NOW()
                 WHERE id = $1`,
                [deposit.id]
            );

            await recordPaymentLog(
                client,
                deposit.id,
                'PAYMENT_REVERSED',
                payment,
                false,
                'Pesapal reported a reversed payment. Manual review required.'
            );

            await client.query('COMMIT');

            return {
                status: 'REVERSED',
                message: 'Payment reversal requires administrator review.'
            };
        }

        if (paymentStatus === 'FAILED' || paymentStatus === 'INVALID') {
            await client.query(
                `UPDATE deposits
                 SET status = 'FAILED',
                     provider_status = $1,
                     updated_at = NOW()
                 WHERE id = $2`,
                [paymentStatus, deposit.id]
            );

            await client.query(
                `UPDATE transactions
                 SET status = 'FAILED'
                 WHERE id = $1`,
                [deposit.transaction_id]
            );

            await client.query('COMMIT');

            return {
                status: 'FAILED'
            };
        }

        if (paymentStatus !== 'COMPLETED') {
            await client.query(
                `UPDATE deposits
                 SET status = 'PROCESSING',
                     provider_status = $1,
                     updated_at = NOW()
                 WHERE id = $2`,
                [paymentStatus || 'PENDING', deposit.id]
            );

            await client.query('COMMIT');

            return {
                status: 'PROCESSING'
            };
        }

        // Lock the LIVE wallet before crediting.
        const walletResult = await client.query(
            `SELECT *
             FROM wallets
             WHERE id = $1
             FOR UPDATE`,
            [deposit.wallet_id]
        );

        if (!walletResult.rows.length) {
            throw new Error('Deposit wallet not found.');
        }

        const wallet = walletResult.rows[0];

        const balanceBefore = money(wallet.balance);
        const reservedBefore = money(wallet.reserved_balance);

        const balanceAfter = money(
            balanceBefore + Number(deposit.usd_amount)
        );

        await client.query(
            `UPDATE wallets
             SET balance = $1,
                 updated_at = NOW()
             WHERE id = $2`,
            [balanceAfter, wallet.id]
        );

        await client.query(
            `UPDATE deposits
             SET status = 'COMPLETED',
                 provider_status = 'COMPLETED',
                 credited_at = NOW(),
                 updated_at = NOW()
             WHERE id = $1`,
            [deposit.id]
        );

        await client.query(
            `UPDATE transactions
             SET status = 'COMPLETED'
             WHERE id = $1`,
            [deposit.transaction_id]
        );

        await insertLedger(client, {
            walletId: wallet.id,
            userId: deposit.user_id,
            entryType: 'DEPOSIT',
            amount: Number(deposit.usd_amount),
            balanceBefore,
            balanceAfter,
            reservedBefore,
            reservedAfter: reservedBefore,
            reference: deposit.reference,
            idempotencyKey: `DEPOSIT_CREDIT_${deposit.id}`,
            description: 'Verified Pesapal deposit'
        });

        await recordPaymentLog(
            client,
            deposit.id,
            'WALLET_CREDITED',
            {
                usdAmount: deposit.usd_amount,
                kesAmount: deposit.kes_amount,
                balanceBefore,
                balanceAfter,
                trackingId: orderTrackingId
            },
            true
        );

        await client.query('COMMIT');

        return {
            status: 'COMPLETED',
            credited: true,
            amountUSD: money(deposit.usd_amount),
            balance: balanceAfter
        };

    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

// ------------------------------------------------------------
// PESAPAL IPN NOTIFICATION
// ------------------------------------------------------------

async function handlePesapalIPN(req, res) {
    const orderTrackingId =
        req.body?.OrderTrackingId ||
        req.query.OrderTrackingId;

    const merchantReference =
        req.body?.OrderMerchantReference ||
        req.query.OrderMerchantReference;

    if (!orderTrackingId || !merchantReference) {
        return res.status(400).json({
            error: 'Missing Pesapal notification information.'
        });
    }

    try {
        await verifyAndCreditDeposit(
            orderTrackingId,
            merchantReference
        );

        // Pesapal expects an acknowledgement response.
        return res.json({
            orderNotificationType:
                req.body?.OrderNotificationType ||
                req.query.OrderNotificationType ||
                'IPNCHANGE',
            orderTrackingId,
            orderMerchantReference: merchantReference,
            status: 200
        });

    } catch (error) {
        console.error('Pesapal IPN processing error:', error.message);

        return res.status(500).json({
            orderNotificationType: 'IPNCHANGE',
            orderTrackingId,
            orderMerchantReference: merchantReference,
            status: 500
        });
    }
}

app.get('/api/payments/pesapal/ipn', handlePesapalIPN);
app.post('/api/payments/pesapal/ipn', handlePesapalIPN);

// ------------------------------------------------------------
// PESAPAL CUSTOMER CALLBACK
// ------------------------------------------------------------

app.get(
    '/api/payments/pesapal/callback',
    asyncHandler(async (req, res) => {
        const orderTrackingId = req.query.OrderTrackingId;
        const merchantReference = req.query.OrderMerchantReference;

        if (!orderTrackingId || !merchantReference) {
            return res.status(400).send(
                'Payment reference information is missing.'
            );
        }

        try {
            const result = await verifyAndCreditDeposit(
                orderTrackingId,
                merchantReference
            );

            // Replace this with the actual customer frontend URL
            // when the frontend deployment address is available.
            const frontendUrl =
                process.env.FRONTEND_URL || '';

            if (frontendUrl) {
                const redirect = new URL(
                    '/payment-result',
                    frontendUrl
                );

                redirect.searchParams.set(
                    'reference',
                    merchantReference
                );

                redirect.searchParams.set(
                    'status',
                    result.status || 'PROCESSING'
                );

                return res.redirect(redirect.toString());
            }

            return res.json({
                message: 'Payment status checked.',
                reference: merchantReference,
                result
            });

        } catch (error) {
            console.error('Pesapal callback error:', error.message);

            return res.status(500).json({
                error: 'Unable to verify payment. Contact support.'
            });
        }
    })
);

// ------------------------------------------------------------
// CUSTOMER CHECK DEPOSIT STATUS
// ------------------------------------------------------------

app.get(
    '/api/cashier/status/:reference',
    auth,
    asyncHandler(async (req, res) => {
        const reference = req.params.reference;

        const result = await db.query(
            `SELECT
                id,
                reference,
                usd_amount,
                kes_amount,
                exchange_rate,
                phone,
                status,
                provider_status,
                credited_at,
                created_at
             FROM deposits
             WHERE reference = $1
               AND user_id = $2`,
            [reference, req.user.id]
        );

        if (!result.rows.length) {
            return res.status(404).json({
                error: 'Deposit not found.'
            });
        }

        const deposit = result.rows[0];

        // If the payment has not completed, refresh its status
        // from Pesapal rather than trusting the browser.

        if (
            deposit.status !== 'COMPLETED' &&
            deposit.status !== 'FAILED' &&
            deposit.status !== 'CANCELLED'
        ) {
            const trackingResult = await db.query(
                `SELECT pesapal_tracking_id
                 FROM deposits
                 WHERE reference = $1`,
                [reference]
            );

            const trackingId =
                trackingResult.rows[0]?.pesapal_tracking_id;

            if (trackingId) {
                try {
                    await verifyAndCreditDeposit(
                        trackingId,
                        reference
                    );
                } catch (error) {
                    console.error(
                        'Deposit status refresh failed:',
                        error.message
                    );
                }
            }
        }

        const refreshed = await db.query(
            `SELECT
                reference,
                usd_amount,
                kes_amount,
                exchange_rate,
                status,
                provider_status,
                credited_at,
                created_at
             FROM deposits
             WHERE reference = $1
               AND user_id = $2`,
            [reference, req.user.id]
        );

        res.json({
            deposit: refreshed.rows[0]
        });
    })
);

// ============================================================
// END OF PART 2
// ============================================================
// ============================================================
// PART 3: WITHDRAWALS AND MANUAL M-PESA PAYMENTS
// ============================================================

// ------------------------------------------------------------
// CUSTOMER REQUESTS A WITHDRAWAL
// ------------------------------------------------------------

app.post(
    '/api/cashier/withdraw',
    auth,
    asyncHandler(async (req, res) => {
        const amount = Number(
            req.body.amount ?? req.body.usdAmount
        );

        const phone = String(
            req.body.phone || req.body.phoneNumber || ''
        ).trim();

        if (
            !Number.isFinite(amount) ||
            amount < MIN_WITHDRAWAL ||
            amount > 100000
        ) {
            return res.status(400).json({
                error: `Minimum withdrawal amount is $${MIN_WITHDRAWAL}.`
            });
        }

        if (!/^\+?[0-9]{9,15}$/.test(phone)) {
            return res.status(400).json({
                error: 'Enter a valid M-Pesa phone number.'
            });
        }

        const kesAmount = money(amount * KES_PER_USD);
        const client = await db.pool.connect();

        try {
            await client.query('BEGIN');

            const userResult = await client.query(
                `SELECT id, account_status
                 FROM users
                 WHERE id = $1
                 FOR UPDATE`,
                [req.user.id]
            );

            if (
                !userResult.rows.length ||
                userResult.rows[0].account_status !== 'ACTIVE'
            ) {
                throw new Error('Your account is unavailable.');
            }

            const wallet = await getWallet(
                client,
                req.user.id,
                'LIVE'
            );

            if (!wallet) {
                throw new Error('LIVE wallet not found.');
            }

            const balanceBefore = money(wallet.balance);
            const reservedBefore = money(wallet.reserved_balance);

            if (balanceBefore < amount) {
                throw new Error('Insufficient available balance.');
            }

            const balanceAfter = money(balanceBefore - amount);
            const reservedAfter = money(reservedBefore + amount);

            const reference = makeReference('GTNWTH');

            // Move the money into reserved balance.
            // It cannot be used for trading while withdrawal
            // approval is pending.

            await client.query(
                `UPDATE wallets
                 SET balance = $1,
                     reserved_balance = $2,
                     updated_at = NOW()
                 WHERE id = $3`,
                [
                    balanceAfter,
                    reservedAfter,
                    wallet.id
                ]
            );

            const transaction = await insertTransaction(client, {
                userId: req.user.id,
                walletId: wallet.id,
                type: 'WITHDRAWAL',
                amount,
                status: 'PENDING',
                reference,
                description: 'Customer withdrawal request'
            });

            const withdrawalResult = await client.query(
                `INSERT INTO withdrawals (
                    user_id,
                    wallet_id,
                    transaction_id,
                    reference,
                    amount,
                    kes_amount,
                    exchange_rate,
                    phone,
                    status
                )
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PENDING')
                RETURNING *`,
                [
                    req.user.id,
                    wallet.id,
                    transaction.id,
                    reference,
                    amount,
                    kesAmount,
                    KES_PER_USD,
                    phone
                ]
            );

            const withdrawal = withdrawalResult.rows[0];

            await insertLedger(client, {
                walletId: wallet.id,
                userId: req.user.id,
                entryType: 'WITHDRAWAL_RESERVE',
                amount: -amount,
                balanceBefore,
                balanceAfter,
                reservedBefore,
                reservedAfter,
                reference,
                idempotencyKey:
                    `WITHDRAWAL_RESERVE_${withdrawal.id}`,
                description: 'Funds reserved for withdrawal'
            });

            await client.query(
                `INSERT INTO payment_logs (
                    withdrawal_id,
                    provider,
                    event_type,
                    payload,
                    processed
                )
                VALUES ($1,'MANUAL_MPESA','WITHDRAWAL_CREATED',$2,true)`,
                [
                    withdrawal.id,
                    JSON.stringify({
                        reference,
                        amount,
                        kesAmount,
                        phone
                    })
                ]
            );

            await client.query('COMMIT');

            res.status(201).json({
                message: 'Withdrawal request submitted successfully.',
                withdrawal: {
                    id: withdrawal.id,
                    reference: withdrawal.reference,
                    amount: money(withdrawal.amount),
                    kesAmount: money(withdrawal.kes_amount),
                    phone: withdrawal.phone,
                    status: withdrawal.status,
                    createdAt: withdrawal.created_at
                },
                wallet: {
                    balance: balanceAfter,
                    reservedBalance: reservedAfter
                }
            });

        } catch (error) {
            await client.query('ROLLBACK');

            res.status(400).json({
                error: error.message || 'Unable to submit withdrawal.'
            });
        } finally {
            client.release();
        }
    })
);

// ------------------------------------------------------------
// CUSTOMER WITHDRAWAL HISTORY
// ------------------------------------------------------------

app.get(
    '/api/cashier/withdrawals',
    auth,
    asyncHandler(async (req, res) => {
        const result = await db.query(
            `SELECT
                id,
                reference,
                amount,
                kes_amount,
                exchange_rate,
                phone,
                status,
                admin_note,
                created_at,
                reviewed_at,
                paid_at
             FROM withdrawals
             WHERE user_id = $1
             ORDER BY created_at DESC
             LIMIT 100`,
            [req.user.id]
        );

        res.json({
            withdrawals: result.rows.map(item => ({
                ...item,
                amount: money(item.amount),
                kes_amount: money(item.kes_amount)
            }))
        });
    })
);

// ------------------------------------------------------------
// CUSTOMER CHECKS ONE WITHDRAWAL
// ------------------------------------------------------------

app.get(
    '/api/cashier/withdrawals/:reference',
    auth,
    asyncHandler(async (req, res) => {
        const result = await db.query(
            `SELECT
                reference,
                amount,
                kes_amount,
                phone,
                status,
                admin_note,
                created_at,
                reviewed_at,
                paid_at
             FROM withdrawals
             WHERE reference = $1
               AND user_id = $2`,
            [
                req.params.reference,
                req.user.id
            ]
        );

        if (!result.rows.length) {
            return res.status(404).json({
                error: 'Withdrawal request not found.'
            });
        }

        res.json({
            withdrawal: result.rows[0]
        });
    })
);

// ============================================================
// ADMIN WITHDRAWAL MANAGEMENT
// ============================================================

// ------------------------------------------------------------
// ADMIN: LIST WITHDRAWALS
// ------------------------------------------------------------

app.get(
    '/api/admin/withdrawals',
    adminAuth,
    asyncHandler(async (req, res) => {
        const status = String(
            req.query.status || ''
        ).toUpperCase();

        const allowedStatuses = [
            'PENDING',
            'APPROVED',
            'REJECTED',
            'PROCESSING',
            'PAID',
            'FAILED',
            'CANCELLED'
        ];

        let query = `
            SELECT
                w.*,
                u.full_name,
                u.email,
                u.phone AS customer_phone
            FROM withdrawals w
            JOIN users u ON u.id = w.user_id
        `;

        const params = [];

        if (status) {
            if (!allowedStatuses.includes(status)) {
                return res.status(400).json({
                    error: 'Invalid withdrawal status.'
                });
            }

            query += ' WHERE w.status = $1';
            params.push(status);
        }

        query += ' ORDER BY w.created_at DESC LIMIT 500';

        const result = await db.query(query, params);

        res.json({
            withdrawals: result.rows.map(item => ({
                ...item,
                amount: money(item.amount),
                kes_amount: money(item.kes_amount)
            }))
        });
    })
);

// ------------------------------------------------------------
// ADMIN: APPROVE WITHDRAWAL
// ------------------------------------------------------------

app.post(
    '/api/admin/withdrawals/:id/approve',
    adminAuth,
    asyncHandler(async (req, res) => {
        const client = await db.pool.connect();

        try {
            await client.query('BEGIN');

            const result = await client.query(
                `SELECT *
                 FROM withdrawals
                 WHERE id = $1
                 FOR UPDATE`,
                [req.params.id]
            );

            if (!result.rows.length) {
                throw new Error('Withdrawal not found.');
            }

            const withdrawal = result.rows[0];

            if (withdrawal.status !== 'PENDING') {
                throw new Error(
                    'Only pending withdrawals can be approved.'
                );
            }

            await client.query(
                `UPDATE withdrawals
                 SET status = 'APPROVED',
                     reviewed_by = $1,
                     reviewed_at = NOW(),
                     admin_note = $2
                 WHERE id = $3`,
                [
                    req.admin.id,
                    req.body.note || 'Withdrawal approved.',
                    withdrawal.id
                ]
            );

            await client.query(
                `UPDATE transactions
                 SET status = 'PROCESSING'
                 WHERE id = $1`,
                [withdrawal.transaction_id]
            );

            await logAdminAction(
                client,
                req.admin.id,
                'APPROVE_WITHDRAWAL',
                'WITHDRAWAL',
                withdrawal.id,
                {
                    reference: withdrawal.reference,
                    amount: withdrawal.amount,
                    kesAmount: withdrawal.kes_amount,
                    note: req.body.note || ''
                }
            );

            await client.query(
                `INSERT INTO payment_logs (
                    withdrawal_id,
                    provider,
                    event_type,
                    payload,
                    processed
                )
                VALUES ($1,'MANUAL_MPESA','WITHDRAWAL_APPROVED',$2,true)`,
                [
                    withdrawal.id,
                    JSON.stringify({
                        adminId: req.admin.id,
                        note: req.body.note || ''
                    })
                ]
            );

            await client.query('COMMIT');

            res.json({
                message: 'Withdrawal approved.',
                reference: withdrawal.reference,
                status: 'APPROVED'
            });

        } catch (error) {
            await client.query('ROLLBACK');

            res.status(400).json({
                error: error.message
            });
        } finally {
            client.release();
        }
    })
);

// ------------------------------------------------------------
// ADMIN: REJECT WITHDRAWAL AND RELEASE RESERVED FUNDS
// ------------------------------------------------------------

app.post(
    '/api/admin/withdrawals/:id/reject',
    adminAuth,
    asyncHandler(async (req, res) => {
        const note = String(
            req.body.note || ''
        ).trim();

        if (note.length < 3) {
            return res.status(400).json({
                error: 'Provide a reason for rejecting the withdrawal.'
            });
        }

        const client = await db.pool.connect();

        try {
            await client.query('BEGIN');

            const result = await client.query(
                `SELECT *
                 FROM withdrawals
                 WHERE id = $1
                 FOR UPDATE`,
                [req.params.id]
            );

            if (!result.rows.length) {
                throw new Error('Withdrawal not found.');
            }

            const withdrawal = result.rows[0];

            if (withdrawal.status !== 'PENDING') {
                throw new Error(
                    'Only pending withdrawals can be rejected.'
                );
            }

            const walletResult = await client.query(
                `SELECT *
                 FROM wallets
                 WHERE id = $1
                 FOR UPDATE`,
                [withdrawal.wallet_id]
            );

            if (!walletResult.rows.length) {
                throw new Error('Customer wallet not found.');
            }

            const wallet = walletResult.rows[0];

            const amount = money(withdrawal.amount);

            const balanceBefore = money(wallet.balance);
            const reservedBefore = money(wallet.reserved_balance);

            if (reservedBefore < amount) {
                throw new Error(
                    'Reserved wallet balance is inconsistent. Manual investigation required.'
                );
            }

            const balanceAfter = money(balanceBefore + amount);
            const reservedAfter = money(reservedBefore - amount);

            await client.query(
                `UPDATE wallets
                 SET balance = $1,
                     reserved_balance = $2,
                     updated_at = NOW()
                 WHERE id = $3`,
                [
                    balanceAfter,
                    reservedAfter,
                    wallet.id
                ]
            );

            await client.query(
                `UPDATE withdrawals
                 SET status = 'REJECTED',
                     reviewed_by = $1,
                     reviewed_at = NOW(),
                     admin_note = $2
                 WHERE id = $3`,
                [
                    req.admin.id,
                    note,
                    withdrawal.id
                ]
            );

            await client.query(
                `UPDATE transactions
                 SET status = 'REJECTED'
                 WHERE id = $1`,
                [withdrawal.transaction_id]
            );

            await insertLedger(client, {
                walletId: wallet.id,
                userId: withdrawal.user_id,
                entryType: 'WITHDRAWAL_RELEASE',
                amount,
                balanceBefore,
                balanceAfter,
                reservedBefore,
                reservedAfter,
                reference: withdrawal.reference,
                idempotencyKey:
                    `WITHDRAWAL_RELEASE_${withdrawal.id}`,
                description: 'Rejected withdrawal funds released'
            });

            await logAdminAction(
                client,
                req.admin.id,
                'REJECT_WITHDRAWAL',
                'WITHDRAWAL',
                withdrawal.id,
                {
                    reference: withdrawal.reference,
                    amount,
                    note
                }
            );

            await client.query(
                `INSERT INTO payment_logs (
                    withdrawal_id,
                    provider,
                    event_type,
                    payload,
                    processed
                )
                VALUES ($1,'MANUAL_MPESA','WITHDRAWAL_REJECTED',$2,true)`,
                [
                    withdrawal.id,
                    JSON.stringify({
                        adminId: req.admin.id,
                        note
                    })
                ]
            );

            await client.query('COMMIT');

            res.json({
                message: 'Withdrawal rejected. Funds returned to customer wallet.',
                reference: withdrawal.reference,
                balance: balanceAfter,
                reservedBalance: reservedAfter
            });

        } catch (error) {
            await client.query('ROLLBACK');

            res.status(400).json({
                error: error.message
            });
        } finally {
            client.release();
        }
    })
);

// ------------------------------------------------------------
// ADMIN: MARK WITHDRAWAL AS PROCESSING
// ------------------------------------------------------------

app.post(
    '/api/admin/withdrawals/:id/processing',
    adminAuth,
    asyncHandler(async (req, res) => {
        const client = await db.pool.connect();

        try {
            await client.query('BEGIN');

            const result = await client.query(
                `SELECT *
                 FROM withdrawals
                 WHERE id = $1
                 FOR UPDATE`,
                [req.params.id]
            );

            if (!result.rows.length) {
                throw new Error('Withdrawal not found.');
            }

            const withdrawal = result.rows[0];

            if (withdrawal.status !== 'APPROVED') {
                throw new Error(
                    'Only approved withdrawals can be marked processing.'
                );
            }

            await client.query(
                `UPDATE withdrawals
                 SET status = 'PROCESSING',
                     admin_note = $1
                 WHERE id = $2`,
                [
                    req.body.note || 'M-Pesa payment being processed.',
                    withdrawal.id
                ]
            );

            await logAdminAction(
                client,
                req.admin.id,
                'PROCESS_WITHDRAWAL',
                'WITHDRAWAL',
                withdrawal.id,
                {
                    reference: withdrawal.reference
                }
            );

            await client.query('COMMIT');

            res.json({
                message: 'Withdrawal marked as processing.',
                status: 'PROCESSING'
            });

        } catch (error) {
            await client.query('ROLLBACK');

            res.status(400).json({
                error: error.message
            });
        } finally {
            client.release();
        }
    })
);

// ------------------------------------------------------------
// ADMIN: CONFIRM MANUAL M-PESA PAYMENT
// ------------------------------------------------------------

app.post(
    '/api/admin/withdrawals/:id/paid',
    adminAuth,
    asyncHandler(async (req, res) => {
        const mpesaReference = String(
            req.body.mpesaReference || ''
        ).trim();

        if (!mpesaReference) {
            return res.status(400).json({
                error: 'Enter the M-Pesa transaction reference.'
            });
        }

        const client = await db.pool.connect();

        try {
            await client.query('BEGIN');

            const result = await client.query(
                `SELECT *
                 FROM withdrawals
                 WHERE id = $1
                 FOR UPDATE`,
                [req.params.id]
            );

            if (!result.rows.length) {
                throw new Error('Withdrawal not found.');
            }

            const withdrawal = result.rows[0];

            if (
                !['APPROVED', 'PROCESSING'].includes(
                    withdrawal.status
                )
            ) {
                throw new Error(
                    'Only approved or processing withdrawals can be marked paid.'
                );
            }

            const walletResult = await client.query(
                `SELECT *
                 FROM wallets
                 WHERE id = $1
                 FOR UPDATE`,
                [withdrawal.wallet_id]
            );

            if (!walletResult.rows.length) {
                throw new Error('Customer wallet not found.');
            }

            const wallet = walletResult.rows[0];

            const amount = money(withdrawal.amount);

            const balanceBefore = money(wallet.balance);
            const reservedBefore = money(wallet.reserved_balance);

            if (reservedBefore < amount) {
                throw new Error(
                    'Reserved wallet balance is inconsistent. Payment cannot be completed.'
                );
            }

            const balanceAfter = balanceBefore;
            const reservedAfter = money(reservedBefore - amount);

            // The funds are removed from reserved balance.
            // No customer balance is credited here because
            // the money has already been sent externally.

            await client.query(
                `UPDATE wallets
                 SET reserved_balance = $1,
                     updated_at = NOW()
                 WHERE id = $2`,
                [
                    reservedAfter,
                    wallet.id
                ]
            );

            await client.query(
                `UPDATE withdrawals
                 SET status = 'PAID',
                     reviewed_by = $1,
                     reviewed_at = COALESCE(reviewed_at, NOW()),
                     paid_at = NOW(),
                     admin_note = $2
                 WHERE id = $3`,
                [
                    req.admin.id,
                    `M-Pesa reference: ${mpesaReference}`,
                    withdrawal.id
                ]
            );

            await client.query(
                `UPDATE transactions
                 SET status = 'COMPLETED'
                 WHERE id = $1`,
                [withdrawal.transaction_id]
            );

            await insertLedger(client, {
                walletId: wallet.id,
                userId: withdrawal.user_id,
                entryType: 'WITHDRAWAL_PAID',
                amount: -amount,
                balanceBefore,
                balanceAfter,
                reservedBefore,
                reservedAfter,
                reference: withdrawal.reference,
                idempotencyKey:
                    `WITHDRAWAL_PAID_${withdrawal.id}`,
                description: `Manual M-Pesa payout ${mpesaReference}`
            });

            await logAdminAction(
                client,
                req.admin.id,
                'MARK_WITHDRAWAL_PAID',
                'WITHDRAWAL',
                withdrawal.id,
                {
                    reference: withdrawal.reference,
                    amount,
                    kesAmount: withdrawal.kes_amount,
                    mpesaReference
                }
            );

            await client.query(
                `INSERT INTO payment_logs (
                    withdrawal_id,
                    provider,
                    event_type,
                    payload,
                    processed
                )
                VALUES ($1,'MANUAL_MPESA','WITHDRAWAL_PAID',$2,true)`,
                [
                    withdrawal.id,
                    JSON.stringify({
                        adminId: req.admin.id,
                        mpesaReference,
                        amount,
                        kesAmount: withdrawal.kes_amount
                    })
                ]
            );

            await client.query('COMMIT');

            res.json({
                message: 'Withdrawal successfully marked as paid.',
                reference: withdrawal.reference,
                mpesaReference,
                status: 'PAID',
                wallet: {
                    balance: balanceAfter,
                    reservedBalance: reservedAfter
                }
            });

        } catch (error) {
            await client.query('ROLLBACK');

            res.status(400).json({
                error: error.message
            });
        } finally {
            client.release();
        }
    })
);

// ============================================================
// END OF PART 3
// ============================================================
// ============================================================
// PART 4: ADMINISTRATION AND SERVER CONFIGURATION
// ============================================================

// ------------------------------------------------------------
// ADMIN LOGIN
// ------------------------------------------------------------

app.post('/api/admin/login', asyncHandler(async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!email || !password) {
        return res.status(400).json({
            error: 'Email and password are required.'
        });
    }

    const result = await db.query(
        `SELECT id, email, password_hash, role, active
         FROM admins
         WHERE email = $1`,
        [email]
    );

    if (!result.rows.length) {
        return res.status(401).json({
            error: 'Invalid administrator credentials.'
        });
    }

    const admin = result.rows[0];

    if (!admin.active) {
        return res.status(403).json({
            error: 'Administrator account is disabled.'
        });
    }

    const validPassword = await bcrypt.compare(
        password,
        admin.password_hash
    );

    if (!validPassword) {
        return res.status(401).json({
            error: 'Invalid administrator credentials.'
        });
    }

    const token = jwt.sign(
        {
            id: admin.id,
            email: admin.email,
            role: admin.role
        },
        JWT_SECRET,
        { expiresIn: '8h' }
    );

    res.json({
        message: 'Administrator login successful.',
        token,
        admin: {
            id: admin.id,
            email: admin.email,
            role: admin.role
        }
    });
}));

// ------------------------------------------------------------
// ADMIN PROFILE
// ------------------------------------------------------------

app.get('/api/admin/me', adminAuth, asyncHandler(async (req, res) => {
    const result = await db.query(
        `SELECT id, email, role, active, created_at
         FROM admins
         WHERE id = $1`,
        [req.admin.id]
    );

    if (!result.rows.length || !result.rows[0].active) {
        return res.status(401).json({
            error: 'Administrator account unavailable.'
        });
    }

    res.json({
        admin: result.rows[0]
    });
}));

// ------------------------------------------------------------
// ADMIN DASHBOARD OVERVIEW
// ------------------------------------------------------------

app.get(
    '/api/admin/dashboard',
    adminAuth,
    asyncHandler(async (req, res) => {
        const [
            customers,
            deposits,
            withdrawals,
            trades,
            wallets
        ] = await Promise.all([
            db.query(`
                SELECT
                    COUNT(*) AS total_customers,
                    COUNT(*) FILTER (
                        WHERE account_status = 'ACTIVE'
                    ) AS active_customers,
                    COUNT(*) FILTER (
                        WHERE account_status = 'SUSPENDED'
                    ) AS suspended_customers
                FROM users
            `),

            db.query(`
                SELECT
                    COUNT(*) AS total_deposits,
                    COUNT(*) FILTER (
                        WHERE status = 'PENDING'
                    ) AS pending_deposits,
                    COALESCE(
                        SUM(usd_amount) FILTER (
                            WHERE status = 'COMPLETED'
                        ), 0
                    ) AS completed_deposit_usd
                FROM deposits
            `),

            db.query(`
                SELECT
                    COUNT(*) AS total_withdrawals,
                    COUNT(*) FILTER (
                        WHERE status = 'PENDING'
                    ) AS pending_withdrawals,
                    COALESCE(
                        SUM(amount) FILTER (
                            WHERE status = 'PAID'
                        ), 0
                    ) AS paid_withdrawal_usd
                FROM withdrawals
            `),

            db.query(`
                SELECT
                    COUNT(*) AS total_trades,
                    COUNT(*) FILTER (
                        WHERE status = 'OPEN'
                    ) AS open_trades,
                    COUNT(*) FILTER (
                        WHERE status = 'WON'
                    ) AS winning_trades,
                    COUNT(*) FILTER (
                        WHERE status = 'LOST'
                    ) AS losing_trades
                FROM trades
            `),

            db.query(`
                SELECT
                    account_type,
                    COUNT(*) AS wallet_count,
                    COALESCE(SUM(balance), 0) AS total_balance,
                    COALESCE(SUM(reserved_balance), 0)
                        AS total_reserved
                FROM wallets
                GROUP BY account_type
            `)
        ]);

        res.json({
            customers: customers.rows[0],
            deposits: deposits.rows[0],
            withdrawals: withdrawals.rows[0],
            trades: trades.rows[0],
            wallets: wallets.rows
        });
    })
);

// ------------------------------------------------------------
// ADMIN CUSTOMER SEARCH
// ------------------------------------------------------------

app.get(
    '/api/admin/users',
    adminAuth,
    asyncHandler(async (req, res) => {
        const search = String(req.query.search || '').trim();
        const status = String(req.query.status || '').toUpperCase();

        const limit = Math.min(
            Math.max(Number(req.query.limit) || 50, 1),
            100
        );

        const offset = Math.max(
            Number(req.query.offset) || 0,
            0
        );

        const conditions = [];
        const params = [];

        if (search) {
            params.push(`%${search}%`);

            conditions.push(`
                (
                    u.full_name ILIKE $${params.length}
                    OR u.email ILIKE $${params.length}
                    OR u.phone ILIKE $${params.length}
                    OR u.referral_code ILIKE $${params.length}
                )
            `);
        }

        if (status) {
            if (!['ACTIVE', 'SUSPENDED'].includes(status)) {
                return res.status(400).json({
                    error: 'Invalid account status.'
                });
            }

            params.push(status);
            conditions.push(
                `u.account_status = $${params.length}`
            );
        }

        let query = `
            SELECT
                u.id,
                u.full_name,
                u.email,
                u.phone,
                u.country,
                u.referral_code,
                u.referrals_count,
                u.kyc_status,
                u.account_status,
                u.created_at,
                COALESCE(
                    JSON_AGG(
                        JSON_BUILD_OBJECT(
                            'account_type', w.account_type,
                            'balance', w.balance,
                            'reserved_balance', w.reserved_balance
                        )
                    ) FILTER (WHERE w.id IS NOT NULL),
                    '[]'
                ) AS wallets
            FROM users u
            LEFT JOIN wallets w ON w.user_id = u.id
        `;

        if (conditions.length) {
            query += ` WHERE ${conditions.join(' AND ')}`;
        }

        query += `
            GROUP BY u.id
            ORDER BY u.created_at DESC
            LIMIT $${params.length + 1}
            OFFSET $${params.length + 2}
        `;

        params.push(limit, offset);

        const result = await db.query(query, params);

        res.json({
            users: result.rows,
            pagination: {
                limit,
                offset,
                returned: result.rows.length
            }
        });
    })
);

// ------------------------------------------------------------
// ADMIN CUSTOMER PROFILE
// ------------------------------------------------------------

app.get(
    '/api/admin/users/:id',
    adminAuth,
    asyncHandler(async (req, res) => {
        const userResult = await db.query(
            `SELECT
                id,
                full_name,
                email,
                phone,
                country,
                referral_code,
                referrals_count,
                referral_earnings,
                kyc_status,
                account_status,
                created_at,
                updated_at
             FROM users
             WHERE id = $1`,
            [req.params.id]
        );

        if (!userResult.rows.length) {
            return res.status(404).json({
                error: 'Customer not found.'
            });
        }

        const [wallets, transactions, trades] = await Promise.all([
            db.query(
                `SELECT *
                 FROM wallets
                 WHERE user_id = $1`,
                [req.params.id]
            ),

            db.query(
                `SELECT *
                 FROM transactions
                 WHERE user_id = $1
                 ORDER BY created_at DESC
                 LIMIT 50`,
                [req.params.id]
            ),

            db.query(
                `SELECT *
                 FROM trades
                 WHERE user_id = $1
                 ORDER BY created_at DESC
                 LIMIT 50`,
                [req.params.id]
            )
        ]);

        res.json({
            user: userResult.rows[0],
            wallets: wallets.rows,
            transactions: transactions.rows,
            trades: trades.rows
        });
    })
);

// ------------------------------------------------------------
// ADMIN SUSPEND CUSTOMER
// ------------------------------------------------------------

app.post(
    '/api/admin/users/:id/suspend',
    adminAuth,
    asyncHandler(async (req, res) => {
        const client = await db.pool.connect();

        try {
            await client.query('BEGIN');

            const result = await client.query(
                `SELECT id, account_status
                 FROM users
                 WHERE id = $1
                 FOR UPDATE`,
                [req.params.id]
            );

            if (!result.rows.length) {
                throw new Error('Customer not found.');
            }

            if (result.rows[0].account_status === 'SUSPENDED') {
                throw new Error('Customer is already suspended.');
            }

            await client.query(
                `UPDATE users
                 SET account_status = 'SUSPENDED',
                     updated_at = NOW()
                 WHERE id = $1`,
                [req.params.id]
            );

            await logAdminAction(
                client,
                req.admin.id,
                'SUSPEND_CUSTOMER',
                'USER',
                req.params.id,
                {
                    reason: req.body.reason || 'No reason provided'
                }
            );

            await client.query('COMMIT');

            res.json({
                message: 'Customer suspended successfully.'
            });

        } catch (error) {
            await client.query('ROLLBACK');

            res.status(400).json({
                error: error.message
            });
        } finally {
            client.release();
        }
    })
);

// ------------------------------------------------------------
// ADMIN REACTIVATE CUSTOMER
// ------------------------------------------------------------

app.post(
    '/api/admin/users/:id/reactivate',
    adminAuth,
    asyncHandler(async (req, res) => {
        const client = await db.pool.connect();

        try {
            await client.query('BEGIN');

            const result = await client.query(
                `SELECT id, account_status
                 FROM users
                 WHERE id = $1
                 FOR UPDATE`,
                [req.params.id]
            );

            if (!result.rows.length) {
                throw new Error('Customer not found.');
            }

            await client.query(
                `UPDATE users
                 SET account_status = 'ACTIVE',
                     updated_at = NOW()
                 WHERE id = $1`,
                [req.params.id]
            );

            await logAdminAction(
                client,
                req.admin.id,
                'REACTIVATE_CUSTOMER',
                'USER',
                req.params.id,
                {}
            );

            await client.query('COMMIT');

            res.json({
                message: 'Customer reactivated successfully.'
            });

        } catch (error) {
            await client.query('ROLLBACK');

            res.status(400).json({
                error: error.message
            });
        } finally {
            client.release();
        }
    })
);

// ------------------------------------------------------------
// ADMIN WALLET BALANCE ADJUSTMENT
// ------------------------------------------------------------

app.post(
    '/api/admin/wallets/:id/adjust',
    adminAuth,
    superAdminOnly,
    asyncHandler(async (req, res) => {
        const amount = Number(req.body.amount);
        const reason = String(req.body.reason || '').trim();

        if (
            !Number.isFinite(amount) ||
            amount === 0 ||
            Math.abs(amount) > 1000000
        ) {
            return res.status(400).json({
                error: 'Enter a valid non-zero adjustment amount.'
            });
        }

        if (reason.length < 5) {
            return res.status(400).json({
                error: 'Provide an adjustment reason.'
            });
        }

        const client = await db.pool.connect();

        try {
            await client.query('BEGIN');

            const walletResult = await client.query(
                `SELECT *
                 FROM wallets
                 WHERE id = $1
                 FOR UPDATE`,
                [req.params.id]
            );

            if (!walletResult.rows.length) {
                throw new Error('Wallet not found.');
            }

            const wallet = walletResult.rows[0];

            const balanceBefore = money(wallet.balance);
            const reservedBefore = money(wallet.reserved_balance);

            const balanceAfter = money(balanceBefore + amount);

            if (balanceAfter < 0) {
                throw new Error(
                    'Adjustment would make wallet balance negative.'
                );
            }

            const reference = makeReference('ADMINADJ');

            await client.query(
                `UPDATE wallets
                 SET balance = $1,
                     updated_at = NOW()
                 WHERE id = $2`,
                [
                    balanceAfter,
                    wallet.id
                ]
            );

            await insertLedger(client, {
                walletId: wallet.id,
                userId: wallet.user_id,
                entryType: 'ADMIN_ADJUSTMENT',
                amount,
                balanceBefore,
                balanceAfter,
                reservedBefore,
                reservedAfter: reservedBefore,
                reference,
                idempotencyKey: reference,
                description: reason
            });

            await insertTransaction(client, {
                userId: wallet.user_id,
                walletId: wallet.id,
                type: 'ADJUSTMENT',
                amount: Math.abs(amount),
                status: 'COMPLETED',
                reference,
                description: reason
            });

            await logAdminAction(
                client,
                req.admin.id,
                'WALLET_ADJUSTMENT',
                'WALLET',
                wallet.id,
                {
                    userId: wallet.user_id,
                    amount,
                    reason,
                    balanceBefore,
                    balanceAfter
                }
            );

            await client.query('COMMIT');

            res.json({
                message: 'Wallet adjusted successfully.',
                reference,
                wallet: {
                    id: wallet.id,
                    balanceBefore,
                    balanceAfter,
                    adjustment: amount
                }
            });

        } catch (error) {
            await client.query('ROLLBACK');

            res.status(400).json({
                error: error.message
            });
        } finally {
            client.release();
        }
    })
);

// ------------------------------------------------------------
// ADMIN DEPOSIT LIST
// ------------------------------------------------------------

app.get(
    '/api/admin/deposits',
    adminAuth,
    asyncHandler(async (req, res) => {
        const status = String(
            req.query.status || ''
        ).toUpperCase();

        const allowedStatuses = [
            'PENDING',
            'PROCESSING',
            'COMPLETED',
            'FAILED',
            'CANCELLED'
        ];

        let query = `
            SELECT
                d.*,
                u.full_name,
                u.email,
                u.phone AS customer_phone
            FROM deposits d
            JOIN users u ON u.id = d.user_id
        `;

        const params = [];

        if (status) {
            if (!allowedStatuses.includes(status)) {
                return res.status(400).json({
                    error: 'Invalid deposit status.'
                });
            }

            query += ' WHERE d.status = $1';
            params.push(status);
        }

        query += `
            ORDER BY d.created_at DESC
            LIMIT 500
        `;

        const result = await db.query(query, params);

        res.json({
            deposits: result.rows
        });
    })
);

// ------------------------------------------------------------
// ADMIN TRADING HISTORY
// ------------------------------------------------------------

app.get(
    '/api/admin/trades',
    adminAuth,
    asyncHandler(async (req, res) => {
        const status = String(
            req.query.status || ''
        ).toUpperCase();

        const allowedStatuses = [
            'OPEN',
            'WON',
            'LOST',
            'CANCELLED'
        ];

        const conditions = [];
        const params = [];

        if (status) {
            if (!allowedStatuses.includes(status)) {
                return res.status(400).json({
                    error: 'Invalid trade status.'
                });
            }

            params.push(status);
            conditions.push(`t.status = $${params.length}`);
        }

        if (req.query.userId) {
            params.push(req.query.userId);
            conditions.push(`t.user_id = $${params.length}`);
        }

        let query = `
            SELECT
                t.*,
                u.full_name,
                u.email
            FROM trades t
            JOIN users u ON u.id = t.user_id
        `;

        if (conditions.length) {
            query += ` WHERE ${conditions.join(' AND ')}`;
        }

        query += `
            ORDER BY t.created_at DESC
            LIMIT 500
        `;

        const result = await db.query(query, params);

        res.json({
            trades: result.rows
        });
    })
);

// ------------------------------------------------------------
// ADMIN ACTIVITY LOGS
// ------------------------------------------------------------

app.get(
    '/api/admin/activity',
    adminAuth,
    superAdminOnly,
    asyncHandler(async (req, res) => {
        const limit = Math.min(
            Math.max(Number(req.query.limit) || 100, 1),
            500
        );

        const result = await db.query(
            `SELECT
                l.*,
                a.email AS admin_email,
                a.role AS admin_role
             FROM admin_activity_logs l
             LEFT JOIN admins a ON a.id = l.admin_id
             ORDER BY l.created_at DESC
             LIMIT $1`,
            [limit]
        );

        res.json({
            activity: result.rows
        });
    })
);

// ------------------------------------------------------------
// ADMIN UPDATE KYC STATUS
// ------------------------------------------------------------

app.post(
    '/api/admin/users/:id/kyc',
    adminAuth,
    asyncHandler(async (req, res) => {
        const status = String(
            req.body.status || ''
        ).toLowerCase();

        const allowed = [
            'unverified',
            'pending_review',
            'verified',
            'rejected'
        ];

        if (!allowed.includes(status)) {
            return res.status(400).json({
                error: 'Invalid KYC status.'
            });
        }

        const client = await db.pool.connect();

        try {
            await client.query('BEGIN');

            const result = await client.query(
                `UPDATE users
                 SET kyc_status = $1,
                     updated_at = NOW()
                 WHERE id = $2
                 RETURNING id, kyc_status`,
                [
                    status,
                    req.params.id
                ]
            );

            if (!result.rows.length) {
                throw new Error('Customer not found.');
            }

            await logAdminAction(
                client,
                req.admin.id,
                'UPDATE_KYC_STATUS',
                'USER',
                req.params.id,
                { status }
            );

            await client.query('COMMIT');

            res.json({
                message: 'KYC status updated.',
                user: result.rows[0]
            });

        } catch (error) {
            await client.query('ROLLBACK');

            res.status(400).json({
                error: error.message
            });
        } finally {
            client.release();
        }
    })
);

// ============================================================
// HEALTH CHECK
// ============================================================

app.get('/api/health', asyncHandler(async (req, res) => {
    await db.query('SELECT 1');

    res.json({
        status: 'OK',
        service: 'GTN Backend',
        database: 'CONNECTED',
        timestamp: new Date().toISOString()
    });
}));

// ============================================================
// GLOBAL ERROR HANDLER
// ============================================================

app.use((err, req, res, next) => {
    console.error('GTN server error:', err);

    if (res.headersSent) {
        return next(err);
    }

    res.status(500).json({
        error: 'An unexpected server error occurred.'
    });
});

// ============================================================
// SERVER STARTUP
// ============================================================

async function startServer() {
    try {
        await db.testConnection();

        server.listen(PORT, () => {
            console.log('====================================');
            console.log('GTN BACKEND STARTED');
            console.log(`HTTP server: http://localhost:${PORT}`);
            console.log(`WebSocket: ws://localhost:${PORT}`);
            console.log('PostgreSQL: CONNECTED');
            console.log('====================================');
        });

    } catch (error) {
        console.error(
            'GTN startup failed:',
            error.message
        );

        process.exit(1);
    }
}

startServer();

// ============================================================
// END OF PART 4
// ============================================================
