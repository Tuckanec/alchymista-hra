import { useState } from 'react';
import bcrypt from 'bcryptjs';
import { supabase } from './supabaseClient';
import './Auth.css';

export default function Auth({ onLogin, showToast }) {
    // Stav pro přepínání mezi formuláři (přihlášení / registrace)
    const [isLogin, setIsLogin] = useState(true);
    const [loading, setLoading] = useState(false);
    
    // Jeden objekt pro všechna data z formuláře
    const [formData, setFormData] = useState({
        prezdivka: '',
        email: '',
        heslo: ''
    });

    const notify = (msg, type = 'info') => {
        if (showToast) {
            showToast(msg, type);
        } else {
            console.log(`[Toast ${type}]:`, msg);
        }
    };

    // Handler pro změnu inputu
    const handleChange = (e) => {
        setFormData({ 
            ...formData, 
            [e.target.name]: e.target.value 
        });
    };

    const handleGuestLogin = () => {
        const randomId = Math.floor(Math.random() * 10000);
        notify('Vstupuješ jako host.', 'info');
        onLogin({ 
            prezdivka: `Mnich_${randomId}`, 
            id: `guest_${randomId}`, 
            isGuest: true,
            role: 'host'
        });
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);

        const cleanNick = formData.prezdivka.trim();
        const cleanEmail = formData.email.trim();

        try {
            if (isLogin) {
                // Přihlášení přes Supabase dotaz do tabulky uzivatele
                const { data: uzivatel, error } = await supabase
                    .from('uzivatele')
                    .select('id, prezdivka, email, heslo, role')
                    .eq('prezdivka', cleanNick)
                    .maybeSingle();

                if (error) {
                    console.error('Chyba Supabase při přihlašování:', error);
                    notify('Chyba při spojení se Supabase: ' + error.message, 'error');
                    return;
                }

                if (!uzivatel) {
                    notify('Neplatná přezdívka nebo heslo.', 'error');
                    return;
                }

                // Bezpečné porovnání hesla pomocí bcryptjs
                let isMatch = false;
                try {
                    isMatch = bcrypt.compareSync(formData.heslo, uzivatel.heslo);
                } catch (err) {
                    console.error('Chyba při ověřování hashe:', err);
                    isMatch = false;
                }

                if (!isMatch) {
                    notify('Neplatná přezdívka nebo heslo.', 'error');
                    return;
                }

                notify('Vítej zpět v laboratoři!', 'success');
                onLogin({ 
                    prezdivka: uzivatel.prezdivka, 
                    id: String(uzivatel.id),
                    role: uzivatel.role || 'hrac',
                    isGuest: false
                });
            } else {
                // Registrace - kontrola duplicity v tabulce uzivatele
                const { data: existujici, error: checkError } = await supabase
                    .from('uzivatele')
                    .select('id, prezdivka, email')
                    .or(`prezdivka.eq.${cleanNick},email.eq.${cleanEmail}`)
                    .limit(1);

                if (checkError) {
                    console.error('Chyba při kontrole uživatele:', checkError);
                    notify('Chyba při ověřování: ' + checkError.message, 'error');
                    return;
                }

                if (existujici && existujici.length > 0) {
                    notify('Tato přezdívka nebo e-mail již existuje.', 'error');
                    return;
                }

                // Hashování hesla pomocí bcryptjs před uložením do databáze
                const salt = bcrypt.genSaltSync(10);
                const hashedPassword = bcrypt.hashSync(formData.heslo, salt);

                // Vložení nového hráče do tabulky uzivatele
                const { error: insertError } = await supabase
                    .from('uzivatele')
                    .insert([
                        {
                            prezdivka: cleanNick,
                            email: cleanEmail,
                            heslo: hashedPassword,
                            role: 'hrac'
                        }
                    ]);

                if (insertError) {
                    console.error('Chyba při registraci:', insertError);
                    notify('Registrace se nezdařila: ' + insertError.message, 'error');
                    return;
                }

                notify('Registrace proběhla úspěšně! Nyní se můžeš přihlásit.', 'success');
                setIsLogin(true);
            }
        } catch (error) {
            console.error('Neočekávaná chyba:', error);
            notify('Nepodařilo se spojit se Supabase.', 'error');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="auth-container">
            <div className="auth-box">
                <h2>{isLogin ? 'Přihlášení do hry' : 'Registrace alchymisty'}</h2>
                
                <form onSubmit={handleSubmit}>
                    <div className="input-group">
                        <label htmlFor="prezdivka">Přezdívka</label>
                        <input
                            id="prezdivka"
                            type="text"
                            name="prezdivka"
                            placeholder="Zadej přezdívku"
                            value={formData.prezdivka}
                            onChange={handleChange}
                            required
                            disabled={loading}
                            autoComplete="username"
                        />
                    </div>
                    
                    {!isLogin && (
                        <div className="input-group">
                            <label htmlFor="email">E-mail</label>
                            <input
                                id="email"
                                type="email"
                                name="email"
                                placeholder="Zadej e-mail"
                                value={formData.email}
                                onChange={handleChange}
                                required
                                disabled={loading}
                                autoComplete="email"
                            />
                        </div>
                    )}

                    <div className="input-group">
                        <label htmlFor="heslo">Heslo</label>
                        <input
                            id="heslo"
                            type="password"
                            name="heslo"
                            placeholder="••••••••"
                            value={formData.heslo}
                            onChange={handleChange}
                            required
                            disabled={loading}
                            autoComplete={isLogin ? 'current-password' : 'new-password'}
                        />
                    </div>

                    <button type="submit" className="auth-button" disabled={loading}>
                        {loading 
                            ? 'Ověřuji...' 
                            : (isLogin ? 'Přihlásit se' : 'Zaregistrovat se')}
                    </button>
                    
                    <button 
                        type="button" 
                        className="guest-button" 
                        onClick={handleGuestLogin}
                        disabled={loading}
                    >
                        Pokračovat jako host
                    </button>
                </form>

                <p 
                    className="toggle-text" 
                    onClick={() => !loading && setIsLogin(!isLogin)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                            !loading && setIsLogin(!isLogin);
                        }
                    }}
                >
                    {isLogin 
                        ? 'Nemáš účet? Zaregistruj se' 
                        : 'Máš již účet? Přihlas se'}
                </p>
            </div>
        </div>
    );
}