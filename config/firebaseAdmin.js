const path = require('path');
const env = require('./env');

let admin = null;

try {
  const firebaseAdmin = require('firebase-admin');

  if (firebaseAdmin.apps.length === 0) {
    const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
    const googleCredentials = process.env.GOOGLE_APPLICATION_CREDENTIALS;

    if (serviceAccountPath) {
      const resolved = path.isAbsolute(serviceAccountPath)
        ? serviceAccountPath
        : path.resolve(process.cwd(), serviceAccountPath);
      const serviceAccount = require(resolved);
      firebaseAdmin.initializeApp({
        credential: firebaseAdmin.credential.cert(serviceAccount),
      });
    } else if (googleCredentials) {
      firebaseAdmin.initializeApp({
        credential: firebaseAdmin.credential.applicationDefault(),
      });
    } else {
      throw new Error(
        'FIREBASE_SERVICE_ACCOUNT_PATH or GOOGLE_APPLICATION_CREDENTIALS is not set'
      );
    }

    console.log('Firebase Admin initialized');
    admin = firebaseAdmin;
  } else {
    admin = firebaseAdmin;
  }
} catch (error) {
  console.warn(`Firebase Admin not configured: ${error.message}`);
}

module.exports = admin;