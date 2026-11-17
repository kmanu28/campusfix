# CampusFix: Intelligent Campus Complaint Management and Resolution System

**DBMS Experiential Learning – Level 3 MiniProject**  
**Department of Computer Science and Engineering, PES University**

A full-stack Next.js web application for managing campus maintenance complaints. Built with **PostgreSQL + pgvector** (relational data + vector similarity search) and **MongoDB** (upvote counters and document metadata), with role-based access control (Reporter, Staff, Admin).

---

## 📋 What This Project Does

Students and faculty report maintenance issues (electricity, plumbing, Wi-Fi, classrooms, cleanliness, hostel amenities). CampusFix:

1. **Auto-assigns** complaints to the correct department with SLA turnaround hours
2. **Detects duplicates** using vector embeddings (semantic similarity search)
3. **Tracks upvotes** so students can say "I'm facing this too"
4. **Escalates** priority automatically when upvote thresholds are hit
5. **Role-based workflow**: Reporters file, Staff resolve, Admins assign & oversee
6. **Analytics dashboard** with SLA compliance and department bottleneck reports
7. **Audit trail** — every status change is recorded with who, when, and why

---

## 🛠 Technology Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Frontend | Next.js 16, React 19, Tailwind CSS | Web UI |
| Relational DB | PostgreSQL 16 + pgvector | Complaints, users, categories, audit triggers, vector embeddings |
| Document DB | MongoDB 7 | Upvote counters, affected users, metadata |
| Auth | bcrypt + HMAC-signed sessions | Login cookies |
| Language | TypeScript | Type-safe backend & frontend |

---

## 🚀 Quick Start (Spoonfed, Step by Step)

Follow these steps in order. Do not skip any step.

### Step 1: Get the code

```bash
git clone https://github.com/kmanu28/campusfix.git
cd campusfix
```

### Step 2: Install Node.js

You need **Node.js version 20.9 or higher**.

- Check your version: `node --version`
- If you don't have it, download from: https://nodejs.org/
- If your version is too old, install the LTS version from the link above

### Step 3: Install Docker Desktop (Recommended — easiest way to get databases)

The app needs **PostgreSQL with pgvector** and **MongoDB** running. Docker Desktop starts both with one command.

1. Download Docker Desktop for Windows: https://www.docker.com/products/docker-desktop/
   - Choose **"Download for Windows – AMD64"** (most laptops/desktops)
   - Only choose ARM64 if you know you have a Snapdragon/Qualcomm Windows-on-ARM device
