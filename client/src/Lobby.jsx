import { useState, useEffect } from 'react';
import { supabase } from './supabaseClient';

export default function Lobby({ user, onLogout }) {
    const [joinCode, setJoinCode] = useState('');
    const [currentRoom, setCurrentRoom] = useState(null);
    const [isHost, setIsHost] = useState(false);
    const [players, setPlayers] = useState([]);
    const [loading, setLoading] = useState(false);

    // Sekce skóre (Síň slávy)
    const [showScores, setShowScores] = useState(false);
    const [leaderboard, setLeaderboard] = useState([]);
    const [submittingScore, setSubmittingScore] = useState(false);

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

        // Asynchronní načtení dat
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

        // Asynchronní počáteční stažení hráčů
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
                    console.log('⚡ Supabase Realtime změna v laboratoři:', payload);
                    loadRoomPlayers();
                }
            )
            .subscribe();

        // Cleanup: odhlášení kanálu při opuštění místnosti nebo unmountu
        return () => {
            isCancelled = true;
            supabase.removeChannel(roomChannel);
        };
    }, [currentRoom]);

    // Založení nové laboratoře (místnosti)
    const handleCreateRoom = async () => {
        setLoading(true);
        try {
            // Vygenerujeme náhodný 4místný kód (např. 7K2M)
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
                alert('❌ Nepodařilo se založit laboratoř: ' + roomError.message);
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
                alert('❌ Chyba při vstupu do laboratoře: ' + playerError.message);
                return;
            }

            setCurrentRoom(newCode);
            setIsHost(true);
        } catch (err) {
            console.error('Neočekávaná chyba při tvorbě místnosti:', err);
            alert('🔌 Chyba spojení se Supabase.');
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
                alert('🔌 Chyba při vyhledávání: ' + roomError.message);
                return;
            }

            if (!room) {
                alert('❌ Tato laboratoř neexistuje nebo už vybuchla.');
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
                // Přidáme hráče do 'room_players'
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
                    alert('❌ Nepodařilo se připojit: ' + joinError.message);
                    return;
                }
            }

            setCurrentRoom(code);
            setIsHost(room.host_id === String(user.id));
            setJoinCode('');
        } catch (err) {
            console.error('Neočekávaná chyba připojení:', err);
            alert('🔌 Chyba spojení se Supabase.');
        } finally {
            setLoading(false);
        }
    };

    // Opuštění laboratoře
    const handleLeaveRoom = async () => {
        if (!currentRoom) return;

        try {
            // Smažeme hráče z room_players (vyvolá Realtime DELETE event pro ostatní hráče)
            await supabase
                .from('room_players')
                .delete()
                .eq('room_code', currentRoom)
                .eq('player_id', String(user.id));

            // Pokud místnost opustí host, smažeme záznam z rooms
            if (isHost) {
                await supabase
                    .from('rooms')
                    .delete()
                    .eq('room_code', currentRoom);
            }
        } catch (err) {
            console.error('Chyba při opuštění místnosti:', err);
        } finally {
            setCurrentRoom(null);
            setPlayers([]);
            setIsHost(false);
        }
    };

    // Zkušební uložení alchymistického skóre do tabulky skore
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
                alert('❌ Chyba při ukládání skóre: ' + error.message);
            } else {
                alert(`⚗️ Zapsáno ${nahodneBody} alchymistických bodů do Síně slávy!`);
            }
        } catch (err) {
            console.error('Chyba skóre:', err);
        } finally {
            setSubmittingScore(false);
        }
    };

    // UI pro čekárnu (Waiting Room v laboratoři)
    if (currentRoom) {
        return (
            <div style={{ textAlign: 'center', marginTop: '40px', color: '#e0d6ff' }}>
                <h2>🏰 Laboratoř: <span style={{ color: '#4ade80', letterSpacing: '3px' }}>{currentRoom}</span></h2>
                <p style={{ color: '#bfa9db' }}>Pošli tento kód dalším alchymistům, ať se připojí ke kotlíku!</p>
                
                <div style={{
                    background: 'rgba(20, 10, 30, 0.85)',
                    padding: '24px',
                    borderRadius: '12px',
                    maxWidth: '360px',
                    margin: '25px auto',
                    border: '1px solid #5a3e85',
                    boxShadow: '0 0 20px rgba(90, 62, 133, 0.4)'
                }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
                        <h3 style={{ margin: 0, color: '#e0d6ff' }}>Učedníci u kotlíku:</h3>
                        <span style={{ fontSize: '12px', background: '#5a3e85', padding: '3px 8px', borderRadius: '12px' }}>
                            ⚡ Realtime
                        </span>
                    </div>

                    <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 20px 0' }}>
                        {players.map((p) => {
                            const isMe = String(p.player_id) === String(user.id);
                            return (
                                <li 
                                    key={p.id || p.player_id} 
                                    style={{ 
                                        padding: '10px', 
                                        borderBottom: '1px solid rgba(90, 62, 133, 0.5)',
                                        display: 'flex',
                                        justifyContent: 'space-between',
                                        alignItems: 'center'
                                    }}
                                >
                                    <span>
                                        {p.is_host && '👑 '}
                                        <strong>{p.prezdivka}</strong> {isMe && <span style={{ color: '#4ade80' }}>(Ty)</span>}
                                    </span>
                                    {p.is_guest && <span style={{ fontSize: '11px', color: '#a78bfa' }}>[Host]</span>}
                                </li>
                            );
                        })}
                    </ul>

                    {isHost && (
                        <p style={{ fontSize: '13px', color: '#4ade80', margin: '10px 0' }}>
                            Jsi správcem této laboratoře.
                        </p>
                    )}

                    <div style={{ display: 'flex', gap: '10px', justifyContent: 'center', marginTop: '15px' }}>
                        <button
                            onClick={handleSaveSampleScore}
                            disabled={submittingScore}
                            style={{
                                padding: '8px 14px',
                                fontSize: '13px',
                                cursor: 'pointer',
                                background: '#5a3e85',
                                color: 'white',
                                border: 'none',
                                borderRadius: '6px'
                            }}
                        >
                            {submittingScore ? 'Zapisuji...' : '🧪 Zapsat skóre'}
                        </button>

                        <button 
                            onClick={handleLeaveRoom}
                            style={{ 
                                padding: '8px 14px', 
                                fontSize: '13px', 
                                cursor: 'pointer', 
                                background: 'transparent', 
                                color: '#f87171', 
                                border: '1px solid #f87171', 
                                borderRadius: '6px' 
                            }}
                        >
                            🚪 Opustit laboratoř
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    // UI pro výběr akce (Lobby menu)
    return (
        <div style={{ textAlign: 'center', marginTop: '30px', color: '#e0d6ff' }}>
            <div style={{ maxWidth: '500px', margin: '0 auto', padding: '20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                    <span style={{ fontSize: '14px', color: '#bfa9db' }}>
                        Alchymista: <strong style={{ color: '#4ade80' }}>{user.prezdivka}</strong>
                        {user.isGuest && <span style={{ color: '#a78bfa', marginLeft: '6px' }}>[Host]</span>}
                    </span>
                    {onLogout && (
                        <button 
                            onClick={onLogout}
                            style={{
                                background: 'transparent',
                                border: '1px solid #5a3e85',
                                color: '#bfa9db',
                                padding: '4px 10px',
                                borderRadius: '6px',
                                cursor: 'pointer',
                                fontSize: '12px'
                            }}
                        >
                            Odhlásit se
                        </button>
                    )}
                </div>

                <h2>Vítej u alchymistického kotlíku!</h2>
                <p style={{ color: '#bfa9db', fontSize: '15px' }}>
                    Založ novou laboratoř pro své přátele nebo se připoj pomocí kódu.
                </p>
                
                <div style={{ margin: '35px 0' }}>
                    <button 
                        onClick={handleCreateRoom}
                        disabled={loading}
                        style={{ 
                            padding: '14px 28px', 
                            fontSize: '17px', 
                            cursor: loading ? 'not-allowed' : 'pointer', 
                            background: '#5a3e85', 
                            color: 'white', 
                            border: '1px solid #7c3aed', 
                            borderRadius: '8px',
                            fontWeight: 'bold',
                            boxShadow: '0 0 15px rgba(124, 58, 237, 0.4)',
                            transition: 'all 0.2s ease'
                        }}
                    >
                        {loading ? 'Zakládám...' : '➕ Založit novou laboratoř'}
                    </button>
                </div>

                <hr style={{ maxWidth: '280px', borderColor: 'rgba(90, 62, 133, 0.5)', margin: '25px auto' }} />

                <div style={{ margin: '30px 0' }}>
                    <form onSubmit={handleJoinRoom}>
                        <input 
                            type="text" 
                            placeholder="KÓD PIN" 
                            value={joinCode}
                            onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                            maxLength={6}
                            disabled={loading}
                            style={{ 
                                padding: '12px', 
                                fontSize: '16px', 
                                width: '130px', 
                                textAlign: 'center', 
                                background: '#1a0f2e', 
                                color: 'white', 
                                border: '1px solid #5a3e85', 
                                borderRadius: '6px',
                                letterSpacing: '2px',
                                fontWeight: 'bold'
                            }}
                        />
                        <button 
                            type="submit" 
                            disabled={loading || !joinCode}
                            style={{ 
                                padding: '12px 22px', 
                                fontSize: '16px', 
                                marginLeft: '10px', 
                                cursor: (loading || !joinCode) ? 'not-allowed' : 'pointer', 
                                background: '#4ade80', 
                                color: '#080411', 
                                border: 'none', 
                                borderRadius: '6px', 
                                fontWeight: 'bold' 
                            }}
                        >
                            Připojit se
                        </button>
                    </form>
                </div>

                {/* Síň slávy (Žebříček ze Supabase tabulky skore) */}
                <div style={{ marginTop: '40px', borderTop: '1px solid rgba(90, 62, 133, 0.4)', paddingTop: '20px' }}>
                    <button
                        onClick={() => setShowScores(!showScores)}
                        style={{
                            background: 'transparent',
                            border: 'none',
                            color: '#a78bfa',
                            cursor: 'pointer',
                            fontSize: '14px',
                            textDecoration: 'underline'
                        }}
                    >
                        {showScores ? '▲ Skrýt Síň slávy' : '🏆 Zobrazit Síň slávy (nejlepší alchymisté)'}
                    </button>

                    {showScores && (
                        <div style={{
                            background: 'rgba(20, 10, 30, 0.8)',
                            padding: '16px',
                            borderRadius: '8px',
                            marginTop: '15px',
                            border: '1px solid #5a3e85'
                        }}>
                            <h4 style={{ margin: '0 0 12px 0', color: '#4ade80' }}>🏆 Nejlepší alchymisté (Supabase)</h4>
                            {leaderboard.length === 0 ? (
                                <p style={{ fontSize: '13px', color: '#9ca3af' }}>Zatím žádné záznamy v síni slávy.</p>
                            ) : (
                                <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                                    {leaderboard.map((item, index) => (
                                        <li 
                                            key={item.id || index}
                                            style={{
                                                display: 'flex',
                                                justifyContent: 'space-between',
                                                padding: '6px 8px',
                                                borderBottom: '1px solid rgba(90, 62, 133, 0.3)',
                                                fontSize: '14px'
                                            }}
                                        >
                                            <span>{index + 1}. {item.prezdivka}</span>
                                            <strong style={{ color: '#4ade80' }}>{item.body} b.</strong>
                                        </li>
                                    ))}
                                </ul>
                            )}
                            <button
                                onClick={handleSaveSampleScore}
                                disabled={submittingScore}
                                style={{
                                    marginTop: '15px',
                                    padding: '8px 16px',
                                    fontSize: '12px',
                                    background: '#5a3e85',
                                    color: 'white',
                                    border: 'none',
                                    borderRadius: '6px',
                                    cursor: 'pointer'
                                }}
                            >
                                {submittingScore ? 'Zapisuji...' : '⚗️ Zapsat náhodné skóre'}
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}