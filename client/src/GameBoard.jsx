import { useState } from 'react';
import './GameBoard.css';

export default function GameBoard({ roomCode, user, isHost, players = [], onLeaveRoom, showToast }) {
    // Schválení soupeři (všichni kromě přihlášeného hráče)
    const opponents = players.filter((p) => Number(p.player_id) !== Number(user.id));

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
        const hostPlayer = players.find((p) => p.is_host);
        return hostPlayer ? Number(hostPlayer.player_id) : Number(user.id);
    });

    const isMyTurn = Number(activeTurnId) === Number(user.id);

    const addLog = (text, type = 'normal') => {
        const now = new Date();
        const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        setLogs((prev) => [...prev, { id: Date.now() + Math.random(), text, type, time: timeStr }]);
    };

    // Zahrání karty do kotlíku
    const handleCardClick = (card) => {
        if (!isMyTurn) {
            if (showToast) showToast('Nyní nejsi na tahu.', 'info');
            return;
        }

        // Přesun z ruky do kotlíku
        setHand((prev) => prev.filter((c) => c.id !== card.id));
        setCauldronIngredients((prev) => [...prev, card]);
        addLog(`${user.prezdivka} vhodil do kotlíku: ${card.name}.`);
    };

    // Ukončení tahu a posun na dalšího hráče
    const handleEndTurn = () => {
        if (!isMyTurn) return;

        // Najdeme index současného hráče a posuneme na dalšího
        const currentIndex = players.findIndex((p) => Number(p.player_id) === Number(activeTurnId));
        const nextIndex = (currentIndex + 1) % (players.length || 1);
        const nextPlayer = players[nextIndex] || players[0];

        if (nextPlayer) {
            const nextId = Number(nextPlayer.player_id);
            const nextName = nextPlayer.uzivatele?.prezdivka || nextPlayer.prezdivka || 'Další hráč';
            setActiveTurnId(nextId);
            addLog(`${user.prezdivka} ukončil svůj tah.`, 'turn');
            addLog(`Na tahu je: ${nextName}.`, 'turn');
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
                                Žádní další alchymisté u kotlíku. Čekáš na soupeře.
                            </div>
                        ) : (
                            opponents.map((opp) => {
                                const oppName = opp.uzivatele?.prezdivka || opp.prezdivka || 'Soupeř';
                                const isOppTurn = Number(opp.player_id) === Number(activeTurnId);
                                return (
                                    <div 
                                        key={opp.id || opp.player_id} 
                                        className={`opponent-card ${isOppTurn ? 'is-turn' : ''}`}
                                    >
                                        <div className="opponent-header">
                                            <span>
                                                {opp.is_host ? '👑 ' : ''}
                                                {oppName}
                                            </span>
                                            {isOppTurn && (
                                                <span className="opponent-turn-indicator">Na tahu</span>
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
                        <span style={{ fontSize: '11px', color: '#6b7280' }}>Záznam</span>
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
