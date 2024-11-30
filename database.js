const { createClient } = require( '@libsql/client' );

const turso = createClient({
  url: process.env.DB_REMOTE_URL,
  authToken: process.env.DB_AUTH_TOKEN,
});

module.exports = turso;
