/**
 * CampusFix database setup (PostgreSQL + pgvector + MongoDB).
 *
 *   npm run db:setup                 # create schema + seed demo data (refuses to overwrite existing data)
 *   npm run db:setup -- --force      # drop and recreate everything
 *   npm run db:sync-mongo            # (re)build the MongoDB documents from PostgreSQL only
 *
 * Reads DATABASE_URL / MONGODB_URI / DEMO_PASSWORD from .env (or the environment).
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';

// --- minimal .env loader (so the script works on any Node version) -------------------------
const envPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
}

const { query, getPgPool } = await import('../lib/db');
const { generateEmbedding, toVectorString, EMBEDDING_MODEL_NAME } = await import('../lib/vector');
const { getMongoDb, getComplaintCollection, syncComplaintToMongo, closeMongo } = await import('../lib/mongo');

const args = new Set(process.argv.slice(2));
const FORCE = args.has('--force');
const SYNC_ONLY = args.has('--sync-mongo');
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'password123';

async function setupMongo() {
  const db = await getMongoDb();
  const existing = (await db.listCollections({ name: 'complaint_documents' }).toArray()).length > 0;
  if (existing) await db.collection('complaint_documents').drop();

  const validator = {
      $jsonSchema: {
        bsonType: 'object',
        required: ['complaint_id', 'title', 'description', 'category', 'created_at'],
        properties: {
          complaint_id: { bsonType: ['int', 'long', 'double'], description: 'complaint_id from PostgreSQL' },
          title: { bsonType: 'string', minLength: 1 },
          description: { bsonType: 'string' },
          category: { bsonType: 'string' },
          department: { bsonType: 'string' },
          extracted_keywords: { bsonType: 'array', items: { bsonType: 'string' } },
          image_url: { bsonType: ['string', 'null'] },
          metadata: {
            bsonType: 'object',
            properties: {
              location: { bsonType: 'string' },
              priority: { enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] },
              status: { enum: ['SUBMITTED', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'REJECTED'] },
              upvote_count: { bsonType: ['int', 'long', 'double'], minimum: 1 },
              affected_users: { bsonType: 'array' },
              locations: { bsonType: 'array', items: { bsonType: 'string' } },
            },
          },
          created_at: { bsonType: 'date' },
        },
      },
  };
  try {
    await db.createCollection('complaint_documents', { validator });
  } catch (err: any) {
    // MongoDB-compatible servers such as FerretDB do not implement $jsonSchema validators.
    console.warn(`⚠ Schema validator not supported by this server (${String(err.message).slice(0, 80)}...). Creating the collection without it.`);
    await db.createCollection('complaint_documents');
  }
  const col = db.collection('complaint_documents');
  const tryIndex = async (spec: any, opts: any) => {
    try {
      await col.createIndex(spec, opts);
    } catch (err: any) {
      console.warn(`⚠ Index ${opts.name} not created: ${String(err.message).slice(0, 80)}`);
    }
  };
  await tryIndex({ title: 'text', description: 'text', extracted_keywords: 'text' },
    { weights: { title: 10, extracted_keywords: 5, description: 2 }, name: 'idx_complaint_text_search' });
  await tryIndex({ category: 1, created_at: -1 }, { name: 'idx_category_created' });
  await tryIndex({ complaint_id: 1 }, { unique: true, name: 'idx_complaint_id_unique' });
  await tryIndex({ 'metadata.upvote_count': -1 }, { name: 'idx_upvotes' });
}

async function syncMongoFromPostgres() {
  const res = await query(
    `SELECT c.complaint_id, c.title, c.description, c.location_text, c.priority, c.status, c.reporter_id, c.created_at,
            cat.category_name, d.department_name
     FROM complaints c
     JOIN categories cat ON c.category_id = cat.category_id
     JOIN departments d ON cat.department_id = d.department_id
     ORDER BY c.complaint_id`
  );
  for (const r of res.rows) {
    await syncComplaintToMongo({
      complaint_id: r.complaint_id, title: r.title, description: r.description,
      category: r.category_name, department: r.department_name, location: r.location_text,
      priority: r.priority, status: r.status, reporter_id: r.reporter_id, created_at: r.created_at,
    });
  }
  // Remove documents whose complaint no longer exists in PostgreSQL.
  const col = await getComplaintCollection();
  const ids = res.rows.map((r) => r.complaint_id);
  const del = await col.deleteMany({ complaint_id: { $nin: ids } });
  console.log(`✔ MongoDB: ${res.rows.length} documents synced from PostgreSQL (${del.deletedCount} orphans removed)`);
}

async function main() {
  if (SYNC_ONLY) {
    await syncMongoFromPostgres();
    return;
  }

  // Safety: do not wipe a database that already holds data unless --force is given.
  const exists = await query(`SELECT to_regclass('public.users') AS t`);
  if (exists.rows[0].t && !FORCE) {
    const n = await query(`SELECT COUNT(*)::int AS n FROM users`);
    if (n.rows[0].n > 0) {
      console.error('✖ The database already contains data. Re-run with  npm run db:setup -- --force  to DROP and recreate it.');
      process.exit(1);
    }
  }

  console.log('→ Applying postgres_schema.sql ...');
  const schema = fs.readFileSync(path.resolve(process.cwd(), 'postgres_schema.sql'), 'utf8');
  await query(schema);
  console.log('✔ Schema applied (tables, indexes, HNSW vector index, views, functions, procedures, trigger)');

  console.log('→ Seeding demo data ...');
  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);

  await query(`INSERT INTO roles (role_name) VALUES ('REPORTER'), ('STAFF'), ('ADMIN')`);
  await query(
    `INSERT INTO users (role_id, full_name, email, password_hash)
     SELECT r.role_id, v.full_name, v.email, $1
     FROM (VALUES
       ('REPORTER', 'Aarav Sharma (Student)',        'aarav.sharma@pes.edu'),
       ('REPORTER', 'Sneha Rao (Student)',           'sneha.rao@pes.edu'),
       ('REPORTER', 'Dr. K. Swaminathan (Faculty)',  'swaminathan.k@pes.edu'),
       ('STAFF',    'Ramesh K (Electrician)',        'ramesh.electrician@pes.edu'),
       ('STAFF',    'Suresh Patel (Plumber)',        'suresh.plumber@pes.edu'),
       ('STAFF',    'Anand V (Network Admin)',       'anand.network@pes.edu'),
       ('STAFF',    'Mariyappa (Housekeeping Lead)', 'mariyappa.clean@pes.edu'),
       ('ADMIN',    'Campus Estate Admin',           'admin.campusfix@pes.edu')
     ) AS v(role_name, full_name, email)
     JOIN roles r ON r.role_name = v.role_name`,
    [hash]
  );

  await query(`INSERT INTO departments (department_name) VALUES
    ('Electrical Maintenance'), ('Estate & Plumbing'), ('IT & Network Infrastructure'),
    ('Housekeeping & Sanitation'), ('Classroom & AV Facilities')`);
  await query(
    `INSERT INTO categories (department_id, category_name, target_hours)
     SELECT d.department_id, v.cat, v.hrs
     FROM (VALUES
       ('Electrical Maintenance', 'Power Outage / MCB Trip', 4),
       ('Electrical Maintenance', 'Ceiling Fan / Tube Light Fault', 12),
       ('Electrical Maintenance', 'AC Cooling Failure', 24),
       ('Estate & Plumbing', 'Water Tap Leakage', 8),
       ('Estate & Plumbing', 'Ceiling Pipe Water Leaking', 6),
       ('Estate & Plumbing', 'Blocked Washroom Drain', 4),
       ('IT & Network Infrastructure', 'Hostel Wi-Fi Disconnected', 6),
       ('IT & Network Infrastructure', 'Slow Internet / Packet Drop', 12),
       ('Housekeeping & Sanitation', 'Corridor Waste Accumulation', 6),
       ('Housekeeping & Sanitation', 'Washroom Sanitization', 4),
       ('Classroom & AV Facilities', 'Classroom Projector Flickering', 8),
       ('Classroom & AV Facilities', 'Audio System / Mic Failure', 4)
     ) AS v(dept, cat, hrs)
     JOIN departments d ON d.department_name = v.dept`
  );

  const uid = async (email: string) => (await query(`SELECT user_id FROM users WHERE email = $1`, [email])).rows[0].user_id as number;
  const cid = async (name: string) => (await query(`SELECT category_id FROM categories WHERE category_name = $1`, [name])).rows[0].category_id as number;
  const aarav = await uid('aarav.sharma@pes.edu');
  const sneha = await uid('sneha.rao@pes.edu');
  const swami = await uid('swaminathan.k@pes.edu');
  const ramesh = await uid('ramesh.electrician@pes.edu');
  const suresh = await uid('suresh.plumber@pes.edu');
  const anand = await uid('anand.network@pes.edu');
  const admin = await uid('admin.campusfix@pes.edu');

  type Seed = { reporter: number; cat: string; title: string; desc: string; loc: string; prio: string; status: string;
                created: string; resolved: string | null; staff: number | null; staffAt: string | null };
  const seeds: Seed[] = [
    { reporter: aarav, cat: 'Ceiling Pipe Water Leaking', title: 'Water leaking in the hostel bathroom',
      desc: 'Constant water leaking from overhead flush pipe in 3rd floor washroom.', loc: 'Hostel Block B, Room 304 Washroom',
      prio: 'HIGH', status: 'RESOLVED', created: '3 days', resolved: '2 days 20 hours', staff: suresh, staffAt: '3 days' },
    { reporter: sneha, cat: 'Hostel Wi-Fi Disconnected', title: 'Wi-Fi not working on hostel 4th floor',
      desc: 'Signal strength is zero and access point AP-H4-02 has amber blinking light.', loc: 'Hostel Block A, 4th Floor Wing B',
      prio: 'URGENT', status: 'IN_PROGRESS', created: '5 hours', resolved: null, staff: anand, staffAt: '5 hours' },
    { reporter: swami, cat: 'Classroom Projector Flickering', title: 'Classroom projector flickering red tint',
      desc: 'During lectures the projector turns red and powers off after 10 minutes.', loc: 'GJBC Building, Room 402',
      prio: 'MEDIUM', status: 'SUBMITTED', created: '10 hours', resolved: null, staff: null, staffAt: null },
    { reporter: aarav, cat: 'Ceiling Fan / Tube Light Fault', title: 'Ceiling fan making screeching noise in study hall',
      desc: 'Fan regulator is unresponsive and bearings are extremely noisy.', loc: 'Central Library, 2nd Floor Study Room 3',
      prio: 'LOW', status: 'ASSIGNED', created: '18 hours', resolved: null, staff: ramesh, staffAt: '18 hours' },
  ];

  for (const s of seeds) {
    const catId = await cid(s.cat);
    const ins = await query(
      `INSERT INTO complaints (reporter_id, category_id, title, description, location_text, priority, status, created_at, resolved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() - $8::interval, ${s.resolved ? `NOW() - $9::interval` : 'NULL'})
       RETURNING complaint_id`,
      s.resolved
        ? [s.reporter, catId, s.title, s.desc, s.loc, s.prio, s.status, s.created, s.resolved]
        : [s.reporter, catId, s.title, s.desc, s.loc, s.prio, s.status, s.created]
    );
    const id = ins.rows[0].complaint_id as number;

    // Audit trail consistent with the workflow
    const trail: [string | null, string, number, string][] = [[null, 'SUBMITTED', s.reporter, 'Complaint submitted by reporter']];
    if (s.status !== 'SUBMITTED') trail.push(['SUBMITTED', 'ASSIGNED', admin, 'Technician assigned by admin']);
    if (['IN_PROGRESS', 'RESOLVED'].includes(s.status)) trail.push(['ASSIGNED', 'IN_PROGRESS', s.staff!, 'Technician started work']);
    if (s.status === 'RESOLVED') trail.push(['IN_PROGRESS', 'RESOLVED', s.staff!, 'Pipe joint replaced and leak tested']);
    for (const [o, n, by, remark] of trail) {
      await query(
        `INSERT INTO status_history (complaint_id, changed_by, old_status, new_status, remarks) VALUES ($1, $2, $3, $4, $5)`,
        [id, by, o, n, remark]
      );
    }

    if (s.staff) {
      await query(
        `INSERT INTO assignments (complaint_id, staff_id, assigned_by, assigned_at, ended_at)
         VALUES ($1, $2, $3, NOW() - $4::interval, ${s.status === 'RESOLVED' ? `NOW() - $5::interval` : 'NULL'})`,
        s.status === 'RESOLVED' ? [id, s.staff, admin, s.staffAt, s.resolved] : [id, s.staff, admin, s.staffAt]
      );
    }
    if (s.status === 'RESOLVED') {
      await query(
        `INSERT INTO feedback (complaint_id, rating, comment) VALUES ($1, 5, 'Promptly fixed within 4 hours. Great job by Suresh.')`,
        [id]
      );
    }

    const text = `${s.title} ${s.desc} ${s.loc}`;
    await query(
      `INSERT INTO complaint_embeddings (complaint_id, embedding, model_name, content_hash) VALUES ($1, $2::vector, $3, $4)`,
      [id, toVectorString(generateEmbedding(text)), EMBEDDING_MODEL_NAME, crypto.createHash('sha256').update(text).digest('hex')]
    );
  }
  console.log(`✔ Seeded roles, 8 users (password: "${DEMO_PASSWORD}"), 5 departments, 12 categories, ${seeds.length} complaints with embeddings`);

  console.log('→ Setting up MongoDB ...');
  await setupMongo();
  await syncMongoFromPostgres();
  console.log('\nAll done. Start the app with:  npm run dev');
}

main()
  .catch((err) => {
    console.error('✖ Setup failed:', err.message || err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeMongo().catch(() => {});
    await getPgPool().end().catch(() => {});
  });
