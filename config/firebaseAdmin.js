const path = require('path');
const env = require('./env');

let admin = null;

try {
  const { initializeApp, cert, applicationDefault, getApps } = require('firebase-admin/app');
  const { getAuth } = require('firebase-admin/auth');

  if (getApps().length === 0) {
    const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
    const googleCredentials = process.env.GOOGLE_APPLICATION_CREDENTIALS;

    if (serviceAccountPath) {
      const resolved = path.isAbsolute(serviceAccountPath)
        ? serviceAccountPath
        : path.resolve(process.cwd(), serviceAccountPath);
      const serviceAccount = require(resolved);
      initializeApp({ credential: cert(serviceAccount) });
    } else if (googleCredentials) {
      initializeApp({ credential: applicationDefault() });
    } else {
      throw new Error(
        'FIREBASE_SERVICE_ACCOUNT_PATH or GOOGLE_APPLICATION_CREDENTIALS is not set'
      );
    }
  }

  admin = { auth: getAuth };
  console.log('Firebase Admin initialized');
} catch (error) {
  console.warn(`Firebase Admin not configured: ${error.message}`);
}

module.exports = admin;