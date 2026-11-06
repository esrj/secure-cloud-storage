/**
 * This file handles database for ABSE parameters and user attributes
 */
import Database from "better-sqlite3";
import { logger } from "./Logger.js";

const db = new Database("data/TA.db", /*{ verbose: console.log }*/);
// Global/private parameters for ABSE
db.prepare(
  `CREATE TABLE IF NOT EXISTS params (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alpha TEXT not null,
    beta TEXT not null,
    g1 TEXT not null,
    g2 TEXT not null,
    eggalpha TEXT not null,
    h TEXT not null
    );`
).run();
// Global/private parameters for ABSE in arrays
db.prepare(
  `CREATE TABLE IF NOT EXISTS array_params (
    id INTEGER not null PRIMARY KEY,
    u TEXT not null,
    s TEXT not null,
    h_i TEXT not null
    );`
).run();
export const insertParams = db.prepare(
  `INSERT INTO params (alpha, beta, g1, g2, eggalpha, h) VALUES (?, ?, ?, ?, ?, ?);`
);
export const getParams = db.prepare(`SELECT * FROM params;`);
export const insertArrayParams = db.prepare(
  `INSERT INTO array_params (id, u, s, h_i) VALUES (?, ?, ?, ?);`
);
export const getArrayParams = db.prepare(`SELECT * FROM array_params;`);
export const getAttributeArrayParams = db.prepare(`SELECT id, u FROM array_params;`)
export const getArrayParamsCount = db.prepare(`SELECT COUNT(id) as count FROM array_params;`)

db.prepare(
    `CREATE TABLE IF NOT EXISTS user_attr (
    userid TEXT not null,
    attrid INTEGER not null,
    PRIMARY KEY (userid, attrid)   
    );`
).run()
export const getUserAttrIds = db.prepare(`SELECT attrid FROM user_attr WHERE userid = ?;`)
export const insertUserAttrId = db.prepare(`INSERT INTO user_attr (userid, attrid) VALUES (?, ?);`)

logger.info(`Database initialized.`)