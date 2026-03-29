require("dotenv").config();
const db = require("./src/services/firestore");

async function check() {
  const usersSnap = await db.collection("users").limit(10).get();
  for (const userDoc of usersSnap.docs) {
    const accountsSnap = await userDoc.ref.collection("connected_accounts").get();
    for (const acc of accountsSnap.docs) {
      if (acc.id !== "google" && acc.id !== "gmail" && acc.id !== "youtube" && acc.id !== "google_drive" && acc.id !== "google_sheets") {
         console.log(`User: ${userDoc.id}, Provider: ${acc.id}`);
         console.log(Object.keys(acc.data()));
         console.log(`accessToken exists? ${!!acc.data().accessToken}`);
      }
    }
  }
}

check().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
