const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PHONE = (process.env.ADMIN_PHONE || '').trim();
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password, storedHash) {
  const [salt, keyHex] = String(storedHash || '').split(':');
  if (!salt || !keyHex) return false;
  const derived = crypto.scryptSync(password, salt, 64);
  const storedBuf = Buffer.from(keyHex, 'hex');
  if (derived.length !== storedBuf.length) return false;
  return crypto.timingSafeEqual(derived, storedBuf);
}

function makeId(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

function sanitizeUser(u) {
  return {
    id: u.id,
    name: u.name,
    phone: u.phone,
    university: u.university,
    year: u.year,
    hostel: u.hostel,
    role: u.role || 'both',
    isAdmin: Boolean(u.is_admin || (ADMIN_PHONE && u.phone === ADMIN_PHONE)),
    isBanned: Boolean(u.is_banned),
    createdAt: Number(u.created_at) || 0
  };
}

function sanitizeJobForViewer(job, viewer) {
  const viewerId = viewer ? viewer.id : null;
  const isAdmin = Boolean(viewer && (viewer.is_admin || (ADMIN_PHONE && viewer.phone === ADMIN_PHONE)));
  const isPoster = Boolean(viewerId && viewerId === job.poster_id);
  const acceptedBid = (job.bids || []).find(b => b.id === job.accepted_bid_id) || null;
  const isWinner = Boolean(viewerId && acceptedBid && viewerId === acceptedBid.bidder_id);

  let visibleBids = [];
  if (isPoster || isAdmin) {
    visibleBids = (job.bids || []).map(b => ({
      id: b.id,
      bidderId: b.bidder_id,
      bidderName: b.bidder_name,
      bidderUniversity: b.bidder_university,
      bidderYear: b.bidder_year,
      bidderHostel: b.bidder_hostel,
      price: b.price,
      eta: b.eta,
      note: b.note,
      createdAt: Number(b.created_at) || 0
    }));
  } else if (viewerId) {
    visibleBids = (job.bids || [])
      .filter(b => b.bidder_id === viewerId)
      .map(b => ({
        id: b.id,
        bidderId: b.bidder_id,
        bidderName: b.bidder_name,
        bidderUniversity: b.bidder_university,
        bidderYear: b.bidder_year,
        bidderHostel: b.bidder_hostel,
        price: b.price,
        eta: b.eta,
        note: b.note,
        createdAt: Number(b.created_at) || 0
      }));
  }

  let matchedContact = null;
  if (acceptedBid && (isPoster || isWinner)) {
    matchedContact = isPoster
      ? {
          role: 'Freelancer',
          name: acceptedBid.bidder_name,
          phone: acceptedBid.bidder_phone,
          university: acceptedBid.bidder_university,
          year: acceptedBid.bidder_year,
          hostel: acceptedBid.bidder_hostel,
          agreedPrice: acceptedBid.price
        }
      : {
          role: 'Client',
          name: job.poster_name,
          phone: job.poster_phone,
          university: job.poster_university,
          year: job.poster_year,
          hostel: job.poster_hostel,
          agreedPrice: acceptedBid.price
        };
  }

  return {
    id: job.id,
    title: job.title,
    category: job.category,
    budget: job.budget,
    deadline: job.deadline,
    description: job.description,
    posterId: job.poster_id,
    posterName: job.poster_name,
    posterUniversity: job.poster_university,
    posterYear: job.poster_year,
    posterHostel: job.poster_hostel,
    status: job.status || (job.accepted_bid_id ? 'matched' : 'open'),
    createdAt: Number(job.created_at) || 0,
    acceptedBidId: job.accepted_bid_id || null,
    bidCount: (job.bids || []).length,
    isPoster,
    isWinner,
    bids: visibleBids,
    matchedContact
  };
}

function sanitizePoolForViewer(pool, viewer) {
  const viewerId = viewer ? viewer.id : null;
  const isAdmin = Boolean(viewer && (viewer.is_admin || (ADMIN_PHONE && viewer.phone === ADMIN_PHONE)));
  const isStarter = Boolean(viewerId && viewerId === pool.starter_id);
  const isParticipant = isStarter || isAdmin || Boolean(viewerId && (pool.items || []).some(i => i.student_id === viewerId));

  return {
    id: pool.id,
    university: pool.university,
    platform: pool.platform,
    hostel: pool.hostel,
    target: pool.target,
    closes: pool.closes,
    status: pool.status,
    starterId: pool.starter_id,
    starterName: pool.starter_name,
    starterYear: pool.starter_year,
    starterPhone: isParticipant ? pool.starter_phone : null,
    isStarter,
    isParticipant,
    createdAt: Number(pool.created_at) || 0,
    items: (pool.items || []).map(i => ({
      id: i.id,
      studentId: i.student_id,
      studentName: i.student_name,
      studentYear: i.student_year,
      itemName: i.item_name,
      price: i.price
    }))
  };
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 1e6) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(new Error('Invalid JSON')); }
    });
  });
}

