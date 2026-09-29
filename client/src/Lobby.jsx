import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from './supabaseClient';
import GameBoard from './GameBoard';
import Auth from './Auth';
import './Lobby.css';

export default function Lobby({ user, onLogin, onLogout, showToast }) {
    const [joinCode, setJoinCode] = useState('');
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

    // Navigace v postranním panelu a modální okno pro tvorbu laboratoře / přihlášení
    const [activeNav, setActiveNav] = useState('lobby'); // 'lobby' | 'profile' | 'stats'
    const [sidebarOpen, setSidebarOpen] = useState(false);
    const [showCreateModal, setShowCreateModal] = useState(false);
    const [showAuthModal, setShowAuthModal] = useState(false);
    const [modalRoomName, setModalRoomName] = useState('');
    const [modalIsPublic, setModalIsPublic] = useState(true);

    // Losovací animace začínajícího hráče
    const [isRollingStartingPlayer, setIsRollingStartingPlayer] = useState(false);
    const [rollingPlayer, setRollingPlayer] = useState(null);
    const [isRollFinished, setIsRollFinished] = useState(false);
    const rollTimeoutsRef = useRef([]);

    useEffect(() => {
        return () => {
            rollTimeoutsRef.current.forEach(clearTimeout);
        };
    }, []);

    // Reference pro předcházení duplicitním notifikacím o schválení
    const prevStatusRef = useRef(null);

    const notify = useCallback((msg, type = 'info') => {
        if (showToast) {
            showToast(msg, type);
        } else {
            console.log(`[Toast ${type}]:`, msg);
        }
    }, [showToast]);

    // Filtrovaní hráči a určení začínajícího hráče
    const approvedPlayers = players.filter((p) => p.status === 'approved');
    const pendingPlayers = players.filter((p) => p.status === 'pending');
    const hostPlayer = approvedPlayers.find((p) => p.is_host);
    const effectiveStartingPlayerId = startingPlayerId && approvedPlayers.some((p) => String(p.player_id) === String(startingPlayerId))
        ? String(startingPlayerId)
        : (hostPlayer ? String(hostPlayer.player_id) : (approvedPlayers[0] ? String(approvedPlayers[0].player_id) : ''));

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
                // POUZE VEŘEJNÉ MÍSTNOSTI (.eq('is_public', true))
                const { data, error } = await supabase
                    .from('rooms')
                    .select('*, uzivatele(prezdivka)')
                    .eq('is_public', true)
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
                    const me = data.find((p) => Number(p.player_id) === Number(user?.id));
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
    }, [currentRoom, user?.id, notify]);

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
                    .select('status, game_status, room_name, current_turn_player_id')
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
                    if (data.current_turn_player_id) {
                        setStartingPlayerId(String(data.current_turn_player_id));
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
                        if (payload.new.current_turn_player_id) {
                            setStartingPlayerId(String(payload.new.current_turn_player_id));
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
    // 3. ZALOŽENÍ NOVÉ LABORATOŘE (PŘES MODÁLNÍ OKNO)
    // =========================================================
    const handleCreateRoomSubmit = async (e) => {
        if (e && e.preventDefault) e.preventDefault();

        if (!user || !user.id || isNaN(Number(user.id))) {
            notify('Neplatná relace uživatele. Prosím obnov stránku (Ctrl+F5) a přihlas se znovu.', 'error');
            return;
        }

        setLoading(true);
        try {
            const newCode = Math.random().toString(36).substring(2, 6).toUpperCase();
            const defaultPartyName = user?.prezdivka ? `Párty hráče ${user.prezdivka}` : `Párty ${newCode}`;
            const formattedName = modalRoomName.trim() || defaultPartyName;

            // 1. Vložení místnosti do tabulky 'rooms' včetně room_name a is_public
            const { error: roomError } = await supabase
                .from('rooms')
                .insert([
                    {
                        room_code: newCode,
                        host_id: Number(user.id),
                        status: 'waiting',
                        game_status: 'waiting',
                        room_name: formattedName,
                        is_public: Boolean(modalIsPublic),
                        current_turn_player_id: Number(user.id)
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
            setShowCreateModal(false);
            setModalRoomName('');
            setModalIsPublic(true);
            setActiveNav('lobby');
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

            // 3. Kontrola limitu 5 schválených hráčů v místnosti
            const { count: approvedCount, error: countError } = await supabase
                .from('room_players')
                .select('*', { count: 'exact', head: true })
                .eq('room_code', code)
                .eq('status', 'approved');

            if (countError) {
                console.error('Chyba při zjišťování kapacity:', countError);
            } else if (approvedCount !== null && approvedCount >= 5) {
                notify('Tato párty je již plná (max. 5 hráčů).', 'error');
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
        if (approvedPlayers.length >= 5) {
            notify('Tato párty je již plná (max. 5 hráčů).', 'error');
            return;
        }
        const playerName = targetPlayer.uzivatele?.prezdivka || 'Hráč';
        try {
            const { error } = await supabase
                .from('room_players')
                .update({ status: 'approved' })
                .eq('id', targetPlayer.id);

            if (error) {
                notify('Chyba při schvalování: ' + error.message, 'error');
            } else {
                notify(`Hráč ${playerName} byl schválen.`, 'success');
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
    // 5c. VÝBĚR ZAČÍNAJÍCÍHO HRÁČE (VLAJEČKA / NÁHODNÁ KOSTKA)
    // =========================================================
    const handleSetStartingPlayer = async (playerId, playerName) => {
        if (!isHost) return;
        setStartingPlayerId(String(playerId));
        notify(`Začínající hráč určen: ${playerName}`, 'info');
        if (currentRoom) {
            try {
                await supabase
                    .from('rooms')
                    .update({ current_turn_player_id: Number(playerId) })
                    .eq('room_code', currentRoom);
            } catch (e) {
                console.error('Chyba při ukládání začínajícího hráče:', e);
            }
        }
    };

    const handleSelectRandomPlayer = () => {
        if (!isHost || isRollingStartingPlayer || approvedPlayers.length === 0) return;

        // Vyčistit předchozí časovače
        rollTimeoutsRef.current.forEach(clearTimeout);
        rollTimeoutsRef.current = [];

        setIsRollingStartingPlayer(true);
        setIsRollFinished(false);

        // Náhodný cílový začínající hráč
        const targetIndex = Math.floor(Math.random() * approvedPlayers.length);
        const targetWinner = approvedPlayers[targetIndex];

        // Zpomalující se ruleta (postupné navýšení intervalu, celkem ~1.8 s)
        const steps = [50, 50, 55, 60, 65, 75, 85, 100, 120, 150, 190, 240, 300, 380];
        let cumulativeTime = 0;
        let currPlayerIdx = 0;

        steps.forEach((delay, index) => {
            cumulativeTime += delay;
            const isLast = index === steps.length - 1;

            const t = setTimeout(() => {
                if (isLast) {
                    setRollingPlayer(targetWinner);
                    setIsRollFinished(true);

                    // Po krátkém zobrazení vítězného hráče (450 ms) uložit do DB a rozsvítit vlaječku
                    const finishTimer = setTimeout(async () => {
                        const targetName = targetWinner.uzivatele?.prezdivka || 'Alchymista';
                        await handleSetStartingPlayer(targetWinner.player_id, targetName);
                        setIsRollingStartingPlayer(false);
                        setIsRollFinished(false);
                    }, 450);
                    rollTimeoutsRef.current.push(finishTimer);
                } else {
                    currPlayerIdx = (currPlayerIdx + 1) % approvedPlayers.length;
                    setRollingPlayer(approvedPlayers[currPlayerIdx]);
                }
            }, cumulativeTime);

            rollTimeoutsRef.current.push(t);
        });
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
            // 1. Nastav v databázi všem schváleným hráčům v místnosti výchozí ruku s 5 prázdnými kartami
            const initialHand = ['safe', 'safe', 'safe', 'safe', 'safe'];
            await supabase
                .from('room_players')
                .update({
                    is_dead: false,
                    hand: initialHand
                })
                .eq('room_code', currentRoom)
                .eq('status', 'approved');

            // 2. Teprve poté vygeneruj a zamíchej zbylý dobírací balíček (deck) se smrtícími kartami
            const deck = [...Array(25).fill('safe'), ...Array(2).fill('killer')];
            for (let i = deck.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [deck[i], deck[j]] = [deck[j], deck[i]];
            }

            // Určení začínajícího hráče: ID vybrané vlaječkou/kostkou nebo ID hosta
            let chosenPlayerId = Number(effectiveStartingPlayerId) || Number(user.id);

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
    // UI: HLAVNÍ ROZVRŽENÍ APLIKACE (POSTRANNÍ PANEL + OBSAH)
    // =========================================================
    // Pokud hra již začala, zobrazíme herní desku GameBoard fullscreen
    if (currentRoom && myPlayerStatus === 'approved' && (roomStatus === 'playing' || roomStatus === 'finished')) {
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

    return (
        <div className="app-layout">
            {/* Mobilní lišta s Hamburger menu */}
            <header className="mobile-header">
                <button
                    type="button"
                    onClick={() => setSidebarOpen((prev) => !prev)}
                    className="btn-hamburger"
                    aria-label="Otevřít navigaci"
                >
                    {sidebarOpen ? '✕' : '☰'}
                </button>
                <div className="mobile-brand">⚗️ BuchyBuch</div>
                {user ? (
                    <div className="mobile-user-tag">{user.prezdivka}</div>
                ) : (
                    <button
                        type="button"
                        className="btn-mobile-login"
                        onClick={() => setShowAuthModal(true)}
                    >
                        Přihlásit se
                    </button>
                )}
            </header>

            {/* Backdrop pro mobilní zobrazení */}
            {sidebarOpen && (
                <div
                    className="sidebar-backdrop"
                    onClick={() => setSidebarOpen(false)}
                    aria-hidden="true"
                />
            )}

            {/* Levý postranní panel */}
            <aside className={`app-sidebar ${sidebarOpen ? 'is-open' : ''}`}>
                <div className="sidebar-brand">
                    <span className="brand-icon">⚗️</span>
                    <div className="brand-text">
                        <span className="brand-name">BuchyBuch</span>
                        <span className="brand-sub">Ruská ruleta</span>
                    </div>
                    <button
                        type="button"
                        onClick={() => setSidebarOpen(false)}
                        className="btn-close-sidebar-mobile"
                        aria-label="Zavřít menu"
                    >
                        ✕
                    </button>
                </div>

                <nav className="sidebar-nav">
                    <button
                        type="button"
                        className={`nav-item ${activeNav === 'lobby' ? 'active' : ''}`}
                        onClick={() => {
                            setActiveNav('lobby');
                            setSidebarOpen(false);
                        }}
                    >
                        <span className="nav-icon">⚗️</span>
                        <span className="nav-label">Laboratoř</span>
                    </button>

                    <button
                        type="button"
                        className={`nav-item ${activeNav === 'profile' ? 'active' : ''}`}
                        onClick={() => {
                            setActiveNav('profile');
                            setSidebarOpen(false);
                        }}
                    >
                        <span className="nav-icon">👤</span>
                        <span className="nav-label">Můj Profil</span>
                        <span className="nav-badge-wip">Připravujeme</span>
                    </button>

                    <button
                        type="button"
                        className={`nav-item ${activeNav === 'stats' ? 'active' : ''}`}
                        onClick={() => {
                            setActiveNav('stats');
                            setSidebarOpen(false);
                        }}
                    >
                        <span className="nav-icon">📊</span>
                        <span className="nav-label">Statistiky</span>
                        <span className="nav-badge-wip">Připravujeme</span>
                    </button>
                </nav>

                {/* Spodní část panelu: Profil přihlášeného hráče a Odhlášení / Přihlášení */}
                <div className="sidebar-footer">
                    {user ? (
                        <>
                            <div className="sidebar-user-card">
                                <div className="sidebar-avatar">🧙</div>
                                <div className="sidebar-user-details">
                                    <span className="sidebar-user-name">{user.prezdivka}</span>
                                    <span className="sidebar-user-role">Alchymista</span>
                                </div>
                            </div>

                            {onLogout && (
                                <button
                                    type="button"
                                    onClick={handleLogoutClick}
                                    className="btn-sidebar-logout"
                                >
                                    Odhlásit se
                                </button>
                            )}
                        </>
                    ) : (
                        <>
                            <div className="sidebar-user-card guest-card">
                                <div className="sidebar-avatar">👤</div>
                                <div className="sidebar-user-details">
                                    <span className="sidebar-user-name">Návštěvník</span>
                                    <span className="sidebar-user-role">Nepřihlášen</span>
                                </div>
                            </div>

                            <button
                                type="button"
                                onClick={() => {
                                    setShowAuthModal(true);
                                    setSidebarOpen(false);
                                }}
                                className="btn-sidebar-login"
                            >
                                Přihlásit se
                            </button>
                        </>
                    )}
                </div>
            </aside>

            {/* Hlavní obsahová část */}
            <main className="layout-content">
                {activeNav === 'profile' && (
                    <div className="placeholder-view">
                        <div className="placeholder-card">
                            <div className="placeholder-icon">👤</div>
                            <h2>Můj Profil</h2>
                            <span className="badge-coming-soon">Připravujeme</span>
                            {user ? (
                                <div className="profile-details-preview">
                                    <div className="profile-row">
                                        <span>Přezdívka:</span>
                                        <strong>{user.prezdivka}</strong>
                                    </div>
                                    <div className="profile-row">
                                        <span>Role:</span>
                                        <strong>Alchymista</strong>
                                    </div>
                                    {user.email && (
                                        <div className="profile-row">
                                            <span>E-mail:</span>
                                            <strong>{user.email}</strong>
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <div className="profile-guest-notice">
                                    <p className="placeholder-hint">
                                        Pro zobrazení svého profilu se musíš nejprve přihlásit.
                                    </p>
                                    <button
                                        type="button"
                                        onClick={() => setShowAuthModal(true)}
                                        className="btn-guest-auth"
                                        style={{ marginBottom: '16px' }}
                                    >
                                        Přihlásit / Registrovat
                                    </button>
                                </div>
                            )}
                            <p className="placeholder-hint">
                                Možnost změny avataru, přezdívky a herních preferencí bude brzy dostupná.
                            </p>
                            <button
                                type="button"
                                onClick={() => setActiveNav('lobby')}
                                className="btn-back-to-lobby"
                            >
                                ← Zpět do laboratoře
                            </button>
                        </div>
                    </div>
                )}

                {activeNav === 'stats' && (
                    <div className="placeholder-view">
                        <div className="placeholder-card">
                            <div className="placeholder-icon">📊</div>
                            <h2>Statistiky</h2>
                            <span className="badge-coming-soon">Připravujeme</span>
                            <div className="stats-preview-grid">
                                <div className="stat-box">
                                    <span className="stat-num">-</span>
                                    <span className="stat-label">Odehrané hry</span>
                                </div>
                                <div className="stat-box">
                                    <span className="stat-num">-</span>
                                    <span className="stat-label">Výhry</span>
                                </div>
                                <div className="stat-box">
                                    <span className="stat-num">-</span>
                                    <span className="stat-label">Přežití</span>
                                </div>
                            </div>
                            <p className="placeholder-hint">
                                Sledování tvých úspěchů u kotlíku a žebříčky alchymistů připravujeme.
                            </p>
                            <button
                                type="button"
                                onClick={() => setActiveNav('lobby')}
                                className="btn-back-to-lobby"
                            >
                                ← Zpět do laboratoře
                            </button>
                        </div>
                    </div>
                )}

                {activeNav === 'lobby' && (
                    <>
                        {/* 1. Čekání na schválení vstupu do laboratoře */}
                        {currentRoom && myPlayerStatus === 'pending' && (
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
                        )}

                        {/* 2. Čekárna laboratoře (schválený hráč / správce) */}
                        {currentRoom && myPlayerStatus === 'approved' && (
                            <div className="lobby-wrapper">
                                <div className="lobby-card">
                                    <div className="room-header">
                                        <h2 className="room-name-heading">{currentRoomName || (user?.prezdivka ? `Párty hráče ${user.prezdivka}` : `Párty ${currentRoom}`)}</h2>
                                        <div className="room-code-tag">{currentRoom}</div>
                                    </div>

                                    {/* Kompaktní žádosti o přístup pro správce */}
                                    {isHost && pendingPlayers.length > 0 && (
                                        <div className="pending-compact-container">
                                            {pendingPlayers.map((p) => {
                                                const playerName = p.uzivatele?.prezdivka || 'Učedník';
                                                const isFull = approvedPlayers.length >= 5;
                                                return (
                                                    <div key={p.id} className="pending-compact-strip">
                                                        <span className="pending-compact-text">
                                                            Hráč <strong>{playerName}</strong> čeká na vpuštění
                                                        </span>
                                                        <div className="pending-compact-actions">
                                                            <button
                                                                type="button"
                                                                onClick={() => handleApprovePlayer(p)}
                                                                className="btn-compact-action btn-compact-approve"
                                                                title={isFull ? 'Tato párty je již plná (max. 5 hráčů).' : `Schválit hráče ${playerName}`}
                                                                aria-label={`Schválit hráče ${playerName}`}
                                                                disabled={isFull}
                                                            >
                                                                ✓
                                                            </button>
                                                            <button
                                                                type="button"
                                                                onClick={() => handleRejectPlayer(p)}
                                                                className="btn-compact-action btn-compact-reject"
                                                                title={`Zamítnout žádost hráče ${playerName}`}
                                                                aria-label={`Zamítnout žádost hráče ${playerName}`}
                                                            >
                                                                ✕
                                                            </button>
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}

                                    {/* Hráči v párty */}
                                    <div className="room-players-box">
                                        <div className="room-players-header">
                                            <h3>Hráči v párty ({approvedPlayers.length}/5)</h3>
                                            {isHost && (
                                                <button
                                                    type="button"
                                                    onClick={handleSelectRandomPlayer}
                                                    className={`btn-dice-random ${isRollingStartingPlayer ? 'is-rolling' : ''}`}
                                                    title="Náhodně vylosovat začínajícího hráče ze seznamu"
                                                    aria-label="Náhodně vylosovat začínajícího hráče ze seznamu"
                                                    disabled={isRollingStartingPlayer}
                                                >
                                                    🎲
                                                </button>
                                            )}
                                        </div>

                                        {/* Losovací animovaný box (zpomalující se ruleta) */}
                                        {isRollingStartingPlayer && (
                                            <div className={`roulette-roller-box ${isRollFinished ? 'is-winner' : ''}`}>
                                                <div className="roulette-roller-header">
                                                    <span className="roulette-dice-icon">🎲</span>
                                                    <span className="roulette-roller-title">
                                                        {isRollFinished ? 'Začínající alchymista' : 'Losování začínajícího hráče...'}
                                                    </span>
                                                </div>
                                                <div className="roulette-roller-content">
                                                    <span className="roulette-roller-avatar">
                                                        {rollingPlayer?.is_host ? '👑' : '🧪'}
                                                    </span>
                                                    <span className="roulette-roller-name">
                                                        {rollingPlayer?.uzivatele?.prezdivka || 'Alchymista'}
                                                    </span>
                                                    {isRollFinished && <span className="roulette-roller-flag">🚩</span>}
                                                </div>
                                            </div>
                                        )}

                                        <ul className="player-list">
                                            {approvedPlayers.map((p) => {
                                                const isMe = Number(p.player_id) === Number(user.id);
                                                const playerName = p.uzivatele?.prezdivka || 'Alchymista';
                                                const isStarting = String(p.player_id) === effectiveStartingPlayerId;

                                                return (
                                                    <li key={p.id || p.player_id} className={`player-item ${isStarting ? 'is-starting' : ''}`}>
                                                        <span className="player-item-name">
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
                                                                    disabled={isRollingStartingPlayer}
                                                                >
                                                                    ✕
                                                                </button>
                                                            )}
                                                            <button
                                                                type="button"
                                                                onClick={() => {
                                                                    if (isHost && !isRollingStartingPlayer) {
                                                                        handleSetStartingPlayer(p.player_id, playerName);
                                                                    }
                                                                }}
                                                                className={`btn-flag-starting ${isStarting ? 'is-active' : ''}`}
                                                                title={
                                                                    isHost
                                                                        ? (isStarting ? `Začínající hráč: ${playerName}` : `Určit hráče ${playerName} jako začínajícího`)
                                                                        : (isStarting ? `Začínající hráč: ${playerName}` : '')
                                                                }
                                                                aria-label={isStarting ? `Začínající hráč: ${playerName}` : `Určit hráče ${playerName} jako začínajícího`}
                                                                style={{ cursor: isHost && !isRollingStartingPlayer ? 'pointer' : 'default' }}
                                                                disabled={isRollingStartingPlayer}
                                                            >
                                                                🚩
                                                            </button>
                                                        </div>
                                                    </li>
                                                );
                                            })}
                                        </ul>
                                    </div>

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
                        )}

                        {/* 3. Vyčištěné Lobby */}
                        {!currentRoom && (
                            <div className="lobby-wrapper">
                                <div className="lobby-card">
                                    {user ? (
                                        <>
                                            <button 
                                                type="button"
                                                onClick={() => {
                                                    setModalRoomName('');
                                                    setModalIsPublic(true);
                                                    setShowCreateModal(true);
                                                }}
                                                disabled={loading}
                                                className="btn-create-room"
                                            >
                                                + Založit novou laboratoř
                                            </button>

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
                                        </>
                                    ) : (
                                        <div className="guest-cta-box">
                                            <div className="guest-cta-icon">⚗️</div>
                                            <p className="guest-cta-text">
                                                Pro hraní alchymie se musíš přihlásit
                                            </p>
                                            <button
                                                type="button"
                                                onClick={() => setShowAuthModal(true)}
                                                className="btn-guest-auth"
                                            >
                                                Přihlásit / Registrovat
                                            </button>
                                        </div>
                                    )}

                                    {/* Seznam aktivních laboratoří v reálném čase */}
                                    <div className="active-rooms-section">
                                        <div className="active-rooms-header">
                                            <h3>Aktivní laboratoře ({activeRooms.length})</h3>
                                            <span className="realtime-pill">Live</span>
                                        </div>

                                        {activeRooms.length === 0 ? (
                                            <p className="empty-rooms-text">Aktuálně není otevřena žádná veřejná laboratoř. Založ novou!</p>
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
                                                                onClick={() => {
                                                                    if (!user) {
                                                                        notify('Pro vstup do laboratoře se musíš přihlásit.', 'info');
                                                                        setShowAuthModal(true);
                                                                        return;
                                                                    }
                                                                    joinLaboratoryByCode(room.room_code);
                                                                }}
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
                        )}
                    </>
                )}
            </main>

            {/* Modální okno pro založení nové laboratoře */}
            {showCreateModal && (
                <div className="modal-overlay" role="dialog" aria-modal="true">
                    <div className="modal-card">
                        <div className="modal-header">
                            <h3 className="modal-title">Založit novou párty</h3>
                            <button
                                type="button"
                                onClick={() => setShowCreateModal(false)}
                                className="btn-modal-close"
                                aria-label="Zavřít okno"
                            >
                                ✕
                            </button>
                        </div>

                        <form onSubmit={handleCreateRoomSubmit} className="modal-form">
                            <div className="modal-form-group">
                                <label htmlFor="modal-room-name" className="modal-label">
                                    Název párty
                                </label>
                                <input
                                    id="modal-room-name"
                                    type="text"
                                    placeholder={user?.prezdivka ? `Párty hráče ${user.prezdivka}` : 'Párty'}
                                    value={modalRoomName}
                                    onChange={(e) => setModalRoomName(e.target.value)}
                                    disabled={loading}
                                    className="modal-input"
                                    maxLength={40}
                                    autoFocus
                                />
                            </div>

                            <div className="modal-form-group toggle-group">
                                <label className="toggle-switch-label" htmlFor="modal-is-public-toggle">
                                    <span className="toggle-switch-text">Viditelná v seznamu párty</span>
                                    <div className="toggle-switch-wrap">
                                        <input
                                            id="modal-is-public-toggle"
                                            type="checkbox"
                                            checked={modalIsPublic}
                                            onChange={(e) => setModalIsPublic(e.target.checked)}
                                            disabled={loading}
                                            className="toggle-switch-input"
                                        />
                                        <span className="toggle-switch-slider"></span>
                                    </div>
                                </label>
                            </div>

                            <div className="modal-actions">
                                <button
                                    type="button"
                                    onClick={() => setShowCreateModal(false)}
                                    disabled={loading}
                                    className="btn-modal-cancel"
                                >
                                    Zrušit
                                </button>
                                <button
                                    type="submit"
                                    disabled={loading}
                                    className="btn-modal-create"
                                >
                                    {loading ? 'Vytvářím...' : 'Vytvořit'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* Modální okno pro přihlášení / registraci */}
            {showAuthModal && (
                <div
                    className="modal-overlay auth-modal-overlay"
                    role="dialog"
                    aria-modal="true"
                    onClick={(e) => {
                        if (e.target === e.currentTarget) {
                            setShowAuthModal(false);
                        }
                    }}
                >
                    <div className="auth-modal-window">
                        <Auth
                            onLogin={(userData) => {
                                setShowAuthModal(false);
                                if (onLogin) onLogin(userData);
                            }}
                            onClose={() => setShowAuthModal(false)}
                            showToast={showToast}
                        />
                    </div>
                </div>
            )}
        </div>
    );
}
