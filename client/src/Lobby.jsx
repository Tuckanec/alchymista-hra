import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from './supabaseClient';
import GameBoard from './GameBoard';
import './Lobby.css';

export default function Lobby({ user, onLogout, showToast }) {
    const [joinCode, setJoinCode] = useState('');
    const [roomName, setRoomName] = useState('');
    const [currentRoomName, setCurrentRoomName] = useState('');
    const [startingPlayerId, setStartingPlayerId] = useState('');
    const [currentRoom, setCurrentRoom] = useState(null);
    const [isHost, setIsHost] = useState(false);
    const [myPlayerStatus, setMyPlayerStatus] = useState(null); // 'pending' | 'approved' | null
    const [roomStatus, setRoomStatus] = useState('waiting'); // 'waiting' | 'playing'
    const [players, setPlayers] = useState([]);
    const [activeRooms, setActiveRooms] = useState([]);
    const [loading, setLoading] = useState(false);
    const [checkingRoom, setCheckingRoom] = useState(Boolean(user?.id));

    // Reference pro předcházení duplicitním notifikacím o schválení
    const prevStatusRef = useRef(null);

    const notify = useCallback((msg, type = 'info') => {
        if (showToast) {
            showToast(msg, type);
        } else {
            console.log(`[Toast ${type}]:`, msg);
        }
    }, [showToast]);

    // =========================================================
    // 0. AUTOMATICKÝ RECONNECT PO OBNOVENÍ STRÁNKY (F5)
    // =========================================================
    useEffect(() => {
        if (!user?.id) return;

        let isCancelled = false;

        const checkActiveRoom = async () => {
            try {
                const { data, error } = await supabase
                    .from('room_players')
                    .select('*')
                    .eq('player_id', Number(user.id))
                    .order('joined_at', { ascending: false })
                    .limit(1)
                    .maybeSingle();

                if (error) {
                    console.error('Chyba při auto-reconnectu do laboratoře:', error);
                } else if (!isCancelled && data) {
                    prevStatusRef.current = data.status;
                    setMyPlayerStatus(data.status);
                    setIsHost(!!data.is_host);
                    setCurrentRoom(data.room_code);

                    // Načteme i název laboratoře
                    const { data: roomData } = await supabase
                        .from('rooms')
                        .select('room_name')
                        .eq('room_code', data.room_code)
                        .maybeSingle();

                    if (!isCancelled && roomData?.room_name) {
                        setCurrentRoomName(roomData.room_name);
                    }

                    notify(`Návrat do laboratoře ${data.room_code}.`, 'info');
                }
            } catch (err) {
                console.error('Chyba při automatickém reconnectu do laboratoře:', err);
            } finally {
                if (!isCancelled) {
                    setCheckingRoom(false);
                }
            }
        };

        checkActiveRoom();

        return () => {
            isCancelled = true;
        };
    }, [user, notify]);

    // =========================================================
    // 1. NAČTENÍ AKTIVNÍCH LABORATOŘÍ A REALTIME ODBĚR 'rooms'
    // =========================================================
    useEffect(() => {
        let isCancelled = false;

        const fetchRooms = async () => {
            try {
                // Supabase implicitní join přes cizí klíč host_id -> uzivatele(id)
                const { data, error } = await supabase
                    .from('rooms')
                    .select('*, uzivatele(prezdivka)')
                    .order('created_at', { ascending: false });

                if (!isCancelled && !error && data) {
                    setActiveRooms(data);
                }
            } catch (err) {
                console.error('Chyba při načítání laboratoří:', err);
            }
        };

        fetchRooms();

        const roomsChannel = supabase
            .channel('realtime_active_rooms')
            .on(
                'postgres_changes',
                { event: '*', schema: 'public', table: 'rooms' },
                () => {
                    fetchRooms();
                }
            )
            .subscribe();

        return () => {
            isCancelled = true;
            supabase.removeChannel(roomsChannel);
        };
    }, []);

    // =========================================================
    // 2. REALTIME ODBĚR HRÁČŮ PRO AKTUÁLNÍ MÍSTNOST
    // =========================================================
    useEffect(() => {
        if (!currentRoom) {
            prevStatusRef.current = null;
            return;
        }

        let isCancelled = false;

        const fetchPlayers = async () => {
            try {
                // Supabase implicitní join přes cizí klíč player_id -> uzivatele(id)
                const { data, error } = await supabase
                    .from('room_players')
                    .select('*, uzivatele(prezdivka)')
                    .eq('room_code', currentRoom)
                    .order('joined_at', { ascending: true });

                if (error) {
                    console.error('Chyba při načítání hráčů:', error);
                    return;
                }

                if (!isCancelled && data) {
                    setPlayers(data);

                    // Zjistíme stav přihlášeného hráče
                    const me = data.find((p) => Number(p.player_id) === Number(user.id));
                    if (me) {
                        setIsHost(!!me.is_host);

                        // Notifikace při změně ze stavu 'pending' na 'approved'
                        if (prevStatusRef.current === 'pending' && me.status === 'approved') {
                            notify('Tvoje žádost byla schválena! Vítej v laboratoři.', 'success');
                        }
                        prevStatusRef.current = me.status;
                        setMyPlayerStatus(me.status);
                    } else {
                        // Hráč v místnosti již neexistuje (byl vyhozen správcem nebo byla místnost zrušena)
                        if (prevStatusRef.current === 'pending') {
                            notify('Správce zamítl tvoji žádost o vstup do laboratoře.', 'error');
                        } else if (prevStatusRef.current === 'approved') {
                            notify('Byl jsi vyhozen z laboratoře.', 'error');
                        }
                        prevStatusRef.current = null;
                        setCurrentRoom(null);
                        setPlayers([]);
                        setIsHost(false);
                        setMyPlayerStatus(null);
                    }
                }
            } catch (err) {
                console.error('Chyba při komunikaci se Supabase:', err);
            }
        };

        fetchPlayers();

        const roomChannel = supabase
            .channel(`room_${currentRoom}`)
            .on(
                'postgres_changes',
                {
                    event: '*',
                    schema: 'public',
                    table: 'room_players',
                    filter: `room_code=eq.${currentRoom}`
                },
                () => {
                    fetchPlayers();
                }
            )
            .subscribe();

        return () => {
            isCancelled = true;
            supabase.removeChannel(roomChannel);
        };
    }, [currentRoom, user.id, notify]);

    // =========================================================
    // 2b. ODBĚR STAVU MÍSTNOSTI (WAITING / PLAYING)
    // =========================================================
    useEffect(() => {
        if (!currentRoom) return;

        let isCancelled = false;

        const fetchRoomStatus = async () => {
            try {
                const { data, error } = await supabase
                    .from('rooms')
                    .select('status, game_status, room_name')
                    .eq('room_code', currentRoom)
                    .maybeSingle();

                if (!isCancelled && !error && data) {
                    const st = data.game_status || data.status;
                    if (st) {
                        setRoomStatus(st);
                    }
                    if (data.room_name) {
                        setCurrentRoomName(data.room_name);
                    }
                }
            } catch (err) {
                console.error('Chyba při načítání stavu místnosti:', err);
            }
        };

        fetchRoomStatus();

        const roomStatusChannel = supabase
            .channel(`room_status_${currentRoom}`)
            .on(
                'postgres_changes',
                {
                    event: 'UPDATE',
                    schema: 'public',
                    table: 'rooms',
                    filter: `room_code=eq.${currentRoom}`
                },
                (payload) => {
                    if (payload.new) {
                        const st = payload.new.game_status || payload.new.status;
                        if (st) {
                            setRoomStatus(st);
                        }
                        if (payload.new.room_name) {
                            setCurrentRoomName(payload.new.room_name);
                        }
                    }
                }
            )
            .on(
                'postgres_changes',
                {
                    event: 'DELETE',
                    schema: 'public',
                    table: 'rooms',
                    filter: `room_code=eq.${currentRoom}`
                },
                () => {
                    notify('Hra byla zrušena, všichni ostatní alchymisté utekli.', 'error');
                    prevStatusRef.current = null;
                    setCurrentRoom(null);
                    setPlayers([]);
                    setIsHost(false);
                    setMyPlayerStatus(null);
                    setRoomStatus('waiting');
                }
            )
            .subscribe();

        return () => {
            isCancelled = true;
            supabase.removeChannel(roomStatusChannel);
        };
    }, [currentRoom, notify]);

    // =========================================================
    // 3. ZALOŽENÍ NOVÉ LABORATOŘE
    // =========================================================
    const handleCreateRoom = async (e) => {
        if (e && e.preventDefault) e.preventDefault();

        if (!user || !user.id || isNaN(Number(user.id))) {
            notify('Neplatná relace uživatele. Prosím obnov stránku (Ctrl+F5) a přihlas se znovu.', 'error');
            return;
        }

        setLoading(true);
        try {
            const newCode = Math.random().toString(36).substring(2, 6).toUpperCase();
            const formattedName = roomName.trim() || `Laboratoř ${newCode}`;

            // 1. Vložení místnosti do tabulky 'rooms' včetně nového sloupce room_name
            const { error: roomError } = await supabase
                .from('rooms')
                .insert([
                    {
                        room_code: newCode,
                        host_id: Number(user.id),
                        status: 'waiting',
                        game_status: 'waiting',
                        room_name: formattedName
                    }
                ]);

            if (roomError) {
                console.error('Chyba při zakládání místnosti:', roomError);
                notify('Nepodařilo se založit laboratoř: ' + roomError.message, 'error');
                return;
            }

            // 2. Vložení zakladatele jako schváleného správce
            const { error: playerError } = await supabase
                .from('room_players')
                .insert([
                    {
                        room_code: newCode,
                        player_id: Number(user.id),
                        is_guest: !!user.isGuest,
                        is_host: true,
                        status: 'approved',
                        is_dead: false
                    }
                ]);

            if (playerError) {
                console.error('Chyba při zápisu hráče:', playerError);
                notify('Chyba při vstupu do laboratoře: ' + playerError.message, 'error');
                return;
            }

            prevStatusRef.current = 'approved';
            setMyPlayerStatus('approved');
            setIsHost(true);
            setCurrentRoom(newCode);
            setCurrentRoomName(formattedName);
            setRoomName('');
            notify(`Laboratoř "${formattedName}" (${newCode}) byla úspěšně vytvořena.`, 'success');
        } catch (err) {
            console.error('Neočekávaná chyba při tvorbě místnosti:', err);
            notify('Chyba spojení se Supabase.', 'error');
        } finally {
            setLoading(false);
        }
    };

    // =========================================================
    // 4. PŘIPOJENÍ / ŽÁDOST O VSTUP DO LABORATOŘE
    // =========================================================
    const joinLaboratoryByCode = async (targetCode) => {
        const code = targetCode.trim().toUpperCase();
        if (!code) return;

        if (!user || !user.id || isNaN(Number(user.id))) {
            notify('Neplatná relace uživatele. Prosím obnov stránku (Ctrl+F5) a přihlas se znovu.', 'error');
            return;
        }

        setLoading(true);
        try {
            // 1. Ověření existence místnosti
            const { data: room, error: roomError } = await supabase
                .from('rooms')
                .select('*')
                .eq('room_code', code)
                .maybeSingle();

            if (roomError) {
                console.error('Chyba při vyhledání místnosti:', roomError);
                notify('Chyba vyhledávání: ' + roomError.message, 'error');
                return;
            }

            if (!room) {
                notify('Tato laboratoř neexistuje nebo již byla zrušena.', 'error');
                return;
            }

            // 2. Kontrola, zda hráč již v místnosti není
            const { data: existing, error: existingError } = await supabase
                .from('room_players')
                .select('*, uzivatele(prezdivka)')
                .eq('room_code', code)
                .eq('player_id', Number(user.id))
                .maybeSingle();

            if (existingError) {
                console.error('Chyba při kontrole hráče:', existingError);
            }

            if (existing) {
                // Hráč už záznam má, použijeme existující stav
                prevStatusRef.current = existing.status;
                setMyPlayerStatus(existing.status);
                setIsHost(!!existing.is_host);
                setCurrentRoom(code);
                setJoinCode('');
                if (existing.status === 'approved') {
                    notify(`Vstup do laboratoře ${code}.`, 'success');
                } else {
                    notify(`Čekáš na schválení do laboratoře ${code}.`, 'info');
                }
                return;
            }

            // Pokud je hráč původní zakladatel místnosti podle rooms tabulky, rovnou approved host
            const isOriginalHost = Number(room.host_id) === Number(user.id);
            const initialStatus = isOriginalHost ? 'approved' : 'pending';

            const { error: joinError } = await supabase
                .from('room_players')
                .insert([
                    {
                        room_code: code,
                        player_id: Number(user.id),
                        is_guest: !!user.isGuest,
                        is_host: isOriginalHost,
                        status: initialStatus
                    }
                ]);

            if (joinError) {
                console.error('Chyba při žádosti o připojení:', joinError);
                notify('Nepodařilo se odeslat žádost: ' + joinError.message, 'error');
                return;
            }

            prevStatusRef.current = initialStatus;
            setMyPlayerStatus(initialStatus);
            setIsHost(isOriginalHost);
            setCurrentRoom(code);
            setJoinCode('');

            if (initialStatus === 'approved') {
                notify(`Vstup do laboratoře ${code}.`, 'success');
            } else {
                notify(`Žádost o vstup do laboratoře ${code} byla odeslána.`, 'info');
            }
        } catch (err) {
            console.error('Neočekávaná chyba při vstupu:', err);
            notify('Chyba spojení se Supabase.', 'error');
        } finally {
            setLoading(false);
        }
    };

    const handleJoinFormSubmit = (e) => {
        e.preventDefault();
        joinLaboratoryByCode(joinCode);
    };

    // =========================================================
    // 5. SCHVALOVÁNÍ A ODMÍTÁNÍ ŽÁDOSTÍ (HOST ACTIONS)
    // =========================================================
    const handleApprovePlayer = async (targetPlayer) => {
        const playerName = targetPlayer.uzivatele?.prezdivka || 'Učedník';
        try {
            const { error } = await supabase
                .from('room_players')
                .update({ status: 'approved' })
                .eq('id', targetPlayer.id);

            if (error) {
                notify('Chyba při schvalování: ' + error.message, 'error');
            } else {
                notify(`Učedník ${playerName} byl schválen.`, 'success');
            }
        } catch (err) {
            console.error('Chyba při schvalování:', err);
        }
    };

    const handleRejectPlayer = async (targetPlayer) => {
        const playerName = targetPlayer.uzivatele?.prezdivka || 'Učedník';
        try {
            const { error } = await supabase
                .from('room_players')
                .delete()
                .eq('id', targetPlayer.id);

            if (error) {
                notify('Chyba při zamítnutí: ' + error.message, 'error');
            } else {
                notify(`Žádost hráče ${playerName} byla zamítnuta.`, 'info');
            }
        } catch (err) {
            console.error('Chyba při zamítnutí:', err);
        }
    };

    // =========================================================
    // 5b. VYKOPNUTÍ HRÁČE / DUCHA (KICK PLAYER)
    // =========================================================
    const handleKickPlayer = async (targetPlayer) => {
        const playerName = targetPlayer.uzivatele?.prezdivka || 'Hráč';
        try {
            const { error } = await supabase
                .from('room_players')
                .delete()
                .eq('id', targetPlayer.id);

            if (error) {
                notify('Chyba při vyhazování hráče: ' + error.message, 'error');
            } else {
                notify(`Hráč ${playerName} byl vykázán z laboratoře.`, 'info');
            }
        } catch (err) {
            console.error('Chyba při kicku hráče:', err);
        }
    };

    // =========================================================
    // 5c. VÝBĚR NÁHODNÉHO ZAČÍNAJÍCÍHO HRÁČE
    // =========================================================
    const handleSelectRandomPlayer = () => {
        if (approvedPlayers.length === 0) return;
        const randomIndex = Math.floor(Math.random() * approvedPlayers.length);
        const chosen = approvedPlayers[randomIndex];
        setStartingPlayerId(String(chosen.player_id));
        const chosenName = chosen.uzivatele?.prezdivka || 'Učedník';
        notify(`Začínající hráč náhodně vybrán: ${chosenName}`, 'info');
    };

    // =========================================================
    // 5d. ZAHÁJENÍ HRY (HOST ACTION)
    // =========================================================
    const handleStartGame = async () => {
        if (!isHost || !currentRoom) return;

        // Tlačítko a spuštění je platné, pokud je v místnosti alespoň jeden další approved hráč
        const otherApprovedPlayers = approvedPlayers.filter(
            (p) => Number(p.player_id) !== Number(user.id)
        );

        if (otherApprovedPlayers.length < 1) {
            notify('K zahájení hry je potřeba alespoň jeden další schválený hráč.', 'error');
            return;
        }

        try {
            // Vygeneruje pole: 25 řetězců 'safe' a 2 řetězce 'killer'. Pole náhodně zamíchej (shuffle).
            const deck = [...Array(25).fill('safe'), ...Array(2).fill('killer')];
            for (let i = deck.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [deck[i], deck[j]] = [deck[j], deck[i]];
            }

            // Určení začínajícího hráče: ID z dropdownu nebo ID hosta
            let chosenPlayerId = Number(startingPlayerId);
            if (!chosenPlayerId || !approvedPlayers.some((p) => Number(p.player_id) === chosenPlayerId)) {
                chosenPlayerId = Number(user.id);
            }

            // Reset is_dead pro všechny schválené hráče
            await supabase
                .from('room_players')
                .update({ is_dead: false })
                .eq('room_code', currentRoom);

            // Update tabulky rooms: ulož zamíchané pole do deck, game_status = 'playing', current_turn_player_id
            const { error } = await supabase
                .from('rooms')
                .update({
                    deck,
                    game_status: 'playing',
                    status: 'playing',
                    current_turn_player_id: chosenPlayerId
                })
                .eq('room_code', currentRoom);

            if (error) {
                notify('Nepodařilo se zahájit hru: ' + error.message, 'error');
            } else {
                setRoomStatus('playing');
                const startingPlayer = approvedPlayers.find((p) => Number(p.player_id) === chosenPlayerId);
                const startingName = startingPlayer?.uzivatele?.prezdivka || 'Zvolený alchymista';
                notify(`Hra byla zahájena! Začíná ${startingName}.`, 'success');
            }
        } catch (err) {
            console.error('Chyba při zahájení hry:', err);
        }
    };

    // =========================================================
    // 6. OPUŠTĚNÍ LABORATOŘE & PŘEDÁVÁNÍ SPRÁVCOVSTVÍ (HOST TRANSFER)
    // =========================================================
    const handleLeaveRoom = async (silent = false) => {
        if (!currentRoom) return;
        const isSilent = silent === true;

        try {
            // 1. Zjistíme ostatní hráče v této laboratoři
            const { data: otherPlayers, error: fetchErr } = await supabase
                .from('room_players')
                .select('*')
                .eq('room_code', currentRoom)
                .neq('player_id', Number(user.id))
                .order('joined_at', { ascending: true });

            if (fetchErr) {
                console.error('Chyba při zjišťování hráčů:', fetchErr);
            }

            const remaining = otherPlayers || [];

            if (isHost) {
                if (remaining.length > 0) {
                    // Najdeme nejstaršího 'approved' hráče (pokud žádný approved není, vezmeme nejstaršího)
                    const nextHost = remaining.find((p) => p.status === 'approved') || remaining[0];

                    // Povýšíme hráče na hosta (a schválíme ho)
                    await supabase
                        .from('room_players')
                        .update({ is_host: true, status: 'approved' })
                        .eq('id', nextHost.id);

                    // Aktualizujeme záznam v tabulce 'rooms' (pouze host_id)
                    await supabase
                        .from('rooms')
                        .update({ host_id: Number(nextHost.player_id) })
                        .eq('room_code', currentRoom);

                    // Smažeme odcházejícího hosta
                    await supabase
                        .from('room_players')
                        .delete()
                        .eq('room_code', currentRoom)
                        .eq('player_id', Number(user.id));
                } else {
                    // V místnosti nezůstal nikdo -> smažeme hráče i celou místnost z rooms
                    await supabase
                        .from('room_players')
                        .delete()
                        .eq('room_code', currentRoom)
                        .eq('player_id', Number(user.id));

                    await supabase
                        .from('rooms')
                        .delete()
                        .eq('room_code', currentRoom);
                }
            } else {
                // Běžný hráč (nebo čekající žádost)
                await supabase
                    .from('room_players')
                    .delete()
                    .eq('room_code', currentRoom)
                    .eq('player_id', Number(user.id));

                // Pokud byl poslední hráč v místnosti, místnost také smažeme
                if (remaining.length === 0) {
                    await supabase
                        .from('rooms')
                        .delete()
                        .eq('room_code', currentRoom);
                }
            }

            if (!isSilent) {
                notify('Laboratoř opuštěna.', 'info');
            }
        } catch (err) {
            console.error('Chyba při opouštění místnosti:', err);
        } finally {
            prevStatusRef.current = null;
            setCurrentRoom(null);
            setPlayers([]);
            setIsHost(false);
            setMyPlayerStatus(null);
            setRoomStatus('waiting');
        }
    };

    const handleLogoutClick = async () => {
        if (currentRoom) {
            await handleLeaveRoom();
        }
        if (onLogout) {
            onLogout();
        }
    };

    // Filtrovaní hráči pro zobrazení
    const approvedPlayers = players.filter((p) => p.status === 'approved');
    const pendingPlayers = players.filter((p) => p.status === 'pending');

    // =========================================================
    // UI: KONTROLA AKTIVNÍ RELACE PO OBNOVENÍ (F5)
    // =========================================================
    if (checkingRoom) {
        return (
            <div className="lobby-wrapper">
                <div className="lobby-card">
                    <p style={{ color: '#9ca3af', fontSize: '14px', margin: '24px 0' }}>
                        Ověřuji stav laboratoře...
                    </p>
                </div>
            </div>
        );
    }

    // =========================================================
    // UI: ČEKÁRNA PRO NEZCHVÁLENÉHO UČEDNÍKA (PENDING SCREEN)
    // =========================================================
    if (currentRoom && myPlayerStatus === 'pending') {
        return (
            <div className="lobby-wrapper">
                <div className="lobby-card">
                    <div className="room-header">
                        <div className="room-status-badge pending-badge">Čekání na schválení</div>
                        <div className="room-code-tag">{currentRoom}</div>
                        <h3 className="pending-title">Čekám na schválení správcem...</h3>
                        <p className="pending-desc">
                            Správce laboratoře obdržel tvoji žádost. Vyčkej, dokud ti neodemkne vstup k alchymistickému stolu.
                        </p>
                    </div>

                    <div className="room-actions">
                        <button 
                            type="button" 
                            onClick={handleLeaveRoom}
                            className="btn-leave"
                        >
                            Zrušit žádost
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    // =========================================================
    // UI: VNITŘEK LABORATOŘE (SCHVÁLENÝ HRÁČ / SPRÁVCE)
    // =========================================================
    if (currentRoom && myPlayerStatus === 'approved') {
        // Pokud hra již začala, zobrazíme herní desku GameBoard
        if (roomStatus === 'playing' || roomStatus === 'finished') {
            return (
                <GameBoard
                    roomCode={currentRoom}
                    roomName={currentRoomName}
                    user={user}
                    isHost={isHost}
                    players={approvedPlayers}
                    onLeaveRoom={handleLeaveRoom}
                    showToast={showToast}
                />
            );
        }

        // Jinak zobrazíme čekárnu v laboratoři před spuštěním vaření
        return (
            <div className="lobby-wrapper">
                <div className="lobby-card">
                    <div className="room-header">
                        <div className="room-code-label">Kód laboratoře</div>
                        <div className="room-code-tag">{currentRoom}</div>
                        {currentRoomName && (
                            <h2 className="room-name-heading">{currentRoomName}</h2>
                        )}
                        <p className="room-share-hint">
                            Sdílej tento kód s ostatními učedníky
                        </p>
                    </div>

                    {/* Sekce čekajících učedníků pro hosta */}
                    {isHost && (
                        <div className="room-pending-box">
                            <div className="room-players-header">
                                <h3>Čekající učedníci ({pendingPlayers.length})</h3>
                                {pendingPlayers.length > 0 && (
                                    <span className="badge-pending-count">Žádosti</span>
                                )}
                            </div>

                            {pendingPlayers.length === 0 ? (
                                <p className="empty-subtext">Žádné nevyřízené žádosti o vstup.</p>
                            ) : (
                                <ul className="pending-list">
                                    {pendingPlayers.map((p) => {
                                        const playerName = p.uzivatele?.prezdivka || 'Učedník';
                                        return (
                                            <li key={p.id} className="pending-item">
                                                <div className="pending-item-info">
                                                    <span className="pending-name">{playerName}</span>
                                                    {p.is_guest && <span className="badge-guest">Host</span>}
                                                </div>
                                                <div className="pending-item-actions">
                                                    <button
                                                        type="button"
                                                        onClick={() => handleApprovePlayer(p)}
                                                        className="btn-approve"
                                                        title="Povolit vstup"
                                                    >
                                                        Schválit
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => handleRejectPlayer(p)}
                                                        className="btn-reject"
                                                        title="Odmítnout žádost"
                                                    >
                                                        Odmítnout
                                                    </button>
                                                </div>
                                            </li>
                                        );
                                    })}
                                </ul>
                            )}
                        </div>
                    )}

                    {/* Učedníci u kotlíku v místnosti */}
                    <div className="room-players-box">
                        <div className="room-players-header">
                            <h3>Učedníci u kotlíku ({approvedPlayers.length})</h3>
                            <span className="realtime-pill">Realtime</span>
                        </div>

                        <ul className="player-list">
                            {approvedPlayers.map((p) => {
                                const isMe = Number(p.player_id) === Number(user.id);
                                const playerName = p.uzivatele?.prezdivka || 'Alchymista';
                                return (
                                    <li key={p.id || p.player_id} className="player-item">
                                        <span>
                                            {p.is_host ? '👑 ' : ''}
                                            {playerName}
                                            {isMe && <span className="player-me">(Ty)</span>}
                                        </span>
                                        <div className="player-item-meta">
                                            {p.is_guest && <span className="badge-guest">Host</span>}
                                            {isHost && !isMe && (
                                                <button
                                                    type="button"
                                                    onClick={() => handleKickPlayer(p)}
                                                    className="btn-kick"
                                                    title={`Vykopnout hráče ${playerName}`}
                                                    aria-label={`Vykopnout hráče ${playerName}`}
                                                >
                                                    ❌
                                                </button>
                                            )}
                                        </div>
                                    </li>
                                );
                            })}
                        </ul>

                        {isHost && (
                            <p className="host-role-notice">Jsi správcem této laboratoře.</p>
                        )}
                    </div>

                    {/* Volba začínajícího hráče pro hosta */}
                    {isHost && approvedPlayers.length >= 2 && (
                        <div className="starting-player-box">
                            <label htmlFor="starting-player-select" className="starting-player-label">
                                🎲 Začínající hráč:
                            </label>
                            <div className="starting-player-controls">
                                <select
                                    id="starting-player-select"
                                    value={startingPlayerId || (approvedPlayers[0] ? String(approvedPlayers[0].player_id) : '')}
                                    onChange={(e) => setStartingPlayerId(e.target.value)}
                                    className="starting-player-select"
                                    aria-label="Výběr začínajícího hráče"
                                >
                                    {approvedPlayers.map((p) => {
                                        const pName = p.uzivatele?.prezdivka || 'Alchymista';
                                        const isMe = Number(p.player_id) === Number(user.id);
                                        return (
                                            <option key={p.id || p.player_id} value={String(p.player_id)}>
                                                {pName} {isMe ? '(Ty / Host)' : ''}
                                            </option>
                                        );
                                    })}
                                </select>
                                <button
                                    type="button"
                                    onClick={handleSelectRandomPlayer}
                                    className="btn-random-player"
                                    title="Vybrat začínajícího hráče náhodně"
                                >
                                    Vybrat náhodně
                                </button>
                            </div>
                        </div>
                    )}

                    <div className="room-actions">
                        {isHost && approvedPlayers.filter((p) => Number(p.player_id) !== Number(user.id)).length >= 1 && (
                            <button
                                type="button"
                                onClick={handleStartGame}
                                className="btn-start-game"
                            >
                                Zahájit hru
                            </button>
                        )}

                        <button 
                            type="button" 
                            onClick={handleLeaveRoom}
                            className="btn-leave"
                        >
                            Opustit laboratoř
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    // =========================================================
    // UI: HLAVNÍ NABÍDKA LOBBY (VÝBĚR MÍSTNOSTI / ZALOŽENÍ)
    // =========================================================
    return (
        <div className="lobby-wrapper">
            <div className="lobby-topbar">
                <div className="lobby-user-info">
                    <span>Hráč:</span>
                    <span className="lobby-user-name">{user.prezdivka}</span>
                    {user.isGuest && <span className="badge-guest">Host</span>}
                </div>

                {onLogout && (
                    <button 
                        type="button"
                        onClick={handleLogoutClick}
                        className="btn-logout"
                    >
                        Odhlásit se
                    </button>
                )}
            </div>

            <div className="lobby-card">
                <h2 className="lobby-title">Alchymistická dílna</h2>
                <p className="lobby-subtitle">Vyber si aktivní laboratoř ze seznamu, zadej PIN nebo založ novou.</p>

                <form onSubmit={handleCreateRoom} className="create-room-form">
                    <input 
                        type="text" 
                        placeholder="Název laboratoře (např. Temná komnata)" 
                        value={roomName}
                        onChange={(e) => setRoomName(e.target.value)}
                        disabled={loading}
                        className="room-name-input"
                        aria-label="Název laboratoře"
                        maxLength={40}
                    />
                    <button 
                        type="submit"
                        disabled={loading}
                        className="btn-create-room"
                    >
                        {loading ? 'Vytvářím...' : 'Založit novou laboratoř'}
                    </button>
                </form>

                <div className="join-section">
                    <form onSubmit={handleJoinFormSubmit} className="join-form">
                        <input 
                            type="text" 
                            placeholder="PIN KÓD" 
                            value={joinCode}
                            onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                            maxLength={6}
                            disabled={loading}
                            className="pin-input"
                            aria-label="Kód laboratoře"
                        />
                        <button 
                            type="submit" 
                            disabled={loading || !joinCode}
                            className="btn-join"
                        >
                            Připojit se
                        </button>
                    </form>
                </div>

                {/* Seznam aktivních laboratoří v reálném čase */}
                <div className="active-rooms-section">
                    <div className="active-rooms-header">
                        <h3>Aktivní laboratoře ({activeRooms.length})</h3>
                        <span className="realtime-pill">Live</span>
                    </div>

                    {activeRooms.length === 0 ? (
                        <p className="empty-rooms-text">Aktuálně není otevřena žádná laboratoř. Buď první!</p>
                    ) : (
                        <ul className="active-rooms-list">
                            {activeRooms.map((room) => {
                                const hostDisplayName = room.uzivatele?.prezdivka || 'Neznámý';
                                return (
                                    <li key={room.id || room.room_code} className="active-room-item">
                                        <div className="active-room-info">
                                            <div className="active-room-code">{room.room_code}</div>
                                            {room.room_name && (
                                                <div className="active-room-name">{room.room_name}</div>
                                            )}
                                            <div className="active-room-host">
                                                Správce: <strong>{hostDisplayName}</strong>
                                            </div>
                                        </div>
                                        <button
                                            type="button"
                                            disabled={loading}
                                            onClick={() => joinLaboratoryByCode(room.room_code)}
                                            className="btn-room-enter"
                                        >
                                            Požádat o vstup
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </div>
            </div>
        </div>
    );
}