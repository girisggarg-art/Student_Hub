const fs = require('fs');
const path = require('path');

const USE_PG = Boolean(process.env.DATABASE_URL);
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'campuslink.db.json');

let pgPool = null;

function emptyFileDb() {
  return { users: [], sessions: [], jobs: [], bids: [], pools: [], pool_items: [] };
}

function readFileDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    writeFileDb(emptyFileDb());
    return emptyFileDb();
  }
  const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  return Object.assign(emptyFileDb(), parsed);
}

function writeFileDb(data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, DB_FILE);
}

async function initDb() {
  if (USE_PG) {
    const { Pool } = require('pg');
    pgPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false }
    });
    const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await pgPool.query(schemaSql);
    console.log('Connected to PostgreSQL and verified v3 schema.');
  } else {
    readFileDb();
    console.log('Running with local atomic file database (set DATABASE_URL for PostgreSQL).');
  }
}

async function countUsers() {
  if (USE_PG) {
    const r = await pgPool.query('SELECT COUNT(*)::int AS cnt FROM users');
    return r.rows[0].cnt;
  }
  return readFileDb().users.length;
}

async function listUsers() {
  if (USE_PG) {
    const r = await pgPool.query('SELECT * FROM users ORDER BY created_at DESC');
    return r.rows;
  }
  return [...readFileDb().users].sort((a, b) => b.created_at - a.created_at);
}

