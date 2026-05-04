require("dotenv").config();
const admin = require("firebase-admin");

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
        })
    });
}

const db = admin.firestore();
const auth = admin.auth();

const TARGET_EMAIL = "xyzgamer665@gmail.com";
const CREDITS_TO_SET = 1000;

async function run() {
    // 1. Look up by email
    const userRecord = await auth.getUserByEmail(TARGET_EMAIL);
    const uid = userRecord.uid;
    console.log(`✅ Found user: ${userRecord.email} (uid: ${uid})`);

    // 2. Set dailyCredits — this is the field Navbar.jsx and CanvasAutomation.jsx read
    const userRef = db.collection("users").doc(uid);
    await userRef.set({
        dailyCredits: CREDITS_TO_SET,
        lastCreditReset: new Date().toISOString().split("T")[0]  // today's date prevents auto-reset
    }, { merge: true });

    // 3. Confirm
    const snap = await userRef.get();
    console.log(`✅ dailyCredits set to: ${snap.data().dailyCredits}`);
    console.log(`✅ lastCreditReset:     ${snap.data().lastCreditReset}`);
    process.exit(0);
}

run().catch(err => {
    console.error("❌ Error:", err.message);
    process.exit(1);
});
