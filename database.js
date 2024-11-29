const { createClient } = require( '@libsql/client' );

const objectForClient = {
  url: process.env.DB_REMOTE_URL,
  authToken: process.env.DB_AUTH_TOKEN,
}

console.log({ objectForClient });
const db = createClient({
  ...objectForClient,
});

module.exports = db;