async function createUser(user) {
  if (USE_PG) {
    await pgPool.query(
      `INSERT INTO users (id, name, phone, password_hash, university, year, hostel, role, is_admin, is_banned, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [user.id, user.name, user.phone, user.password_hash, user.university, user.year, user.hostel, user.role, user.is_admin, false, user.created_at]
    );
    return user;
  }
  const db = readFileDb();
  if (db.users.some(u => u.phone === user.phone)) {
    const err = new Error('Phone number already registered');
    err.code = '23505';
    throw err;
  }
  db.users.push(user);
  writeFileDb(db);
  return user;
}

async function findUserByPhone(phone) {
  if (USE_PG) {
    const r = await pgPool.query('SELECT * FROM users WHERE phone = $1 LIMIT 1', [phone]);
    return r.rows[0] || null;
  }
  return readFileDb().users.find(u => u.phone === phone) || null;
}

async function findUserById(id) {
  if (USE_PG) {
    const r = await pgPool.query('SELECT * FROM users WHERE id = $1 LIMIT 1', [id]);
    return r.rows[0] || null;
  }
  return readFileDb().users.find(u => u.id === id) || null;
}

async function updateUserProfile(userId, fields) {
  if (USE_PG) {
    const r = await pgPool.query(
      `UPDATE users SET name=$1, university=$2, year=$3, hostel=$4, role=$5 WHERE id=$6 RETURNING *`,
      [fields.name, fields.university, fields.year, fields.hostel, fields.role, userId]
    );
    return r.rows[0] || null;
  }
  const db = readFileDb();
  const u = db.users.find(x => x.id === userId);
  if (!u) return null;
  u.name = fields.name;
  u.university = fields.university;
  u.year = fields.year;
  u.hostel = fields.hostel;
  u.role = fields.role;
  writeFileDb(db);
  return u;
}

async function setUserBan(userId, isBanned) {
  if (USE_PG) {
    const r = await pgPool.query('UPDATE users SET is_banned=$1 WHERE id=$2 RETURNING *', [Boolean(isBanned), userId]);
    if (isBanned) await pgPool.query('DELETE FROM sessions WHERE user_id=$1', [userId]);
    return r.rows[0] || null;
  }
  const db = readFileDb();
  const u = db.users.find(x => x.id === userId);
  if (!u) return null;
  u.is_banned = Boolean(isBanned);
  if (isBanned) db.sessions = db.sessions.filter(s => s.user_id !== userId);
  writeFileDb(db);
  return u;
}

async function createSession(session) {
  if (USE_PG) {
    await pgPool.query(
      'INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES ($1,$2,$3,$4)',
      [session.token, session.user_id, session.created_at, session.expires_at]
    );
    return session;
  }
  const db = readFileDb();
  db.sessions.push(session);
  writeFileDb(db);
  return session;
}

async function findSession(token) {
  const now = Date.now();
  if (USE_PG) {
    const r = await pgPool.query('SELECT * FROM sessions WHERE token=$1 AND expires_at > $2 LIMIT 1', [token, now]);
    return r.rows[0] || null;
  }
  return readFileDb().sessions.find(s => s.token === token && s.expires_at > now) || null;
}

async function deleteSession(token) {
  if (USE_PG) {
    await pgPool.query('DELETE FROM sessions WHERE token=$1', [token]);
    return;
  }
  const db = readFileDb();
  db.sessions = db.sessions.filter(s => s.token !== token);
  writeFileDb(db);
}

async function listJobsWithBids() {
  if (USE_PG) {
    const jobsRes = await pgPool.query('SELECT * FROM jobs ORDER BY created_at DESC');
    const bidsRes = await pgPool.query('SELECT * FROM bids ORDER BY price ASC, created_at ASC');
    const byJob = new Map();
    for (const b of bidsRes.rows) {
      if (!byJob.has(b.job_id)) byJob.set(b.job_id, []);
      byJob.get(b.job_id).push(b);
    }
    return jobsRes.rows.map(j => Object.assign({}, j, { bids: byJob.get(j.id) || [] }));
  }
  const db = readFileDb();
  return [...db.jobs]
    .sort((a, b) => b.created_at - a.created_at)
    .map(j => Object.assign({}, j, {
      bids: db.bids.filter(b => b.job_id === j.id).sort((a, b) => a.price - b.price || a.created_at - b.created_at)
    }));
}

async function getJobWithBids(jobId) {
  const all = await listJobsWithBids();
  return all.find(j => j.id === jobId) || null;
}

async function createJob(job) {
  if (USE_PG) {
    await pgPool.query(
      `INSERT INTO jobs (id, title, category, budget, deadline, description, poster_id, poster_name, poster_phone, poster_university, poster_year, poster_hostel, accepted_bid_id, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [job.id, job.title, job.category, job.budget, job.deadline, job.description, job.poster_id, job.poster_name, job.poster_phone, job.poster_university, job.poster_year, job.poster_hostel, null, 'open', job.created_at]
    );
    return Object.assign({}, job, { status: 'open', bids: [] });
  }
  const db = readFileDb();
  db.jobs.unshift(Object.assign({}, job, { status: 'open' }));
  writeFileDb(db);
  return Object.assign({}, job, { status: 'open', bids: [] });
}

async function upsertBid(bid) {
  if (USE_PG) {
    const existing = await pgPool.query('SELECT id FROM bids WHERE job_id=$1 AND bidder_id=$2 LIMIT 1', [bid.job_id, bid.bidder_id]);
    if (existing.rows.length > 0) {
      const bidId = existing.rows[0].id;
      const r = await pgPool.query(
        `UPDATE bids SET price=$1, eta=$2, note=$3, bidder_name=$4, bidder_university=$5, bidder_year=$6, bidder_hostel=$7
         WHERE id=$8 RETURNING *`,
        [bid.price, bid.eta, bid.note, bid.bidder_name, bid.bidder_university, bid.bidder_year, bid.bidder_hostel, bidId]
      );
      return r.rows[0];
    }
    await pgPool.query(
      `INSERT INTO bids (id, job_id, bidder_id, bidder_name, bidder_phone, bidder_university, bidder_year, bidder_hostel, price, eta, note, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [bid.id, bid.job_id, bid.bidder_id, bid.bidder_name, bid.bidder_phone, bid.bidder_university, bid.bidder_year, bid.bidder_hostel, bid.price, bid.eta, bid.note, bid.created_at]
    );
    return bid;
  }
  const db = readFileDb();
  const idx = db.bids.findIndex(b => b.job_id === bid.job_id && b.bidder_id === bid.bidder_id);
  if (idx >= 0) {
    db.bids[idx] = Object.assign(db.bids[idx], {
      price: bid.price, eta: bid.eta, note: bid.note,
      bidder_name: bid.bidder_name, bidder_university: bid.bidder_university,
      bidder_year: bid.bidder_year, bidder_hostel: bid.bidder_hostel
    });
    writeFileDb(db);
    return db.bids[idx];
  }
  db.bids.push(bid);
  writeFileDb(db);
  return bid;
}

async function acceptBid(jobId, bidId) {
  if (USE_PG) {
    await pgPool.query("UPDATE jobs SET accepted_bid_id=$1, status='matched' WHERE id=$2", [bidId, jobId]);
    return getJobWithBids(jobId);
  }
  const db = readFileDb();
  const job = db.jobs.find(j => j.id === jobId);
  if (!job) return null;
  job.accepted_bid_id = bidId;
  job.status = 'matched';
  writeFileDb(db);
  return getJobWithBids(jobId);
}

async function completeJob(jobId) {
  if (USE_PG) {
    await pgPool.query("UPDATE jobs SET status='completed' WHERE id=$1", [jobId]);
    return getJobWithBids(jobId);
  }
  const db = readFileDb();
  const job = db.jobs.find(j => j.id === jobId);
  if (!job) return null;
  job.status = 'completed';
  writeFileDb(db);
  return getJobWithBids(jobId);
}

async function deleteJob(jobId) {
  if (USE_PG) {
    const r = await pgPool.query('DELETE FROM jobs WHERE id=$1', [jobId]);
    return r.rowCount > 0;
  }
  const db = readFileDb();
  const before = db.jobs.length;
  db.jobs = db.jobs.filter(j => j.id !== jobId);
  db.bids = db.bids.filter(b => b.job_id !== jobId);
  writeFileDb(db);
  return db.jobs.length < before;
}

async function listPoolsWithItems() {
  if (USE_PG) {
    const poolsRes = await pgPool.query('SELECT * FROM pools ORDER BY created_at DESC');
    const itemsRes = await pgPool.query('SELECT * FROM pool_items ORDER BY created_at ASC');
    const byPool = new Map();
    for (const it of itemsRes.rows) {
      if (!byPool.has(it.pool_id)) byPool.set(it.pool_id, []);
      byPool.get(it.pool_id).push(it);
    }
    return poolsRes.rows.map(p => Object.assign({}, p, { items: byPool.get(p.id) || [] }));
  }
  const db = readFileDb();
  return [...db.pools]
    .sort((a, b) => b.created_at - a.created_at)
    .map(p => Object.assign({}, p, {
      items: db.pool_items.filter(i => i.pool_id === p.id).sort((a, b) => a.created_at - b.created_at)
    }));
}

async function getPoolWithItems(poolId) {
  const all = await listPoolsWithItems();
  return all.find(p => p.id === poolId) || null;
}

async function createPool(pool, firstItem) {
  if (USE_PG) {
    await pgPool.query(
      `INSERT INTO pools (id, university, platform, hostel, target, closes, status, starter_id, starter_name, starter_year, starter_phone, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [pool.id, pool.university, pool.platform, pool.hostel, pool.target, pool.closes, 'open', pool.starter_id, pool.starter_name, pool.starter_year, pool.starter_phone, pool.created_at]
    );
    await pgPool.query(
      `INSERT INTO pool_items (id, pool_id, student_id, student_name, student_phone, student_year, item_name, price, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [firstItem.id, pool.id, firstItem.student_id, firstItem.student_name, firstItem.student_phone, firstItem.student_year, firstItem.item_name, firstItem.price, firstItem.created_at]
    );
    return getPoolWithItems(pool.id);
  }
  const db = readFileDb();
  db.pools.unshift(pool);
  db.pool_items.push(firstItem);
  writeFileDb(db);
  return getPoolWithItems(pool.id);
}

async function addPoolItem(item) {
  if (USE_PG) {
    await pgPool.query(
      `INSERT INTO pool_items (id, pool_id, student_id, student_name, student_phone, student_year, item_name, price, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [item.id, item.pool_id, item.student_id, item.student_name, item.student_phone, item.student_year, item.item_name, item.price, item.created_at]
    );
    return item;
  }
  const db = readFileDb();
  db.pool_items.push(item);
  writeFileDb(db);
  return item;
}

async function deletePoolItem(poolId, itemId) {
  if (USE_PG) {
    const r = await pgPool.query('DELETE FROM pool_items WHERE pool_id=$1 AND id=$2', [poolId, itemId]);
    return r.rowCount > 0;
  }
  const db = readFileDb();
  const before = db.pool_items.length;
  db.pool_items = db.pool_items.filter(i => !(i.pool_id === poolId && i.id === itemId));
  writeFileDb(db);
  return db.pool_items.length < before;
}

async function updatePoolStatus(poolId, status) {
  if (USE_PG) {
    await pgPool.query('UPDATE pools SET status=$1 WHERE id=$2', [status, poolId]);
    return getPoolWithItems(poolId);
  }
  const db = readFileDb();
  const pool = db.pools.find(p => p.id === poolId);
  if (!pool) return null;
  pool.status = status;
  writeFileDb(db);
  return getPoolWithItems(poolId);
}

async function deletePool(poolId) {
  if (USE_PG) {
    const r = await pgPool.query('DELETE FROM pools WHERE id=$1', [poolId]);
    return r.rowCount > 0;
  }
  const db = readFileDb();
  const before = db.pools.length;
  db.pools = db.pools.filter(p => p.id !== poolId);
  db.pool_items = db.pool_items.filter(i => i.pool_id !== poolId);
  writeFileDb(db);
  return db.pools.length < before;
}

module.exports = {
  initDb,
  countUsers,
  listUsers,
  createUser,
  findUserByPhone,
  findUserById,
  updateUserProfile,
  setUserBan,
  createSession,
  findSession,
  deleteSession,
  listJobsWithBids,
  getJobWithBids,
  createJob,
  upsertBid,
  acceptBid,
  completeJob,
  deleteJob,
  listPoolsWithItems,
  getPoolWithItems,
  createPool,
  addPoolItem,
  deletePoolItem,
  updatePoolStatus,
  deletePool
};
