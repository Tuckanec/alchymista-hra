import { useState, useEffect, useRef, useCallback } from 'react';
import { supabase } from './supabaseClient';
import './GameBoard.css';

export default function GameBoard({ roomCode, user, isHost, players: initialPlayers = [], onLeaveRoom, showToast }) {
    // Seznam hráčů v místnosti (udržovaný v reálném čase)
    const [players, setPlayers] = useState(initialPlayers);

    // Kdo je zrovna na tahu (ID hráče z rooms.current_turn_player_id)
    const [currentTurnPlayerId, setCurrentTurnPlayerId] = useState(null);

    // Aktuální balíček karet (pole 'safe' a 'killer' z rooms.deck)
    const [deck, setDeck] = useState([]);

    // Stav hry: 'waiting' | 'playing' | 'finished' (z rooms.game_status)
    const [gameStatus, setGameStatus] = useState('playing');

    // Příznak probíhajícího lízání (zabraňuje vícenásobnému kliknutí)
    const [isDrawing, setIsDrawing] = useState(false);

    // Herní log událostí
    const [logs, setLogs] = useState([
        { id: 1, text: 'Hra byla zahájena. Balíček je připraven.', type: 'system', time: '00:00' }
    ]);

    // Sledování odpojených hráčů a jejich zbývajícího času { [playerId]: seconds }
    const [disconnectedPlayers, setDisconnectedPlayers] = useState({});

    // Reference pro časovače odpojení
    const disconnectTimers = useRef({});
    const disconnectIntervals = useRef({});

    // Reference na Realtime kanál
    const channelRef = useRef(null);

    // Příznak, zda hra někdy měla alespoň 2 hráče (pro Last Player Standing)
    const hasHadMultiplePlayersRef = useRef(
        initialPlayers.filter((p) => p.status === 'approved').length >= 2
    );

    // Zabraňuje opakovanému zrušení hry
    const isCancellingRef = useRef(false);

    // Sledování předchozího stavu tahu pro notifikaci "Jsi na tahu"
    const prevTurnPlayerIdRef = useRef(null);

    const notify = useCallback((msg, type = 'info') => {
        if (showToast) {
            showToast(msg, type);
        } else {
            console.log(`[Toast ${type}]:`, msg);
        }
    }, [showToast]);

    const addLog = useCallback((text, type = 'normal') => {
        const now = new Date();
        const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        setLogs((prev) => [...prev, { id: Date.now() + Math.random(), text, type, time: timeStr }]);
    }, []);

    // Stabilní reference pro callbacky a hodnoty uvnitř Realtime listenerů
    const userRef = useRef(user);
    useEffect(() => {
        userRef.current = user;
    }, [user]);

    const isHostRef = useRef(isHost);
    useEffect(() => {
        isHostRef.current = isHost;
    }, [isHost]);

    const roomCodeRef = useRef(roomCode);
    useEffect(() => {
        roomCodeRef.current = roomCode;
    }, [roomCode]);

    const onLeaveRoomRef = useRef(onLeaveRoom);
    useEffect(() => {
        onLeaveRoomRef.current = onLeaveRoom;
    }, [onLeaveRoom]);

    const notifyRef = useRef(notify);
    useEffect(() => {
        notifyRef.current = notify;
    }, [notify]);

    const addLogRef = useRef(addLog);
    useEffect(() => {
        addLogRef.current = addLog;
    }, [addLog]);

    const playersRef = useRef(players);
    useEffect(() => {
        playersRef.current = players;
    }, [players]);

    // =========================================================
    // 1. SUPABASE REALTIME: PRESENCE & POSTGRES CHANGES
    // =========================================================
    useEffect(() => {
        if (!roomCode || !user?.id) return;

        let isCancelled = false;

        // Načtení dat místnosti (balíček, stav hry, kdo je na tahu)
        const fetchRoomData = async () => {
            try {
                const activeRoom = roomCodeRef.current || roomCode;
                const { data, error } = await supabase
                    .from('rooms')
                    .select('*')
                    .eq('room_code', activeRoom)
                    .maybeSingle();

                if (!isCancelled && !error && data) {
                    if (data.current_turn_player_id !== undefined && data.current_turn_player_id !== null) {
                        const newTurnId = Number(data.current_turn_player_id);
                        setCurrentTurnPlayerId(newTurnId);
                        prevTurnPlayerIdRef.current = newTurnId;
                    }
                    if (Array.isArray(data.deck)) {
                        setDeck(data.deck);
                    }
                    if (data.game_status) {
                        setGameStatus(data.game_status);
                    }
                }
            } catch (err) {
                console.error('Chyba při načítání stavu místnosti:', err);
            }
        };

        // Načtení aktuálních hráčů z tabulky room_players (včetně is_dead)
        const fetchPlayers = async () => {
            try {
                const activeRoom = roomCodeRef.current || roomCode;
                const { data, error } = await supabase
                    .from('room_players')
                    .select('*, uzivatele(prezdivka)')
                    .eq('room_code', activeRoom)
                    .order('joined_at', { ascending: true });

                if (!isCancelled && !error && data) {
                    playersRef.current = data;
                    setPlayers(data);

                    const me = data.find((p) => Number(p.player_id) === Number(userRef.current?.id));
                    if (me) {
                        isHostRef.current = Boolean(me.is_host);
                    }

                    const approved = data.filter((p) => p.status === 'approved');
                    if (approved.length >= 2) {
                        hasHadMultiplePlayersRef.current = true;
                    }

                    // Last Player Standing: zrušení místnosti, pokud zbyl jen host sám
                    if (hasHadMultiplePlayersRef.current && approved.length <= 1 && !isCancellingRef.current) {
                        const remainingPlayer = approved[0];
                        const isMe = remainingPlayer ? Number(remainingPlayer.player_id) === Number(userRef.current?.id) : false;
                        const isRemainingHost = isHostRef.current || Boolean(remainingPlayer?.is_host);

                        if (isMe && isRemainingHost) {
                            isCancellingRef.current = true;
                            notifyRef.current?.('Hra byla zrušena, všichni ostatní alchymisté odešli.', 'error');

                            try {
                                await supabase.from('rooms').delete().eq('room_code', roomCode);
                            } catch (err) {
                                console.error('Chyba při mazání prázdné laboratoře:', err);
                            }

                            if (onLeaveRoomRef.current) {
                                onLeaveRoomRef.current(true);
                            }
                        }
                    }
                }
            } catch (err) {
                console.error('Chyba při načítání hráčů:', err);
            }
        };

        fetchRoomData();
        fetchPlayers();

        // Jednotný realtime kanál pro místnost
        const channel = supabase.channel(`game_room_${roomCode}`, {
            config: {
                presence: {
                    key: String(user.id)
                }
            }
        });
        channelRef.current = channel;

        channel
            // A) Presence: odpojení hráče
            .on('presence', { event: 'leave' }, ({ key, leftPresences }) => {
                const currentUserId = userRef.current?.id;
                if (Number(key) === Number(currentUserId)) return;

                const foundPlayer = playersRef.current.find((p) => String(p.player_id) === String(key));
                if (!foundPlayer) return;

                const targetName = leftPresences?.[0]?.prezdivka || foundPlayer?.uzivatele?.prezdivka || 'Alchymista';

                notifyRef.current?.(`Hráč ${targetName} se odpojil. Čekáme 60 sekund...`, 'error');
                addLogRef.current?.(`Hráč ${targetName} se odpojil. Běží 60s limit pro návrat.`, 'system');

                setDisconnectedPlayers((prev) => ({ ...prev, [key]: 60 }));

                if (disconnectTimers.current[key]) {
                    clearTimeout(disconnectTimers.current[key]);
                    delete disconnectTimers.current[key];
                }
                if (disconnectIntervals.current[key]) {
                    clearInterval(disconnectIntervals.current[key]);
                    delete disconnectIntervals.current[key];
                }

                disconnectIntervals.current[key] = setInterval(() => {
                    setDisconnectedPlayers((prev) => {
                        const currentVal = prev[key];
                        if (currentVal === undefined) return prev;
                        if (currentVal <= 1) {
                            return { ...prev, [key]: 0 };
                        }
                        return { ...prev, [key]: currentVal - 1 };
                    });
                }, 1000);

                disconnectTimers.current[key] = setTimeout(async () => {
                    if (disconnectIntervals.current[key]) {
                        clearInterval(disconnectIntervals.current[key]);
                        delete disconnectIntervals.current[key];
                    }
                    delete disconnectTimers.current[key];

                    setDisconnectedPlayers((prev) => {
                        const copy = { ...prev };
                        delete copy[key];
                        return copy;
                    });

                    addLogRef.current?.(`Časový limit pro hráče ${targetName} vypršel.`, 'system');

                    if (isHostRef.current) {
                        try {
                            const playerId = Number(key);
                            const currentRoom = roomCodeRef.current || roomCode;
                            await supabase
                                .from('room_players')
                                .delete()
                                .eq('player_id', playerId)
                                .eq('room_code', currentRoom);
                        } catch (err) {
                            console.error('Chyba při odstraňování odpojeného hráče:', err);
                        }
                    }
                }, 60000);
            })

            // B) Presence: návrat hráče
            .on('presence', { event: 'join' }, ({ key, newPresences }) => {
                const currentUserId = userRef.current?.id;
                if (Number(key) === Number(currentUserId)) return;

                if (disconnectTimers.current[key]) {
                    clearTimeout(disconnectTimers.current[key]);
                    delete disconnectTimers.current[key];

                    if (disconnectIntervals.current[key]) {
                        clearInterval(disconnectIntervals.current[key]);
                        delete disconnectIntervals.current[key];
                    }

                    setDisconnectedPlayers((prev) => {
                        const copy = { ...prev };
                        delete copy[key];
                        return copy;
                    });

                    const foundPlayer = playersRef.current.find((p) => String(p.player_id) === String(key));
                    const targetName = newPresences?.[0]?.prezdivka || foundPlayer?.uzivatele?.prezdivka || 'Alchymista';
                    notifyRef.current?.(`Hráč ${targetName} je zpět!`, 'success');
                    addLogRef.current?.(`Hráč ${targetName} se vrátil zpět do hry.`, 'system');
                }
            })

            // C) Realtime Postgres Changes: změny v tabulce room_players (připojení, odchod, is_dead)
            .on(
                'postgres_changes',
                {
                    event: 'DELETE',
                    schema: 'public',
                    table: 'room_players',
                    filter: `room_code=eq.${roomCode}`
                },
                (payload) => {
                    const deletedId = payload.old?.id;
                    const deletedPlayerId = payload.old?.player_id;

                    const target = playersRef.current.find(
                        (p) => (deletedId && Number(p.id) === Number(deletedId)) ||
                               (deletedPlayerId && Number(p.player_id) === Number(deletedPlayerId))
                    );

                    const targetPlayerId = target ? target.player_id : deletedPlayerId;
                    const playerIdKey = targetPlayerId ? String(targetPlayerId) : null;

                    if (playerIdKey) {
                        if (disconnectTimers.current[playerIdKey]) {
                            clearTimeout(disconnectTimers.current[playerIdKey]);
                            delete disconnectTimers.current[playerIdKey];
                        }
                        if (disconnectIntervals.current[playerIdKey]) {
                            clearInterval(disconnectIntervals.current[playerIdKey]);
                            delete disconnectIntervals.current[playerIdKey];
                        }
                        setDisconnectedPlayers((prev) => {
                            const copy = { ...prev };
                            delete copy[playerIdKey];
                            return copy;
                        });
                    }

                    playersRef.current = playersRef.current.filter((p) => {
                        if (deletedId && Number(p.id) === Number(deletedId)) return false;
                        if (playerIdKey && String(p.player_id) === playerIdKey) return false;
                        return true;
                    });
                    setPlayers([...playersRef.current]);

                    if (target) {
                        const targetName = target.uzivatele?.prezdivka || 'Alchymista';
                        addLogRef.current?.(`Hráč ${targetName} opustil laboratoř.`, 'system');
                    }

                    fetchPlayers();
                }
            )
            .on(
                'postgres_changes',
                {
                    event: 'INSERT',
                    schema: 'public',
                    table: 'room_players',
                    filter: `room_code=eq.${roomCode}`
                },
                () => {
                    fetchPlayers();
                }
            )
            .on(
                'postgres_changes',
                {
                    event: 'UPDATE',
                    schema: 'public',
                    table: 'room_players',
                    filter: `room_code=eq.${roomCode}`
                },
                () => {
                    fetchPlayers();
                }
            )

            // D) Realtime Postgres Changes: změny v tabulce rooms (deck, current_turn_player_id, game_status)
            .on(
                'postgres_changes',
                {
                    event: 'UPDATE',
                    schema: 'public',
                    table: 'rooms',
                    filter: `room_code=eq.${roomCode}`
                },
                (payload) => {
                    if (payload.new) {
                        if (payload.new.current_turn_player_id !== undefined && payload.new.current_turn_player_id !== null) {
                            const newTurnId = Number(payload.new.current_turn_player_id);
                            setCurrentTurnPlayerId(newTurnId);

                            // Notifikace, pokud tah právě přešel na mě
                            const myId = Number(userRef.current?.id);
                            if (newTurnId === myId && prevTurnPlayerIdRef.current !== myId) {
                                notifyRef.current?.('Jsi na tahu! Lízej kartu.', 'info');
                            }
                            prevTurnPlayerIdRef.current = newTurnId;
                        }
                        if (Array.isArray(payload.new.deck)) {
                            setDeck(payload.new.deck);
                        }
                        if (payload.new.game_status) {
                            setGameStatus(payload.new.game_status);
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
                    filter: `room_code=eq.${roomCode}`
                },
                () => {
                    if (!isCancellingRef.current) {
                        isCancellingRef.current = true;
                        notifyRef.current?.('Hra byla zrušena, místnost byla smazána.', 'error');
                        if (onLeaveRoomRef.current) {
                            onLeaveRoomRef.current(true);
                        }
                    }
                }
            )

            // Přihlášení do přítomnosti (Presence)
            .subscribe(async (status) => {
                if (status === 'SUBSCRIBED') {
                    await channel.track({
                        player_id: Number(userRef.current?.id || user?.id),
                        prezdivka: userRef.current?.prezdivka || 'Alchymista',
                        online_at: new Date().toISOString()
                    });
                }
            });

        return () => {
            isCancelled = true;
            Object.values(disconnectTimers.current).forEach(clearTimeout);
            Object.values(disconnectIntervals.current).forEach(clearInterval);
            disconnectTimers.current = {};
            disconnectIntervals.current = {};
            supabase.removeChannel(channel);
        };
    }, [roomCode, user?.id]);

    // =========================================================
    // ODVOZENÉ STAVY PRO UI
    // =========================================================
    const myPlayer = players.find((p) => Number(p.player_id) === Number(user.id));
    const isMeDead = Boolean(myPlayer?.is_dead);
    const isMyTurn = currentTurnPlayerId !== null && Number(currentTurnPlayerId) === Number(user.id);
    const opponents = players.filter((p) => Number(p.player_id) !== Number(user.id));
    const approvedPlayers = players.filter((p) => p.status === 'approved');
    const alivePlayers = approvedPlayers.filter((p) => !p.is_dead);

    // Kdo je zrovna na tahu podle jména
    const currentTurnPlayer = players.find((p) => Number(p.player_id) === Number(currentTurnPlayerId));
    const currentTurnPlayerName = currentTurnPlayer?.uzivatele?.prezdivka || 'Soupeř';

    // =========================================================
    // HERNÍ LOGIKA: LÍZNUTÍ KARTY (RUSKÁ RULETA)
    // =========================================================
    const handleDrawCard = async () => {
        // Kontrola oprávnění: pouze hráč na tahu, nesmí být mrtvý, hra nesmí být u konce
        if (!isMyTurn || isMeDead || gameStatus === 'finished' || isDrawing) {
            return;
        }

        setIsDrawing(true);

        try {
            // a) Stáhni aktuální deck z tabulky rooms. Vezmi první kartu (index 0) a odstraň ji z pole.
            const { data: roomData, error: fetchErr } = await supabase
                .from('rooms')
                .select('*')
                .eq('room_code', roomCode)
                .single();

            if (fetchErr || !roomData) {
                notify('Chyba při stahování balíčku: ' + (fetchErr?.message || 'Nenalezena místnost'), 'error');
                setIsDrawing(false);
                return;
            }

            const currentDeck = Array.isArray(roomData.deck) ? [...roomData.deck] : [];
            if (currentDeck.length === 0) {
                notify('Balíček karet je prázdný!', 'info');
                setIsDrawing(false);
                return;
            }

            // Vezmi první kartu (index 0) a odstraň ji z pole
            const drawnCard = currentDeck.shift();

            // b) Pokud je karta 'killer':
            if (drawnCard === 'killer') {
                // Nastav aktuálnímu hráči v room_players hodnotu is_dead = true
                const { error: deadErr } = await supabase
                    .from('room_players')
                    .update({ is_dead: true })
                    .eq('room_code', roomCode)
                    .eq('player_id', Number(user.id));

                if (deadErr) {
                    console.error('Chyba při nastavení is_dead:', deadErr);
                }

                // Nastav v rooms game_status = 'finished'
                const { error: roomErr } = await supabase
                    .from('rooms')
                    .update({
                        deck: currentDeck,
                        game_status: 'finished'
                    })
                    .eq('room_code', roomCode);

                if (roomErr) {
                    console.error('Chyba při ukončení hry:', roomErr);
                }

                // Vyhoď Toast notifikaci "Vytáhl jsi smrtící kartu!"
                notify('Vytáhl jsi smrtící kartu!', 'error');
                addLog(`☠️ ${user.prezdivka} vytáhl smrtící kartu! Hra skončila.`, 'system');

                // Okamžitá lokální aktualizace stavu
                setDeck(currentDeck);
                setGameStatus('finished');
                setPlayers((prev) =>
                    prev.map((p) =>
                        Number(p.player_id) === Number(user.id) ? { ...p, is_dead: true } : p
                    )
                );
            } else {
                // c) Pokud je karta 'safe':
                // Zjisti, kdo hraje další. Najdi v seznamu hráčů dalšího v pořadí (musí být approved a !is_dead).
                const { data: latestPlayers } = await supabase
                    .from('room_players')
                    .select('*, uzivatele(prezdivka)')
                    .eq('room_code', roomCode)
                    .order('joined_at', { ascending: true });

                const playerList = latestPlayers || playersRef.current;
                const eligible = playerList.filter((p) => p.status === 'approved' && !p.is_dead);

                let nextPlayerId = Number(user.id);
                let nextPlayerName = user.prezdivka;

                if (eligible.length > 0) {
                    const currentIndex = eligible.findIndex(
                        (p) => Number(p.player_id) === Number(user.id)
                    );
                    const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % eligible.length : 0;
                    const nextPlayer = eligible[nextIndex];
                    nextPlayerId = Number(nextPlayer.player_id);
                    nextPlayerName = nextPlayer.uzivatele?.prezdivka || 'Další hráč';
                }

                // Updatuj tabulku rooms: ulož zmenšený deck a změň current_turn_player_id na ID dalšího hráče
                const { error: updateErr } = await supabase
                    .from('rooms')
                    .update({
                        deck: currentDeck,
                        current_turn_player_id: nextPlayerId
                    })
                    .eq('room_code', roomCode);

                if (updateErr) {
                    console.error('Chyba při aktualizaci tahu:', updateErr);
                }

                // Vyhoď Toast "Karta je bezpečná, uff."
                notify('Karta je bezpečná, uff.', 'success');
                addLog(`🍀 ${user.prezdivka} lízl bezpečnou kartu. Na tahu je ${nextPlayerName}.`, 'turn');

                // Okamžitá lokální aktualizace stavu
                setDeck(currentDeck);
                setCurrentTurnPlayerId(nextPlayerId);
            }
        } catch (err) {
            console.error('Chyba při lízání karty:', err);
            notify('Chyba při lízání karty: ' + err.message, 'error');
        } finally {
            setIsDrawing(false);
        }
    };

    // Restart hry správcem místnosti (Host action)
    const handleRestartGame = async () => {
        if (!isHostRef.current) return;
        try {
            const newDeck = [...Array(25).fill('safe'), ...Array(2).fill('killer')];
            for (let i = newDeck.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [newDeck[i], newDeck[j]] = [newDeck[j], newDeck[i]];
            }

            const hostPlayerId = Number(user.id);

            await supabase
                .from('room_players')
                .update({ is_dead: false })
                .eq('room_code', roomCode);

            await supabase
                .from('rooms')
                .update({
                    deck: newDeck,
                    game_status: 'playing',
                    status: 'playing',
                    current_turn_player_id: hostPlayerId
                })
                .eq('room_code', roomCode);

            notify('Nová hra byla zahájena! Začínáš na tahu.', 'success');
            addLog('Správce zahájil novou hru! Karty byly zamíchány.', 'system');
        } catch (err) {
            console.error('Chyba při restartu hry:', err);
            notify('Nepodařilo se restartovat hru.', 'error');
        }
    };

    return (
        <div className="gameboard-container">
            {/* Horní lišta herní desky */}
            <header className="gameboard-topbar">
                <div className="gameboard-room-info">
                    <span>Laboratoř:</span>
                    <span className="gameboard-room-code">{roomCode}</span>
                    {isHost && <span className="badge-host-crown">👑 Správce</span>}
                </div>

                <div className="topbar-user-badge">
                    <span className="topbar-label">Alchymista:</span>
                    <strong className={`topbar-player-name ${isMeDead ? 'text-dead' : ''}`}>
                        {user.prezdivka}
                    </strong>
                    {isMeDead ? (
                        <span className="topbar-dead-badge">💀 MRTEV</span>
                    ) : isMyTurn ? (
                        <span className="topbar-turn-badge">
                            <span className="turn-dot-pulse"></span> Na tahu
                        </span>
                    ) : null}
                </div>
            </header>

            {/* Hlavní rozvržení: Stůl + Postranní panel */}
            <div className="gameboard-layout">
                {/* Herní stůl */}
                <main className="gameboard-table">
                    {/* 1. Horní zóna: Soupeři */}
                    <section className="opponents-zone" aria-label="Soupeři u stolu">
                        {opponents.length === 0 ? (
                            <div className="no-opponents-hint">
                                Žádní další alchymisté u kotlíku.
                            </div>
                        ) : (
                            opponents.map((opp) => {
                                const oppName = opp.uzivatele?.prezdivka || 'Soupeř';
                                const isOppTurn = Number(opp.player_id) === Number(currentTurnPlayerId);
                                const isOppDead = Boolean(opp.is_dead);
                                const isDisconnected = disconnectedPlayers[opp.player_id] !== undefined;
                                const remainingSeconds = disconnectedPlayers[opp.player_id];

                                return (
                                    <div
                                        key={opp.id || opp.player_id}
                                        className={`opponent-card ${isOppTurn && !isOppDead ? 'is-turn' : ''} ${isOppDead ? 'is-dead' : ''} ${isDisconnected ? 'is-disconnected' : ''}`}
                                    >
                                        <div className="opponent-header">
                                            <div className="opponent-name-group">
                                                {isOppTurn && !isOppDead && (
                                                    <span className="turn-dot-pulse" title="Na tahu"></span>
                                                )}
                                                <span className={`opponent-name ${isOppDead ? 'text-dead' : ''}`}>
                                                    {opp.is_host ? '👑 ' : ''}
                                                    {oppName}
                                                </span>
                                            </div>

                                            {isOppDead ? (
                                                <span className="opponent-dead-badge">💀 MRTEV</span>
                                            ) : isOppTurn && !isDisconnected ? (
                                                <span className="opponent-turn-indicator">Na tahu</span>
                                            ) : isDisconnected ? (
                                                <span className="disconnect-countdown">
                                                    Odpojen ({remainingSeconds}s)
                                                </span>
                                            ) : null}
                                        </div>

                                        <div className="opponent-meta">
                                            <span>{opp.is_guest ? 'Host' : 'Učedník'}</span>
                                            <span className={`opponent-status-tag ${isOppDead ? 'tag-dead' : isOppTurn ? 'tag-turn' : 'tag-waiting'}`}>
                                                {isOppDead ? 'Vyřazen' : isOppTurn ? 'Líže kartu' : 'Čeká'}
                                            </span>
                                        </div>
                                    </div>
                                );
                            })
                        )}
                    </section>

                    {/* 2. Středová zóna: Balíček a akční tlačítko Líznout kartu */}
                    <section className="roulette-center-zone" aria-label="Ruská ruleta">
                        <div className="roulette-frame">
                            <div className="roulette-header">
                                <span className="roulette-title">
                                    <span className="roulette-icon">⚗️</span> Ruská ruleta
                                </span>
                                <span className="roulette-deck-count">
                                    🂠 {deck.length} karet v balíčku
                                </span>
                            </div>

                            {/* Vizuál balíčku karet */}
                            <div className="roulette-deck-display">
                                <div className={`roulette-card-stack ${gameStatus === 'finished' ? 'card-finished' : isMyTurn && !isMeDead ? 'card-my-turn' : ''}`}>
                                    <div className="card-layer layer-back-2"></div>
                                    <div className="card-layer layer-back-1"></div>
                                    <div className="card-layer layer-front">
                                        <div className="card-sigil">
                                            {gameStatus === 'finished' ? '☠️' : isMyTurn && !isMeDead ? '✨' : '🔮'}
                                        </div>
                                        <div className="card-label">
                                            {gameStatus === 'finished' ? 'OSUD NAPLNĚN' : 'TAJEMNÁ KARTA'}
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* Tlačítko Líznout kartu (aktivní POUZE pokud je hráč na tahu) */}
                            <div className="roulette-controls">
                                <button
                                    type="button"
                                    className={`btn-draw-card ${isMyTurn && !isMeDead && gameStatus !== 'finished' ? 'active' : 'disabled'}`}
                                    disabled={!isMyTurn || isMeDead || gameStatus === 'finished' || isDrawing}
                                    onClick={handleDrawCard}
                                >
                                    {isDrawing ? (
                                        'Lízám kartu...'
                                    ) : isMyTurn && !isMeDead && gameStatus !== 'finished' ? (
                                        '🃏 Líznout kartu'
                                    ) : gameStatus === 'finished' ? (
                                        'Hra skončila'
                                    ) : isMeDead ? (
                                        'Byl jsi vyřazen 💀'
                                    ) : (
                                        'Hraje soupeř...'
                                    )}
                                </button>
                            </div>

                            {/* Informační stavový řádek */}
                            <div className="roulette-status-info">
                                {gameStatus === 'finished' ? (
                                    <div className="roulette-finished-box">
                                        <p className="finished-text">
                                            ☠️ Hra skončila! Byla vytažena smrtící karta.
                                        </p>
                                        {isHost && (
                                            <button
                                                type="button"
                                                onClick={handleRestartGame}
                                                className="btn-restart-action"
                                            >
                                                🔄 Začít novou hru
                                            </button>
                                        )}
                                    </div>
                                ) : isMeDead ? (
                                    <p className="status-note dead">
                                        💀 Vytáhl jsi smrtící kartu a byl jsi vyřazen ze hry. Sleduj dohrání.
                                    </p>
                                ) : isMyTurn ? (
                                    <p className="status-note my-turn">
                                        🟢 Jsi na tahu! Lízej kartu z balíčku a pokus své štěstí.
                                    </p>
                                ) : (
                                    <p className="status-note waiting">
                                        ⏳ Na tahu je {currentTurnPlayerName}...
                                    </p>
                                )}
                            </div>
                        </div>
                    </section>

                    {/* 3. Spodní zóna: Můj profil hráče */}
                    <section className="my-zone" aria-label="Můj profil">
                        <div className={`my-card ${isMyTurn && !isMeDead ? 'is-turn' : ''} ${isMeDead ? 'is-dead' : ''}`}>
                            <div className="my-card-header">
                                <div className="my-name-wrap">
                                    {isMyTurn && !isMeDead && <span className="turn-dot-pulse"></span>}
                                    <span className={`my-name ${isMeDead ? 'text-dead' : ''}`}>
                                        {user.prezdivka} (Ty)
                                    </span>
                                    {isHost && <span className="host-badge">👑 Správce</span>}
                                </div>

                                {isMeDead ? (
                                    <span className="dead-tag">💀 VYŘAZEN</span>
                                ) : isMyTurn ? (
                                    <span className="turn-tag">🟢 JSI NA TAHU</span>
                                ) : (
                                    <span className="wait-tag">ČEKÁŠ NA SOUPEŘE</span>
                                )}
                            </div>

                            <div className="my-card-desc">
                                {isMeDead
                                    ? '☠️ Osud ti nepřál, vytáhl jsi smrtící kartu.'
                                    : isMyTurn
                                    ? '🃏 Jsi na tahu – klikni na tlačítko uprostřed desky a lízni si kartu!'
                                    : `⏳ Na tahu je ${currentTurnPlayerName}. Sleduj výsledek.`}
                            </div>
                        </div>
                    </section>
                </main>

                {/* 4. Pravý panel: Seznam hráčů, herní deník a ovládání */}
                <aside className="gameboard-sidebar">
                    {/* Seznam všech schválených hráčů */}
                    <div className="sidebar-players-list">
                        <div className="sidebar-section-header">
                            <span>Učedníci u stolu ({approvedPlayers.length})</span>
                            <span className="sidebar-alive-count">{alivePlayers.length} naživu</span>
                        </div>

                        <div className="sidebar-players-items">
                            {approvedPlayers.map((p) => {
                                const isTurn = Number(p.player_id) === Number(currentTurnPlayerId);
                                const isDead = Boolean(p.is_dead);
                                const isMe = Number(p.player_id) === Number(user.id);
                                const pName = p.uzivatele?.prezdivka || 'Alchymista';

                                return (
                                    <div
                                        key={p.id || p.player_id}
                                        className={`sidebar-player-row ${isTurn && !isDead ? 'is-turn' : ''} ${isDead ? 'is-dead' : ''}`}
                                    >
                                        <div className="sidebar-player-info">
                                            {isTurn && !isDead && <span className="turn-dot-pulse"></span>}
                                            <span className={`sidebar-player-name ${isDead ? 'text-dead' : ''}`}>
                                                {p.is_host ? '👑 ' : ''}{pName} {isMe ? '(Ty)' : ''}
                                            </span>
                                        </div>
                                        {isDead ? (
                                            <span className="sidebar-dead-label">💀 Mrtvý</span>
                                        ) : isTurn ? (
                                            <span className="sidebar-turn-label">Na tahu</span>
                                        ) : (
                                            <span className="sidebar-alive-label">Naživu</span>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    {/* Herní deník */}
                    <div className="sidebar-section-header">
                        <span>Herní deník</span>
                        <span style={{ fontSize: '11px', color: '#6b7280' }}>Realtime</span>
                    </div>

                    <div className="log-container">
                        {logs.map((log) => (
                            <div key={log.id} className={`log-entry log-${log.type || 'normal'}`}>
                                <span className="log-time">{log.time}</span>
                                <span>{log.text}</span>
                            </div>
                        ))}
                    </div>

                    {/* Ovládací tlačítka v bočním panelu */}
                    <div className="sidebar-controls">
                        <button
                            type="button"
                            onClick={onLeaveRoom}
                            className="btn-leave-game"
                        >
                            Opustit hru
                        </button>
                    </div>
                </aside>
            </div>
        </div>
    );
}
