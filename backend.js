
'use strict';

// ============================================================
// GTN BINARY OPTIONS PLATFORM
// PostgreSQL + Pesapal + Manual M-Pesa Withdrawals
// Node.js 18+
// ============================================================

require('dotenv').config();

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const path = require('path');

const db = require('./database/db');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = Number(process.env.PORT || 4000);
const JWT_SECRET = process.env.JWT_SECRET;
const KES_PER_USD = Number(process.env.KES_PER_USD || 130);

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

if (!JWT_SECRET || JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET must contain at least 32 characters.');
}

if (!Number.isFinite(KES_PER_USD) || KES_PER_USD <= 0) {
    throw new Error('KES_PER_USD must be positive.');
}

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'frontend.html'));
});

// ============================================================
// GENERAL HELPERS
// ============================================================

function money(value) {
    return Number(Number(value || 0).toFixed(2));
}

function reference(prefix = 'GTN') {
    return `${prefix}-${Date.now()}-${crypto.randomBytes(5)
        .toString('hex').toUpperCase()}`;
}

function asyncHandler(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}

function signCustomer(user) {
    return jwt.sign(
        { id: user.id, role: 'CUSTOMER' },
        JWT_SECRET,
        { expiresIn: '7d' }
    );
}

function signAdmin(admin) {
    return jwt.sign(
        {
            id: admin.id,
            email: admin.email,
            role: admin.role
        },
        JWT_SECRET,
        { expiresIn: '8h' }
    );
}

function customerView(user, wallets = []) {
    const demo = wallets.find(w => w.account_type === 'DEMO');
    const live = wallets.find(w => w.account_type === 'LIVE');

    return {
        id: user.id,
        fullName: user.full_name,
        email: user.email,
        phone: user.phone,
        country: user.country || 'KE',
        referralCode: user.referral_code,
        referralsCount: Number(user.referrals_count || 0),
        referralEarnings: money(user.referral_earnings),
        kycStatus: user.kyc_status,
        accountStatus: user.account_status,
        twoFactorEnabled: Boolean(user.two_factor_enabled),
        demoBalance: money(demo?.balance),
        liveBalance: money(live?.balance)
    };
}

function tradeView(trade) {
    return {
        ...trade,
        marketName: trade.symbol,
        contractType: trade.contract_type,
        accountType: trade.account_type,
        entryPrice: Number(trade.entry_price),
        exitPrice: trade.exit_price == null
            ? null : Number(trade.exit_price),
        exitDigit: trade.exit_digit,
        createdAt: trade.created_at,
        expiresAt: trade.expires_at,
        stake: money(trade.stake),
        profit: money(trade.profit),
        payoutRate: Number(trade.payout_rate)
    };
}

function transactionView(item) {
    return {
        id: item.id,
        type: item.type,
        method: item.provider || '',
        accountType: item.wallet_id ? 'LIVE' : '',
        amount: money(item.amount),
        status: item.status,
        destination: item.description || '',
        timestamp: item.created_at,
        reference: item.reference
    };
}

function normalizePhone(phone) {
    let value = String(phone || '').replace(/\s+/g, '');

    if (value.startsWith('0')) {
        value = '+254' + value.substring(1);
    } else if (value.startsWith('254')) {
        value = '+' + value;
    } else if (/^7\d{8}$/.test(value)) {
        value = '+254' + value;
    }

    return value;
}

function validPhone(phone) {
    return /^\+254[17]\d{8}$/.test(phone);
}

async function withTransaction(callback) {
    const client = await db.pool.connect();

    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        try {
            await client.query('ROLLBACK');
        } catch (rollbackError) {
            console.error('Rollback error:', rollbackError.message);
        }
        throw error;
    } finally {
        client.release();
    }
}

async function getWallet(client, userId, accountType) {
    const result = await client.query(
        `SELECT *
         FROM wallets
         WHERE user_id = $1 AND account_type = $2
         FOR UPDATE`,
        [userId, accountType]
    );

    return result.rows[0] || null;
}

async function insertTransaction(client, data) {
    const result = await client.query(
        `INSERT INTO transactions (
            user_id, wallet_id, reference,
            type, amount, currency, status,
            description, provider, provider_reference
         )
         VALUES ($1,$2,$3,$4,$5,'USD',$6,$7,$8,$9)
         RETURNING *`,
        [
            data.userId,
            data.walletId || null,
            data.reference,
            data.type,
            data.amount,
            data.status,
            data.description || null,
            data.provider || null,
            data.providerReference || null
        ]
    );

    return result.rows[0];
}

