import { useState, useEffect } from 'react';

export default function Lobby({ socket, user }) {
    const [joinCode, setJoinCode] = useState('');
    const [currentRoom, setCurrentRoom] = useState(null);
    const [players, setPlayers] = useState([]); // Zde budeme držet seznam lidí

    // Naslouchání na aktualizace ze serveru
    useEffect(() => {
        socket.on('updatePlayers', (updatedPlayers) => {
            setPlayers(updatedPlayers);
        });

        // Cleanup při odpojení komponenty
        return () => {
            socket.off('updatePlayers');
        };
    }, [socket]);

    const handleCreateRoom = () => {
        socket.emit('createRoom', user, (response) => {
            if (response.success) {
                setCurrentRoom(response.roomCode);
                setPlayers(response.players); // Nastavíme sebe jako prvního hráče
            }
        });
    };

    const handleJoinRoom = (e) => {
        e.preventDefault();
        if (!joinCode) return;

        socket.emit('joinRoom', { roomCode: joinCode, userData: user }, (response) => {
            if (response.success) {
                setCurrentRoom(response.roomCode);
                setPlayers(response.players); // Nastavíme všechny stávající hráče
            } else {
                alert('❌ ' + response.error);
            }
        });
    };

    // UI pro čekárnu (Waiting Room)
    if (currentRoom) {
        return (
            <div style={{ textAlign: 'center', marginTop: '50px', color: '#e0d6ff' }}>
                <h2>🏰 Laboratoř: <span style={{ color: '#4ade80' }}>{currentRoom}</span></h2>
                <p>Pošli tento kód dalším alchymistům!</p>
                
                <div style={{ background: 'rgba(20, 10, 30, 0.8)', padding: '20px', borderRadius: '8px', maxWidth: '300px', margin: '20px auto', border: '1px solid #5a3e85' }}>
                    <h3>Připojení učedníci:</h3>
                    <ul style={{ listStyle: 'none', padding: 0 }}>
                        {players.map((p, index) => (
                            <li key={index} style={{ padding: '8px', borderBottom: '1px solid #5a3e85' }}>
                                {p.prezdivka} {p.id === user.id && '(Ty)'}
                            </li>
                        ))}
                    </ul>
                </div>
            </div>
        );
    }

    // UI pro výběr akce
    return (
        <div style={{ textAlign: 'center', marginTop: '50px', color: '#e0d6ff' }}>
            <h2>Vítej u kotlíku, <span style={{ color: '#a78bfa' }}>{user.prezdivka}</span>!</h2>
            
            <div style={{ margin: '40px 0' }}>
                <button onClick={handleCreateRoom} style={{ padding: '15px 30px', fontSize: '18px', cursor: 'pointer', background: '#5a3e85', color: 'white', border: 'none', borderRadius: '6px' }}>
                    ➕ Založit novou laboratoř
                </button>
            </div>

            <hr style={{ maxWidth: '300px', borderColor: '#5a3e85' }} />

            <div style={{ margin: '40px 0' }}>
                <form onSubmit={handleJoinRoom}>
                    <input 
                        type="text" 
                        placeholder="Zadej PIN kód" 
                        value={joinCode}
                        onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                        maxLength={4}
                        style={{ padding: '10px', fontSize: '16px', width: '120px', textAlign: 'center', background: '#1a0f2e', color: 'white', border: '1px solid #5a3e85', borderRadius: '6px' }}
                    />
                    <button type="submit" style={{ padding: '10px 20px', fontSize: '16px', marginLeft: '10px', cursor: 'pointer', background: '#4ade80', color: 'black', border: 'none', borderRadius: '6px', fontWeight: 'bold' }}>
                        Připojit se
                    </button>
                </form>
            </div>
        </div>
    );
}