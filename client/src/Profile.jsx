import { useState, useEffect, useRef } from 'react';
import { supabase } from './supabaseClient';
import Avatar from './Avatar';
import './Profile.css';

export default function Profile({ user, onUpdateUser, onBackToLobby, showToast, onOpenAuth }) {
    // Stav pro přepnutí na detail kamaráda (read-only náhled)
    const [selectedFriendProfile, setSelectedFriendProfile] = useState(null);

    // Osobní statistiky načtené z databáze
    const [stats, setStats] = useState({
        games_played: user?.games_played || 0,
        games_won: user?.games_won || 0,
        skulls_drawn: user?.skulls_drawn || 0,
    });

    // Seznamy přátelství
    const [friends, setFriends] = useState([]);
    const [pendingRequests, setPendingRequests] = useState([]);
    const [searchNickname, setSearchNickname] = useState('');
    const [isSearching, setIsSearching] = useState(false);
    const [isUploading, setIsUploading] = useState(false);

    const fileInputRef = useRef(null);

    // Načtení čerstvých statistik aktuálního uživatele
    useEffect(() => {
        if (!user?.id) return;

        let isCancelled = false;

        const fetchUserStats = async () => {
            try {
                const { data, error } = await supabase
                    .from('uzivatele')
                    .select('id, prezdivka, avatar_url, games_played, games_won, skulls_drawn')
                    .eq('id', Number(user.id))
                    .maybeSingle();

                if (!isCancelled && data && !error) {
                    setStats({
                        games_played: data.games_played || 0,
                        games_won: data.games_won || 0,
                        skulls_drawn: data.skulls_drawn || 0,
                    });

                    if (data.avatar_url !== user.avatar_url && onUpdateUser) {
                        onUpdateUser({ ...user, avatar_url: data.avatar_url });
                    }
                }
            } catch (err) {
                console.error('Chyba při stahování statistik profilu:', err);
            }
        };

        fetchUserStats();

        return () => {
            isCancelled = true;
        };
    }, [user?.id]);

    // Načtení přátel a nevyřízených žádostí
    const fetchFriendships = async () => {
        if (!user?.id) return;

        try {
            const { data: friendships, error } = await supabase
                .from('friendships')
                .select('*')
                .or(`requester_id.eq.${user.id},addressee_id.eq.${user.id}`);

            if (error || !friendships) {
                console.error('Chyba při načítání přátelství:', error);
                return;
            }

            // Sesbíráme unikátní ID ostatních hráčů
            const otherIds = new Set();
            friendships.forEach((f) => {
                const other = Number(f.requester_id) === Number(user.id) ? Number(f.addressee_id) : Number(f.requester_id);
                otherIds.add(other);
            });

            const usersMap = {};
            if (otherIds.size > 0) {
                const { data: usersData } = await supabase
                    .from('uzivatele')
                    .select('id, prezdivka, avatar_url, games_played, games_won, skulls_drawn')
                    .in('id', Array.from(otherIds));

                if (usersData) {
                    usersData.forEach((u) => {
                        usersMap[u.id] = u;
                    });
                }
            }

            // Příchozí žádosti čekající na schválení
            const incoming = friendships
                .filter((f) => Number(f.addressee_id) === Number(user.id) && f.status === 'pending')
                .map((f) => ({
                    friendshipId: f.id,
                    user: usersMap[f.requester_id] || { id: f.requester_id, prezdivka: 'Alchymista' }
                }));

            // Schválení přátelé
            const accepted = friendships
                .filter((f) => f.status === 'accepted')
                .map((f) => {
                    const friendId = Number(f.requester_id) === Number(user.id)
                        ? Number(f.addressee_id)
                        : Number(f.requester_id);
                    return {
                        friendshipId: f.id,
                        user: usersMap[friendId] || { id: friendId, prezdivka: 'Alchymista' }
                    };
                });

            setPendingRequests(incoming);
            setFriends(accepted);
        } catch (err) {
            console.error('Chyba při zpracování přátelství:', err);
        }
    };

    useEffect(() => {
        if (!user?.id) return;

        fetchFriendships();

        // Realtime odběr pro změny v tabulce friendships
        const channel = supabase
            .channel(`friendships_realtime_${user.id}`)
            .on(
                'postgres_changes',
                { event: '*', schema: 'public', table: 'friendships' },
                () => {
                    fetchFriendships();
                }
            )
            .subscribe();

        return () => {
            supabase.removeChannel(channel);
        };
    }, [user?.id]);

    // Výpočet procentuální úspěšnosti (Winrate)
    const calculateWinrate = (played, won) => {
        const p = Number(played) || 0;
        const w = Number(won) || 0;
        if (p === 0) return '0%';
        return `${Math.round((w / p) * 100)}%`;
    };

    // Nahrání a zpracování profilového obrázku pomocí HTML5 Canvas
    const handleAvatarClick = () => {
        if (fileInputRef.current && !isUploading) {
            fileInputRef.current.click();
        }
    };

    const handleFileChange = (e) => {
        const file = e.target.files?.[0];
        if (!file) return;

        if (!file.type.startsWith('image/')) {
            showToast?.('Vyber prosím platný obrázkový soubor.', 'error');
            return;
        }

        const reader = new FileReader();
        reader.onload = (event) => {
            const img = new Image();
            img.onload = () => {
                // Vytvoříme plátno 256x256 px a vycentrujeme čtvercový výřez
                const canvas = document.createElement('canvas');
                const targetSize = 256;
                canvas.width = targetSize;
                canvas.height = targetSize;
                const ctx = canvas.getContext('2d');

                const minSide = Math.min(img.width, img.height);
                const sx = (img.width - minSide) / 2;
                const sy = (img.height - minSide) / 2;

                ctx.drawImage(img, sx, sy, minSide, minSide, 0, 0, targetSize, targetSize);

                canvas.toBlob(async (blob) => {
                    if (!blob) {
                        showToast?.('Chyba při kompresi obrázku.', 'error');
                        return;
                    }
                    await uploadProcessedAvatar(blob);
                }, 'image/webp', 0.85);
            };
            img.src = event.target.result;
        };
        reader.readAsDataURL(file);

        // Reset inputu
        e.target.value = '';
    };

    const uploadProcessedAvatar = async (blob) => {
        setIsUploading(true);
        try {
            const fileName = `avatar_${user.id}_${Date.now()}.webp`;

            const { error: uploadError } = await supabase.storage
                .from('avatars')
                .upload(fileName, blob, {
                    cacheControl: '3600',
                    upsert: true,
                    contentType: blob.type || 'image/webp'
                });

            if (uploadError) {
                console.error('Chyba uploadu do Supabase Storage:', uploadError);
                showToast?.(`Nahrávání selhalo: ${uploadError.message}`, 'error');
                return;
            }

            const { data: publicUrlData } = supabase.storage
                .from('avatars')
                .getPublicUrl(fileName);

            const newAvatarUrl = publicUrlData.publicUrl;

            // Uložíme odkaz do databáze uzivatele
            const { error: dbError } = await supabase
                .from('uzivatele')
                .update({ avatar_url: newAvatarUrl })
                .eq('id', Number(user.id));

            if (dbError) {
                console.error('Chyba při ukládání url avataru do DB:', dbError);
                showToast?.('Chyba při zápisu avataru do profilu.', 'error');
                return;
            }

            // Aktualizujeme stav v aplikaci
            if (onUpdateUser) {
                onUpdateUser({ ...user, avatar_url: newAvatarUrl });
            }

            showToast?.('Profilový obrázek byl úspěšně změněn!', 'success');
        } catch (err) {
            console.error('Neočekávaná chyba při uploadu avataru:', err);
            showToast?.('Nepodařilo se nahrát profilový obrázek.', 'error');
        } finally {
            setIsUploading(false);
        }
    };

    // Odeslání žádosti o přátelství podle přezdívky
    const handleSendFriendRequest = async (e) => {
        e.preventDefault();
        const query = searchNickname.trim();
        if (!query) return;

        if (query.toLowerCase() === user.prezdivka?.toLowerCase()) {
            showToast?.('Nemůžeš poslat žádost sám sobě.', 'error');
            return;
        }

        setIsSearching(true);
        try {
            // Najdeme hráče v databázi
            const { data: targetUser, error: searchErr } = await supabase
                .from('uzivatele')
                .select('id, prezdivka')
                .ilike('prezdivka', query)
                .maybeSingle();

            if (searchErr || !targetUser) {
                showToast?.(`Hráč "${query}" nebyl nalezen.`, 'error');
                return;
            }

            if (Number(targetUser.id) === Number(user.id)) {
                showToast?.('Nemůžeš poslat žádost sám sobě.', 'error');
                return;
            }

            // Ověříme stávající vztah
            const { data: existing } = await supabase
                .from('friendships')
                .select('*')
                .or(`and(requester_id.eq.${user.id},addressee_id.eq.${targetUser.id}),and(requester_id.eq.${targetUser.id},addressee_id.eq.${user.id})`)
                .maybeSingle();

            if (existing) {
                if (existing.status === 'accepted') {
                    showToast?.(`S hráčem ${targetUser.prezdivka} už jste přátelé.`, 'info');
                    return;
                }
                if (Number(existing.requester_id) === Number(user.id)) {
                    showToast?.(`Žádost hráči ${targetUser.prezdivka} již byla odeslána.`, 'info');
                    return;
                }
                // Druhý hráč nám už dříve poslal žádost -> schválíme ji
                await handleAcceptRequest(existing.id);
                showToast?.(`Žádost od hráče ${targetUser.prezdivka} byla schválena!`, 'success');
                setSearchNickname('');
                return;
            }

            const { error: insertErr } = await supabase
                .from('friendships')
                .insert({
                    requester_id: Number(user.id),
                    addressee_id: Number(targetUser.id),
                    status: 'pending'
                });

            if (insertErr) {
                console.error('Chyba při odesílání žádosti:', insertErr);
                showToast?.('Chyba při odesílání žádosti.', 'error');
                return;
            }

            showToast?.(`Žádost o přátelství odeslána hráči ${targetUser.prezdivka}!`, 'success');
            setSearchNickname('');
            fetchFriendships();
        } catch (err) {
            console.error('Chyba při vyhledávání kamaráda:', err);
            showToast?.('Chyba při odesílání žádosti.', 'error');
        } finally {
            setIsSearching(false);
        }
    };

    // Schválení příchozí žádosti
    const handleAcceptRequest = async (friendshipId) => {
        try {
            const { error } = await supabase
                .from('friendships')
                .update({ status: 'accepted' })
                .eq('id', friendshipId);

            if (error) {
                showToast?.('Chyba při schvalování žádosti.', 'error');
                return;
            }

            showToast?.('Žádost o přátelství byla přijata!', 'success');
            fetchFriendships();
        } catch (err) {
            console.error('Chyba při schválení:', err);
        }
    };

    // Odmítnutí žádosti nebo odebrání z přátel
    const handleRemoveFriendship = async (friendshipId, isRemoval = false) => {
        try {
            const { error } = await supabase
                .from('friendships')
                .delete()
                .eq('id', friendshipId);

            if (error) {
                showToast?.('Chyba při odebírání záznamu.', 'error');
                return;
            }

            showToast?.(isRemoval ? 'Přítel byl odebrán ze seznamu.' : 'Žádost byla odmítnuta.', 'info');
            fetchFriendships();
        } catch (err) {
            console.error('Chyba při mazání přátelství:', err);
        }
    };

    // Pokud návštěvník není přihlášen
    if (!user) {
        return (
            <div className="profile-container">
                <div className="profile-guest-card">
                    <div className="profile-guest-icon">👤</div>
                    <h2>Můj Profil</h2>
                    <p className="profile-guest-text">Pro zobrazení svého profilu se musíš nejprve přihlásit.</p>
                    <button
                        type="button"
                        onClick={onOpenAuth}
                        className="btn-profile-primary"
                    >
                        Přihlásit se
                    </button>
                    {onBackToLobby && (
                        <button
                            type="button"
                            onClick={onBackToLobby}
                            className="btn-profile-secondary"
                        >
                            ← Zpět na párty
                        </button>
                    )}
                </div>
            </div>
        );
    }

    // Profil, který právě zobrazujeme (vlastní nebo náhled kamaráda)
    const isViewingFriend = Boolean(selectedFriendProfile);
    const activeProfileData = isViewingFriend ? selectedFriendProfile : {
        ...user,
        games_played: stats.games_played,
        games_won: stats.games_won,
        skulls_drawn: stats.skulls_drawn
    };

    return (
        <div className="profile-container">
            <div className="profile-card">
                {/* Tlačítko zpět pokud prohlížíme profil kamaráda */}
                {isViewingFriend && (
                    <div className="profile-back-bar">
                        <button
                            type="button"
                            onClick={() => setSelectedFriendProfile(null)}
                            className="btn-back-to-my-profile"
                        >
                            ← Zpět na můj profil
                        </button>
                    </div>
                )}

                {/* Hlavička profilu s avatarem a přezdívkou */}
                <header className="profile-header">
                    <div className="profile-avatar-wrapper">
                        {!isViewingFriend ? (
                            <>
                                <input
                                    ref={fileInputRef}
                                    type="file"
                                    accept="image/*"
                                    style={{ display: 'none' }}
                                    onChange={handleFileChange}
                                />
                                <div
                                    className={`profile-avatar-clickable ${isUploading ? 'uploading' : ''}`}
                                    onClick={handleAvatarClick}
                                    title="Klikni pro změnu profilového obrázku"
                                >
                                    <Avatar
                                        avatarUrl={activeProfileData.avatar_url}
                                        name={activeProfileData.prezdivka}
                                        size={96}
                                        className="profile-main-avatar"
                                    />
                                    <div className="avatar-hover-overlay">
                                        <span>📷</span>
                                    </div>
                                </div>
                            </>
                        ) : (
                            <Avatar
                                avatarUrl={activeProfileData.avatar_url}
                                name={activeProfileData.prezdivka}
                                size={96}
                                className="profile-main-avatar"
                            />
                        )}
                    </div>

                    <div className="profile-title-group">
                        <h1 className="profile-username">{activeProfileData.prezdivka}</h1>
                        <span className="profile-role-tag">
                            {isViewingFriend ? 'Kamarád' : 'Alchymista'}
                        </span>
                    </div>
                </header>

                {/* 4 čisté osobní statistiky vedle sebe (bez zbytečných ikon) */}
                <section className="profile-stats-section" aria-label="Osobní statistiky">
                    <div className="profile-stats-grid">
                        <div className="stat-card">
                            <span className="stat-value">{activeProfileData.games_played || 0}</span>
                            <span className="stat-label">Odehrané hry</span>
                        </div>
                        <div className="stat-card">
                            <span className="stat-value">{activeProfileData.games_won || 0}</span>
                            <span className="stat-label">Výhry</span>
                        </div>
                        <div className="stat-card">
                            <span className="stat-value">
                                {calculateWinrate(activeProfileData.games_played, activeProfileData.games_won)}
                            </span>
                            <span className="stat-label">Winrate</span>
                        </div>
                        <div className="stat-card">
                            <span className="stat-value">{activeProfileData.skulls_drawn || 0}</span>
                            <span className="stat-label">Vylíznuté lebky</span>
                        </div>
                    </div>
                </section>

                {/* Sekce Přátelé (zobrazuje se VÝHRADNĚ na vlastním profilu) */}
                {!isViewingFriend && (
                    <section className="profile-friends-section" aria-label="Přátelé">
                        <h2 className="friends-heading">Přátelé</h2>

                        {/* a) Vyhledávací input pro nalezení hráče a odeslání žádosti */}
                        <form onSubmit={handleSendFriendRequest} className="friend-search-form">
                            <input
                                type="text"
                                value={searchNickname}
                                onChange={(e) => setSearchNickname(e.target.value)}
                                placeholder="Zadej přezdívku hráče..."
                                className="friend-search-input"
                                disabled={isSearching}
                            />
                            <button
                                type="submit"
                                className="btn-send-request"
                                disabled={isSearching || !searchNickname.trim()}
                            >
                                {isSearching ? 'Odesílám...' : 'Přidat'}
                            </button>
                        </form>

                        {/* b) Příchozí žádosti (žádná prázdná tabulka, pouze pokud existují) */}
                        {pendingRequests.length > 0 && (
                            <div className="pending-requests-container">
                                <span className="pending-section-title">Nové žádosti o přátelství:</span>
                                <div className="pending-requests-list">
                                    {pendingRequests.map((req) => (
                                        <div key={req.friendshipId} className="pending-request-row">
                                            <div className="pending-user-info">
                                                <Avatar
                                                    avatarUrl={req.user.avatar_url}
                                                    name={req.user.prezdivka}
                                                    size={32}
                                                />
                                                <span className="pending-user-name">{req.user.prezdivka}</span>
                                            </div>
                                            <div className="pending-actions">
                                                <button
                                                    type="button"
                                                    onClick={() => handleAcceptRequest(req.friendshipId)}
                                                    className="btn-request-accept"
                                                    title="Schválit žádost"
                                                    aria-label="Schválit"
                                                >
                                                    ✓
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => handleRemoveFriendship(req.friendshipId, false)}
                                                    className="btn-request-reject"
                                                    title="Odmítnout žádost"
                                                    aria-label="Odmítnout"
                                                >
                                                    ✕
                                                </button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* c) Seznam schválených přátel */}
                        <div className="friends-list-container">
                            {friends.length === 0 ? (
                                <p className="friends-empty-hint">Zatím nemáš v seznamu žádné přátele.</p>
                            ) : (
                                <ul className="friends-list">
                                    {friends.map((friend) => (
                                        <li key={friend.friendshipId} className="friend-item">
                                            <div
                                                className="friend-item-clickable"
                                                onClick={() => setSelectedFriendProfile(friend.user)}
                                                title={`Zobrazit profil hráče ${friend.user.prezdivka}`}
                                            >
                                                <Avatar
                                                    avatarUrl={friend.user.avatar_url}
                                                    name={friend.user.prezdivka}
                                                    size={36}
                                                />
                                                <span className="friend-name">{friend.user.prezdivka}</span>
                                            </div>
                                            <button
                                                type="button"
                                                onClick={() => handleRemoveFriendship(friend.friendshipId, true)}
                                                className="btn-remove-friend"
                                                title={`Odebrat hráče ${friend.user.prezdivka} z přátel`}
                                                aria-label={`Odebrat hráče ${friend.user.prezdivka}`}
                                            >
                                                ✕
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    </section>
                )}
            </div>
        </div>
    );
}
