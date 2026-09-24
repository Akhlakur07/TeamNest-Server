const mongoose = require('mongoose');
const env = require('./env');

async function connectDB() {
  try {
    mongoose.set('strictQuery', true);
    const conn = await mongoose.connect(env.MONGO_URI, { dbName: env.DB_NAME });
    console.log(`MongoDB connected: ${conn.connection.host}/${conn.connection.name}`);
    return conn;
  } catch (error) {
    console.error(`MongoDB connection error: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { connectDB };