async function getAuth(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;
  const session = await db.findSession(token);
  if (!session) return null;
  const user = await db.findUserById(session.user_id);
  if (!user || user.is_banned) return null;
  return { user, token };
}

function isUserAdmin(user) {
  return Boolean(user && (user.is_admin || (ADMIN_PHONE && user.phone === ADMIN_PHONE)));
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = urlObj.pathname;
  const method = req.method;

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    return res.end();
  }

  try {
    if (pathname === '/api/health' && method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        version: '3.0.0',
        mode: process.env.DATABASE_URL ? 'postgresql' : 'local-file',
        timestamp: Date.now()
      });
    }

    // AUTH: Register (First registered user or ADMIN_PHONE automatically becomes Admin)
    if (pathname === '/api/auth/register' && method === 'POST') {
      const body = await parseBody(req);
      const name = String(body.name || '').trim();
      const phone = String(body.phone || '').trim();
      const password = String(body.password || '');
      const university = String(body.university || '').trim();
      const year = String(body.year || '').trim();
      const hostel = String(body.hostel || '').trim();
      const role = ['client', 'freelancer', 'both'].includes(body.role) ? body.role : 'both';

      if (!name || !/^[0-9]{10}$/.test(phone) || password.length < 6 || !university || !year || !hostel) {
        return sendJson(res, 400, { error: 'Name, 10-digit phone, 6+ char password, university, year, and location are required.' });
      }
      const existing = await db.findUserByPhone(phone);
      if (existing) {
        return sendJson(res, 409, { error: 'This phone number is already registered. Please sign in instead.' });
      }

      const existingCount = await db.countUsers();
      const makeAdmin = Boolean((ADMIN_PHONE && phone === ADMIN_PHONE) || (!ADMIN_PHONE && existingCount === 0));

      const user = await db.createUser({
        id: makeId('usr'),
        name,
        phone,
        password_hash: hashPassword(password),
        university,
        year,
        hostel,
        role,
        is_admin: makeAdmin,
        is_banned: false,
        created_at: Date.now()
      });

      const token = crypto.randomBytes(32).toString('hex');
      await db.createSession({ token, user_id: user.id, created_at: Date.now(), expires_at: Date.now() + SESSION_TTL_MS });
      return sendJson(res, 201, { token, user: sanitizeUser(user) });
    }

    // AUTH: Login
    if (pathname === '/api/auth/login' && method === 'POST') {
      const body = await parseBody(req);
      const phone = String(body.phone || '').trim();
      const password = String(body.password || '');
      if (!/^[0-9]{10}$/.test(phone) || !password) {
        return sendJson(res, 400, { error: 'Enter your 10-digit phone number and password.' });
      }
      const user = await db.findUserByPhone(phone);
      if (!user || !verifyPassword(password, user.password_hash)) {
        return sendJson(res, 401, { error: 'Invalid phone number or password.' });
      }
      if (user.is_banned) {
        return sendJson(res, 403, { error: 'This account has been suspended by the campus admin.' });
      }
      const token = crypto.randomBytes(32).toString('hex');
      await db.createSession({ token, user_id: user.id, created_at: Date.now(), expires_at: Date.now() + SESSION_TTL_MS });
      return sendJson(res, 200, { token, user: sanitizeUser(user) });
    }

    // AUTH: Me
    if (pathname === '/api/auth/me' && method === 'GET') {
      const auth = await getAuth(req);
      if (!auth) return sendJson(res, 401, { error: 'Not authenticated' });
      return sendJson(res, 200, { user: sanitizeUser(auth.user) });
    }

    // AUTH: Update Profile
    if (pathname === '/api/auth/profile' && method === 'PATCH') {
      const auth = await getAuth(req);
      if (!auth) return sendJson(res, 401, { error: 'Sign in required' });
      const body = await parseBody(req);
      const updated = await db.updateUserProfile(auth.user.id, {
        name: String(body.name || auth.user.name).trim(),
        university: String(body.university || auth.user.university).trim(),
        year: String(body.year || auth.user.year).trim(),
        hostel: String(body.hostel || auth.user.hostel).trim(),
        role: ['client', 'freelancer', 'both'].includes(body.role) ? body.role : (auth.user.role || 'both')
      });
      return sendJson(res, 200, { user: sanitizeUser(updated) });
    }

    // AUTH: Logout
    if (pathname === '/api/auth/logout' && method === 'POST') {
      const auth = await getAuth(req);
      if (auth) await db.deleteSession(auth.token);
      return sendJson(res, 200, { ok: true });
    }

    // PUBLIC/USER STATE
    if (pathname === '/api/state' && method === 'GET') {
      const auth = await getAuth(req);
      const viewer = auth ? auth.user : null;
      const [jobs, pools] = await Promise.all([db.listJobsWithBids(), db.listPoolsWithItems()]);
      return sendJson(res, 200, {
        jobs: jobs.map(j => sanitizeJobForViewer(j, viewer)),
        pools: pools.map(p => sanitizePoolForViewer(p, viewer))
      });
    }

    // ADMIN: Overview (Users + All Jobs/Bids + All Pools)
    if (pathname === '/api/admin/overview' && method === 'GET') {
      const auth = await getAuth(req);
      if (!auth || !isUserAdmin(auth.user)) return sendJson(res, 403, { error: 'Admin access required.' });
      const [users, jobs, pools] = await Promise.all([db.listUsers(), db.listJobsWithBids(), db.listPoolsWithItems()]);
      return sendJson(res, 200, {
        stats: {
          totalUsers: users.length,
          bannedUsers: users.filter(u => u.is_banned).length,
          totalJobs: jobs.length,
          openJobs: jobs.filter(j => !j.accepted_bid_id).length,
          totalBids: jobs.reduce((s, j) => s + (j.bids || []).length, 0),
          totalPools: pools.length,
          openPools: pools.filter(p => p.status !== 'ordered').length
        },
        users: users.map(sanitizeUser),
        jobs: jobs.map(j => sanitizeJobForViewer(j, auth.user)),
        pools: pools.map(p => sanitizePoolForViewer(p, auth.user))
      });
    }

    // ADMIN: Ban / Unban User
    const banMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)\/ban$/);
    if (banMatch && method === 'PATCH') {
      const auth = await getAuth(req);
      if (!auth || !isUserAdmin(auth.user)) return sendJson(res, 403, { error: 'Admin access required.' });
      const targetId = decodeURIComponent(banMatch[1]);
      if (targetId === auth.user.id) return sendJson(res, 400, { error: 'You cannot suspend your own admin account.' });
      const body = await parseBody(req);
      const updated = await db.setUserBan(targetId, Boolean(body.isBanned));
      if (!updated) return sendJson(res, 404, { error: 'User not found.' });
      return sendJson(res, 200, { user: sanitizeUser(updated) });
    }

    // CLIENT: Post Job
    if (pathname === '/api/jobs' && method === 'POST') {
      const auth = await getAuth(req);
      if (!auth) return sendJson(res, 401, { error: 'Please sign in to post a job.' });
      const body = await parseBody(req);
      const title = String(body.title || '').trim();
      const category = String(body.category || 'PPT & Docs').trim();
      const budget = Math.round(Number(body.budget));
      const deadline = String(body.deadline || '').trim();
      const description = String(body.description || '').trim();
      const university = String(body.university || auth.user.university).trim();
      const year = String(body.year || auth.user.year).trim();
      const location = String(body.location || auth.user.hostel).trim();

      if (!title || !description || !deadline || !university || !Number.isFinite(budget) || budget < 10) {
        return sendJson(res, 400, { error: 'All job fields and a valid budget (₹10+) are required.' });
      }
      const job = await db.createJob({
        id: makeId('job'),
        title, category, budget, deadline, description,
        poster_id: auth.user.id,
        poster_name: auth.user.name,
        poster_phone: auth.user.phone,
        poster_university: university,
        poster_year: year,
        poster_hostel: location,
        accepted_bid_id: null,
        status: 'open',
        created_at: Date.now()
      });
      return sendJson(res, 201, sanitizeJobForViewer(job, auth.user));
    }

    // FREELANCER: Place or Update Bid
    const bidMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/bids$/);
    if (bidMatch && method === 'POST') {
      const auth = await getAuth(req);
      if (!auth) return sendJson(res, 401, { error: 'Please sign in to place a bid.' });
      const jobId = decodeURIComponent(bidMatch[1]);
      const job = await db.getJobWithBids(jobId);
      if (!job) return sendJson(res, 404, { error: 'Job not found.' });
      if (job.poster_id === auth.user.id) return sendJson(res, 403, { error: 'You cannot bid on your own job.' });
      if (job.accepted_bid_id) return sendJson(res, 409, { error: 'This job has already accepted a bid.' });

      const body = await parseBody(req);
      const price = Math.round(Number(body.price));
      const eta = String(body.eta || '').trim();
      const note = String(body.note || '').trim();
      if (!Number.isFinite(price) || price < 10 || !eta || !note) {
        return sendJson(res, 400, { error: 'Valid rate (₹10+), delivery time, and pitch note are required.' });
      }
      await db.upsertBid({
        id: makeId('bid'),
        job_id: job.id,
        bidder_id: auth.user.id,
        bidder_name: auth.user.name,
        bidder_phone: auth.user.phone,
        bidder_university: auth.user.university,
        bidder_year: auth.user.year,
        bidder_hostel: auth.user.hostel,
        price, eta, note,
        created_at: Date.now()
      });
      const updated = await db.getJobWithBids(job.id);
      return sendJson(res, 201, sanitizeJobForViewer(updated, auth.user));
    }

    // CLIENT: Accept Bid
    const acceptMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/accept$/);
    if (acceptMatch && method === 'POST') {
      const auth = await getAuth(req);
      if (!auth) return sendJson(res, 401, { error: 'Sign in required.' });
      const jobId = decodeURIComponent(acceptMatch[1]);
      const job = await db.getJobWithBids(jobId);
      if (!job) return sendJson(res, 404, { error: 'Job not found.' });
      if (job.poster_id !== auth.user.id) return sendJson(res, 403, { error: 'Only the job poster can accept a bid.' });
      if (job.accepted_bid_id) return sendJson(res, 409, { error: 'A bid has already been accepted.' });
      const body = await parseBody(req);
      const bid = (job.bids || []).find(b => b.id === body.bidId);
      if (!bid) return sendJson(res, 404, { error: 'Bid not found.' });
      const updated = await db.acceptBid(job.id, bid.id);
      return sendJson(res, 200, sanitizeJobForViewer(updated, auth.user));
    }

    // CLIENT: Mark Job Completed
    const completeMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/complete$/);
    if (completeMatch && method === 'POST') {
      const auth = await getAuth(req);
      if (!auth) return sendJson(res, 401, { error: 'Sign in required.' });
      const jobId = decodeURIComponent(completeMatch[1]);
      const job = await db.getJobWithBids(jobId);
      if (!job) return sendJson(res, 404, { error: 'Job not found.' });
      if (job.poster_id !== auth.user.id && !isUserAdmin(auth.user)) {
        return sendJson(res, 403, { error: 'Only the job poster or admin can mark completed.' });
      }
      const updated = await db.completeJob(job.id);
      return sendJson(res, 200, sanitizeJobForViewer(updated, auth.user));
    }

    // CLIENT OR ADMIN: Delete Job
    const jobDelMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
    if (jobDelMatch && method === 'DELETE') {
      const auth = await getAuth(req);
      if (!auth) return sendJson(res, 401, { error: 'Sign in required.' });
      const jobId = decodeURIComponent(jobDelMatch[1]);
      const job = await db.getJobWithBids(jobId);
      if (!job) return sendJson(res, 404, { error: 'Job not found.' });
      if (job.poster_id !== auth.user.id && !isUserAdmin(auth.user)) {
        return sendJson(res, 403, { error: 'Only the job poster or admin can delete this job.' });
      }
      await db.deleteJob(job.id);
      return sendJson(res, 200, { deleted: true });
    }

    // USER: Create Pool
    if (pathname === '/api/pools' && method === 'POST') {
      const auth = await getAuth(req);
      if (!auth) return sendJson(res, 401, { error: 'Please sign in to start a delivery pool.' });
      const body = await parseBody(req);
      const university = String(body.university || auth.user.university).trim();
      const platform = String(body.platform || '').trim();
      const hostel = String(body.hostel || auth.user.hostel).trim();
      const target = Math.round(Number(body.target));
      const closes = String(body.closes || '').trim();
      const firstItem = String(body.firstItem || '').trim();
      const firstPrice = Math.round(Number(body.firstPrice));
      if (!university || !platform || !hostel || !closes || !firstItem || !Number.isFinite(target) || target < 50 || !Number.isFinite(firstPrice) || firstPrice < 5) {
        return sendJson(res, 400, { error: 'All pool fields, target (₹50+), and first item (₹5+) are required.' });
      }
      const poolId = makeId('pool');
      const now = Date.now();
      const pool = await db.createPool(
        {
          id: poolId, university, platform, hostel, target, closes, status: 'open',
          starter_id: auth.user.id, starter_name: auth.user.name, starter_year: auth.user.year, starter_phone: auth.user.phone,
          created_at: now
        },
        {
          id: makeId('item'), pool_id: poolId,
          student_id: auth.user.id, student_name: auth.user.name, student_phone: auth.user.phone, student_year: auth.user.year,
          item_name: firstItem, price: firstPrice, created_at: now
        }
      );
      return sendJson(res, 201, sanitizePoolForViewer(pool, auth.user));
    }

    // USER: Add Pool Item
    const poolItemMatch = pathname.match(/^\/api\/pools\/([^/]+)\/items$/);
    if (poolItemMatch && method === 'POST') {
      const auth = await getAuth(req);
      if (!auth) return sendJson(res, 401, { error: 'Please sign in to join a delivery pool.' });
      const poolId = decodeURIComponent(poolItemMatch[1]);
      const pool = await db.getPoolWithItems(poolId);
      if (!pool) return sendJson(res, 404, { error: 'Pool not found.' });
      if (pool.status === 'ordered') return sendJson(res, 409, { error: 'This pool has already been ordered.' });
      const body = await parseBody(req);
      const itemName = String(body.itemName || '').trim();
      const price = Math.round(Number(body.price));
      if (!itemName || !Number.isFinite(price) || price < 5) {
        return sendJson(res, 400, { error: 'Item name and valid price (₹5+) are required.' });
      }
      await db.addPoolItem({
        id: makeId('item'), pool_id: pool.id,
        student_id: auth.user.id, student_name: auth.user.name, student_phone: auth.user.phone, student_year: auth.user.year,
        item_name: itemName, price, created_at: Date.now()
      });
      const updated = await db.getPoolWithItems(pool.id);
      return sendJson(res, 201, sanitizePoolForViewer(updated, auth.user));
    }

    // USER / STARTER / ADMIN: Remove Pool Item
    const poolItemDelMatch = pathname.match(/^\/api\/pools\/([^/]+)\/items\/([^/]+)$/);
    if (poolItemDelMatch && method === 'DELETE') {
      const auth = await getAuth(req);
      if (!auth) return sendJson(res, 401, { error: 'Sign in required.' });
      const poolId = decodeURIComponent(poolItemDelMatch[1]);
      const itemId = decodeURIComponent(poolItemDelMatch[2]);
      const pool = await db.getPoolWithItems(poolId);
      if (!pool) return sendJson(res, 404, { error: 'Pool not found.' });
      const item = (pool.items || []).find(i => i.id === itemId);
      if (!item) return sendJson(res, 404, { error: 'Item not found.' });
      if (item.student_id !== auth.user.id && pool.starter_id !== auth.user.id && !isUserAdmin(auth.user)) {
        return sendJson(res, 403, { error: 'Not allowed to remove this item.' });
      }
      await db.deletePoolItem(pool.id, item.id);
      const updated = await db.getPoolWithItems(pool.id);
      return sendJson(res, 200, sanitizePoolForViewer(updated, auth.user));
    }

    // STARTER OR ADMIN: Update Pool Status
    const poolStatusMatch = pathname.match(/^\/api\/pools\/([^/]+)\/status$/);
    if (poolStatusMatch && method === 'PATCH') {
      const auth = await getAuth(req);
      if (!auth) return sendJson(res, 401, { error: 'Sign in required.' });
      const poolId = decodeURIComponent(poolStatusMatch[1]);
      const pool = await db.getPoolWithItems(poolId);
      if (!pool) return sendJson(res, 404, { error: 'Pool not found.' });
      if (pool.starter_id !== auth.user.id && !isUserAdmin(auth.user)) {
        return sendJson(res, 403, { error: 'Only the pool starter or admin can update status.' });
      }
      const body = await parseBody(req);
      const updated = await db.updatePoolStatus(pool.id, body.status === 'ordered' ? 'ordered' : 'open');
      return sendJson(res, 200, sanitizePoolForViewer(updated, auth.user));
    }

    // STARTER OR ADMIN: Delete Pool
    const poolDelMatch = pathname.match(/^\/api\/pools\/([^/]+)$/);
    if (poolDelMatch && method === 'DELETE') {
      const auth = await getAuth(req);
      if (!auth) return sendJson(res, 401, { error: 'Sign in required.' });
      const poolId = decodeURIComponent(poolDelMatch[1]);
      const pool = await db.getPoolWithItems(poolId);
      if (!pool) return sendJson(res, 404, { error: 'Pool not found.' });
      if (pool.starter_id !== auth.user.id && !isUserAdmin(auth.user)) {
        return sendJson(res, 403, { error: 'Only the pool starter or admin can delete this pool.' });
      }
      await db.deletePool(pool.id);
      return sendJson(res, 200, { deleted: true });
    }

    // SERVE FRONTEND FROM ROOT (index.html — zero subfolder upload issues!)
    if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      const rootHtml = path.join(__dirname, 'index.html');
      const publicHtml = path.join(__dirname, 'public', 'index.html');
      const target = fs.existsSync(rootHtml) ? rootHtml : publicHtml;
      if (fs.existsSync(target)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return fs.createReadStream(target).pipe(res);
      }
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    sendJson(res, 500, { error: err.message || 'Internal server error' });
  }
});

async function start() {
  await db.initDb();
  server.listen(PORT, () => {
    console.log(`CampusLink v3 running on http://localhost:${PORT}`);
  });
}

if (require.main === module) {
  start().catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}

module.exports = { server, initDb: db.initDb };
