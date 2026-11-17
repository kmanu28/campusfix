/**
 * CampusFix — MongoDB document model, indexes and demo aggregations.
 * Database: campusfix_nosql      Collection: complaint_documents
 *
 * Run with mongosh (the Next.js app / `npm run db:setup` already does the setup part via the driver):
 *     mongosh "mongodb://127.0.0.1:27017/campusfix_nosql" mongodb_schema.js
 *
 * PostgreSQL is the system of record for complaints. MongoDB stores the *flexible, high-churn*
 * community data that does not fit a fixed relational schema: upvote counters, the set of affected
 * users, the set of locations reporting the same issue, extracted keywords and evidence URLs.
 * Documents are created/refreshed by the app (lib/mongo.ts) and by `npm run db:sync-mongo`.
 *
 * Sample document:
 * {
 *   complaint_id: 12, title: "...", description: "...", category: "Water Tap Leakage",
 *   department: "Estate & Plumbing", extracted_keywords: ["tap","leaking",...], image_url: null,
 *   metadata: { location: "Hostel Block C", priority: "MEDIUM", status: "ASSIGNED",
 *               upvote_count: 3, affected_users: [1,2,3], locations: ["Hostel Block C"],
 *               last_technician_remark: "...", updated_at: ISODate() },
 *   created_at: ISODate()
 * }
 */

// NOTE: `const db = db.getSiblingDB(...)` (the previous version) throws a ReferenceError in mongosh.
const campusdb = db.getSiblingDB("campusfix_nosql");

// 1. (Re)create the collection with JSON-schema validation -------------------------------------
campusdb.complaint_documents.drop();
campusdb.createCollection("complaint_documents", {
  validator: {
    $jsonSchema: {
      bsonType: "object",
      required: ["complaint_id", "title", "description", "category", "created_at"],
      properties: {
        // The Node driver stores whole JS numbers as int32, so int/long/double must all be accepted.
        complaint_id: { bsonType: ["int", "long", "double"], description: "complaint_id from PostgreSQL" },
        title: { bsonType: "string", minLength: 1 },
        description: { bsonType: "string" },
        category: { bsonType: "string" },
        department: { bsonType: "string" },
        extracted_keywords: { bsonType: "array", items: { bsonType: "string" } },
        image_url: { bsonType: ["string", "null"] },
        metadata: {
          bsonType: "object",
          properties: {
            location: { bsonType: "string" },
            priority: { enum: ["LOW", "MEDIUM", "HIGH", "URGENT"] },
            status: { enum: ["SUBMITTED", "ASSIGNED", "IN_PROGRESS", "RESOLVED", "REJECTED"] },
            upvote_count: { bsonType: ["int", "long", "double"], minimum: 1 },
            affected_users: { bsonType: "array" },
            locations: { bsonType: "array", items: { bsonType: "string" } }
          }
        },
        created_at: { bsonType: "date" }
      }
    }
  }
});

// 2. Indexes -----------------------------------------------------------------------------------
campusdb.complaint_documents.createIndex(
  { title: "text", description: "text", extracted_keywords: "text" },
  { weights: { title: 10, extracted_keywords: 5, description: 2 }, name: "idx_complaint_text_search" }
);
campusdb.complaint_documents.createIndex({ category: 1, created_at: -1 }, { name: "idx_category_created" });
campusdb.complaint_documents.createIndex({ complaint_id: 1 }, { unique: true, name: "idx_complaint_id_unique" });
campusdb.complaint_documents.createIndex({ "metadata.upvote_count": -1 }, { name: "idx_upvotes" });

print("Collection ready. Now populate it from PostgreSQL:  npm run db:sync-mongo");

// 3. Demo operations (run after the sync) ------------------------------------------------------
// 3.1 Full-text search (weighted) — find similar complaints
print("=== Text search: 'water leaking' ===");
campusdb.complaint_documents
  .find({ $text: { $search: "water leaking" } }, { score: { $meta: "textScore" }, title: 1, category: 1 })
  .sort({ score: { $meta: "textScore" } })
  .limit(5)
  .forEach(printjson);

// 3.2 Aggregation: reports and community upvotes per category
print("=== Aggregation: category breakdown ===");
campusdb.complaint_documents
  .aggregate([
    { $group: { _id: "$category", reports: { $sum: 1 }, upvotes: { $sum: "$metadata.upvote_count" } } },
    { $sort: { upvotes: -1 } }
  ])
  .forEach(printjson);

// 3.3 Aggregation: most frequent extracted keywords
print("=== Aggregation: top keywords ===");
campusdb.complaint_documents
  .aggregate([
    { $unwind: "$extracted_keywords" },
    { $group: { _id: "$extracted_keywords", frequency: { $sum: 1 } } },
    { $sort: { frequency: -1 } },
    { $limit: 10 }
  ])
  .forEach(printjson);

// 3.4 Atomic, once-per-user upvote (this is exactly what the app runs)
//     Matches only while user 99 is not yet in affected_users, so repeating it changes nothing.
print("=== Atomic idempotent upvote demo (complaint 1, user 99) ===");
printjson(
  campusdb.complaint_documents.findOneAndUpdate(
    { complaint_id: 1, "metadata.affected_users": { $ne: 99 } },
    {
      $inc: { "metadata.upvote_count": 1 },
      $addToSet: { "metadata.affected_users": 99, "metadata.locations": "Demo location" }
    },
    { returnDocument: "after" }
  )
);
