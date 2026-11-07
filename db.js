const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function init() {
  await pool.query(`
  create table if not exists users(
    id serial primary key,
    phone text unique not null,
    name text,
    avatar_url text,
    coins int not null default 0 check (coins >= 0),
    created_at timestamptz default now()
  );
  create table if not exists otps(
    id serial primary key,
    phone text not null,
    code_hash text not null,
    attempts int default 0,
    used boolean default false,
    expires_at timestamptz not null,
    created_at timestamptz default now()
  );
  create table if not exists packages(
    id serial primary key,
    name text,
    coins int,
    price_etb int,
    period text
  );
  create table if not exists coin_tx(
    id serial primary key,
    user_id int references users(id),
    amount int not null,
    balance_after int not null,
    reason text,
    created_at timestamptz default now()
  );`);

  const c = await pool.query('select count(*) from packages');
  if (c.rows[0].count === '0') {
    await pool.query(`insert into packages(name, coins, price_etb, period) values
      ('Daily', 30, 10, 'daily'),
      ('Weekly', 150, 50, 'weekly'),
      ('Monthly', 500, 150, 'monthly')`);
  }
}

module.exports = { pool, init };
