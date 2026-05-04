const admin = require("firebase-admin");

if (!admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n") : undefined,
      }),
    });
  } catch (error) {
    console.error("⚠️ Failed to initialize Firebase Admin in firebase.js:", error.message);
  }
}

module.exports = admin;