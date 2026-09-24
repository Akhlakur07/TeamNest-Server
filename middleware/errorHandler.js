const env = require('../config/env');
const { ZodError } = require('zod');

const errorHandler = (err, req, res, next) => {
  let statusCode = err.statusCode || 500;
  let message = err.message || 'Internal server error';

  if (err instanceof ZodError) {
    statusCode = 400;
    message = err.issues
      .map((issue) => `${issue.path.join('.') || 'field'}: ${issue.message}`)
      .join('; ');
  }

  if (err.name === 'CastError') {
    statusCode = 400;
    message = 'Invalid resource identifier';
  }

  if (err.name === 'ValidationError') {
    statusCode = 400;
    message = Object.values(err.errors)
      .map((e) => e.message)
      .join(', ');
  }

  if (err.code === 11000) {
    statusCode = 409;
    message = 'Duplicate value for a unique field';
  }

  if (statusCode === 500 && env.NODE_ENV === 'production') {
    message = 'Internal server error';
  }

  if (statusCode >= 500) {
    console.error(err);
  }

  res.status(statusCode).json({
    success: false,
    message,
    ...(env.NODE_ENV !== 'production' && statusCode >= 500 ? { stack: err.stack } : {}),
  });
};

module.exports = errorHandler;