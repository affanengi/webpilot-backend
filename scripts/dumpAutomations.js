const admin = require("firebase-admin");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
  })
});

async function main() {
    const db = admin.firestore();
    const usersSnap = await db.collection("users").get();
    for (const userDoc of usersSnap.docs) {
        console.log(`User: ${userDoc.id}`);
        const autoSnap = await db.collection("users").doc(userDoc.id).collection("automations").get();
        autoSnap.forEach(d => {
            const data = d.data();
            const location = (data.isCustom === true || (data.steps && data.steps.length > 1)) ? "Custom" : "Prebuilt";
            console.log(`  - [${location}] ${data.name} (ID: ${d.id})`);
        });
    }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
