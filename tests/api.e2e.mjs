// End-to-end API test. Requires the app running (npm start / npm run dev) and a freshly seeded DB:
//   npm run db:setup -- --force && npm run dev     then     npm test
import pg from 'pg';
import { MongoClient } from 'mongodb';
import fs from 'fs';

for (const line of fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8').split(/\r?\n/) : []) {
  const m = line.match(/^\s*([A-Za-z_]\w*)\s*=\s*(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
const mongo = new MongoClient(process.env.MONGODB_URI);
await mongo.connect();
const col = mongo.db().collection('complaint_documents');

let passed = 0, failed = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { passed++; console.log('  ✔', name); } else { failed++; console.log('  ✖ FAIL:', name, extra); }
};

class Client {
  constructor() { this.cookie = ''; }
  async req(method, path, body) {
    const res = await fetch(BASE + path, {
      method, redirect: 'manual',
      headers: { 'Content-Type': 'application/json', ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = res.headers.getSetCookie?.() || [];
    for (const c of sc) { const kv = c.split(';')[0]; if (kv.endsWith('=')) this.cookie = ''; else this.cookie = kv; }
    let data = null; try { data = await res.json(); } catch {}
    return { status: res.status, data };
  }
  async login(email, extra = {}) { return this.req('POST', '/api/auth/login', { email, password: 'password123', ...extra }); }
}
const as = async (email) => { const c = new Client(); const r = await c.login(email); if (r.status !== 200) throw new Error('login failed ' + email); return c; };

console.log('\n[Auth & session security]');
{
  const c = new Client();
  ok((await c.req('POST', '/api/auth/login', { email: 'admin.campusfix@pes.edu' })).status === 400, 'login without password is rejected');
  ok((await c.req('POST', '/api/auth/login', { email: 'admin.campusfix@pes.edu', password: 'wrong' })).status === 401, 'wrong password rejected');
  ok((await c.req('POST', '/api/auth/login', { email: 'aarav.sharma@pes.edu', password: 'forDBMSsem5#' })).status === 401, 'old hardcoded bypass password no longer works');
  const mism = new Client();
  const r = await mism.login('aarav.sharma@pes.edu', { expected_role: 'ADMIN' });
  ok(r.status === 403 && !mism.cookie, 'role mismatch refused BEFORE a session is created');
  const forged = new Client();
  forged.cookie = 'campusfix_session=' + encodeURIComponent(JSON.stringify({ user_id: 8, full_name: 'x', email: 'x', role_id: 3, role_name: 'ADMIN' }));
  ok((await forged.req('GET', '/api/analytics')).status === 401, 'forged unsigned ADMIN cookie rejected');
  const good = await as('aarav.sharma@pes.edu');
  const [p, s] = decodeURIComponent(good.cookie.split('=')[1]).split('.');
  const evil = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url')), role_name: 'ADMIN' })).toString('base64url');
  const t = new Client(); t.cookie = `campusfix_session=${evil}.${s}`;
  ok((await t.req('GET', '/api/analytics')).status === 401, 'tampered signed cookie rejected');
  const reg = new Client();
  const rr = await reg.req('POST', '/api/auth/register', { full_name: 'Test Person', email: `t${Date.now()}@pes.edu`, role_id: 3, password: 'longenough1' });
  ok(rr.status === 200 && rr.data.user.role_name === 'REPORTER', 'self-registration with role_id=3 still yields REPORTER');
  ok((await reg.req('POST', '/api/auth/register', { full_name: 'A', email: 'a@pes.edu', password: 'short' })).status === 400, 'short password rejected');
  const hash = (await pool.query(`SELECT password_hash FROM users WHERE email='aarav.sharma@pes.edu'`)).rows[0].password_hash;
  ok(hash.startsWith('$2'), 'seeded passwords are bcrypt hashes');
}

console.log('\n[Complaint creation: transaction + procedure + vector + mongo]');
const aarav = await as('aarav.sharma@pes.edu');
const sneha = await as('sneha.rao@pes.edu');
const swami = await as('swaminathan.k@pes.edu');
const admin = await as('admin.campusfix@pes.edu');
const ramesh = await as('ramesh.electrician@pes.edu');
const suresh = await as('suresh.plumber@pes.edu');
let cid;
{
  ok((await new Client().req('POST', '/api/complaints', {})).status === 401, 'anonymous cannot create');
  ok((await aarav.req('POST', '/api/complaints', { category_id: 4, title: 'x', description: 'y', location_text: 'z', priority: 'SUPER' })).status === 400, 'invalid priority -> 400');
  ok((await aarav.req('POST', '/api/complaints', { category_id: 9999, title: 'x', description: 'y', location_text: 'z', priority: 'LOW' })).status === 400, 'unknown category -> 400 (FK)');
  const before = (await pool.query('SELECT COUNT(*)::int n FROM complaints')).rows[0].n;
  const r = await aarav.req('POST', '/api/complaints', { category_id: 4, title: 'Tap leaking in hostel washroom', description: 'Water dripping from the tap continuously', location_text: 'Hostel Block C washroom', priority: 'LOW' });
  ok(r.status === 200 && r.data.complaint_id, 'valid complaint created', JSON.stringify(r));
  cid = r.data.complaint_id;
  const hist = (await pool.query('SELECT * FROM status_history WHERE complaint_id=$1', [cid])).rows;
  ok(hist.length === 1 && hist[0].new_status === 'SUBMITTED', 'exactly one initial history row');
  ok((await pool.query('SELECT 1 FROM complaint_embeddings WHERE complaint_id=$1', [cid])).rowCount === 1, 'embedding stored');
  const model = (await pool.query('SELECT model_name FROM complaint_embeddings WHERE complaint_id=$1', [cid])).rows[0].model_name;
  ok(model === 'campusfix-keyword-hash-384', 'embedding model labelled honestly', model);
  ok((await pool.query(`SELECT 1 FROM notifications WHERE complaint_id=$1 AND user_id=(SELECT user_id FROM users WHERE email='admin.campusfix@pes.edu')`, [cid])).rowCount === 1, 'admin notified');
  const doc = await col.findOne({ complaint_id: cid });
  ok(doc && doc.metadata.upvote_count === 1 && doc.metadata.status === 'SUBMITTED', 'mongo document mirrored');
  ok(before + 1 === (await pool.query('SELECT COUNT(*)::int n FROM complaints')).rows[0].n, 'exactly one row added');
}

console.log('\n[Vector duplicate detection]');
{
  const r = await sneha.req('POST', '/api/complaints/check-duplicate', { title: 'Water tap leaking in washroom', description: 'tap dripping water', location_text: 'Hostel C' });
  ok(r.data.duplicates?.some((d) => d.complaint_id === cid), 'similar active complaint is found', JSON.stringify(r.data).slice(0, 200));
  const r2 = await sneha.req('POST', '/api/complaints/check-duplicate', { title: 'Projector flickering in lecture hall', description: 'projector display flickers', location_text: 'Room 12' });
  ok(!r2.data.duplicates?.some((d) => d.complaint_id === cid), 'unrelated complaint is not matched');
  const r3 = await sneha.req('POST', '/api/complaints/check-duplicate', { title: 'Water leaking in the hostel bathroom', description: 'water leaking pipe', location_text: 'Hostel' });
  ok(!r3.data.duplicates?.some((d) => d.complaint_id === 1), 'RESOLVED complaint is not suggested as a duplicate');
}

console.log('\n[Upvotes: dedupe + escalation]');
{
  ok((await aarav.req('POST', `/api/complaints/${cid}/upvote`, {})).status === 409, 'reporter cannot upvote own complaint');
  const u1 = await sneha.req('POST', `/api/complaints/${cid}/upvote`, { location: 'Hostel C' });
  ok(u1.status === 200 && u1.data.upvote_count === 2 && !u1.data.priority_escalated, 'first upvote -> 2, no escalation');
  const u1b = await sneha.req('POST', `/api/complaints/${cid}/upvote`, {});
  ok(u1b.status === 409 && u1b.data.upvote_count === 2, 'same user cannot upvote twice');
  const burst = await Promise.all(Array.from({ length: 6 }, () => swami.req('POST', `/api/complaints/${cid}/upvote`, {})));
  ok(burst.filter((b) => b.status === 200).length === 1, '6 concurrent upvotes from one user count once', burst.map((b) => b.status).join());
  const prio = (await pool.query('SELECT priority FROM complaints WHERE complaint_id=$1', [cid])).rows[0].priority;
  ok(prio === 'MEDIUM', 'escalated exactly one level (LOW -> MEDIUM) at 3 upvotes', prio);
  ok((await col.findOne({ complaint_id: cid })).metadata.priority === 'MEDIUM', 'mongo priority kept in sync');
}

console.log('\n[Workflow, RBAC and audit trail]');
{
  ok((await aarav.req('PATCH', `/api/complaints/${cid}/status`, { status: 'RESOLVED' })).status === 403, 'reporter cannot change status');
  ok((await ramesh.req('PATCH', `/api/complaints/${cid}/status`, { status: 'IN_PROGRESS', remarks: 'x' })).status === 403, 'unassigned staff cannot change status');
  ok((await aarav.req('POST', `/api/complaints/${cid}/assign`, { staff_id: 5 })).status === 403, 'reporter cannot assign');
  ok((await new Client().req('POST', `/api/complaints/${cid}/assign`, { staff_id: 5 })).status === 401, 'anonymous cannot assign (no hardcoded admin id)');
  ok((await admin.req('POST', `/api/complaints/${cid}/assign`, { staff_id: 1 })).status === 400, 'cannot assign a non-staff user');
  const staffId = (await pool.query(`SELECT user_id FROM users WHERE email='suresh.plumber@pes.edu'`)).rows[0].user_id;
  const a = await admin.req('POST', `/api/complaints/${cid}/assign`, { staff_id: staffId });
  ok(a.status === 200 && a.data.status === 'ASSIGNED', 'admin assigns technician -> ASSIGNED', JSON.stringify(a));
  // reassign keeps a single active assignment
  const other = (await pool.query(`SELECT user_id FROM users WHERE email='ramesh.electrician@pes.edu'`)).rows[0].user_id;
  await admin.req('POST', `/api/complaints/${cid}/assign`, { staff_id: other });
  await admin.req('POST', `/api/complaints/${cid}/assign`, { staff_id: staffId });
  const active = (await pool.query('SELECT COUNT(*)::int n FROM assignments WHERE complaint_id=$1 AND ended_at IS NULL', [cid])).rows[0].n;
  ok(active === 1, 'reassigning leaves exactly one active assignment');
  ok((await suresh.req('PATCH', `/api/complaints/${cid}/status`, { status: 'SUBMITTED' })).status === 403, 'technician cannot set SUBMITTED');
  const ip = await suresh.req('PATCH', `/api/complaints/${cid}/status`, { status: 'IN_PROGRESS', remarks: 'Started work' });
  ok(ip.status === 200, 'assigned technician -> IN_PROGRESS');
  ok((await suresh.req('PATCH', `/api/complaints/${cid}/status`, { status: 'IN_PROGRESS' })).status === 400, 'no-op transition rejected');
  const fbEarly = await aarav.req('POST', `/api/complaints/${cid}/feedback`, { rating: 5 });
  ok(fbEarly.status === 400, 'feedback before resolution rejected');
  const rs = await suresh.req('PATCH', `/api/complaints/${cid}/status`, { status: 'RESOLVED', remarks: 'Washer replaced' });
  ok(rs.status === 200, 'technician resolves');
  const row = (await pool.query('SELECT status, resolved_at FROM complaints WHERE complaint_id=$1', [cid])).rows[0];
  ok(row.status === 'RESOLVED' && row.resolved_at, 'trigger stamped resolved_at');
  const bad = await admin.req('PATCH', `/api/complaints/${cid}/status`, { status: 'SUBMITTED' });
  ok(bad.status === 400 && /Invalid status transition/.test(bad.data.error), 'DB trigger blocks RESOLVED -> SUBMITTED', JSON.stringify(bad.data));
  const hist = (await pool.query('SELECT old_status,new_status,remarks,changed_by FROM status_history WHERE complaint_id=$1 ORDER BY history_id', [cid])).rows;
  const path = hist.map((h) => `${h.old_status ?? '∅'}>${h.new_status}`).join(' ');
  ok(path === '∅>SUBMITTED SUBMITTED>ASSIGNED ASSIGNED>IN_PROGRESS IN_PROGRESS>RESOLVED', 'one audit row per transition, no duplicates', path);
  const sur = (await pool.query(`SELECT user_id FROM users WHERE email='suresh.plumber@pes.edu'`)).rows[0].user_id;
  ok(hist[3].changed_by === sur && hist[3].remarks === 'Washer replaced', 'audit row attributed to technician with remarks');
  const detail = await new Client().req('GET', `/api/complaints/${cid}`);
  ok(detail.data.history.length === 4 && detail.data.complaint.reporter_email === null, 'anonymous detail: full history, no emails');
  ok(new Client().req && (await admin.req('GET', `/api/complaints/${cid}`)).data.complaint.reporter_email, 'admin sees reporter email');
  const reopen = await admin.req('PATCH', `/api/complaints/${cid}/status`, { status: 'IN_PROGRESS', remarks: 'Reopened' });
  ok(reopen.status === 200 && (await pool.query('SELECT resolved_at FROM complaints WHERE complaint_id=$1', [cid])).rows[0].resolved_at === null, 'reopen clears resolved_at');
  await suresh.req('PATCH', `/api/complaints/${cid}/status`, { status: 'RESOLVED', remarks: 'Fixed again' });
  ok((await col.findOne({ complaint_id: cid })).metadata.status === 'RESOLVED', 'mongo status kept in sync');
  ok((await pool.query(`SELECT COUNT(*)::int n FROM notifications WHERE complaint_id=$1 AND user_id=(SELECT user_id FROM users WHERE email='sneha.rao@pes.edu')`, [cid])).rows[0].n >= 1, 'upvoters notified of status changes');
}

console.log('\n[Feedback]');
{
  ok((await sneha.req('POST', `/api/complaints/${cid}/feedback`, { rating: 5 })).status === 403, 'non-owner cannot rate');
  ok((await aarav.req('POST', `/api/complaints/${cid}/feedback`, { rating: 6 })).status === 400, 'rating out of range');
  ok((await aarav.req('POST', `/api/complaints/${cid}/feedback`, { rating: 4.5 })).status === 400, 'non-integer rating');
  ok((await aarav.req('POST', `/api/complaints/${cid}/feedback`, { rating: 4, comment: 'ok' })).status === 200, 'owner can rate resolved complaint');
}

console.log('\n[Analytics & eval queries]');
{
  ok((await aarav.req('GET', '/api/analytics')).status === 403, 'reporter blocked from analytics');
  ok((await new Client().req('GET', '/api/eval-queries?query=q1')).status === 401, 'anonymous blocked from eval queries');
  const an = await admin.req('GET', '/api/analytics');
  ok(an.status === 200 && an.data.department_analytics.length === 5, 'admin analytics ok');
  const plumb = an.data.department_analytics.find((d) => d.department_name.includes('Plumbing'));
  ok(plumb.sla_compliance_rate_pct >= 0 && plumb.sla_compliance_rate_pct <= 100, 'SLA compliance within 0-100', String(plumb.sla_compliance_rate_pct));
  ok(an.data.mongo_analytics.topUpvoted.length > 0 && an.data.mongo_analytics.categoryAgg.length > 0, 'mongo aggregations return data');
  for (const q of ['q1', 'q2', 'q3', 'q4']) {
    const r = await admin.req('GET', `/api/eval-queries?query=${q}`);
    ok(r.status === 200 && r.data.success, `eval query ${q} runs`, JSON.stringify(r.data).slice(0, 150));
  }
  ok((await admin.req('GET', '/api/eval-queries?type=staff')).data.staff.length === 4, 'staff list');
}

console.log('\n[Concurrency / transaction integrity]');
{
  const before = (await pool.query('SELECT COUNT(*)::int n FROM complaints')).rows[0].n;
  const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => aarav.req('POST', '/api/complaints', { category_id: 1, title: `Power cut ${i}`, description: 'mcb tripped', location_text: `Lab ${i}`, priority: 'HIGH' })));
  ok(rs.every((r) => r.status === 200), '12 concurrent creations all succeed');
  const after = (await pool.query('SELECT COUNT(*)::int n FROM complaints')).rows[0].n;
  ok(after === before + 12, 'exactly 12 complaints persisted');
  const orphans = (await pool.query(`SELECT COUNT(*)::int n FROM complaints c WHERE NOT EXISTS (SELECT 1 FROM status_history h WHERE h.complaint_id=c.complaint_id) OR NOT EXISTS (SELECT 1 FROM complaint_embeddings e WHERE e.complaint_id=c.complaint_id)`)).rows[0].n;
  ok(orphans === 0, 'every complaint has history + embedding (no partial transactions)');
  const mongoCount = await col.countDocuments();
  ok(mongoCount === after, `mongo has the same number of documents (${mongoCount} vs ${after})`);
}

console.log('\n[Delete]');
{
  ok((await aarav.req('DELETE', `/api/complaints/${cid}`)).status === 403, 'reporter cannot delete');
  ok((await admin.req('DELETE', `/api/complaints/${cid}`)).status === 200, 'admin deletes');
  ok((await col.findOne({ complaint_id: cid })) === null, 'mongo document removed');
  ok((await pool.query('SELECT 1 FROM complaint_embeddings WHERE complaint_id=$1', [cid])).rowCount === 0, 'cascade removed embedding');
  ok((await admin.req('DELETE', `/api/complaints/${cid}`)).status === 404, 'deleting again -> 404');
}

console.log(`\n${passed} passed, ${failed} failed`);
await pool.end(); await mongo.close();
process.exit(failed ? 1 : 0);
