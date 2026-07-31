const path = require('path');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const keyPath = path.join(__dirname, '..', 'serviceAccountKey.json');

let serviceAccount;
try {
  serviceAccount = require(keyPath);
} catch {
  console.error(
    `Missing serviceAccountKey.json at project root (${keyPath}).\n` +
    'Get it from Firebase Console > Project Settings > Service Accounts > Generate new private key.'
  );
  process.exit(1);
}

initializeApp({ credential: cert(serviceAccount) });

const db = getFirestore();

module.exports = { db };
