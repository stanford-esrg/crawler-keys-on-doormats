const { open } = require('sqlite');
const sqlite3 = require('sqlite3');

let dbPath;

function setDbPath(path) {
  dbPath = path;
}

async function getDb() {
  const db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });
  
  // Standard SQLite configuration for local filesystem
  await db.run(`PRAGMA busy_timeout = 10000;`);
  await db.run(`PRAGMA journal_mode = WAL;`);
  await db.run(`PRAGMA synchronous = NORMAL;`);
  await db.run(`PRAGMA temp_store = MEMORY;`);
  await db.run(`PRAGMA cache_size = 10000;`);
  
  return db;
}

async function storeData(table, data) {
  if (!Array.isArray(data[0])) {
    data = [data];
  }

  const placeholders = data.map(row => `(${row.map(() => '?').join(', ')})`).join(', ');
  const query = `INSERT OR IGNORE INTO ${table} VALUES ${placeholders}`;
  const flatData = data.flat();

  let attempts = 0;
  const maxAttempts = 15; // Increased from 10 to 15

  while (attempts < maxAttempts) {
    let db;
    try {
      db = await getDb();
      await db.run(query, flatData);
      await db.close();
      return;
    } catch (err) {
      if (db) {
        try {
          await db.close();
        } catch (closeErr) {
          // Ignore close errors
        }
      }
      
      if (err.message.includes('database is locked') && attempts < maxAttempts - 1) {
        const waitTime = Math.min((attempts + 1) * 1000, 10000); // Cap at 10 seconds, start with 1 second
        console.log(`Database is locked, retrying in ${waitTime/1000} seconds... (attempt ${attempts + 1}/${maxAttempts})`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      } else if (err.message.includes('SQLITE_CONSTRAINT')) {
        // Silently ignore constraint violations (duplicate data)
        return;
      } else {
        console.error(`Error storing data in ${table}: ${err.message}`);
        break;
      }
    }
    attempts++;
  }
}

async function closeDb() {
  // No-op since we're creating fresh connections
}

module.exports = {
  storeData,
  getDb,
  setDbPath,
  closeDb
};

