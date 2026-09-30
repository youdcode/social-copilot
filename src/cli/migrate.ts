import { loadConfig } from '../config.ts';
import { openDatabase, schemaVersion } from '../db/database.ts';

const config = loadConfig();
const db = openDatabase(config.paths.database);
console.log(`Base à jour : ${config.paths.database} (schéma v${schemaVersion(db)})`);
db.close();
