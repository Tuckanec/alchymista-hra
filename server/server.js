const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const db = require('./db');
const bcrypt = require('bcrypt');

// CORS konfigurace pro produkci (Cloudflare Pages) i lokální vývoj
const allowedOrigins = [
    'https://alchymista-hra.pages.dev',
    'http://localhost:5173'
];

const corsOptions = {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true
};

const app = express();
app.use(cors(corsOptions)); // Povolí komunikaci z Cloudflare Pages a lokálního vývoje
app.use(express.json()); // Dovolí serveru číst req.body v JSON formátu

const server = http.createServer(app);

const io = new Server(server, {
    cors: corsOptions
});

// Paměť pro aktivní čekárny a hry
const activeRooms = {};

// Hlavní smyčka pro WebSockety – tady se bude dít veškerá alchymie
io.on('connection', (socket) => {
    console.log('🧪 Nový alchymista připojen, ID:', socket.id);

socket.on('createRoom', (userData, callback) => {
    const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
    
    // Vytvoříme záznam o místnosti v paměti serveru
    activeRooms[roomCode] = {
        host: userData.id,
        players: [userData] // Zakladatel je první hráč
    };
    
    socket.join(roomCode);
    socket.currentRoom = roomCode; // Uložíme si, kde hráč je, pro případ odpojení
    socket.userData = userData;
    
    console.log(`🏰 ${userData.prezdivka} založil místnost: ${roomCode}`);
    
    // Odpovíme klientovi a pošleme mu aktuální seznam hráčů
    callback({ success: true, roomCode, players: activeRooms[roomCode].players });
});

socket.on('joinRoom', ({ roomCode, userData }, callback) => {
    roomCode = roomCode.toUpperCase();
    const room = activeRooms[roomCode];
    
    if (room) {
        // Ochrana proti duplikátům (pokud by někdo klikal moc rychle)
        const isAlreadyIn = room.players.find(p => p.id === userData.id);
        if (!isAlreadyIn) {
            room.players.push(userData);
        }

        socket.join(roomCode);
        socket.currentRoom = roomCode;
        socket.userData = userData;
        
        console.log(`🚶 ${userData.prezdivka} vstoupil do: ${roomCode}`);
        
        // Rozpošleme VŠEM v místnosti (včetně nového) aktualizovaný seznam
        io.to(roomCode).emit('updatePlayers', room.players);
        
        callback({ success: true, roomCode, players: room.players });
    } else {
        callback({ success: false, error: 'Tato laboratoř neexistuje nebo už vybuchla.' });
    }
});

// Úklid, když někdo zavře okno prohlížeče
socket.on('disconnect', () => {
    const roomCode = socket.currentRoom;
    if (roomCode && activeRooms[roomCode]) {
        // Odstraníme hráče ze seznamu
        activeRooms[roomCode].players = activeRooms[roomCode].players.filter(
            p => p.id !== socket.userData.id
        );
        
        // Pokud v místnosti nikdo nezbyl, smažeme ji z paměti
        if (activeRooms[roomCode].players.length === 0) {
            delete activeRooms[roomCode];
            console.log(`💥 Místnost ${roomCode} byla zničena (prázdná).`);
        } else {
            // Jinak dáme ostatním vědět, že někdo odešel
            io.to(roomCode).emit('updatePlayers', activeRooms[roomCode].players);
        }
    }
});

    socket.on('disconnect', () => {
        console.log('💨 Alchymista se odpařil, ID:', socket.id);
    });
});

// Zapnutí serveru
// Použije port od Renderu, nebo 3001, pokud to spustíš lokálně
const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
    console.log(`Alchymistická laboratoř běží na portu ${PORT}`);
});

// POST endpoint pro registraci nového alchymisty
app.post('/api/register', async (req, res) => {
    const { prezdivka, email, heslo } = req.body;

    // 1. Základní validace
    if (!prezdivka || !email || !heslo) {
        return res.status(400).json({ error: 'Chybí ingredience. Vyplň všechna pole.' });
    }

    try {
        // 2. Hashování hesla (10 cyklů je bezpečný standard)
        const hesloHash = await bcrypt.hash(heslo, 10);

        // 3. Zápis do databáze (používáme ? pro ochranu proti SQL Injection)
        const [vysledek] = await db.execute(
            'INSERT INTO uzivatele (prezdivka, email, heslo_hash) VALUES (?, ?, ?)',
            [prezdivka, email, hesloHash]
        );

        // Úspěch
        res.status(201).json({ 
            message: 'Přísaha složena, vítej v cechu!', 
            userId: vysledek.insertId 
        });

    } catch (error) {
        // 4. Odchycení chyby (např. unikátní jméno/email už existuje)
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'Tato přezdívka nebo e-mail už v laboratoři existuje.' });
        }
        
        console.error('Chyba při registraci:', error);
        res.status(500).json({ error: 'Interní exploze kotlíku na serveru.' });
    }
});

// POST endpoint pro přihlášení alchymisty
app.post('/api/login', async (req, res) => {
    const { prezdivka, heslo } = req.body;

    // 1. Kontrola, zda hráč něco nevynechal
    if (!prezdivka || !heslo) {
        return res.status(400).json({ error: 'Musíš zadat přezdívku i heslo.' });
    }

    try {
        // 2. Hledání uživatele v databázi
        const [rows] = await db.execute(
            'SELECT id, prezdivka, heslo_hash, role FROM uzivatele WHERE prezdivka = ?',
            [prezdivka]
        );

        // Pokud databáze nic nevrátí, uživatel neexistuje
        if (rows.length === 0) {
            // Bezpečnostní pravidlo: Nikdy neříkej "Uživatel neexistuje", usnadňuje to útoky.
            return res.status(401).json({ error: 'Neplatná přezdívka nebo heslo.' });
        }

        const uzivatel = rows[0];

        // 3. Porovnání hesel přes bcrypt
        const hesloSouhlasi = await bcrypt.compare(heslo, uzivatel.heslo_hash);

        if (!hesloSouhlasi) {
            return res.status(401).json({ error: 'Neplatná přezdívka nebo heslo.' });
        }

        // 4. Úspěch - odesíláme data zpět Reactu
        res.status(200).json({
            message: 'Vítej zpět u kotlíku!',
            userId: uzivatel.id,
            role: uzivatel.role // Tohle využiješ pro zobrazení admin tlačítka
        });

    } catch (error) {
        console.error('Chyba při přihlášení:', error);
        res.status(500).json({ error: 'Interní exploze kotlíku na serveru.' });
    }
});