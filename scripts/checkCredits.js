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

admin.firestore().collection("users").doc("Pwc7Cs706hY2x98rh2ADHC1jvI23").get().then(s => {
    const d = s.data();
    console.log("dailyCredits:", d.dailyCredits);
    console.log("lastCreditReset:", d.lastCreditReset);
    process.exit(0);
}).catch(e => { console.error(e); process.exit(1); });
