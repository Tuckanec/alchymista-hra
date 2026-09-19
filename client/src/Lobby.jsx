import { useState, useEffect } from 'react';
import { supabase } from './supabaseClient';
import './Lobby.css';

export default function Lobby({ user, onLogout, showToast }) {
    const [joinCode, setJoinCode] = useState('');
    const [currentRoom, setCurrentRoom] = useState(null);
    const [isHost, setIsHost] = useState(false);
    const [players, setPlayers] = useState([]);
    const [loading, setLoading] = useState(false);

    // Sekce skóre (Síň slávy)
    const [showScores, setShowScores] = useState(false);
    const [leaderboard, setLeaderboard] = useState([]);
    const [submittingScore, setSubmittingScore] = useState(false);

    const notify = (msg, type = 'info') => {
        if (showToast) {
            showToast(msg, type);
        } else {
            console.log(`[Toast ${type}]:`, msg);
        }
    };

    // 1. Načtení žebříčku a realtime odběr změn v tabulce 'skore'
    useEffect(() => {
        let isCancelled = false;

        const loadScores = async () => {
            try {
                const { data, error } = await supabase
                    .from('skore')
                    .select('*')
                    .order('body', { ascending: false })
                    .limit(10);

                if (!isCancelled && !error && data) {
                    setLeaderboard(data);
                }
            } catch (err) {
                console.error('Chyba spojení se Supabase:', err);
            }
        };

        loadScores();

        // Realtime odběr změn skóre
        const scoreChannel = supabase
            .channel('realtime_skore')
            .on(
                'postgres_changes',
                { event: '*', schema: 'public', table: 'skore' },
                () => {
                    loadScores();
                }
            )
            .subscribe();

        return () => {
            isCancelled = true;
            supabase.removeChannel(scoreChannel);
        };
    }, []);

    // 2. SUPABASE REALTIME SUBSCRIPTION PRO HRÁČE V MÍSTNOSTI
    useEffect(() => {
        if (!currentRoom) return;

        let isCancelled = false;

        const loadRoomPlayers = async () => {
            try {
                const { data, error } = await supabase
                    .from('room_players')
                    .select('*')
                    .eq('room_code', currentRoom)
                    .order('joined_at', { ascending: true });

                if (!isCancelled && !error && data) {
                    setPlayers(data);
                }
            } catch (err) {
                console.error('Chyba při načítání hráčů z laboratoře:', err);
            }
        };

        loadRoomPlayers();

        // Odběr Realtime změn v tabulce 'room_players' pro danou místnost
        const roomChannel = supabase
            .channel(`room_${currentRoom}`)
            .on(
                'postgres_changes',
                {
                    event: '*', // INSERT, UPDATE, DELETE
                    schema: 'public',
                    table: 'room_players',
                    filter: `room_code=eq.${currentRoom}`
                },
                (payload) => {
                    console.log('⚡ Supabase Realtime změna:', payload);
                    loadRoomPlayers();
                }
            )
            .subscribe();

        return () => {
            isCancelled = true;
            supabase.removeChannel(roomChannel);
        };
    }, [currentRoom]);

    // Založení nové laboratoře (místnosti)
    const handleCreateRoom = async () => {
        setLoading(true);
        try {
            const newCode = Math.random().toString(36).substring(2, 6).toUpperCase();

            // 1. Vložíme místnost do tabulky 'rooms'
            const { error: roomError } = await supabase
                .from('rooms')
                .insert([
                    {
                        room_code: newCode,
                        host_id: String(user.id),
                        host_name: user.prezdivka,
                        status: 'waiting'
                    }
                ]);

            if (roomError) {
                console.error('Chyba při zakládání místnosti:', roomError);
                notify('Nepodařilo se založit laboratoř: ' + roomError.message, 'error');
                return;
            }

            // 2. Vložíme zakladatele jako prvního hráče do 'room_players'
            const { error: playerError } = await supabase
                .from('room_players')
                .insert([
                    {
                        room_code: newCode,
                        player_id: String(user.id),
                        prezdivka: user.prezdivka,
                        is_guest: !!user.isGuest,
                        is_host: true
                    }
                ]);

            if (playerError) {
                console.error('Chyba při zápisu hráče:', playerError);
                notify('Chyba při vstupu do laboratoře: ' + playerError.message, 'error');
                return;
            }

            setCurrentRoom(newCode);
            setIsHost(true);
            notify(`Laboratoř ${newCode} byla vytvořena.`, 'success');
        } catch (err) {
            console.error('Neočekávaná chyba při tvorbě místnosti:', err);
            notify('Chyba spojení se Supabase.', 'error');
        } finally {
            setLoading(false);
        }
    };

    // Připojení k existující laboratoři
    const handleJoinRoom = async (e) => {
        e.preventDefault();
        const code = joinCode.trim().toUpperCase();
        if (!code) return;

        setLoading(true);
        try {
            // 1. Ověříme existenci místnosti v Supabase
            const { data: room, error: roomError } = await supabase
                .from('rooms')
                .select('*')
                .eq('room_code', code)
                .maybeSingle();

            if (roomError) {
                console.error('Chyba vyhledání místnosti:', roomError);
                notify('Chyba při vyhledávání: ' + roomError.message, 'error');
                return;
            }

            if (!room) {
                notify('Tato laboratoř neexistuje nebo byla zrušena.', 'error');
                return;
            }

            // 2. Zkontrolujeme, zda hráč už v místnosti není
            const { data: existing } = await supabase
                .from('room_players')
                .select('id')
                .eq('room_code', code)
                .eq('player_id', String(user.id))
                .maybeSingle();

            if (!existing) {
                const { error: joinError } = await supabase
                    .from('room_players')
                    .insert([
                        {
                            room_code: code,
                            player_id: String(user.id),
                            prezdivka: user.prezdivka,
                            is_guest: !!user.isGuest,
                            is_host: room.host_id === String(user.id)
                        }
                    ]);

                if (joinError) {
                    console.error('Chyba při připojování:', joinError);
                    notify('Nepodařilo se připojit: ' + joinError.message, 'error');
                    return;
                }
            }

            setCurrentRoom(code);
            setIsHost(room.host_id === String(user.id));
            setJoinCode('');
            notify(`Připojeno do laboratoře ${code}.`, 'success');
        } catch (err) {
            console.error('Neočekávaná chyba připojení:', err);
            notify('Chyba spojení se Supabase.', 'error');
        } finally {
            setLoading(false);
        }
    };

    // Opuštění laboratoře
    const handleLeaveRoom = async () => {
        if (!currentRoom) return;

        try {
            await supabase
                .from('room_players')
                .delete()
                .eq('room_code', currentRoom)
                .eq('player_id', String(user.id));

            if (isHost) {
                await supabase
                    .from('rooms')
                    .delete()
                    .eq('room_code', currentRoom);
            }
            notify('Laboratoř opuštěna.', 'info');
        } catch (err) {
            console.error('Chyba při opuštění místnosti:', err);
        } finally {
            setCurrentRoom(null);
            setPlayers([]);
            setIsHost(false);
        }
    };

    // Uložení testovacího skóre do tabulky skore
    const handleSaveSampleScore = async () => {
        setSubmittingScore(true);
        try {
            const nahodneBody = Math.floor(Math.random() * 250) + 50;
            const { error } = await supabase
                .from('skore')
                .insert([
                    {
                        prezdivka: user.prezdivka,
                        body: nahodneBody
                    }
                ]);

            if (error) {
                notify('Chyba při ukládání skóre: ' + error.message, 'error');
            } else {
                notify(`Zapsáno ${nahodneBody} bodů do Síně slávy!`, 'success');
            }
        } catch (err) {
            console.error('Chyba skóre:', err);
            notify('Chyba při zápisu skóre.', 'error');
        } finally {
            setSubmittingScore(false);
        }
    };

    // UI pro čekárnu (Waiting Room v laboratoři)
    if (currentRoom) {
        return (
            <div className="lobby-wrapper">
                <div className="lobby-card">
                    <div className="room-header">
                        <div style={{ fontSize: '13px', color: '#9ca3af' }}>Kód laboratoře</div>
                        <div className="room-code-tag">{currentRoom}</div>
                        <p style={{ margin: '6px 0 0 0', fontSize: '13px', color: '#9ca3af' }}>
                            Sdílej tento kód s ostatními hráči
                        </p>
                    </div>

                    <div className="room-players-box">
                        <div className="room-players-header">
                            <h3>Připojení hráči ({players.length})</h3>
                            <span className="realtime-pill">Realtime</span>
                        </div>

                        <ul className="player-list">
                            {players.map((p) => {
                                const isMe = String(p.player_id) === String(user.id);
                                return (
                                    <li key={p.id || p.player_id} className="player-item">
                                        <span>
                                            {p.is_host ? '👑 ' : ''}
                                            {p.prezdivka}
                                            {isMe && <span className="player-me">(Ty)</span>}
                                        </span>
                                        {p.is_guest && <span className="badge-guest">Host</span>}
                                    </li>
                                );
                            })}
                        </ul>

                        {isHost && (
                            <p className="host-role-notice">Jsi správcem této laboratoře.</p>
                        )}
                    </div>

                    <div className="room-actions">
                        <button
                            type="button"
                            onClick={handleSaveSampleScore}
                            disabled={submittingScore}
                            className="btn-secondary"
                        >
                            {submittingScore ? 'Zapisuji...' : 'Zapsat body'}
                        </button>

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

    // UI pro výběr akce (Lobby menu)
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
                        onClick={onLogout}
                        className="btn-logout"
                    >
                        Odhlásit se
                    </button>
                )}
            </div>

            <div className="lobby-card">
                <h2 className="lobby-title">Alchymistická dílna</h2>
                <p className="lobby-subtitle">Založ novou laboratoř nebo se připoj ke hře pomocí PIN kódu.</p>

                <button 
                    type="button"
                    onClick={handleCreateRoom}
                    disabled={loading}
                    className="btn-create-room"
                >
                    {loading ? 'Vytvářím...' : 'Založit novou laboratoř'}
                </button>

                <div className="join-section">
                    <form onSubmit={handleJoinRoom} className="join-form">
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

                <div className="leaderboard-section">
                    <button
                        type="button"
                        onClick={() => setShowScores(!showScores)}
                        className="leaderboard-toggle-btn"
                    >
                        {showScores ? '▲ Skrýt Síň slávy' : '▼ Zobrazit Síň slávy'}
                    </button>

                    {showScores && (
                        <div className="leaderboard-card">
                            <h4>Nejlepší alchymisté</h4>
                            {leaderboard.length === 0 ? (
                                <p style={{ fontSize: '13px', color: '#9ca3af', margin: 0 }}>
                                    Zatím žádné záznamy.
                                </p>
                            ) : (
                                <ul className="leaderboard-list">
                                    {leaderboard.map((item, index) => (
                                        <li key={item.id || index} className="leaderboard-item">
                                            <span>{index + 1}. {item.prezdivka}</span>
                                            <span className="leaderboard-score">{item.body} b.</span>
                                        </li>
                                    ))}
                                </ul>
                            )}
                            <div style={{ marginTop: '12px', textAlign: 'right' }}>
                                <button
                                    type="button"
                                    onClick={handleSaveSampleScore}
                                    disabled={submittingScore}
                                    className="btn-secondary"
                                    style={{ fontSize: '12px', padding: '6px 12px' }}
                                >
                                    {submittingScore ? 'Zapisuji...' : 'Zapsat body'}
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}