async function insertLedger(client, data) {
    await client.query(
        `INSERT INTO wallet_ledger (
            wallet_id, user_id, entry_type,
            reference, idempotency_key, amount,
            balance_before, balance_after,
            reserved_before, reserved_after,
            description
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
            data.walletId,
            data.userId,
            data.entryType,
            data.reference,
            data.idempotencyKey,
            data.amount,
            data.balanceBefore,
            data.balanceAfter,
            data.reservedBefore,
            data.reservedAfter,
            data.description || null
        ]
    );
}

async function logAdminAction(
    client,
    adminId,
    action,
    targetType,
    targetId,
    details = {}
) {
    await client.query(
        `INSERT INTO admin_activity_logs (
            admin_id, action, target_type, target_id, details
         )
         VALUES ($1,$2,$3,$4,$5)`,
        [
            adminId,
            action,
            targetType,
            targetId,
            JSON.stringify(details)
        ]
    );
}

// ============================================================
// AUTHENTICATION
// ============================================================

async function customerAuth(req, res, next) {
    const header = req.headers.authorization;

    if (!header || !header.startsWith('Bearer ')) {
        return res.status(401).json({
            error: 'Authentication required.'
        });
    }

    try {
        const decoded = jwt.verify(header.substring(7), JWT_SECRET);

        if (decoded.role !== 'CUSTOMER') {
            return res.status(403).json({
                error: 'Customer access required.'
            });
        }

        const result = await db.query(
            `SELECT id, account_status
             FROM users
             WHERE id = $1`,
            [decoded.id]
        );

        if (!result.rows.length ||
            result.rows[0].account_status !== 'ACTIVE') {
            return res.status(403).json({
                error: 'Account unavailable.'
            });
        }

        req.user = decoded;
        next();
    } catch (error) {
        if (error.name === 'JsonWebTokenError' ||
            error.name === 'TokenExpiredError') {
            return res.status(401).json({
                error: 'Invalid or expired token.'
            });
        }

        next(error);
    }
}

async function adminAuth(req, res, next) {
    const header = req.headers.authorization;

    if (!header || !header.startsWith('Bearer ')) {
        return res.status(401).json({
            error: 'Admin authentication required.'
        });
    }

    try {
        const decoded = jwt.verify(header.substring(7), JWT_SECRET);

        if (!['ADMIN', 'SUPER_ADMIN'].includes(decoded.role)) {
            return res.status(403).json({
                error: 'Administrator access required.'
            });
        }

        const result = await db.query(
            `SELECT id, email, role, active
             FROM admins
             WHERE id = $1`,
            [decoded.id]
        );

        const admin = result.rows[0];

        if (!admin || !admin.active ||
            admin.role !== decoded.role) {
            return res.status(403).json({
                error: 'Administrator account is disabled.'
            });
        }

        req.admin = admin;
        next();
    } catch (error) {
        if (error.name === 'JsonWebTokenError' ||
            error.name === 'TokenExpiredError') {
            return res.status(401).json({
                error: 'Invalid or expired admin token.'
            });
        }

        next(error);
    }
}

function superAdminOnly(req, res, next) {
    if (req.admin.role !== 'SUPER_ADMIN') {
        return res.status(403).json({
            error: 'Super administrator access required.'
        });
    }

    next();
}

// ============================================================
// MARKET ENGINE
// ============================================================

const prices = {};
const priceHistory = {};

for (const symbol of SYMBOLS) {
    prices[symbol] = 100 + Math.random() * 100;
    priceHistory[symbol] = [];
}

function lastDigit(price) {
    return Math.abs(Math.floor(Number(price) * 10000) % 10);
}

function broadcast(payload) {
    const message = JSON.stringify(payload);

    for (const socket of wss.clients) {
        if (socket.readyState === WebSocket.OPEN) {
            socket.send(message);
        }
    }
}

function generateTick(symbol) {
    const previous = prices[symbol];

    const volatility = {
        VOL_10_1S: 0.0005,
        VOL_25: 0.001,
        VOL_50: 0.002,
        VOL_75: 0.003,
        VOL_100: 0.004
    }[symbol];

    const movement =
        (Math.random() - 0.5) * previous * volatility * 2;

    const current = Math.max(1, previous + movement);
    prices[symbol] = current;

    const tick = {
        symbol,
        price: Number(current.toFixed(4)),
        time: new Date().toISOString(),
        timestamp: new Date().toISOString(),
        lastDigit: lastDigit(current),
        digit: lastDigit(current)
    };

    priceHistory[symbol].push(tick);

    if (priceHistory[symbol].length > 500) {
        priceHistory[symbol].shift();
    }

    // Frontend expects message.data[marketSymbol].
    broadcast({
        type: 'TICK',
        data: {
            [symbol]: tick
        }
    });

    return tick;
}

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
        return res.status(404).json({
            error: 'Market not found.'
        });
    }

    res.json({
        symbol,
        history: priceHistory[symbol]
    });
});

wss.on('connection', socket => {
    const data = {};

    for (const symbol of SYMBOLS) {
        data[symbol] = {
            symbol,
            price: prices[symbol],
            time: new Date().toISOString(),
            lastDigit: lastDigit(prices[symbol])
        };
    }

    socket.send(JSON.stringify({
        type: 'TICK',
        data
    }));
});

const marketTimer = setInterval(() => {
    for (const symbol of SYMBOLS) {
        generateTick(symbol);
    }
}, 1000);

// ============================================================
// CUSTOMER REGISTRATION
// ============================================================

app.post('/api/auth/register', asyncHandler(async (req, res) => {
    const fullName = String(
        req.body.fullName || req.body.name || ''
    ).trim();

    const email = String(req.body.email || '')
        .trim().toLowerCase();

    const phone = normalizePhone(req.body.phone);
    const password = String(req.body.password || '');

    const country = String(req.body.country || 'KE')
        .trim().toUpperCase().slice(0, 5);

    if (!fullName || !email || !phone || !password) {
        return res.status(400).json({
            error: 'Full name, email, phone and password are required.'
        });
    }

    if (password.length < 6) {
        return res.status(400).json({
            error: 'Password must contain at least 6 characters.'
        });
    }

    if (!validPhone(phone)) {
        return res.status(400).json({
            error: 'Enter a valid Kenyan M-Pesa phone number.'
        });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const user = await withTransaction(async client => {
        const existing = await client.query(
            `SELECT id FROM users
             WHERE email = $1 OR phone = $2`,
            [email, phone]
        );

        if (existing.rows.length) {
            const error = new Error(
                'Email or phone number already registered.'
            );
            error.status = 409;
            throw error;
        }

        let referralCode;

        for (let i = 0; i < 10; i++) {
            referralCode = crypto.randomBytes(5)
                .toString('hex').toUpperCase();

            const check = await client.query(
                'SELECT id FROM users WHERE referral_code = $1',
                [referralCode]
            );

            if (!check.rows.length) break;
            referralCode = null;
        }

        if (!referralCode) {
            throw new Error('Could not generate referral code.');
        }

        let referrerId = null;
        const referredBy = String(req.body.referredBy || '').trim();

        if (referredBy) {
            const referrer = await client.query(
                `SELECT id FROM users WHERE referral_code = $1`,
                [referredBy]
            );

            if (referrer.rows.length) {
                referrerId = referrer.rows[0].id;
            }
        }

        const inserted = await client.query(
            `INSERT INTO users (
                full_name, email, country, phone,
                password_hash, referral_code, referred_by
             )
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             RETURNING *`,
            [
                fullName,
                email,
                country,
                phone,
                passwordHash,
                referralCode,
                referrerId
            ]
        );

        const created = inserted.rows[0];

        const demo = await client.query(
            `INSERT INTO wallets (
                user_id, account_type, currency, balance
             )
             VALUES ($1,'DEMO','USD',1000)
             RETURNING *`,
            [created.id]
        );

        const live = await client.query(
            `INSERT INTO wallets (
                user_id, account_type, currency, balance
             )
             VALUES ($1,'LIVE','USD',0)
             RETURNING *`,
            [created.id]
        );

        await insertLedger(client, {
            walletId: demo.rows[0].id,
            userId: created.id,
            entryType: 'INITIAL_DEMO',
            reference: reference('DEMO'),
            idempotencyKey: `INITIAL_DEMO_${created.id}`,
            amount: 1000,
            balanceBefore: 0,
            balanceAfter: 1000,
            reservedBefore: 0,
            reservedAfter: 0,
            description: 'Initial demo wallet'
        });

        if (referrerId) {
            await client.query(
                `UPDATE users
                 SET referrals_count = referrals_count + 1,
                     updated_at = NOW()
                 WHERE id = $1`,
                [referrerId]
            );
        }

        return {
            user: created,
            wallets: [demo.rows[0], live.rows[0]]
        };
    });

    res.status(201).json({
        message: 'Registration successful.',
        token: signCustomer(user.user),
        user: customerView(user.user, user.wallets)
    });
}));

// ============================================================
// CUSTOMER LOGIN
// ============================================================

app.post('/api/auth/login', asyncHandler(async (req, res) => {
    const email = String(req.body.email || '')
        .trim().toLowerCase();

    const password = String(req.body.password || '');

    if (!email || !password) {
        return res.status(400).json({
            error: 'Email and password are required.'
        });
    }

    const result = await db.query(
        `SELECT * FROM users WHERE email = $1`,
        [email]
    );

    const user = result.rows[0];

    if (!user || !(await bcrypt.compare(
        password,
        user.password_hash
    ))) {
        return res.status(401).json({
            error: 'Invalid login details.'
        });
    }

    if (user.account_status !== 'ACTIVE') {
        return res.status(403).json({
            error: 'Your account has been suspended.'
        });
    }

    const wallets = await db.query(
        `SELECT * FROM wallets WHERE user_id = $1`,
        [user.id]
    );

    res.json({
        message: 'Login successful.',
        token: signCustomer(user),
        user: customerView(user, wallets.rows)
    });
}));

// ============================================================
// CUSTOMER STATE
// ============================================================

app.get('/api/state', customerAuth, asyncHandler(async (req, res) => {
    const [userResult, walletResult, tradeResult, transactionResult] =
        await Promise.all([
            db.query(
                `SELECT * FROM users WHERE id = $1`,
                [req.user.id]
            ),
            db.query(
                `SELECT * FROM wallets WHERE user_id = $1`,
                [req.user.id]
            ),
            db.query(
                `SELECT * FROM trades
                 WHERE user_id = $1
                 ORDER BY created_at DESC LIMIT 100`,
                [req.user.id]
            ),
            db.query(
                `SELECT * FROM transactions
                 WHERE user_id = $1
                 ORDER BY created_at DESC LIMIT 100`,
                [req.user.id]
            )
        ]);

    const wallets = walletResult.rows;

    res.json({
        user: customerView(userResult.rows[0], wallets),
        wallets: wallets.map(w => ({
            ...w,
            balance: money(w.balance),
            reserved_balance: money(w.reserved_balance)
        })),
        trades: tradeResult.rows.map(tradeView),
        transactions: transactionResult.rows.map(transactionView)
    });
}));

// ============================================================
// TRADE CONTRACT EVALUATION
// ============================================================

function evaluateTrade(trade, exitPrice) {
    const exitDigit = lastDigit(exitPrice);
    const entryPrice = Number(trade.entry_price);
    const barrier = Number(trade.barrier);

    switch (trade.contract_type) {
        case 'RISE':
            return exitPrice > entryPrice;
        case 'FALL':
            return exitPrice < entryPrice;
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
            return false;
    }
}

// ============================================================
// PLACE TRADE
// ============================================================

app.post('/api/trades/place', customerAuth, asyncHandler(async (req, res) => {
    const symbol = String(
        req.body.symbol || req.body.market || ''
    );

    const accountType = String(
        req.body.accountType || req.body.account_type || 'DEMO'
    ).toUpperCase();

    const contractType = String(
        req.body.contractType ||
        req.body.contract_type ||
        req.body.type || ''
    ).toUpperCase();

    const stake = Number(req.body.stake ?? req.body.amount);

    const duration = Number(
        req.body.durationSec ?? req.body.duration ?? 2
    );

    const barrierRequired = [
        'OVER', 'UNDER', 'MATCH', 'DIFF'
    ].includes(contractType);

    const barrier = barrierRequired
        ? Number(req.body.barrier)
        : null;

    const contracts = [
        'RISE', 'FALL', 'EVEN', 'ODD',
        'OVER', 'UNDER', 'MATCH', 'DIFF'
    ];

    if (!SYMBOLS.includes(symbol)) {
        return res.status(400).json({
            error: 'Invalid market.'
        });
    }

    if (!['DEMO', 'LIVE'].includes(accountType)) {
        return res.status(400).json({
            error: 'Invalid account type.'
        });
    }

    if (!contracts.includes(contractType)) {
        return res.status(400).json({
            error: 'Invalid contract type.'
        });
    }

    if (!Number.isFinite(stake) ||
        stake < MIN_TRADE ||
        stake > 100000) {
        return res.status(400).json({
            error: `Trade amount must be at least $${MIN_TRADE}.`
        });
    }

    // Frontend sends durationSec: 2.
    if (!Number.isInteger(duration) ||
        duration < 1 ||
        duration > 3600) {
        return res.status(400).json({
            error: 'Duration must be between 1 and 3600 seconds.'
        });
    }

    if (barrierRequired &&
        (!Number.isInteger(barrier) || barrier < 0 || barrier > 9)) {
        return res.status(400).json({
            error: 'Barrier must be a digit from 0 to 9.'
        });
    }

    const result = await withTransaction(async client => {
        const wallet = await getWallet(
            client,
            req.user.id,
            accountType
        );

        if (!wallet) throw new Error('Wallet not found.');

        const before = money(wallet.balance);
        const reserved = money(wallet.reserved_balance);

        if (before < stake) {
            throw new Error('Insufficient wallet balance.');
        }

        const entryPrice = prices[symbol];
        const entryDigit = lastDigit(entryPrice);
        const tradeReference = reference('TRADE');

        const walletUpdate = await client.query(
            `UPDATE wallets
             SET balance = balance - $1,
                 updated_at = NOW()
             WHERE id = $2
             RETURNING balance`,
            [stake, wallet.id]
        );

        const after = money(walletUpdate.rows[0].balance);

        const inserted = await client.query(
            `INSERT INTO trades (
                user_id, wallet_id, symbol, account_type,
                contract_type, stake, entry_price, entry_digit,
                barrier, payout_rate, status, expires_at
             )
             VALUES (
                $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
                'OPEN', NOW() + ($11 * INTERVAL '1 second')
             )
             RETURNING *`,
            [
                req.user.id,
                wallet.id,
                symbol,
                accountType,
                contractType,
                stake,
                entryPrice,
                entryDigit,
                barrier,
                PAYOUT_RATE,
                duration
            ]
        );

        const trade = inserted.rows[0];

        await insertLedger(client, {
            walletId: wallet.id,
            userId: req.user.id,
            entryType: 'TRADE_STAKE',
            reference: tradeReference,
            idempotencyKey: `TRADE_STAKE_${trade.id}`,
            amount: -stake,
            balanceBefore: before,
            balanceAfter: after,
            reservedBefore: reserved,
            reservedAfter: reserved,
            description: `${contractType} trade stake`
        });

        await insertTransaction(client, {
            userId: req.user.id,
            walletId: wallet.id,
            type: 'TRADE',
            amount: stake,
            status: 'COMPLETED',
            reference: tradeReference,
            description: `${contractType} ${symbol}`
        });

        return { trade, balance: after };
    });

    res.status(201).json({
        message: 'Trade placed successfully.',
        trade: tradeView(result.trade),
        balance: result.balance
    });
}));

// ============================================================
// TRADE SETTLEMENT
// ============================================================

async function settleExpiredTrades() {
    try {
        await withTransaction(async client => {
            const expired = await client.query(
                `SELECT *
                 FROM trades
                 WHERE status = 'OPEN'
                   AND expires_at <= NOW()
                 ORDER BY expires_at
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
                     WHERE id = $1 FOR UPDATE`,
                    [trade.wallet_id]
                );

                if (!walletResult.rows.length) continue;

                const wallet = walletResult.rows[0];
                const before = money(wallet.balance);
                const reserved = money(wallet.reserved_balance);
                const after = money(before + payout);

                await client.query(
                    `UPDATE wallets
                     SET balance = $1, updated_at = NOW()
                     WHERE id = $2`,
                    [after, wallet.id]
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
                        lastDigit(exitPrice),
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
                        reference: `TRADE-${trade.id}`,
                        idempotencyKey: `TRADE_WIN_${trade.id}`,
                        amount: payout,
                        balanceBefore: before,
                        balanceAfter: after,
                        reservedBefore: reserved,
                        reservedAfter: reserved,
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
        });
    } catch (error) {
        console.error('Trade settlement error:', error.message);
    }
}

const settlementTimer = setInterval(settleExpiredTrades, 500);

// ============================================================
// PESAPAL CONFIGURATION
// ============================================================

const PESAPAL_BASE_URL =
    String(process.env.PESAPAL_ENVIRONMENT || 'sandbox').toLowerCase() === 'live'
        ? 'https://pay.pesapal.com/v3'
        : 'https://cybqa.pesapal.com/pesapalv3';

let pesapalToken = null;
let pesapalTokenExpiry = 0;

function checkPesapalConfiguration() {
    const required = [
        'PESAPAL_CONSUMER_KEY',
        'PESAPAL_CONSUMER_SECRET',
        'PESAPAL_CALLBACK_URL',
        'PESAPAL_IPN_ID'
    ];

    const missing = required.filter(key => !process.env[key]);

    if (missing.length) {
        throw new Error(
            `Missing Pesapal settings: ${missing.join(', ')}`
        );
    }
}

async function getPesapalToken() {
    checkPesapalConfiguration();

    if (pesapalToken && Date.now() < pesapalTokenExpiry) {
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

    if (!response.ok || !data.token) {
        throw new Error('Pesapal authentication failed.');
    }

    pesapalToken = data.token;
    pesapalTokenExpiry = Date.now() + (4 * 60 * 1000);

    return pesapalToken;
}

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
        throw new Error(
            data?.error?.message ||
            data?.message ||
            'Pesapal request failed.'
        );
    }

    return data;
}

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
            deposit_id, provider, event_type,
            payload, processed, processing_error
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

async function getPesapalStatus(trackingId) {
    if (!trackingId) {
        throw new Error('Pesapal tracking ID is missing.');
    }

    return pesapalRequest(
        '/api/Transactions/GetTransactionStatus?orderTrackingId=' +
        encodeURIComponent(trackingId),
        { method: 'GET' }
    );
}

// ============================================================
// CUSTOMER DEPOSIT
// ============================================================

app.post(
    '/api/cashier/deposit',
    customerAuth,
    asyncHandler(async (req, res) => {
        const amount = Number(req.body.amount ?? req.body.usdAmount);
        const method = String(req.body.method || 'MPESA').toUpperCase();

        if (method !== 'MPESA') {
            return res.status(400).json({
                error: 'Only M-Pesa deposits are supported in this release.'
            });
        }

        if (!Number.isFinite(amount) ||
            amount < MIN_DEPOSIT ||
            amount > 100000) {
            return res.status(400).json({
                error: `Minimum deposit is $${MIN_DEPOSIT}.`
            });
        }

        const userResult = await db.query(
            `SELECT * FROM users WHERE id = $1`,
            [req.user.id]
        );

        const user = userResult.rows[0];

        if (!user) {
            return res.status(404).json({
                error: 'User not found.'
            });
        }

        const phone = normalizePhone(
            req.body.phone || req.body.phoneNumber || user.phone
        );

        if (!validPhone(phone)) {
            return res.status(400).json({
                error: 'Enter a valid Kenyan M-Pesa phone number.'
            });
        }

        checkPesapalConfiguration();

        const kesAmount = money(amount * KES_PER_USD);
        const depositReference = reference('GTNDEP');

        const deposit = await withTransaction(async client => {
            const wallet = await getWallet(client, req.user.id, 'LIVE');

            if (!wallet) throw new Error('LIVE wallet not found.');

            const transaction = await insertTransaction(client, {
                userId: req.user.id,
                walletId: wallet.id,
                type: 'DEPOSIT',
                amount,
                status: 'PENDING',
                reference: depositReference,
                provider: 'PESAPAL',
                description: 'M-Pesa deposit'
            });

            const inserted = await client.query(
                `INSERT INTO deposits (
                    user_id, wallet_id, transaction_id,
                    reference, pesapal_merchant_reference,
                    usd_amount, kes_amount, exchange_rate,
                    phone, status
                 )
                 VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,'PENDING')
                 RETURNING *`,
                [
                    req.user.id,
                    wallet.id,
                    transaction.id,
                    depositReference,
                    amount,
                    kesAmount,
                    KES_PER_USD,
                    phone
                ]
            );

            await recordPaymentLog(
                client,
                inserted.rows[0].id,
                'DEPOSIT_CREATED',
                {
                    reference: depositReference,
                    amountUSD: amount,
                    amountKES: kesAmount,
                    phone
                },
                true
            );

            return inserted.rows[0];
        });

        try {
            const order = await pesapalRequest(
                '/api/Transactions/SubmitOrderRequest',
                {
                    method: 'POST',
                    body: JSON.stringify({
                        id: depositReference,
                        currency: 'KES',
                        amount: kesAmount,
                        description: 'GTN wallet deposit',
                        callback_url: process.env.PESAPAL_CALLBACK_URL,
                        notification_id: process.env.PESAPAL_IPN_ID,
                        billing_address: {
                            email_address: user.email,
                            phone_number: phone,
                            country_code: 'KE',
                            first_name: user.full_name.split(' ')[0] || 'Customer',
                            last_name: user.full_name.split(' ').slice(1).join(' ') || 'GTN',
                            line_1: 'Kenya'
                        }
                    })
                }
            );

            if (!order.order_tracking_id || !order.redirect_url) {
                throw new Error('Pesapal did not return a valid checkout URL.');
            }

            await db.query(
                `UPDATE deposits
                 SET pesapal_tracking_id = $1,
                     pesapal_merchant_reference = $2,
                     status = 'PROCESSING',
                     updated_at = NOW()
                 WHERE id = $3`,
                [
                    order.order_tracking_id,
                    depositReference,
                    deposit.id
                ]
            );

            return res.status(201).json({
                message: 'Deposit request created.',
                reference: depositReference,
                amountUSD: amount,
                amountKES: kesAmount,
                exchangeRate: KES_PER_USD,
                checkoutUrl: order.redirect_url,
                transaction: {
                    reference: depositReference,
                    status: 'PENDING',
                    amount,
                    method: 'MPESA',
                    checkoutUrl: order.redirect_url
                }
            });

        } catch (error) {
            await db.query(
                `UPDATE deposits
                 SET status = 'FAILED',
                     provider_status = $1,
                     updated_at = NOW()
                 WHERE id = $2`,
                [error.message, deposit.id]
            );

            await db.query(
                `UPDATE transactions
                 SET status = 'FAILED', updated_at = NOW()
                 WHERE reference = $1`,
                [depositReference]
            );

            throw error;
        }
    })
);

// ============================================================
// VERIFY AND CREDIT PESAPAL DEPOSIT
// ============================================================

async function verifyAndCreditDeposit(trackingId, merchantReference) {
    if (!trackingId || !merchantReference) {
        throw new Error('Payment references are incomplete.');
    }

    // Always ask Pesapal directly. Never trust the callback status.
    const payment = await getPesapalStatus(trackingId);

    return withTransaction(async client => {
        const result = await client.query(
            `SELECT *
             FROM deposits
             WHERE reference = $1
             FOR UPDATE`,
            [merchantReference]
        );

        const deposit = result.rows[0];

        if (!deposit) throw new Error('Deposit not found.');

        if (deposit.pesapal_tracking_id &&
            deposit.pesapal_tracking_id !== trackingId) {
            throw new Error('Pesapal tracking ID mismatch.');
        }

        if (deposit.pesapal_merchant_reference &&
            deposit.pesapal_merchant_reference !== merchantReference) {
            throw new Error('Pesapal merchant reference mismatch.');
        }

        const status = String(
            payment.payment_status_description || ''
        ).toUpperCase();

        await recordPaymentLog(
            client,
            deposit.id,
            'PESAPAL_STATUS_CHECK',
            payment,
            true
        );

        // An already credited payment must never be credited again.
        if (deposit.status === 'COMPLETED') {
            return {
                status: 'COMPLETED',
                alreadyCredited: true
            };
        }

        if (status === 'REVERSED') {
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
                'Manual reconciliation required.'
            );

            return { status: 'REVERSED' };
        }

        if (status === 'FAILED' || status === 'INVALID') {
            await client.query(
                `UPDATE deposits
                 SET status = 'FAILED',
                     provider_status = $1,
                     updated_at = NOW()
                 WHERE id = $2`,
                [status, deposit.id]
            );

            if (deposit.transaction_id) {
                await client.query(
                    `UPDATE transactions
                     SET status = 'FAILED', updated_at = NOW()
                     WHERE id = $1`,
                    [deposit.transaction_id]
                );
            }

            return { status: 'FAILED' };
        }

        if (status !== 'COMPLETED') {
            await client.query(
                `UPDATE deposits
                 SET status = 'PROCESSING',
                     provider_status = $1,
                     updated_at = NOW()
                 WHERE id = $2`,
                [status || 'PENDING', deposit.id]
            );

            return { status: 'PROCESSING' };
        }

        const paidAmount = Number(payment.amount);
        const paidCurrency = String(payment.currency || '').toUpperCase();

        if (!Number.isFinite(paidAmount) ||
            Math.abs(paidAmount - Number(deposit.kes_amount)) > 0.01 ||
            paidCurrency !== 'KES') {
            await recordPaymentLog(
                client,
                deposit.id,
                'PAYMENT_VALIDATION_FAILED',
                {
                    paidAmount,
                    expectedAmount: Number(deposit.kes_amount),
                    paidCurrency
                },
                false,
                'Amount or currency mismatch.'
            );

            throw new Error('Payment amount or currency mismatch.');
        }

        const walletResult = await client.query(
            `SELECT *
             FROM wallets
             WHERE id = $1
             FOR UPDATE`,
            [deposit.wallet_id]
        );

        const wallet = walletResult.rows[0];

        if (!wallet) throw new Error('Deposit wallet not found.');

        const before = money(wallet.balance);
        const reserved = money(wallet.reserved_balance);
        const amount = money(deposit.usd_amount);
        const after = money(before + amount);

        await client.query(
            `UPDATE wallets
             SET balance = $1, updated_at = NOW()
             WHERE id = $2`,
            [after, wallet.id]
        );

        await client.query(
            `UPDATE deposits
             SET status = 'COMPLETED',
                 provider_status = $1,
                 credited_at = NOW(),
                 updated_at = NOW()
             WHERE id = $2`,
            [status, deposit.id]
        );

        if (deposit.transaction_id) {
            await client.query(
                `UPDATE transactions
                 SET status = 'COMPLETED',
                     provider = 'PESAPAL',
                     provider_reference = $1,
                     updated_at = NOW()
                 WHERE id = $2`,
                [trackingId, deposit.transaction_id]
            );
        }

        await insertLedger(client, {
            walletId: wallet.id,
            userId: deposit.user_id,
            entryType: 'DEPOSIT',
            reference: deposit.reference,
            idempotencyKey: `DEPOSIT_${deposit.id}`,
            amount,
            balanceBefore: before,
            balanceAfter: after,
            reservedBefore: reserved,
            reservedAfter: reserved,
            description: 'Verified Pesapal M-Pesa deposit'
        });

        return {
            status: 'COMPLETED',
            balance: after
        };
    });
}

// ============================================================
// PESAPAL IPN
// ============================================================

async function handlePesapalIPN(req, res) {
    const trackingId =
        req.body?.OrderTrackingId || req.query.OrderTrackingId;

    const merchantReference =
        req.body?.OrderMerchantReference ||
        req.query.OrderMerchantReference;

    if (!trackingId || !merchantReference) {
        return res.status(400).json({
            error: 'Missing payment notification details.'
        });
    }

    try {
        await verifyAndCreditDeposit(trackingId, merchantReference);

        return res.json({
            orderNotificationType:
                req.body?.OrderNotificationType ||
                req.query.OrderNotificationType ||
                'IPNCHANGE',
            orderTrackingId: trackingId,
            orderMerchantReference: merchantReference,
            status: 200
        });
    } catch (error) {
        console.error('Pesapal IPN error:', error.message);

        return res.status(500).json({
            orderNotificationType: 'IPNCHANGE',
            orderTrackingId: trackingId,
            orderMerchantReference: merchantReference,
            status: 500
        });
    }
}

app.get('/api/payments/pesapal/ipn', handlePesapalIPN);
app.post('/api/payments/pesapal/ipn', handlePesapalIPN);

// ============================================================
// PESAPAL CALLBACK
// ============================================================

app.get(
    '/api/payments/pesapal/callback',
    asyncHandler(async (req, res) => {
        const trackingId = req.query.OrderTrackingId;
        const merchantReference = req.query.OrderMerchantReference;

        if (!trackingId || !merchantReference) {
            return res.status(400).send(
                'Payment reference information is missing.'
            );
        }

        let result;

        try {
            result = await verifyAndCreditDeposit(
                trackingId,
                merchantReference
            );
        } catch (error) {
            console.error('Pesapal callback error:', error.message);
            result = { status: 'PROCESSING' };
        }

        const frontendUrl = process.env.FRONTEND_URL;

        if (frontendUrl) {
            const redirect = new URL('/payment-result', frontendUrl);
            redirect.searchParams.set('reference', merchantReference);
            redirect.searchParams.set('status', result.status);
            return res.redirect(redirect.toString());
        }

        res.json({
            message: 'Payment callback received.',
            reference: merchantReference,
            status: result.status
        });
    })
);

// ============================================================
// CUSTOMER DEPOSIT STATUS
// ============================================================

app.get(
    '/api/cashier/status/:reference',
    customerAuth,
    asyncHandler(async (req, res) => {
        const referenceValue = req.params.reference;

        const result = await db.query(
            `SELECT *
             FROM deposits
             WHERE reference = $1 AND user_id = $2`,
            [referenceValue, req.user.id]
        );

        const deposit = result.rows[0];

        if (!deposit) {
            return res.status(404).json({
                error: 'Deposit not found.'
            });
        }

        if (deposit.pesapal_tracking_id &&
            deposit.status !== 'COMPLETED' &&
            deposit.status !== 'FAILED') {
            try {
                await verifyAndCreditDeposit(
                    deposit.pesapal_tracking_id,
                    deposit.reference
                );
            } catch (error) {
                console.error('Deposit refresh error:', error.message);
            }
        }

        const refreshed = await db.query(
            `SELECT *
             FROM deposits
             WHERE reference = $1 AND user_id = $2`,
            [referenceValue, req.user.id]
        );

        const item = refreshed.rows[0];

        res.json({
            status: item.status,
            reference: item.reference,
            deposit: {
                reference: item.reference,
                amount: money(item.usd_amount),
                amountKES: money(item.kes_amount),
                status: item.status,
                providerStatus: item.provider_status,
                createdAt: item.created_at,
                creditedAt: item.credited_at
            },
            transaction: {
                reference: item.reference,
                status: item.status
            }
        });
    })
);

// ============================================================
// CUSTOMER KYC
// ============================================================

app.post(
    '/api/account/kyc',
    customerAuth,
    asyncHandler(async (req, res) => {
        const result = await db.query(
            `UPDATE users
             SET kyc_status = 'pending_review',
                 updated_at = NOW()
             WHERE id = $1
               AND kyc_status IN ('unverified','rejected')
             RETURNING id, kyc_status`,
            [req.user.id]
        );

        if (!result.rows.length) {
            const current = await db.query(
                `SELECT kyc_status
                 FROM users WHERE id = $1`,
                [req.user.id]
            );

            return res.json({
                message: 'KYC status unchanged.',
                kycStatus: current.rows[0]?.kyc_status
            });
        }

        res.json({
            message: 'KYC submitted for review.',
            kycStatus: result.rows[0].kyc_status
        });
    })
);

// ============================================================
// CUSTOMER WITHDRAWAL
// ============================================================

app.post(
    '/api/cashier/withdraw',
    customerAuth,
    asyncHandler(async (req, res) => {
        const amount = Number(req.body.amount ?? req.body.usdAmount);

        if (!Number.isFinite(amount) ||
            amount < MIN_WITHDRAWAL ||
            amount > 100000) {
            return res.status(400).json({
                error: `Minimum withdrawal is $${MIN_WITHDRAWAL}.`
            });
        }

        const userResult = await db.query(
            `SELECT phone FROM users WHERE id = $1`,
            [req.user.id]
        );

        const phone = normalizePhone(
            req.body.phone || req.body.phoneNumber ||
            userResult.rows[0]?.phone
        );

        if (!validPhone(phone)) {
            return res.status(400).json({
                error: 'Enter a valid M-Pesa phone number.'
            });
        }

        const kesAmount = money(amount * KES_PER_USD);
        const withdrawalReference = reference('GTNWTH');

        const withdrawal = await withTransaction(async client => {
            const wallet = await getWallet(
                client,
                req.user.id,
                'LIVE'
            );

            if (!wallet) throw new Error('LIVE wallet not found.');

            const before = money(wallet.balance);
            const reservedBefore = money(wallet.reserved_balance);

            if (before < amount) {
                throw new Error('Insufficient available balance.');
            }

            const after = money(before - amount);
            const reservedAfter = money(reservedBefore + amount);

            await client.query(
                `UPDATE wallets
                 SET balance = $1,
                     reserved_balance = $2,
                     updated_at = NOW()
                 WHERE id = $3`,
                [after, reservedAfter, wallet.id]
            );

            const transaction = await insertTransaction(client, {
                userId: req.user.id,
                walletId: wallet.id,
                type: 'WITHDRAWAL',
                amount,
                status: 'PENDING',
                reference: withdrawalReference,
                provider: 'MANUAL_MPESA',
                description: 'Manual M-Pesa withdrawal request'
            });

            const inserted = await client.query(
                `INSERT INTO withdrawals (
                    user_id, wallet_id, transaction_id,
                    reference, amount, kes_amount,
                    exchange_rate, phone, status
                 )
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PENDING')
                 RETURNING *`,
                [
                    req.user.id,
                    wallet.id,
                    transaction.id,
                    withdrawalReference,
                    amount,
                    kesAmount,
                    KES_PER_USD,
                    phone
                ]
            );

            const row = inserted.rows[0];

            await insertLedger(client, {
                walletId: wallet.id,
                userId: req.user.id,
                entryType: 'WITHDRAWAL_RESERVE',
                reference: withdrawalReference,
                idempotencyKey: `WITHDRAWAL_RESERVE_${row.id}`,
                amount: -amount,
                balanceBefore: before,
                balanceAfter: after,
                reservedBefore,
                reservedAfter,
                description: 'Withdrawal funds reserved'
            });

            await client.query(
                `INSERT INTO payment_logs (
                    withdrawal_id, provider, event_type,
                    payload, processed
                 )
                 VALUES ($1,'MANUAL_MPESA','WITHDRAWAL_CREATED',$2,true)`,
                [
                    row.id,
                    JSON.stringify({
                        reference: withdrawalReference,
                        amount,
                        kesAmount,
                        phone
                    })
                ]
            );

            return {
                row,
                balance: after,
                reservedBalance: reservedAfter
            };
        });

        res.status(201).json({
            message: 'Withdrawal request submitted.',
            transaction: {
                id: withdrawal.row.id,
                reference: withdrawal.row.reference,
                amount: money(withdrawal.row.amount),
                status: withdrawal.row.status
            },
            withdrawal: {
                id: withdrawal.row.id,
                reference: withdrawal.row.reference,
                amount: money(withdrawal.row.amount),
                kesAmount: money(withdrawal.row.kes_amount),
                phone: withdrawal.row.phone,
                status: withdrawal.row.status,
                createdAt: withdrawal.row.created_at
            },
            wallet: {
                balance: withdrawal.balance,
                reservedBalance: withdrawal.reservedBalance
            }
        });
    })
);

// ============================================================
// CUSTOMER WITHDRAWAL HISTORY
// ============================================================

app.get(
    '/api/cashier/withdrawals',
    customerAuth,
    asyncHandler(async (req, res) => {
        const result = await db.query(
            `SELECT *
             FROM withdrawals
             WHERE user_id = $1
             ORDER BY created_at DESC
             LIMIT 100`,
            [req.user.id]
        );

        res.json({
            withdrawals: result.rows.map(row => ({
                ...row,
                amount: money(row.amount),
                kes_amount: money(row.kes_amount)
            }))
        });
    })
);

// ============================================================
// ADMIN LOGIN
// ============================================================

app.post('/api/admin/login', asyncHandler(async (req, res) => {
    const email = String(req.body.email || '')
        .trim().toLowerCase();

    const password = String(req.body.password || '');

    if (!email || !password) {
        return res.status(400).json({
            error: 'Email and password are required.'
        });
    }

    const result = await db.query(
        `SELECT * FROM admins WHERE email = $1`,
        [email]
    );

    const admin = result.rows[0];

    if (!admin ||
        !admin.active ||
        !(await bcrypt.compare(password, admin.password_hash))) {
        return res.status(401).json({
            error: 'Invalid administrator credentials.'
        });
    }

    res.json({
        message: 'Admin login successful.',
        token: signAdmin(admin),
        admin: {
            id: admin.id,
            email: admin.email,
            role: admin.role
        }
    });
}));

// ============================================================
// ADMIN OVERVIEW
// ============================================================

app.get(
    '/api/admin/overview',
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
                    COUNT(*) AS total,
                    COUNT(*) FILTER (
                        WHERE account_status = 'ACTIVE'
                    ) AS active,
                    COUNT(*) FILTER (
                        WHERE account_status = 'SUSPENDED'
                    ) AS suspended
                FROM users
            `),
            db.query(`
                SELECT
                    COUNT(*) AS total,
                    COALESCE(SUM(usd_amount),0) AS total_usd,
                    COUNT(*) FILTER (
                        WHERE status = 'COMPLETED'
                    ) AS completed
                FROM deposits
            `),
            db.query(`
                SELECT
                    COUNT(*) AS total,
                    COALESCE(SUM(amount),0) AS total_usd,
                    COUNT(*) FILTER (
                        WHERE status = 'PENDING'
                    ) AS pending
                FROM withdrawals
            `),
            db.query(`
                SELECT
                    COUNT(*) AS total,
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
                    COALESCE(SUM(balance),0) AS total_balance,
                    COALESCE(SUM(reserved_balance),0) AS total_reserved
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

// ============================================================
// ADMIN CUSTOMER LIST
// ============================================================

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

        const offset = Math.max(Number(req.query.offset) || 0, 0);

        const params = [];
        const conditions = [];

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
            conditions.push(`u.account_status = $${params.length}`);
        }

        let query = `
            SELECT
                u.id, u.full_name, u.email, u.phone,
                u.country, u.referral_code, u.referrals_count,
                u.kyc_status, u.account_status, u.created_at,
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

// ============================================================
// ADMIN CUSTOMER PROFILE
// ============================================================

app.get(
    '/api/admin/users/:id',
    adminAuth,
    asyncHandler(async (req, res) => {
        const [user, wallets, transactions, trades] = await Promise.all([
            db.query(
                `SELECT id, full_name, email, phone, country,
                        referral_code, referrals_count,
                        referral_earnings, kyc_status,
                        account_status, created_at, updated_at
                 FROM users WHERE id = $1`,
                [req.params.id]
            ),
            db.query(
                `SELECT * FROM wallets WHERE user_id = $1`,
                [req.params.id]
            ),
            db.query(
                `SELECT * FROM transactions
                 WHERE user_id = $1
                 ORDER BY created_at DESC LIMIT 50`,
                [req.params.id]
            ),
            db.query(
                `SELECT * FROM trades
                 WHERE user_id = $1
                 ORDER BY created_at DESC LIMIT 50`,
                [req.params.id]
            )
        ]);

        if (!user.rows.length) {
            return res.status(404).json({
                error: 'Customer not found.'
            });
        }

        res.json({
            user: user.rows[0],
            wallets: wallets.rows,
            transactions: transactions.rows,
            trades: trades.rows.map(tradeView)
        });
    })
);

// ============================================================
// ADMIN SUSPEND / REACTIVATE CUSTOMER
// ============================================================

app.post(
    '/api/admin/users/:id/suspend',
    adminAuth,
    asyncHandler(async (req, res) => {
        const result = await withTransaction(async client => {
            const user = await client.query(
                `SELECT id, account_status
                 FROM users WHERE id = $1 FOR UPDATE`,
                [req.params.id]
            );

            if (!user.rows.length) {
                throw new Error('Customer not found.');
            }

            if (user.rows[0].account_status === 'SUSPENDED') {
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
                client, req.admin.id,
                'SUSPEND_CUSTOMER', 'USER',
                req.params.id
            );

            return true;
        });

        res.json({
            message: 'Customer suspended.',
            success: result
        });
    })
);

app.post(
    '/api/admin/users/:id/activate',
    adminAuth,
    asyncHandler(async (req, res) => {
        await withTransaction(async client => {
            const result = await client.query(
                `UPDATE users
                 SET account_status = 'ACTIVE',
                     updated_at = NOW()
                 WHERE id = $1
                 RETURNING id`,
                [req.params.id]
            );

            if (!result.rows.length) {
                throw new Error('Customer not found.');
            }

            await logAdminAction(
                client, req.admin.id,
                'ACTIVATE_CUSTOMER', 'USER',
                req.params.id
            );
        });

        res.json({ message: 'Customer activated.' });
    })
);

// ============================================================
// ADMIN WALLET ADJUSTMENT
// ============================================================

app.post(
    '/api/admin/wallets/:id/adjust',
    adminAuth,
    superAdminOnly,
    asyncHandler(async (req, res) => {
        const amount = money(req.body.amount);
        const reason = String(req.body.reason || '').trim();

        if (!Number.isFinite(amount) ||
            amount === 0 ||
            Math.abs(amount) > 1000000) {
            return res.status(400).json({
                error: 'Enter a valid adjustment amount.'
            });
        }

        if (reason.length < 5) {
            return res.status(400).json({
                error: 'Provide an adjustment reason.'
            });
        }

        const result = await withTransaction(async client => {
            const walletResult = await client.query(
                `SELECT * FROM wallets
                 WHERE id = $1 FOR UPDATE`,
                [req.params.id]
            );

            const wallet = walletResult.rows[0];

            if (!wallet) throw new Error('Wallet not found.');

            const before = money(wallet.balance);
            const reserved = money(wallet.reserved_balance);
            const after = money(before + amount);

            if (after < 0) {
                throw new Error('Adjustment would make balance negative.');
            }

            const ref = reference('ADMINADJ');

            await client.query(
                `UPDATE wallets
                 SET balance = $1, updated_at = NOW()
                 WHERE id = $2`,
                [after, wallet.id]
            );

            await insertLedger(client, {
                walletId: wallet.id,
                userId: wallet.user_id,
                entryType: 'ADMIN_ADJUSTMENT',
                reference: ref,
                idempotencyKey: `ADMIN_ADJUSTMENT_${ref}`,
                amount,
                balanceBefore: before,
                balanceAfter: after,
                reservedBefore: reserved,
                reservedAfter: reserved,
                description: reason
            });

            await insertTransaction(client, {
                userId: wallet.user_id,
                walletId: wallet.id,
                type: 'ADJUSTMENT',
                amount: Math.abs(amount),
                status: 'COMPLETED',
                reference: ref,
                description: reason
            });

            await logAdminAction(
                client,
                req.admin.id,
                'WALLET_ADJUSTMENT',
                'WALLET',
                wallet.id,
                { amount, reason, before, after }
            );

            return { balance: after, reference: ref };
        });

        res.json({
            message: 'Wallet adjusted.',
            ...result
        });
    })
);

// ============================================================
// ADMIN DEPOSITS
// ============================================================

app.get(
    '/api/admin/deposits',
    adminAuth,
    asyncHandler(async (req, res) => {
        const result = await db.query(
            `SELECT d.*, u.full_name, u.email
             FROM deposits d
             JOIN users u ON u.id = d.user_id
             ORDER BY d.created_at DESC
             LIMIT 500`
        );

        res.json({
            deposits: result.rows.map(row => ({
                ...row,
                usd_amount: money(row.usd_amount),
                kes_amount: money(row.kes_amount)
            }))
        });
    })
);

// ============================================================
// ADMIN WITHDRAWALS
// ============================================================

app.get(
    '/api/admin/withdrawals',
    adminAuth,
    asyncHandler(async (req, res) => {
        const status = String(req.query.status || '').toUpperCase();

        const allowed = [
            'PENDING', 'APPROVED', 'REJECTED',
            'PROCESSING', 'PAID', 'FAILED', 'CANCELLED'
        ];

        if (status && !allowed.includes(status)) {
            return res.status(400).json({
                error: 'Invalid withdrawal status.'
            });
        }

        const params = [];
        let query = `
            SELECT w.*, u.full_name, u.email,
                   u.phone AS customer_phone
            FROM withdrawals w
            JOIN users u ON u.id = w.user_id
        `;

        if (status) {
            params.push(status);
            query += ` WHERE w.status = $1`;
        }

        query += ` ORDER BY w.created_at DESC LIMIT 500`;

        const result = await db.query(query, params);

        res.json({
            withdrawals: result.rows.map(row => ({
                ...row,
                amount: money(row.amount),
                kes_amount: money(row.kes_amount)
            }))
        });
    })
);

// ============================================================
// ADMIN APPROVE WITHDRAWAL
// ============================================================

app.post(
    '/api/admin/withdrawals/:id/approve',
    adminAuth,
    asyncHandler(async (req, res) => {
        await withTransaction(async client => {
            const result = await client.query(
                `SELECT * FROM withdrawals
                 WHERE id = $1 FOR UPDATE`,
                [req.params.id]
            );

            const withdrawal = result.rows[0];

            if (!withdrawal) throw new Error('Withdrawal not found.');

            if (withdrawal.status !== 'PENDING') {
                throw new Error('Only pending withdrawals can be approved.');
            }

            await client.query(
                `UPDATE withdrawals
                 SET status = 'APPROVED',
                     reviewed_by = $1,
                     reviewed_at = NOW(),
                     admin_note = $2,
                     updated_at = NOW()
                 WHERE id = $3`,
                [
                    req.admin.id,
                    req.body.note || 'Withdrawal approved.',
                    withdrawal.id
                ]
            );

            await client.query(
                `UPDATE transactions
                 SET status = 'PROCESSING', updated_at = NOW()
                 WHERE id = $1`,
                [withdrawal.transaction_id]
            );

            await logAdminAction(
                client,
                req.admin.id,
                'APPROVE_WITHDRAWAL',
                'WITHDRAWAL',
                withdrawal.id,
                { reference: withdrawal.reference }
            );
        });

        res.json({
            message: 'Withdrawal approved.',
            status: 'APPROVED'
        });
    })
);

// ============================================================
// ADMIN REJECT WITHDRAWAL
// ============================================================

app.post(
    '/api/admin/withdrawals/:id/reject',
    adminAuth,
    asyncHandler(async (req, res) => {
        const note = String(req.body.note || '').trim();

        if (note.length < 3) {
            return res.status(400).json({
                error: 'Provide a rejection reason.'
            });
        }

        await withTransaction(async client => {
            const result = await client.query(
                `SELECT * FROM withdrawals
                 WHERE id = $1 FOR UPDATE`,
                [req.params.id]
            );

            const withdrawal = result.rows[0];

            if (!withdrawal) throw new Error('Withdrawal not found.');

            if (!['PENDING', 'APPROVED'].includes(withdrawal.status)) {
                throw new Error('This withdrawal cannot be rejected.');
            }

            const walletResult = await client.query(
                `SELECT * FROM wallets
                 WHERE id = $1 FOR UPDATE`,
                [withdrawal.wallet_id]
            );

            const wallet = walletResult.rows[0];
            const amount = money(withdrawal.amount);
            const before = money(wallet.balance);
            const reservedBefore = money(wallet.reserved_balance);

            if (reservedBefore < amount) {
                throw new Error('Reserved balance is inconsistent.');
            }

            const after = money(before + amount);
            const reservedAfter = money(reservedBefore - amount);

            await client.query(
                `UPDATE wallets
                 SET balance = $1,
                     reserved_balance = $2,
                     updated_at = NOW()
                 WHERE id = $3`,
                [after, reservedAfter, wallet.id]
            );

            await client.query(
                `UPDATE withdrawals
                 SET status = 'REJECTED',
                     reviewed_by = $1,
                     reviewed_at = NOW(),
                     admin_note = $2,
                     updated_at = NOW()
                 WHERE id = $3`,
                [req.admin.id, note, withdrawal.id]
            );

            await client.query(
                `UPDATE transactions
                 SET status = 'REJECTED', updated_at = NOW()
                 WHERE id = $1`,
                [withdrawal.transaction_id]
            );

            await insertLedger(client, {
                walletId: wallet.id,
                userId: withdrawal.user_id,
                entryType: 'WITHDRAWAL_RELEASE',
                reference: withdrawal.reference,
                idempotencyKey: `WITHDRAWAL_RELEASE_${withdrawal.id}`,
                amount,
                balanceBefore: before,
                balanceAfter: after,
                reservedBefore,
                reservedAfter,
                description: 'Rejected withdrawal funds released'
            });

            await logAdminAction(
                client,
                req.admin.id,
                'REJECT_WITHDRAWAL',
                'WITHDRAWAL',
                withdrawal.id,
                { note }
            );
        });

        res.json({
            message: 'Withdrawal rejected. Funds returned to customer.'
        });
    })
);

// ============================================================
// ADMIN MARK WITHDRAWAL PROCESSING
// ============================================================

app.post(
    '/api/admin/withdrawals/:id/processing',
    adminAuth,
    asyncHandler(async (req, res) => {
        await withTransaction(async client => {
            const result = await client.query(
                `SELECT * FROM withdrawals
                 WHERE id = $1 FOR UPDATE`,
                [req.params.id]
            );

            const withdrawal = result.rows[0];

            if (!withdrawal) throw new Error('Withdrawal not found.');

            if (withdrawal.status !== 'APPROVED') {
                throw new Error('Only approved withdrawals can be processed.');
            }

            await client.query(
                `UPDATE withdrawals
                 SET status = 'PROCESSING',
                     admin_note = $1,
                     updated_at = NOW()
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
                {}
            );
        });

        res.json({
            message: 'Withdrawal marked as processing.',
            status: 'PROCESSING'
        });
    })
);

// ============================================================
// ADMIN CONFIRM MANUAL M-PESA PAYMENT
// ============================================================

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

        await withTransaction(async client => {
            const result = await client.query(
                `SELECT * FROM withdrawals
                 WHERE id = $1 FOR UPDATE`,
                [req.params.id]
            );

            const withdrawal = result.rows[0];

            if (!withdrawal) throw new Error('Withdrawal not found.');

            if (!['APPROVED', 'PROCESSING'].includes(withdrawal.status)) {
                throw new Error('Withdrawal is not ready to be marked paid.');
            }

            const walletResult = await client.query(
                `SELECT * FROM wallets
                 WHERE id = $1 FOR UPDATE`,
                [withdrawal.wallet_id]
            );

            const wallet = walletResult.rows[0];
            const amount = money(withdrawal.amount);
            const before = money(wallet.balance);
            const reservedBefore = money(wallet.reserved_balance);

            if (reservedBefore < amount) {
                throw new Error('Reserved balance is inconsistent.');
            }

            const reservedAfter = money(reservedBefore - amount);

            await client.query(
                `UPDATE wallets
                 SET reserved_balance = $1,
                     updated_at = NOW()
                 WHERE id = $2`,
                [reservedAfter, wallet.id]
            );

            await client.query(
                `UPDATE withdrawals
                 SET status = 'PAID',
                     paid_at = NOW(),
                     admin_note = $1,
                     updated_at = NOW()
                 WHERE id = $2`,
                [`M-Pesa reference: ${mpesaReference}`, withdrawal.id]
            );

            await client.query(
                `UPDATE transactions
                 SET status = 'COMPLETED',
                     provider = 'MANUAL_MPESA',
                     provider_reference = $1,
                     updated_at = NOW()
                 WHERE id = $2`,
                [mpesaReference, withdrawal.transaction_id]
            );

            await insertLedger(client, {
                walletId: wallet.id,
                userId: withdrawal.user_id,
                entryType: 'WITHDRAWAL_PAID',
                reference: withdrawal.reference,
                idempotencyKey: `WITHDRAWAL_PAID_${withdrawal.id}`,
                amount: -amount,
                balanceBefore: before,
                balanceAfter: before,
                reservedBefore,
                reservedAfter,
                description: `Manual M-Pesa payment ${mpesaReference}`
            });

            await client.query(
                `INSERT INTO payment_logs (
                    withdrawal_id, provider, event_type,
                    payload, processed
                 )
                 VALUES ($1,'MANUAL_MPESA','WITHDRAWAL_PAID',$2,true)`,
                [
                    withdrawal.id,
                    JSON.stringify({
                        mpesaReference,
                        adminId: req.admin.id,
                        amountKES: withdrawal.kes_amount
                    })
                ]
            );

            await logAdminAction(
                client,
                req.admin.id,
                'MARK_WITHDRAWAL_PAID',
                'WITHDRAWAL',
                withdrawal.id,
                { mpesaReference }
            );
        });

        res.json({
            message: 'Withdrawal marked as paid.',
            status: 'PAID',
            mpesaReference
        });
    })
);

// ============================================================
// ADMIN TRADES
// ============================================================

app.get(
    '/api/admin/trades',
    adminAuth,
    asyncHandler(async (req, res) => {
        const status = String(req.query.status || '').toUpperCase();

        const allowed = ['OPEN', 'WON', 'LOST', 'CANCELLED'];

        if (status && !allowed.includes(status)) {
            return res.status(400).json({
                error: 'Invalid trade status.'
            });
        }

        const params = [];
        const conditions = [];

        if (status) {
            params.push(status);
            conditions.push(`t.status = $${params.length}`);
        }

        if (req.query.userId) {
            params.push(req.query.userId);
            conditions.push(`t.user_id = $${params.length}`);
        }

        let query = `
            SELECT t.*, u.full_name, u.email
            FROM trades t
            JOIN users u ON u.id = t.user_id
        `;

        if (conditions.length) {
            query += ` WHERE ${conditions.join(' AND ')}`;
        }

        query += ` ORDER BY t.created_at DESC LIMIT 500`;

        const result = await db.query(query, params);

        res.json({
            trades: result.rows.map(tradeView)
        });
    })
);

// ============================================================
// ADMIN KYC REVIEW
// ============================================================

app.post(
    '/api/admin/users/:id/kyc',
    adminAuth,
    asyncHandler(async (req, res) => {
        const status = String(req.body.status || '').toLowerCase();

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

        await withTransaction(async client => {
            const result = await client.query(
                `UPDATE users
                 SET kyc_status = $1, updated_at = NOW()
                 WHERE id = $2
                 RETURNING id`,
                [status, req.params.id]
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
        });

        res.json({
            message: 'KYC status updated.',
            kycStatus: status
        });
    })
);

// ============================================================
// ADMIN ACTIVITY LOG
// ============================================================

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
            `SELECT l.*, a.email AS admin_email, a.role AS admin_role
             FROM admin_activity_logs l
             LEFT JOIN admins a ON a.id = l.admin_id
             ORDER BY l.created_at DESC
             LIMIT $1`,
            [limit]
        );

        res.json({ logs: result.rows });
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
// ERROR HANDLER
// ============================================================

app.use((err, req, res, next) => {
    console.error('GTN backend error:', err.message);

    if (res.headersSent) return next(err);

    const status = Number(err.status) || 500;

    res.status(status).json({
        error: status === 500
            ? 'An internal server error occurred.'
            : err.message
    });
});

// ============================================================
// START SERVER
// ============================================================

async function startServer() {
    try {
        await db.testConnection();

        server.listen(PORT, () => {
            console.log(`GTN backend running on port ${PORT}`);
            console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
            console.log('Database: PostgreSQL');
            console.log('Deposits: Pesapal M-Pesa verification');
            console.log('Withdrawals: Manual M-Pesa administration');
        });
    } catch (error) {
        console.error('GTN startup failed:', error.message);
        process.exit(1);
    }
}

async function shutdown() {
    console.log('Shutting down GTN backend...');

    clearInterval(marketTimer);
    clearInterval(settlementTimer);

    wss.close();

    server.close(async () => {
        try {
            await db.pool.end();
        } catch (error) {
            console.error('Database shutdown error:', error.message);
        }

        process.exit(0);
    });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

startServer();
