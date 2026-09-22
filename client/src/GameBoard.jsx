import { useState, useEffect, useRef, useCallback } from 'react';
import { supabase } from './supabaseClient';
import './GameBoard.css';

export default function GameBoard({ roomCode, user, isHost, players: initialPlayers = [], onLeaveRoom, showToast }) {
    // Seznam hráčů v místnosti (udržovaný v reálném čase)
    const [players, setPlayers] = useState(initialPlayers);

    // Karty v ruce hráče (začáteční suroviny)
    const [hand, setHand] = useState([
        { id: 'c1', name: 'Mandragora', category: 'Bylina', potency: 'I' },
        { id: 'c2', name: 'Dračí krev', category: 'Esence', potency: 'II' },
        { id: 'c3', name: 'Stříbrný prach', category: 'Kov', potency: 'I' },
        { id: 'c4', name: 'Rulík zlomocný', category: 'Jed', potency: 'III' }
    ]);

    // Položky vhozené do kotlíku
    const [cauldronIngredients, setCauldronIngredients] = useState([]);

    // Herní log
    const [logs, setLogs] = useState([
        { id: 1, text: 'Hra byla zahájena. Kotlík byl zapálen.', type: 'system', time: '18:00' },
        { id: 2, text: 'Na tahu je správce laboratoře.', type: 'turn', time: '18:00' }
    ]);

    // Hráč na tahu (výchozí: host nebo první hráč)
    const [activeTurnId, setActiveTurnId] = useState(() => {
        const hostPlayer = initialPlayers.find((p) => p.is_host);
        return hostPlayer ? Number(hostPlayer.player_id) : Number(user.id);
    });

    // Sledování odpojených hráčů a jejich zbývajícího času { [playerId]: seconds }
    const [disconnectedPlayers, setDisconnectedPlayers] = useState({});

    // Reference pro časovače odpojení – přežijí i re-render komponenty
    const disconnectTimers = useRef({});
    const disconnectIntervals = useRef({});

    // Reference na Realtime kanál pro odesílání Broadcast zpráv
    const channelRef = useRef(null);

    // Příznak, zda hra někdy měla alespoň 2 hráče (pro Last Player Standing)
    const hasHadMultiplePlayersRef = useRef(initialPlayers.filter((p) => p.status === 'approved').length >= 2);

    // Zabraňuje opakovanému zrušení hry
    const isCancellingRef = useRef(false);

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

    // Stabilní reference pro hodnoty a callbacky (zabraňují znovuvytváření kanálu v useEffect)
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
    // 1. SUPABASE REALTIME: PRESENCE, BROADCAST A POSTGRES CHANGES
    // Dependency array obsahuje POUZE stabilní hodnoty (roomCode, user?.id)
    // =========================================================
    useEffect(() => {
        if (!roomCode || !user?.id) return;

        let isCancelled = false;

        // Načtení aktuálních hráčů z tabulky room_players
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
                        isHostRef.current = !!me.is_host;
                    }

                    const approved = data.filter((p) => p.status === 'approved');
                    if (approved.length >= 2) {
                        hasHadMultiplePlayersRef.current = true;
                    }

                    // 4. Zrušení prázdné laboratoře (Last Player Standing):
                    // Pokud počet hráčů v místnosti klesne na 1 a tento jediný hráč je host,
                    // místnost se odstraní z tabulky rooms a hráč je přesměrován do Lobby
                    if (hasHadMultiplePlayersRef.current && approved.length <= 1 && !isCancellingRef.current) {
                        const remainingPlayer = approved[0];
                        const isMe = remainingPlayer ? Number(remainingPlayer.player_id) === Number(userRef.current?.id) : false;
                        const isRemainingHost = isHostRef.current || !!remainingPlayer?.is_host;

                        if (isMe && isRemainingHost) {
                            isCancellingRef.current = true;
                            notifyRef.current?.('Hra byla zrušena, všichni ostatní alchymisté utekli.', 'error');

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

        // Vytvoření jednotného kanálu pro místnost
        const channel = supabase.channel(`game_room_${roomCode}`, {
            config: {
                presence: {
                    key: String(user.id)
                }
            }
        });
        channelRef.current = channel;

        channel
            // A) Supabase Presence: odpojení hráče (leave)
            .on('presence', { event: 'leave' }, ({ key, leftPresences }) => {
                const currentUserId = userRef.current?.id;
                if (Number(key) === Number(currentUserId)) return; // Vlastní odpojení neřešíme

                // Kontrola, zda hráč v players listu ještě vůbec fyzicky je.
                // Pokud se už smazal z databáze (úmyslný odchod), Presence timeout se vůbec nesmí spustit!
                const foundPlayer = playersRef.current.find((p) => String(p.player_id) === String(key));
                if (!foundPlayer) {
                    return;
                }

                const targetName = leftPresences?.[0]?.prezdivka || foundPlayer?.uzivatele?.prezdivka || 'Alchymista';

                notifyRef.current?.(`Hráč ${targetName} má problémy s připojením. Čekáme 60 sekund...`, 'error');
                addLogRef.current?.(`Hráč ${targetName} se odpojil. Běží 60s limit pro návrat.`, 'system');

                // Nastavíme odpočet na 60s v UI
                setDisconnectedPlayers((prev) => ({ ...prev, [key]: 60 }));

                // Pokud již pro hráče běžel časovač, vyčistit ho před novým startem
                if (disconnectTimers.current[key]) {
                    clearTimeout(disconnectTimers.current[key]);
                    delete disconnectTimers.current[key];
                }
                if (disconnectIntervals.current[key]) {
                    clearInterval(disconnectIntervals.current[key]);
                    delete disconnectIntervals.current[key];
                }

                // Vteřinový interval pro plynulý UI odpočet
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

                // Timeout na 60 sekund uložený v useRef
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

                    // Správné odstranění z databáze (Host logic):
                    // Uvnitř setTimeout použít if (isHostRef.current) a natvrdo zavolat:
                    // await supabase.from('room_players').delete().eq('player_id', playerId).eq('room_code', currentRoom)
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

            // B) Supabase Presence: návrat hráče (join)
            .on('presence', { event: 'join' }, ({ key, newPresences }) => {
                const currentUserId = userRef.current?.id;
                if (Number(key) === Number(currentUserId)) return;

                // Když přijde join, zavolat clearTimeout a smazat časovač z useRef
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
                    addLogRef.current?.(`Hráč ${targetName} se vrátil zpět do laboratoře.`, 'system');
                }
            })

            // C) Realtime Broadcast: synchronizace odehraných tahů a vhazování surovin
            .on('broadcast', { event: 'game_action' }, ({ payload }) => {
                if (!payload) return;

                if (payload.action === 'CARD_PLAYED') {
                    // Přidání zahrané karty do kotlíku
                    setCauldronIngredients((prev) => [...prev, payload.card]);
                    addLogRef.current?.(`${payload.playerName} vhodil do kotlíku: ${payload.card.name}.`);
                } else if (payload.action === 'END_TURN') {
                    // Střídání tahu
                    setActiveTurnId(payload.activeTurnId);
                    addLogRef.current?.(`${payload.playerName} ukončil svůj tah.`, 'turn');
                    addLogRef.current?.(`Na tahu je: ${payload.nextPlayerName}.`, 'turn');

                    if (Number(payload.activeTurnId) === Number(userRef.current?.id)) {
                        notifyRef.current?.('Jsi na tahu!', 'info');
                    }
                }
            })

            // D) Realtime Postgres Changes: prioritní naslouchání na DELETE v tabulce room_players
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

                    // Najdeme hráče v lokálním seznamu
                    const target = playersRef.current.find(
                        (p) => (deletedId && Number(p.id) === Number(deletedId)) ||
                               (deletedPlayerId && Number(p.player_id) === Number(deletedPlayerId))
                    );

                    const targetPlayerId = target ? target.player_id : deletedPlayerId;
                    const playerIdKey = targetPlayerId ? String(targetPlayerId) : null;

                    if (playerIdKey) {
                        // 1. Zrušit jakýkoliv běžící Presence časovač
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

                    // 2. Okamžitě odstranit z lokálního stavu i synchronní reference
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

                    // 3. Spustit fetchPlayers pro synchronizaci a Last Player Standing
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

            // E) Realtime Postgres Changes: zrušení/smazání místnosti
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
                        notifyRef.current?.('Hra byla zrušena, všichni ostatní alchymisté utekli.', 'error');
                        if (onLeaveRoomRef.current) {
                            onLeaveRoomRef.current(true);
                        }
                    }
                }
            )

            // Spuštění odběru a sledování vlastní přítomnosti
            .subscribe(async (status) => {
                if (status === 'SUBSCRIBED') {
                    await channel.track({
                        player_id: Number(userRef.current?.id || user?.id),
                        prezdivka: userRef.current?.prezdivka || 'Alchymista',
                        online_at: new Date().toISOString()
                    });
                }
            });

        fetchPlayers();

        // Vyčištění při unmountu komponenty
        return () => {
            isCancelled = true;
            Object.values(disconnectTimers.current).forEach(clearTimeout);
            Object.values(disconnectIntervals.current).forEach(clearInterval);
            disconnectTimers.current = {};
            disconnectIntervals.current = {};
            supabase.removeChannel(channel);
        };
    }, [roomCode, user?.id]);

    const isMyTurn = Number(activeTurnId) === Number(user.id);
    const opponents = players.filter((p) => Number(p.player_id) !== Number(user.id));

    // =========================================================
    // HERNÍ AKCE: ZAHRÁNÍ KARTY DO KOTLÍKU
    // =========================================================
    const handleCardClick = async (card) => {
        if (!isMyTurn) {
            notify('Nyní nejsi na tahu.', 'info');
            return;
        }

        // 1. Lokální aktualizace
        setHand((prev) => prev.filter((c) => c.id !== card.id));
        setCauldronIngredients((prev) => [...prev, card]);
        addLog(`${user.prezdivka} vhodil do kotlíku: ${card.name}.`);

        // 2. Realtime Broadcast všem ostatním hráčům
        if (channelRef.current) {
            await channelRef.current.send({
                type: 'broadcast',
                event: 'game_action',
                payload: {
                    action: 'CARD_PLAYED',
                    card,
                    playerId: user.id,
                    playerName: user.prezdivka
                }
            });
        }
    };

    // =========================================================
    // HERNÍ AKCE: UKONČENÍ TAHU
    // =========================================================
    const handleEndTurn = async () => {
        if (!isMyTurn) return;

        const approved = players.filter((p) => p.status === 'approved');
        const currentIndex = approved.findIndex((p) => Number(p.player_id) === Number(activeTurnId));
        const nextIndex = (currentIndex + 1) % (approved.length || 1);
        const nextPlayer = approved[nextIndex] || approved[0];

        if (nextPlayer) {
            const nextId = Number(nextPlayer.player_id);
            const nextName = nextPlayer.uzivatele?.prezdivka || 'Další alchymista';

            // 1. Lokální aktualizace
            setActiveTurnId(nextId);
            addLog(`${user.prezdivka} ukončil svůj tah.`, 'turn');
            addLog(`Na tahu je: ${nextName}.`, 'turn');

            // 2. Realtime Broadcast všem ostatním hráčům
            if (channelRef.current) {
                await channelRef.current.send({
                    type: 'broadcast',
                    event: 'game_action',
                    payload: {
                        action: 'END_TURN',
                        activeTurnId: nextId,
                        playerName: user.prezdivka,
                        nextPlayerName: nextName
                    }
                });
            }
        }
    };

    return (
        <div className="gameboard-container">
            {/* Horní lišta */}
            <div className="gameboard-topbar">
                <div className="gameboard-room-info">
                    <span>Laboratoř:</span>
                    <span className="gameboard-room-code">{roomCode}</span>
                    {isHost && <span style={{ color: '#10b981', fontSize: '12px' }}>👑 Správce</span>}
                </div>
                <div>
                    <span style={{ color: '#9ca3af', fontSize: '12px' }}>
                        Alchymista: <strong style={{ color: '#f3f4f6' }}>{user.prezdivka}</strong>
                    </span>
                </div>
            </div>

            {/* Hlavní rozvržení: Stůl + Postranní panel */}
            <div className="gameboard-layout">
                {/* Herní stůl */}
                <main className="gameboard-table">
                    {/* 1. Horní zóna: Soupeři */}
                    <section className="opponents-zone" aria-label="Soupeři">
                        {opponents.length === 0 ? (
                            <div style={{ fontSize: '13px', color: '#6b7280' }}>
                                Žádní další alchymisté u kotlíku.
                            </div>
                        ) : (
                            opponents.map((opp) => {
                                const oppName = opp.uzivatele?.prezdivka || 'Soupeř';
                                const isOppTurn = Number(opp.player_id) === Number(activeTurnId);
                                const isDisconnected = disconnectedPlayers[opp.player_id] !== undefined;
                                const remainingSeconds = disconnectedPlayers[opp.player_id];

                                return (
                                    <div 
                                        key={opp.id || opp.player_id} 
                                        className={`opponent-card ${isOppTurn ? 'is-turn' : ''} ${isDisconnected ? 'is-disconnected' : ''}`}
                                    >
                                        <div className="opponent-header">
                                            <span>
                                                {opp.is_host ? '👑 ' : ''}
                                                {oppName}
                                            </span>
                                            {isOppTurn && !isDisconnected && (
                                                <span className="opponent-turn-indicator">Na tahu</span>
                                            )}
                                            {isDisconnected && (
                                                <span className="disconnect-countdown">
                                                    Odpojen ({remainingSeconds}s)
                                                </span>
                                            )}
                                        </div>
                                        <div className="opponent-meta">
                                            <span>{opp.is_guest ? 'Host' : 'Učedník'}</span>
                                            <span className="opponent-cards-badge">🂠 4 karty</span>
                                        </div>
                                    </div>
                                );
                            })
                        )}
                    </section>

                    {/* 2. Středová zóna: Kotlík (společná zóna pro vaření) */}
                    <section className="cauldron-zone" aria-label="Společná zóna">
                        <div className="cauldron-frame">
                            <div className="cauldron-header">
                                <span className="cauldron-title">
                                    <span>⚗️</span> Společný Kotlík
                                </span>
                                <span className="cauldron-recipe-tag">
                                    Recept: Lektvar bdělosti
                                </span>
                            </div>

                            <div className="cauldron-content">
                                {cauldronIngredients.length === 0 ? (
                                    <>
                                        <div className="cauldron-slot">
                                            <span>Slot 1</span>
                                        </div>
                                        <div className="cauldron-slot">
                                            <span>Slot 2</span>
                                        </div>
                                        <div className="cauldron-slot">
                                            <span>Slot 3</span>
                                        </div>
                                    </>
                                ) : (
                                    cauldronIngredients.map((item, idx) => (
                                        <div 
                                            key={`${item.id}_${idx}`} 
                                            className="game-card" 
                                            style={{ cursor: 'default', height: '110px', width: '90px' }}
                                        >
                                            <div className="game-card-type">{item.category}</div>
                                            <div className="game-card-name" style={{ fontSize: '11px' }}>{item.name}</div>
                                            <div className="game-card-footer">{item.potency}</div>
                                        </div>
                                    ))
                                )}
                            </div>

                            <p className="cauldron-desc">
                                {isMyTurn 
                                    ? 'Jsi na tahu. Klikni na surovinu v ruce pro vhození do kotlíku.' 
                                    : 'Čekej, až soupeř provede svůj tah.'}
                            </p>
                        </div>
                    </section>

                    {/* 3. Spodní zóna: Ruka hráče */}
                    <section className="hand-zone" aria-label="Tvoje ruka">
                        <div className="hand-header">
                            <span>Tvoje ruka ({hand.length} surovin)</span>
                            {isMyTurn ? (
                                <span style={{ color: '#10b981', fontSize: '12px' }}>● Tvůj tah</span>
                            ) : (
                                <span style={{ color: '#6b7280', fontSize: '12px' }}>Čekáš na tah</span>
                            )}
                        </div>

                        <div className="hand-cards">
                            {hand.map((card) => (
                                <div
                                    key={card.id}
                                    className="game-card"
                                    onClick={() => handleCardClick(card)}
                                    role="button"
                                    tabIndex={0}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter' || e.key === ' ') {
                                            handleCardClick(card);
                                        }
                                    }}
                                    title="Klikni pro vhození do kotlíku"
                                >
                                    <div className="game-card-type">
                                        <span>Surovina</span>
                                        <span>{card.category}</span>
                                    </div>
                                    <div className="game-card-name">{card.name}</div>
                                    <div className="game-card-footer">
                                        <span>Potence</span>
                                        <strong>{card.potency}</strong>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </section>
                </main>

                {/* 4. Pravý panel: Herní deník a ovládání */}
                <aside className="gameboard-sidebar">
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

                    <div className="sidebar-controls">
                        <button
                            type="button"
                            onClick={handleEndTurn}
                            disabled={!isMyTurn}
                            className="btn-end-turn"
                        >
                            {isMyTurn ? 'Ukončit tah' : 'Čekáš na soupeře'}
                        </button>

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
