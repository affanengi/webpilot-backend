const admin = require("./firebase");

let db = null;
try {
  db = admin.firestore();
} catch (error) {
  console.error("⚠️ Failed to initialize Firestore:", error.message);
}

module.exports = db;
