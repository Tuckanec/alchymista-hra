require('dotenv').config();
const mysql = require('mysql2/promise');

// Vytvoření fondu spojení
const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT,
    // Tento nový blok je kritický pro cloudové databáze (Aiven)
    ssl: {
        rejectUnauthorized: false
    }
});

// Testovací dotaz pro ověření připojení při startu
pool.getConnection()
    .then(connection => {
        console.log('📦 Databáze alchymistů úspěšně připojena.');
        connection.release();
    })
    .catch(err => {
        console.error('❌ Chyba připojení k databázi:', err.message);
    });

module.exports = pool;