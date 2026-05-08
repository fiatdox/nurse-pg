import mysql from 'mysql2/promise';
import postgres from 'postgres';

export const his = mysql.createPool({
    host: process.env.HIS_HOST,
    port: Number(process.env.HIS_PORT),
    user: process.env.HIS_USER,
    password: process.env.HIS_PASSWORD,
    database: process.env.HIS_NAME,
    waitForConnections: true,
    connectionLimit: 150,
    queueLimit: 0
});

export const core_kon = postgres({
    host: process.env.CORE_KON_HOST,
    port: Number(process.env.CORE_KON_PORT),
    user: process.env.CORE_KON_USER,
    password: process.env.CORE_KON_PASSWORD,
    database: process.env.CORE_KON_DB_NAME,
    connection: { search_path: process.env.CORE_KON_SCHEMA },
    max: 150,
    idle_timeout: 30,
});

export const nurse = postgres({
    host: process.env.NURSE_PG_HOST,
    port: Number(process.env.NURSE_PG_PORT),
    user: process.env.NURSE_PG_USER,
    password: process.env.NURSE_PG_PASSWORD,
    database: process.env.NURSE_PG_DB_NAME,
    connection: { search_path: process.env.NURSE_PG_SCHEMA },
    max: 150,
    idle_timeout: 30,
});