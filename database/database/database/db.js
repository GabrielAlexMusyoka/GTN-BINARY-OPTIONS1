const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

pool.on('error', (error) => {
    console.error('Unexpected PostgreSQL error:', error);
});

async function query(text, params) {
    return pool.query(text, params);
}

async function testConnection() {
    try {
        const result = await pool.query('SELECT NOW()');
        console.log('GTN PostgreSQL connected:', result.rows[0]);
    } catch (error) {
        console.error('PostgreSQL connection failed:', error.message);
        throw error;
    }
}

module.exports = {
    pool,
    query,
    testConnection
};