2. Run the installer with all default settings
3. **Reboot your computer** when installation finishes (required for WSL2)
4. Make sure Docker Desktop is running (you'll see the Docker whale icon in your system tray)

> **Alternative (no Docker):** Install PostgreSQL 16 with the pgvector extension and MongoDB 7 manually, then update `.env` with your connection strings.

### Step 4: Start the databases

Open PowerShell (or Terminal) in the `campusfix` folder and run:

```powershell
docker compose up -d
```

This starts:
- **PostgreSQL + pgvector** on port `5432`
- **MongoDB** on port `27017`

Wait ~10 seconds for containers to start. Verify they're running:

```powershell
docker ps
```

You should see two containers: one for postgres and one for mongo.

### Step 5: Configure environment variables

Copy the example env file:

```powershell
cp .env.example .env
```

Open `.env` in a text editor. The defaults should work for local Docker:

```env
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/campusfix
MONGODB_URI=mongodb://127.0.0.1:27017/campusfix_nosql
SESSION_SECRET=change-me-to-a-long-random-string
DEMO_MODE=true
DEMO_PASSWORD=password123
```

**Important:** Change `SESSION_SECRET` to a long random string. Generate one with:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Paste the output in place of `change-me-to-a-long-random-string`.

Save the file.

### Step 6: Install npm packages

```powershell
npm install
```

This downloads all dependencies (may take 1–2 minutes).

### Step 7: Set up the database (schema + demo data)

```powershell
npm run db:setup
```

This will:
- Create all tables, indexes, views, triggers, and stored procedures in PostgreSQL
- Enable the pgvector extension and create the HNSW vector index
- Seed demo users, departments, categories, and complaints
- Set up MongoDB collections and sync data from PostgreSQL

You should see output ending with: `All done. Start the app with:  npm run dev`

> If it says "The database already contains data", re-run with: `npm run db:setup -- --force`

### Step 8: Run the app

```powershell
npm run dev
```

You should see:

```
Ready in X seconds
http://localhost:3000
```

Leave this terminal running. Open your browser to:

**http://localhost:3000**

---

## 🔐 Demo Accounts

Because `DEMO_MODE=true`, the login page shows one-click account buttons. All passwords are `password123`.

| Email | Role | What you can do |
|-------|------|-----------------|
| `aarav.sharma@pes.edu` | Reporter (Student) | File complaints, upvote, rate resolutions |
| `sneha.rao@pes.edu` | Reporter (Student) | Same as above |
| `swaminathan.k@pes.edu` | Reporter (Faculty) | Same as above |
| `ramesh.electrician@pes.edu` | Staff | View & update assigned complaints |
| `suresh.plumber@pes.edu` | Staff | View & update assigned complaints |
| `anand.network@pes.edu` | Staff | View & update assigned complaints |
| `mariyappa.clean@pes.edu` | Staff | View & update assigned complaints |
| `admin.campusfix@pes.edu` | Admin | Assign staff, view analytics, run SQL queries |

---

## 🗂 File Structure

```
campusfix/
├── app/                          # Next.js pages & API routes
│   ├── page.tsx                  # Landing page
│   ├── login/                    # Login page (role picker)
│   ├── reporter/                 # Reporter portal
│   ├── staff/                    # Maintenance staff portal
│   ├── admin/                    # Admin console + analytics
│   └── api/                      # API route handlers
│       ├── auth/                 # login, register, logout, me, users
│       ├── complaints/           # CRUD, assign, status, upvote, feedback, duplicate check
│       ├── analytics/            # Department analytics & SLA compliance
│       └── eval-queries/         # SQL evaluator for demo queries
├── lib/
│   ├── db.ts                     # PostgreSQL pool, withTransaction(), type parsers
│   ├── auth.ts                   # Signed sessions, bcrypt login, role guards
│   ├── mongo.ts                  # MongoDB access, upvote sync
│   └── vector.ts                 # Keyword-hash embedding model (384-d)
├── scripts/
│   └── setup-db.ts               # Database setup & seeding (npm run db:setup)
├── tests/
│   └── api.e2e.mjs               # 72 end-to-end API checks (npm test)
├── postgres_schema.sql           # DDL: tables, triggers, views, procedures, pgvector
├── mongodb_schema.js             # MongoDB collection setup & indexes
├── queries.sql                   # Demo SQL queries for viva
├── docker-compose.yml            # Local PostgreSQL + MongoDB
├── .env.example                  # Environment variable template
├── package.json                  # npm scripts & dependencies
├── CHANGES.md                    # Full list of bugs fixed
└── *.drawio                      # ER diagrams
```

---

## 🔌 API Endpoints

| Method | Endpoint | Description | Access |
|--------|----------|-------------|--------|
| POST | `/api/auth/register` | Register new account (REPORTER only) | Public |
| POST | `/api/auth/login` | Login with email + password | Public |
| POST | `/api/auth/logout` | Clear session cookie | Authenticated |
| GET | `/api/auth/me` | Get current user & role | Authenticated |
| GET | `/api/auth/users` | List all users | Admin |
| GET | `/api/complaints` | List complaints (with filters) | Authenticated |
| POST | `/api/complaints` | Create a new complaint | Reporter/Staff/Admin |
| GET | `/api/complaints/[id]` | Get single complaint details | Authenticated |
| PATCH | `/api/complaints/[id]/status` | Update complaint status | Staff/Admin |
| POST | `/api/complaints/[id]/assign` | Assign complaint to staff | Admin |
| POST | `/api/complaints/[id]/upvote` | Upvote a complaint | Reporter |
| POST | `/api/complaints/[id]/feedback` | Submit rating & comment | Reporter |
| GET | `/api/complaints/check-duplicate` | Check for similar complaints | Reporter |
| GET | `/api/analytics` | Department analytics & SLA compliance | Admin |
| POST | `/api/eval-queries` | Run demo SQL queries | Admin |

---

## 🧪 Run the Tests

The project includes 72 end-to-end API checks.

1. Make sure the app is running (`npm run dev`)
2. Make sure the database is freshly seeded (`npm run db:setup`)
3. Run:

```powershell
npm test
```

All 72 checks should pass.

---

## 🐛 Troubleshooting

| Problem | Fix |
|---------|-----|
| `npm run db:setup` fails to connect to PostgreSQL | Make sure `docker compose up -d` ran successfully and `docker ps` shows the postgres container |
| `npm run dev` crashes on startup | Make sure both databases are running, then restart the dev server |
| Port 3000 already in use | Close the other app using port 3000, or run `npx kill-port 3000` first |
| Staff page shows "Failed to fetch complaints" | Make sure you ran `npm run db:setup` and the app is running. Refresh the page. |
| Login doesn't work | Check that `SESSION_SECRET` is set in `.env` and the demo password matches `DEMO_PASSWORD` |
| `docker compose` command not found | Docker Desktop isn't running or wasn't installed correctly. Reboot and try again. |
| MongoDB connection errors | Make sure the mongo container is running: `docker ps` |

---

## 📊 Database Diagram

ER diagrams are included as `.drawio` files (open with https://app.diagrams.net/):
- `CampusFix_Chen_ER_Diagram.drawio` — Chen notation
- `CampusFix_Database_Design.drawio` — Relational schema
- `CampusFix_Syllabus_Aligned.drawio` — Syllabus-aligned model

---

## 📜 License

ISC License

---

## 🙋 Need Help?

If something isn't working, paste the exact error message and which step you were on. The most common issues are:
1. Docker Desktop not running / not rebooted after install
2. `npm run db:setup` not run before `npm run dev`
3. `.env` not copied from `.env.example`