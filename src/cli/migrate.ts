import { loadConfig } from '../config.ts';
import { openDatabase, schemaVersion } from '../db/database.ts';

const config = loadConfig();
const db = openDatabase(config.paths.database);
console.log(`Database up to date: ${config.paths.database} (schema v${schemaVersion(db)})`);
db.close();
