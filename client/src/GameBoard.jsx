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

    // Reference pro časovače odpojení { [playerId]: { timeoutId, intervalId } }
    const disconnectTimersRef = useRef({});

    // Reference na Realtime kanál pro odesílání Broadcast zpráv
    const channelRef = useRef(null);

    // Příznak, zda hra někdy měla alespoň 2 hráče (pro Last Player Standing)
    const hasHadMultiplePlayersRef = useRef(initialPlayers.filter((p) => p.status === 'approved').length >= 2);

    // Reference pro aktuální hráče (pro přístup v Presence handlerech)
    const playersRef = useRef(players);
    useEffect(() => {
        playersRef.current = players;
    }, [players]);

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

    // =========================================================
    // 1. SUPABASE REALTIME: PRESENCE, BROADCAST A POSTGRES CHANGES
    // =========================================================
    useEffect(() => {
        if (!roomCode || !user?.id) return;

        let isCancelled = false;

        // Načtení aktuálních hráčů z tabulky room_players
        const fetchPlayers = async () => {
            try {
                const { data, error } = await supabase
                    .from('room_players')
                    .select('*, uzivatele(prezdivka)')
                    .eq('room_code', roomCode)
                    .order('joined_at', { ascending: true });

                if (!isCancelled && !error && data) {
                    setPlayers(data);

                    const approved = data.filter((p) => p.status === 'approved');
                    if (approved.length >= 2) {
                        hasHadMultiplePlayersRef.current = true;
                    }

                    // 3. Last Player Standing: Pokud zbyl pouze 1 hráč
                    if (hasHadMultiplePlayersRef.current && approved.length <= 1 && !isCancellingRef.current) {
                        isCancellingRef.current = true;
                        notify('Hra byla zrušena, všichni ostatní alchymisté utekli.', 'error');

                        try {
                            await supabase.from('rooms').delete().eq('room_code', roomCode);
                        } catch (err) {
                            console.error('Chyba při mazání zrušené místnosti:', err);
                        }

                        if (onLeaveRoom) {
                            onLeaveRoom(true);
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
                if (Number(key) === Number(user.id)) return; // Vlastní odpojení neřešíme

                const foundPlayer = playersRef.current.find((p) => String(p.player_id) === String(key));
                const targetName = leftPresences?.[0]?.prezdivka || foundPlayer?.uzivatele?.prezdivka || 'Alchymista';

                notify(`Hráč ${targetName} má problémy s připojením. Čekáme 60 sekund...`, 'error');
                addLog(`Hráč ${targetName} se odpojil. Běží 60s limit pro návrat.`, 'system');

                // Nastavíme odpočet na 60s
                setDisconnectedPlayers((prev) => ({ ...prev, [key]: 60 }));

                // Pokud již existuje starý časovač pro tohoto hráče, smažeme ho
                if (disconnectTimersRef.current[key]) {
                    clearTimeout(disconnectTimersRef.current[key].timeoutId);
                    clearInterval(disconnectTimersRef.current[key].intervalId);
                }

                // Interval pro odpočet každou sekundu v UI
                const intervalId = setInterval(() => {
                    setDisconnectedPlayers((prev) => {
                        const currentVal = prev[key];
                        if (currentVal === undefined) return prev;
                        if (currentVal <= 1) {
                            return { ...prev, [key]: 0 };
                        }
                        return { ...prev, [key]: currentVal - 1 };
                    });
                }, 1000);

                // Timeout na 60000 ms (60 sekund)
                const timeoutId = setTimeout(async () => {
                    clearInterval(intervalId);
                    delete disconnectTimersRef.current[key];
                    setDisconnectedPlayers((prev) => {
                        const copy = { ...prev };
                        delete copy[key];
                        return copy;
                    });

                    addLog(`Časový limit pro hráče ${targetName} vypršel.`, 'system');

                    // Definitivní vyhození odpojeného hráče z room_players po 60s
                    try {
                        await supabase
                            .from('room_players')
                            .delete()
                            .eq('room_code', roomCode)
                            .eq('player_id', Number(key));
                    } catch (err) {
                        console.error('Chyba při odstraňování odpojeného hráče:', err);
                    }
                }, 60000);

                disconnectTimersRef.current[key] = { timeoutId, intervalId };
            })

            // B) Supabase Presence: návrat hráče (join)
            .on('presence', { event: 'join' }, ({ key, newPresences }) => {
                if (Number(key) === Number(user.id)) return;

                // Pokud pro tohoto hráče běžel 60s timeout, zrušíme ho
                if (disconnectTimersRef.current[key]) {
                    clearTimeout(disconnectTimersRef.current[key].timeoutId);
                    clearInterval(disconnectTimersRef.current[key].intervalId);
                    delete disconnectTimersRef.current[key];

                    setDisconnectedPlayers((prev) => {
                        const copy = { ...prev };
                        delete copy[key];
                        return copy;
                    });

                    const foundPlayer = playersRef.current.find((p) => String(p.player_id) === String(key));
                    const targetName = newPresences?.[0]?.prezdivka || foundPlayer?.uzivatele?.prezdivka || 'Alchymista';
                    notify(`Hráč ${targetName} je zpět!`, 'success');
                    addLog(`Hráč ${targetName} se vrátil zpět do laboratoře.`, 'system');
                }
            })

            // C) Realtime Broadcast: synchronizace odehraných tahů a vhazování surovin
            .on('broadcast', { event: 'game_action' }, ({ payload }) => {
                if (!payload) return;

                if (payload.action === 'CARD_PLAYED') {
                    // Přidání zahrané karty do kotlíku
                    setCauldronIngredients((prev) => [...prev, payload.card]);
                    addLog(`${payload.playerName} vhodil do kotlíku: ${payload.card.name}.`);
                } else if (payload.action === 'END_TURN') {
                    // Střídání tahu
                    setActiveTurnId(payload.activeTurnId);
                    addLog(`${payload.playerName} ukončil svůj tah.`, 'turn');
                    addLog(`Na tahu je: ${payload.nextPlayerName}.`, 'turn');

                    if (Number(payload.activeTurnId) === Number(user.id)) {
                        notify('Jsi na tahu!', 'info');
                    }
                }
            })

            // D) Realtime Postgres Changes: změny v tabulce room_players (připojení, odchod, kick)
            .on(
                'postgres_changes',
                {
                    event: '*',
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
                        notify('Hra byla zrušena, všichni ostatní alchymisté utekli.', 'error');
                        if (onLeaveRoom) {
                            onLeaveRoom(true);
                        }
                    }
                }
            )

            // Spuštění odběru a sledování vlastní přítomnosti
            .subscribe(async (status) => {
                if (status === 'SUBSCRIBED') {
                    await channel.track({
                        player_id: Number(user.id),
                        prezdivka: user.prezdivka,
                        online_at: new Date().toISOString()
                    });
                }
            });

        fetchPlayers();

        // Vyčištění při unmountu komponenty
        return () => {
            isCancelled = true;
            Object.values(disconnectTimersRef.current).forEach(({ timeoutId, intervalId }) => {
                clearTimeout(timeoutId);
                clearInterval(intervalId);
            });
            disconnectTimersRef.current = {};
            supabase.removeChannel(channel);
        };
    }, [roomCode, user.id, user.prezdivka, isHost, notify, addLog, onLeaveRoom]);

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
