require('dotenv').config({ path: __dirname + '/../.env' });
const admin = require('./services/firebase');

async function updateKeys() {
  try {
    const newGeminiKey = process.env.GEMINI_API_KEY;
    if (!newGeminiKey) {
      console.error("GEMINI_API_KEY not found in .env file.");
      process.exit(1);
    }

    const db = admin.firestore();
    const usersRef = db.collection('users');
    const snapshot = await usersRef.get();
    
    if (snapshot.empty) {
      console.log('No matching documents.');
      process.exit(0);
    }

    let updatedCount = 0;
    
    for (const doc of snapshot.docs) {
      const data = doc.data();
      if (!data.connectedAccounts) {
          data.connectedAccounts = {};
      }
      
      data.connectedAccounts.gemini = newGeminiKey;

      await usersRef.doc(doc.id).update({
        connectedAccounts: data.connectedAccounts
      });
      console.log(`Updated Gemini API key for user: ${doc.id}`);
      updatedCount++;
    }
    
    console.log(`Successfully updated ${updatedCount} users with the new Gemini API Key from .env.`);
    process.exit(0);

  } catch (error) {
    console.error('Error updating keys:', error);
    process.exit(1);
  }
}

updateKeys();
