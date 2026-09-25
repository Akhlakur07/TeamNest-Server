const express = require('express');
const mongoose = require('mongoose');
const env = require('../config/env');
const app = require('../app');

let dbConnectPromise = null;

function ensureDb() {
  if (mongoose.connection.readyState === 1) return Promise.resolve();
  if (!dbConnectPromise) {
    mongoose.set('strictQuery', true);
    dbConnectPromise = mongoose
      .connect(env.MONGO_URI, { dbName: env.DB_NAME })
      .catch((error) => {
        console.error('[serverless] MongoDB connection error:', error.message);
        throw error;
      })
      .finally(() => {
        dbConnectPromise = null;
      });
  }
  return dbConnectPromise;
}

const handler = express();
handler.use(async (req, res, next) => {
  try {
    await ensureDb();
    next();
  } catch (error) {
    console.error('[serverless] Request aborted, DB not connected:', error.message);
    res.status(503).json({ success: false, message: 'Service temporarily unavailable' });
  }
});
handler.use(app);

module.exports = handler;