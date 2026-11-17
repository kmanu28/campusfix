import { MongoClient, Db, Collection } from 'mongodb';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/campusfix_nosql';

let client: MongoClient | null = null;
let db: Db | null = null;
let lastFailure = 0;
const RETRY_AFTER_MS = 10_000;

export async function getMongoDb(): Promise<Db> {
  if (db) return db;
  // After a failed connection, fail fast for a few seconds instead of making every request wait
  // for the 3s server-selection timeout.
  if (Date.now() - lastFailure < RETRY_AFTER_MS) {
    throw new Error('MongoDB is unavailable (retrying shortly)');
  }
  const c = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 3000 });
  try {
    await c.connect();
  } catch (err) {
    lastFailure = Date.now();
    await c.close().catch(() => {});
    throw err;
  }
  client = c;
  // Database name comes from the URI path (…/campusfix_nosql); fall back to the default name.
  db = c.db(new URL(MONGODB_URI.replace(/^mongodb(\+srv)?:/, 'http:')).pathname.slice(1) || 'campusfix_nosql');
  return db;
}

export async function closeMongo() {
  await client?.close();
  client = null;
  db = null;
}

export interface ComplaintDocument {
  complaint_id: number;
  title: string;
  description: string;
  category: string;
  department: string;
  extracted_keywords: string[];
  image_url?: string | null;
  metadata: {
    location: string;
    priority: string;
    status: string;
    upvote_count: number;
    affected_users: number[];
    locations: string[];
    last_technician_remark?: string | null;
    updated_at?: Date;
  };
  created_at: Date;
}

export async function getComplaintCollection(): Promise<Collection<ComplaintDocument>> {
  const database = await getMongoDb();
  return database.collection<ComplaintDocument>('complaint_documents');
}

const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'from', 'room', 'floor', 'hall', 'area', 'near', 'this', 'that']);

export function extractKeywords(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z0-9]{3,}/g) || [];
  return Array.from(new Set(words.filter((w) => !STOP_WORDS.has(w)))).slice(0, 10);
}

export interface SyncInput {
  complaint_id: number | string;
  title: string;
  description: string;
  category: string;
  department: string;
  location: string;
  priority: string;
  status: string;
  reporter_id: number | string;
  created_at?: Date | string;
}

/**
 * Upsert the document for a complaint. Descriptive fields are always refreshed from PostgreSQL
 * (the system of record) but the community-driven fields (upvote_count, affected_users, locations)
 * are only initialised on insert, so re-syncing never wipes upvotes.
 * Throws on failure so callers can decide how to react.
 */
export async function syncComplaintToMongo(data: SyncInput) {
  const col = await getComplaintCollection();
  const id = Number(data.complaint_id);
  const reporterId = Number(data.reporter_id);
  await col.updateOne(
    { complaint_id: id },
    {
      $set: {
        title: data.title,
        description: data.description,
        category: data.category,
        department: data.department,
        extracted_keywords: extractKeywords(`${data.title} ${data.description}`),
        'metadata.location': data.location,
        'metadata.priority': data.priority,
        'metadata.status': data.status,
        'metadata.updated_at': new Date(),
      },
      $setOnInsert: {
        image_url: null,
        'metadata.upvote_count': 1,
        'metadata.affected_users': [reporterId],
        'metadata.locations': [data.location],
        created_at: data.created_at ? new Date(data.created_at) : new Date(),
      },
    } as any,
    { upsert: true }
  );
}

/** Best-effort variant used by request handlers: Postgres has already committed, so only log. */
export async function trySyncComplaintToMongo(data: SyncInput) {
  try {
    await syncComplaintToMongo(data);
    return true;
  } catch (err: any) {
    console.error('[MongoDB sync failed — run `npm run db:sync-mongo` to repair]:', err.message);
    return false;
  }
}

/**
 * Atomic, idempotent upvote. A user is counted at most once: the filter only matches while the user
 * is NOT yet in affected_users, so concurrent/duplicate requests cannot inflate the counter.
 * Returns { doc, added } where `added` is false if this user had already upvoted.
 */
export async function upvoteComplaintInMongo(
  complaint_id: number | string,
  user_id: number | string,
  location: string
): Promise<{ doc: ComplaintDocument | null; added: boolean }> {
  const col = await getComplaintCollection();
  const id = Number(complaint_id);
  const uid = Number(user_id);

  const updated = await col.findOneAndUpdate(
    { complaint_id: id, 'metadata.affected_users': { $ne: uid } },
    {
      $inc: { 'metadata.upvote_count': 1 },
      $addToSet: { 'metadata.affected_users': uid, 'metadata.locations': location },
      $set: { 'metadata.updated_at': new Date() },
    },
    { returnDocument: 'after' }
  );
  if (updated) return { doc: updated, added: true };
  return { doc: await col.findOne({ complaint_id: id }), added: false };
}

export async function updateComplaintStatusInMongo(complaint_id: number | string, new_status: string, remark?: string | null) {
  try {
    const col = await getComplaintCollection();
    await col.updateOne(
      { complaint_id: Number(complaint_id) },
      {
        $set: {
          'metadata.status': new_status,
          'metadata.last_technician_remark': remark || null,
          'metadata.updated_at': new Date(),
        },
      }
    );
  } catch (err: any) {
    console.error('[MongoDB status update failed]:', err.message);
  }
}

export async function updateComplaintPriorityInMongo(complaint_id: number | string, priority: string) {
  try {
    const col = await getComplaintCollection();
    await col.updateOne(
      { complaint_id: Number(complaint_id) },
      { $set: { 'metadata.priority': priority, 'metadata.updated_at': new Date() } }
    );
  } catch (err: any) {
    console.error('[MongoDB priority update failed]:', err.message);
  }
}

export async function deleteComplaintFromMongo(complaint_id: number | string) {
  try {
    const col = await getComplaintCollection();
    await col.deleteOne({ complaint_id: Number(complaint_id) });
  } catch (err: any) {
    console.error('[MongoDB delete failed]:', err.message);
  }
}

/** NoSQL aggregation pipelines for the admin analytics dashboard. */
export async function getMongoIncidentAnalytics() {
  try {
    const col = await getComplaintCollection();
    const topUpvoted = await col.find().sort({ 'metadata.upvote_count': -1 }).limit(5).toArray();
    const categoryAgg = await col
      .aggregate([
        {
          $group: {
            _id: '$category',
            total_reports: { $sum: 1 },
            total_upvotes: { $sum: '$metadata.upvote_count' },
          },
        },
        { $sort: { total_upvotes: -1 } },
      ])
      .toArray();
    return { topUpvoted, categoryAgg };
  } catch (err: any) {
    console.error('[MongoDB aggregation failed]:', err.message);
    return { topUpvoted: [], categoryAgg: [] };
  }
}
