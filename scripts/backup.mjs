import { DatabaseSync, backup } from 'node:sqlite';
import { chmod, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const source = process.env.DATABASE_PATH || '/data/saga-fe.sqlite';
const destination = process.argv[2];
if (!destination || resolve(source) === resolve(destination)) throw new Error('Provide a distinct backup destination.');
try { await stat(destination); throw new Error('Backup destination already exists. Choose a new filename.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const db = new DatabaseSync(source, { readOnly: true });
try { await backup(db, destination); await chmod(destination, 0o600); }
finally { db.close(); }
console.log('Consistent SQLite backup created.');
