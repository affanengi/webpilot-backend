const admin = require('./src/services/firebase');
const db = admin.firestore();

async function checkLogs() {
  const uid = "9Mrch5Pls5fdZrrlJvgKFIG9CvE3";
  try {
    const snapshot = await db.collection("users").doc(uid).collection("execution_logs").get();
    console.log(`Found ${snapshot.size} logs`);
    snapshot.forEach(doc => {
      console.log(doc.id, '=>', doc.data());
    });
  } catch (err) {
    console.error("Error reading logs:", err);
  }
  process.exit(0);
}
checkLogs();
