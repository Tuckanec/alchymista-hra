import { useState, useEffect, useRef, useCallback } from 'react';
import { flushSync } from 'react-dom';
import { supabase } from './supabaseClient';
import './GameBoard.css';

export default function GameBoard({ roomCode, roomName, user, isHost, players: initialPlayers = [], onLeaveRoom, onResetToLobby, showToast }) {
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

    // Stav otočení karty: null | { card: 'safe' | 'killer', isFlipped: boolean }
    const [flippedCard, setFlippedCard] = useState(null);

    // Cíl animace přesunu dobrané karty: 'player' (dolů do ruky) | 'opponent' (nahoru k soupeřům) | null
    const [flyingTarget, setFlyingTarget] = useState(null);

    // Příznak zobrazení placeholder slotu na konci ruky pro plynulé posunutí karet
    const [showHandSlot, setShowHandSlot] = useState(false);

    // Dynamické CSS proměnné pro přesný let karty (--tx, --ty, --scale)
    const [flyingStyle, setFlyingStyle] = useState({});

    // Reference na elementy pro přesné měření souřadnic letu karty
    const deckRef = useRef(null);
    const targetSlotRef = useRef(null);
    const handCardsContainerRef = useRef(null);
    const opponentRefs = useRef({});
    const currentTurnPlayerIdRef = useRef(null);

    // Příznak úvodní animace rozdání 5 karet
    const [isDealingAnimation, setIsDealingAnimation] = useState(true);

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

    // Spuštění 3D otočení karty
    const triggerCardFlip = useCallback((cardType) => {
        setFlippedCard({ card: cardType, isFlipped: false });
        setTimeout(() => {
            setFlippedCard({ card: cardType, isFlipped: true });
        }, 20);
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

    const onResetToLobbyRef = useRef(onResetToLobby);
    useEffect(() => {
        onResetToLobbyRef.current = onResetToLobby;
    }, [onResetToLobby]);

    const notifyRef = useRef(notify);
    useEffect(() => {
        notifyRef.current = notify;
    }, [notify]);

    const triggerCardFlipRef = useRef(triggerCardFlip);
    useEffect(() => {
        triggerCardFlipRef.current = triggerCardFlip;
    }, [triggerCardFlip]);

    const playersRef = useRef(players);
    useEffect(() => {
        playersRef.current = players;
    }, [players]);

    useEffect(() => {
        currentTurnPlayerIdRef.current = currentTurnPlayerId;
    }, [currentTurnPlayerId]);

    // Obsluha animace otočení a přesunu karty pro soupeře
    const handleOpponentCardFlip = useCallback((cardType, drawingPlayerId) => {
        triggerCardFlip(cardType);
        if (cardType === 'safe') {
            setTimeout(() => {
                const oppId = drawingPlayerId !== undefined ? Number(drawingPlayerId) : currentTurnPlayerIdRef.current;
                const oppEl = (oppId && (opponentRefs.current[oppId] || opponentRefs.current[String(oppId)])) ||
                              document.querySelector(`.opponent-card[data-player-id="${oppId}"]`) ||
                              document.querySelector('.opponent-card.is-turn') ||
                              document.querySelector('.opponents-zone');

                let dx = 0;
                let dy = -260;
                let scale = 0.35;

                if (deckRef.current && oppEl) {
                    const deckRect = deckRef.current.getBoundingClientRect();
                    const oppRect = oppEl.getBoundingClientRect();

                    const deckCenterX = deckRect.left + deckRect.width / 2;
                    const deckCenterY = deckRect.top + deckRect.height / 2;
                    const oppCenterX = oppRect.left + oppRect.width / 2;
                    const oppCenterY = oppRect.top + oppRect.height / 2;

                    dx = oppCenterX - deckCenterX;
                    dy = oppCenterY - deckCenterY;
                    scale = Math.min(0.4, (oppRect.height * 0.7) / deckRect.height || 0.35);
                }

                setFlyingStyle({
                    '--tx': `${dx}px`,
                    '--ty': `${dy}px`,
                    '--scale': scale
                });
                setFlyingTarget('opponent');

                setTimeout(() => {
                    setFlyingTarget(null);
                    setFlyingStyle({});
                    setFlippedCard(null);
                }, 500);
            }, 500);
        } else {
            setTimeout(() => {
                setFlippedCard(null);
            }, 1700);
        }
    }, [triggerCardFlip]);

    const handleOpponentCardFlipRef = useRef(handleOpponentCardFlip);
    useEffect(() => {
        handleOpponentCardFlipRef.current = handleOpponentCardFlip;
    }, [handleOpponentCardFlip]);

    // Úvodní animace rozdání 5 karet při startu hry
    useEffect(() => {
        if (gameStatus === 'playing') {
            setIsDealingAnimation(true);
            const timer = setTimeout(() => {
                setIsDealingAnimation(false);
            }, 2200);
            return () => clearTimeout(timer);
        }
    }, [gameStatus]);

    // =========================================================
    // 1. SUPABASE REALTIME: PRESENCE, BROADCAST & POSTGRES CHANGES
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

        // Jednotný realtime kanál pro místnost s podporou Presence i Broadcastu
        const channel = supabase.channel(`game_room_${roomCode}`, {
            config: {
                presence: {
                    key: String(user.id)
                },
                broadcast: {
                    self: false
                }
            }
        });
        channelRef.current = channel;

        channel
            // A) Broadcast: Otočení karty v reálném čase pro soupeře
            .on('broadcast', { event: 'card_flip' }, ({ payload }) => {
                if (payload?.card) {
                    handleOpponentCardFlipRef.current?.(payload.card, payload.playerId);
                }
            })

            // B) Presence: odpojení hráče
            .on('presence', { event: 'leave' }, ({ key, leftPresences }) => {
                const currentUserId = userRef.current?.id;
                if (Number(key) === Number(currentUserId)) return;

                const foundPlayer = playersRef.current.find((p) => String(p.player_id) === String(key));
                if (!foundPlayer) return;

                const targetName = leftPresences?.[0]?.prezdivka || foundPlayer?.uzivatele?.prezdivka || 'Alchymista';

                notifyRef.current?.(`Hráč ${targetName} se odpojil. Čekáme 60 sekund...`, 'error');

                setDisconnectedPlayers((prev) => ({ ...prev, [key]: 60 }));

                if (disconnectTimers.current[key]) {
                    clearTimeout(disconnectTimers.current[key]);
                }
                if (disconnectIntervals.current[key]) {
                    clearInterval(disconnectIntervals.current[key]);
                }

                disconnectIntervals.current[key] = setInterval(() => {
                    setDisconnectedPlayers((prev) => {
                        const currentVal = prev[key];
                        if (currentVal === undefined) return prev;
                        if (currentVal <= 1) {
                            clearInterval(disconnectIntervals.current[key]);
                            delete disconnectIntervals.current[key];
                            const copy = { ...prev };
                            delete copy[key];
                            return copy;
                        }
                        return { ...prev, [key]: currentVal - 1 };
                    });
                }, 1000);

                disconnectTimers.current[key] = setTimeout(async () => {
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

            // C) Presence: návrat hráče
            .on('presence', { event: 'join' }, ({ key }) => {
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

                    const target = playersRef.current.find((p) => String(p.player_id) === String(key));
                    const targetName = target?.uzivatele?.prezdivka || 'Alchymista';
                    notifyRef.current?.(`Hráč ${targetName} se vrátil zpět do hry.`, 'success');
                }
            })

            // D) Realtime Postgres Changes: změny hráčů
            .on(
                'postgres_changes',
                {
                    event: 'DELETE',
                    schema: 'public',
                    table: 'room_players',
                    filter: `room_code=eq.${roomCode}`
                },
                (payload) => {
                    const deletedId = payload.old?.player_id;
                    const playerIdKey = deletedId ? String(deletedId) : null;

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

                    const target = playersRef.current.find((p) => {
                        if (payload.old?.id && p.id === payload.old.id) return true;
                        if (playerIdKey && String(p.player_id) === playerIdKey) return true;
                        return false;
                    });

                    playersRef.current = playersRef.current.filter((p) => {
                        if (payload.old?.id && p.id === payload.old.id) return false;
                        if (playerIdKey && String(p.player_id) === playerIdKey) return false;
                        return true;
                    });
                    setPlayers([...playersRef.current]);

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

            // E) Realtime Postgres Changes: změny v tabulce rooms (deck, current_turn_player_id, game_status)
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
                                notifyRef.current?.('Jsi na tahu!', 'info');
                            }
                            prevTurnPlayerIdRef.current = newTurnId;
                            setFlippedCard(null);
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
    const myHand = Array.isArray(myPlayer?.hand) ? myPlayer.hand : [];
    const isMeDead = Boolean(myPlayer?.is_dead);
    const isMyTurn = currentTurnPlayerId !== null && Number(currentTurnPlayerId) === Number(user.id);
    const opponents = players.filter((p) => Number(p.player_id) !== Number(user.id));
    const approvedPlayers = players.filter((p) => p.status === 'approved');
    const alivePlayers = approvedPlayers.filter((p) => !p.is_dead);

    // Kdo je zrovna na tahu podle jména
    const currentTurnPlayer = players.find((p) => Number(p.player_id) === Number(currentTurnPlayerId));
    const currentTurnPlayerName = currentTurnPlayer?.uzivatele?.prezdivka || 'Soupeř';

    // Určení vítěze (jediný hráč v room_players, který má is_dead === false)
    const winnerPlayer = alivePlayers.length === 1 ? alivePlayers[0] : (alivePlayers[0] || null);
    const winnerName = winnerPlayer?.uzivatele?.prezdivka || 'Přeživší alchymista';
    const isMeWinner = winnerPlayer && Number(winnerPlayer.player_id) === Number(user.id);

    // =========================================================
    // HERNÍ LOGIKA: LÍZNUTÍ A OTOČENÍ KARTY (CARD FLIP)
    // =========================================================
    const handleDrawCard = async () => {
        // Kontrola oprávnění: pouze hráč na tahu, nesmí být mrtev, hra nesmí být u konce, nesmí probíhat lízání
        if (!isMyTurn || isMeDead || gameStatus !== 'playing' || isDrawing || flippedCard) {
            return;
        }

        // a) Zablokuj další klikání, aby nešlo líznout vícekrát za sebou
        setIsDrawing(true);

        try {
            // Stáhni aktuální deck z tabulky rooms
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

            // b) Spusť animaci otočení vrchní karty:
            // 1. Broadcast pro soupeře v místnosti
            if (channelRef.current) {
                channelRef.current.send({
                    type: 'broadcast',
                    event: 'card_flip',
                    payload: {
                        card: drawnCard,
                        playerId: Number(user.id)
                    }
                });
            }

            // 2. Lokální animace otočení
            triggerCardFlip(drawnCard);

            // c) Vyhodnocení typu karty
            if (drawnCard === 'killer') {
                // b) Pokud je karta 'killer' (💀): Zůstane otočená na balíčku, nepřesouvá se do ruky a po 1500 ms se hra ukončí jako dosud.
                await new Promise((resolve) => setTimeout(resolve, 1500));

                await supabase
                    .from('room_players')
                    .update({ is_dead: true })
                    .eq('room_code', roomCode)
                    .eq('player_id', Number(user.id));

                await supabase
                    .from('rooms')
                    .update({
                        deck: currentDeck,
                        game_status: 'finished'
                    })
                    .eq('room_code', roomCode);

                setDeck(currentDeck);
                setGameStatus('finished');
                setPlayers((prev) =>
                    prev.map((p) =>
                        Number(p.player_id) === Number(user.id) ? { ...p, is_dead: true } : p
                    )
                );
            } else {
                // c) Pokud je karta 'safe' (prázdná):
                // Po krátkém zobrazení (cca 500 ms po otočení na balíčku) začne fáze přesunu do ruky lokálního hráče
                await new Promise((resolve) => setTimeout(resolve, 500));

                // 1. Přidej placeholder slot na pravý konec ruky a posuň stávající karty v ruce plynule doleva
                const handContainer = handCardsContainerRef.current;
                if (handContainer) {
                    const existingCards = Array.from(handContainer.querySelectorAll('.my-hand-card:not(.hand-card-slot)'));
                    const prevRects = existingCards.map((c) => c.getBoundingClientRect().left);

                    flushSync(() => {
                        setShowHandSlot(true);
                    });

                    const newRects = existingCards.map((c) => c.getBoundingClientRect().left);

                    existingCards.forEach((card, i) => {
                        const deltaX = prevRects[i] - newRects[i];
                        if (deltaX !== 0) {
                            card.style.transition = 'none';
                            card.style.transform = `translateX(${deltaX}px)`;
                        }
                    });

                    requestAnimationFrame(() => {
                        requestAnimationFrame(() => {
                            existingCards.forEach((card) => {
                                card.style.transition = '';
                                card.style.transform = '';
                            });
                        });
                    });
                } else {
                    flushSync(() => {
                        setShowHandSlot(true);
                    });
                }

                // 2. Spočti přesný rozdíl souřadnic dx, dy a scale mezi balíčkem a novým slotem na pravém konci ruky
                let dx = 0;
                let dy = 260;
                let scale = 0.45;

                if (deckRef.current && targetSlotRef.current) {
                    const deckRect = deckRef.current.getBoundingClientRect();
                    const targetRect = targetSlotRef.current.getBoundingClientRect();

                    const deckCenterX = deckRect.left + deckRect.width / 2;
                    const deckCenterY = deckRect.top + deckRect.height / 2;
                    const targetCenterX = targetRect.left + targetRect.width / 2;
                    const targetCenterY = targetRect.top + targetRect.height / 2;

                    dx = targetCenterX - deckCenterX;
                    dy = targetCenterY - deckCenterY;
                    scale = targetRect.width / deckRect.width;
                }

                // 3. Spusť letící animaci s dynamickými CSS proměnnými (--tx, --ty, --scale)
                setFlyingStyle({
                    '--tx': `${dx}px`,
                    '--ty': `${dy}px`,
                    '--scale': scale
                });
                setFlyingTarget('player');

                // 4. Během 500ms letu karty připrav paralelně data z databáze
                const [_, fetchRes] = await Promise.all([
                    new Promise((resolve) => setTimeout(resolve, 500)),
                    supabase
                        .from('room_players')
                        .select('*, uzivatele(prezdivka)')
                        .eq('room_code', roomCode)
                        .order('joined_at', { ascending: true })
                        .catch(() => ({ data: null }))
                ]);

                const playerList = fetchRes?.data || playersRef.current;
                const meInDb = playerList.find((p) => Number(p.player_id) === Number(user.id));
                const currentHand = Array.isArray(meInDb?.hand) ? meInDb.hand : (Array.isArray(myPlayer?.hand) ? myPlayer.hand : []);
                const updatedHand = [...currentHand, 'safe'];

                const eligible = playerList.filter((p) => p.status === 'approved' && !p.is_dead);

                let nextPlayerId = Number(user.id);
                if (eligible.length > 0) {
                    const currentIndex = eligible.findIndex(
                        (p) => Number(p.player_id) === Number(user.id)
                    );
                    const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % eligible.length : 0;
                    const nextPlayer = eligible[nextIndex];
                    nextPlayerId = Number(nextPlayer.player_id);
                }

                // 5. Okamžitě a plynule v jedné synchronní dávce nahraď placeholder slot reálnou kartou
                setPlayers((prev) =>
                    prev.map((p) =>
                        Number(p.player_id) === Number(user.id) ? { ...p, hand: updatedHand } : p
                    )
                );
                setShowHandSlot(false);
                setFlyingTarget(null);
                setFlyingStyle({});
                setFlippedCard(null);

                // 6. Ulož novou ruku a dalšího hráče na tahu do Supabase
                await supabase
                    .from('room_players')
                    .update({ hand: updatedHand })
                    .eq('room_code', roomCode)
                    .eq('player_id', Number(user.id));

                await supabase
                    .from('rooms')
                    .update({
                        deck: currentDeck,
                        current_turn_player_id: nextPlayerId
                    })
                    .eq('room_code', roomCode);

                setDeck(currentDeck);
                setCurrentTurnPlayerId(nextPlayerId);
                currentTurnPlayerIdRef.current = nextPlayerId;
            }
        } catch (err) {
            console.error('Chyba při lízání karty:', err);
            notify('Chyba při lízání karty: ' + err.message, 'error');
        } finally {
            setFlyingTarget(null);
            setFlyingStyle({});
            setShowHandSlot(false);
            setFlippedCard(null);
            setIsDrawing(false);
        }
    };

    // =========================================================
    // NÁVRAT DO ČEKÁRNY / HRÁT ZNOVU (HOST ACTION PO SKONČENÍ HRY)
    // =========================================================
    const handleResetToLobby = async () => {
        if (!isHostRef.current) return;
        try {
            // 1. V tabulce room_players nastav všem hráčům v místnosti is_dead: false a vyprázdni jim ruku (hand: [])
            await supabase
                .from('room_players')
                .update({
                    is_dead: false,
                    hand: []
                })
                .eq('room_code', roomCode);

            // 2. V tabulce rooms nastav stav game_status: 'waiting', status: 'waiting' a vyprázdni balíček (deck: [])
            const { error } = await supabase
                .from('rooms')
                .update({
                    deck: [],
                    game_status: 'waiting',
                    status: 'waiting'
                })
                .eq('room_code', roomCode);

            if (error) {
                console.error('Chyba při návratu do čekárny:', error);
                notify('Chyba: ' + error.message, 'error');
            } else {
                setGameStatus('waiting');
                setDeck([]);
                setFlippedCard(null);
                if (onResetToLobbyRef.current) {
                    onResetToLobbyRef.current();
                }
            }
        } catch (err) {
            console.error('Chyba při návratu do čekárny:', err);
            notify('Chyba při návratu do čekárny.', 'error');
        }
    };

    return (
        <div className="gameboard-container">
            {/* Horní lišta herní desky: vlevo hráč, vpravo čisté tlačítko Opustit hru */}
            <header className="gameboard-topbar">
                <div className="topbar-user-badge">
                    <span className="topbar-label">Alchymista:</span>
                    <strong className={`topbar-player-name ${isMeDead ? 'text-dead' : ''}`}>
                        {user.prezdivka}
                    </strong>
                    {isHost && <span className="badge-host-crown">👑 Správce</span>}
                    {isMeDead ? (
                        <span className="topbar-dead-badge">💀 MRTEV</span>
                    ) : isMyTurn ? (
                        <span className="topbar-turn-badge">
                            <span className="turn-dot-pulse"></span> Na tahu
                        </span>
                    ) : null}
                </div>

                <button
                    type="button"
                    onClick={onLeaveRoom}
                    className="btn-topbar-leave"
                    title="Opustit hru"
                >
                    Opustit hru
                </button>
            </header>

            {/* Hlavní rozvržení: Herní stůl přes celou šířku obrazovky */}
            <div className="gameboard-layout">
                <main className="gameboard-table">
                    {/* 1. Horní zóna: Soupeři */}
                    <section className="opponents-zone" aria-label="Soupeři u stolu">
                        {opponents.length === 0 ? (
                            <div className="no-opponents-hint">
                                Žádní další alchymisté u stolu.
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
                                        ref={(el) => {
                                            if (el) {
                                                opponentRefs.current[opp.player_id] = el;
                                            } else {
                                                delete opponentRefs.current[opp.player_id];
                                            }
                                        }}
                                        data-player-id={opp.player_id}
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
                                            <span className="opponent-hand-count">🂠 {opp.hand?.length || 0} v ruce</span>
                                            <span className={`opponent-status-tag ${isOppDead ? 'tag-dead' : isOppTurn ? 'tag-turn' : 'tag-waiting'}`}>
                                                {isOppDead ? 'Vyřazen' : isOppTurn ? 'Líže kartu' : 'Čeká'}
                                            </span>
                                        </div>
                                    </div>
                                );
                            })
                        )}
                    </section>

                    {/* 2. Středová zóna: Balíček s 3D flip animací líznuté karty */}
                    <section className="roulette-center-zone" aria-label="Balíček karet">
                        <div className="roulette-frame">
                            <div className="roulette-header">
                                <span className="roulette-deck-count">
                                    🂠 {deck.length} {deck.length === 1 ? 'karta' : (deck.length >= 2 && deck.length <= 4 ? 'karty' : 'karet')} v balíčku
                                </span>
                            </div>

                            {/* Vizuál balíčku karet s 3D flip animací */}
                            <div ref={deckRef} className="roulette-deck-display">
                                <div className="card-flip-wrap">
                                    {/* Spodní vrstvy balíčku pro fyzický efekt stohu karet */}
                                    {deck.length > 2 && <div className="card-layer layer-back-2"></div>}
                                    {deck.length > 1 && <div className="card-layer layer-back-1"></div>}

                                    {/* Samotná vrchní karta s 3D flip animací */}
                                    <div
                                        className={`card-3d-flipper ${flippedCard?.isFlipped ? 'is-flipped' : ''} ${flyingTarget === 'player' ? 'is-flying-to-hand' : flyingTarget === 'opponent' ? 'is-flying-to-opponent' : ''} ${isMyTurn && !isMeDead && gameStatus !== 'finished' && !isDrawing && !flippedCard ? 'is-clickable' : 'not-clickable'}`}
                                        style={flyingStyle}
                                        onClick={isMyTurn && !isMeDead && gameStatus !== 'finished' && !isDrawing && !flippedCard ? handleDrawCard : undefined}
                                        role={isMyTurn && !isMeDead && gameStatus !== 'finished' ? 'button' : undefined}
                                        tabIndex={isMyTurn && !isMeDead && gameStatus !== 'finished' ? 0 : undefined}
                                        title={isMyTurn && !isMeDead && gameStatus !== 'finished' && !flippedCard ? 'Klikni pro líznutí karty' : undefined}
                                    >
                                        {/* Zadní strana karty (rub: tajemná karta se sigilem) */}
                                        <div className="card-side card-side-back">
                                            <div className="card-sigil">✨</div>
                                            <div className="card-label">TAJEMNÁ KARTA</div>
                                        </div>

                                        {/* Přední strana karty (líc: po otočení - prázdná pro safe, 💀 pro killer) */}
                                        <div className={`card-side card-side-front ${flippedCard?.card === 'killer' ? 'is-killer' : 'is-safe'}`}>
                                            {flippedCard?.card === 'killer' && (
                                                <div className="card-killer-skull" aria-label="Smrtící karta">
                                                    💀
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* Informační stavový řádek */}
                            <div className="roulette-status-info">
                                {flippedCard?.isFlipped ? (
                                    flippedCard.card === 'killer' ? (
                                        <p className="status-note dead">💀 Smrtící karta!</p>
                                    ) : null
                                ) : isMeDead ? (
                                    <p className="status-note dead">
                                        💀 Byl jsi vyřazen smrtící kartou. Sleduj dohrání.
                                    </p>
                                ) : !isMyTurn ? (
                                    <p className="status-note waiting">
                                        ⏳ Na tahu je {currentTurnPlayerName}...
                                    </p>
                                ) : (
                                    <p className="status-note my-turn">
                                        👉 Jsi na tahu! Klikni na balíček a otoč kartu.
                                    </p>
                                )}
                            </div>
                        </div>
                    </section>

                    {/* 3. Spodní zóna: Moje ruka a profil hráče */}
                    <section className="my-zone" aria-label="Moje ruka a profil">
                        {/* Ruka hráče */}
                        <div className="my-hand-container">
                            <div ref={handCardsContainerRef} className="my-hand-cards">
                                {myHand.map((cardType, idx) => (
                                    <div
                                        key={idx}
                                        className={`my-hand-card ${isDealingAnimation ? 'deal-fly-in' : ''}`}
                                        style={{
                                            animationDelay: isDealingAnimation ? `${idx * 220}ms` : undefined,
                                            zIndex: idx + 1
                                        }}
                                        title={`Bezpečná karta (${idx + 1}/${myHand.length})`}
                                    >
                                        <div className="hand-card-inner"></div>
                                    </div>
                                ))}
                                {showHandSlot && (
                                    <div
                                        ref={targetSlotRef}
                                        className="my-hand-card hand-card-slot"
                                        style={{ zIndex: myHand.length + 1 }}
                                    >
                                        <div className="hand-card-inner slot-inner"></div>
                                    </div>
                                )}
                            </div>
                        </div>

                        <div className={`my-card ${isMyTurn && !isMeDead ? 'is-turn' : ''} ${isMeDead ? 'is-dead' : ''}`}>
                            <div className="my-card-header">
                                <div className="my-name-wrap">
                                    {isMyTurn && !isMeDead && <span className="turn-dot-pulse" title="Na tahu"></span>}
                                    <span className={`my-name ${isMeDead ? 'text-dead' : ''}`}>
                                        {user.prezdivka} (Ty)
                                    </span>
                                    {isHost && <span className="host-badge">👑 Správce</span>}
                                </div>

                                <div className="my-meta-right">
                                    <span className="my-hand-counter">
                                        🂠 {myHand.length} {myHand.length === 1 ? 'karta' : (myHand.length >= 2 && myHand.length <= 4 ? 'karty' : 'karet')} v ruce
                                    </span>
                                    {isMeDead && (
                                        <span className="dead-tag">💀 VYŘAZEN</span>
                                    )}
                                </div>
                            </div>
                        </div>
                    </section>
                </main>
            </div>

            {/* ========================================================= */}
            {/* 4. MODAL OKNO KONCE HRY A VÍTĚZ                           */}
            {/* ========================================================= */}
            {gameStatus === 'finished' && (
                <div className="game-over-modal-overlay" role="dialog" aria-modal="true">
                    <div className="game-over-modal-card">
                        <h2 className="game-over-heading">Konec hry</h2>

                        <div className="game-over-winner-box">
                            <span className="game-over-winner-label">VÍTĚZ</span>
                            <h1 className="game-over-winner-name">{winnerName}</h1>
                        </div>

                        <div className="game-over-actions">
                            {isHost ? (
                                <button
                                    type="button"
                                    onClick={handleResetToLobby}
                                    className="btn-return-lobby"
                                >
                                    Hrát znovu
                                </button>
                            ) : (
                                <p className="waiting-host-text">Čeká se na správce...</p>
                            )}

                            <button
                                type="button"
                                onClick={onLeaveRoom}
                                className="btn-leave-permanently"
                            >
                                Opustit hru
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
