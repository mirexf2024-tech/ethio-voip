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
  );
  create table if not exists messages(
    id serial primary key,
    from_id int references users(id) on delete cascade,
    to_id int references users(id) on delete cascade,
    kind text not null default 'text',
    body text,
    media_url text,
    media_name text,
    media_size int,
    duration int,
    created_at timestamptz default now(),
    read_at timestamptz
  );
  create index if not exists messages_to_idx on messages(to_id, id);
  create index if not exists messages_from_idx on messages(from_id, id);
  create table if not exists abuse_reports(
    id bigserial primary key,
    reporter_id int not null references users(id) on delete cascade,
    target_id int not null references users(id) on delete cascade,
    message_id int references messages(id) on delete set null,
    reason text not null,
    details text,
    status text not null default 'pending' check (status in ('pending','reviewed','actioned','dismissed')),
    admin_note text,
    created_at timestamptz not null default now(),
    reviewed_at timestamptz,
    check (reporter_id <> target_id)
  );
  create index if not exists abuse_reports_status_idx on abuse_reports(status, created_at desc);
  create index if not exists abuse_reports_target_idx on abuse_reports(target_id, created_at desc);
  create table if not exists blocks(
    user_id int references users(id) on delete cascade,
    blocked_id int references users(id) on delete cascade,
    primary key (user_id, blocked_id)
  );
  alter table users add column if not exists about text;
  alter table users add column if not exists username text;
  create unique index if not exists users_username_unique on users(lower(username)) where username is not null and username <> '';
  alter table messages add column if not exists edited_at timestamptz;
  alter table messages add column if not exists reply_to int references messages(id) on delete set null;
  create table if not exists message_reactions(
    msg_id int not null references messages(id) on delete cascade,
    user_id int not null references users(id) on delete cascade,
    emoji text not null,
    primary key(msg_id,user_id)
  );
  create table if not exists pinned_messages(
    user_id int not null references users(id) on delete cascade,
    peer_id int not null references users(id) on delete cascade,
    msg_id int not null references messages(id) on delete cascade,
    created_at timestamptz default now(),
    primary key(user_id,peer_id,msg_id)
  );
`);

  const c = await pool.query('select count(*) from packages');
  if (c.rows[0].count === '0') {
    await pool.query(`insert into packages(name, coins, price_etb, period) values
      ('Daily', 30, 10, 'daily'),
      ('Weekly', 150, 50, 'weekly'),
      ('Monthly', 500, 150, 'monthly')`);
  }
}

module.exports = { pool, init };
