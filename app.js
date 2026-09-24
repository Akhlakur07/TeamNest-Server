const express = require('express');
const cors = require('cors');
const env = require('./config/env');
const routes = require('./routes');
const notFound = require('./middleware/notFound');
const errorHandler = require('./middleware/errorHandler');

const app = express();

app.use(cors({ origin: env.FRONTEND_URL }));
app.use(express.json());

app.get('/', (req, res) => {
  res.send('TeamNest API is running');
});

app.use('/api', routes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;