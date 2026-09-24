const app = require('./app');
const env = require('./config/env');
const { connectDB } = require('./config/db');

const start = async () => {
  await connectDB();
  app.listen(env.PORT, () => {
    console.log(`TeamNest API listening on port ${env.PORT}`);
  });
};

start();