const admin = require('firebase-admin');

function loadServiceAccountFromEnv() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return null;
  try {
    // Expecting a JSON string in .env (one-line). User will set it.
    return JSON.parse(raw);
  } catch (err) {
    console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT JSON:', err.message);
    return null;
  }
}

// Initialize the Admin SDK once. Prefer explicit service account JSON from env,
// otherwise fall back to ADC (GOOGLE_APPLICATION_CREDENTIALS, etc.).
if (!admin.apps.length) {
  const serviceAccount = loadServiceAccountFromEnv();
  if (serviceAccount) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  } else {
    admin.initializeApp(); // relies on ADC
  }
}

const db = admin.firestore();

module.exports = { admin, db };

