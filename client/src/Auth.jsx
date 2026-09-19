import { useState } from 'react';
import { supabase } from './supabaseClient';
import './Auth.css';

export default function Auth({ onLogin }) {
    // Stav pro přepínání mezi formuláři (přihlášení / registrace)
    const [isLogin, setIsLogin] = useState(true);
    const [loading, setLoading] = useState(false);
    
    // Jeden objekt pro všechna data z formuláře
    const [formData, setFormData] = useState({
        prezdivka: '',
        email: '',
        heslo: ''
    });

    // Univerzální handler pro změnu jakéhokoliv inputu
    const handleChange = (e) => {
        setFormData({ 
            ...formData, 
            [e.target.name]: e.target.value 
        });
    };

    const handleGuestLogin = () => {
        const randomId = Math.floor(Math.random() * 10000);
        // Vygenerujeme dočasné jméno a označíme ho jako hosta
        onLogin({ 
            prezdivka: `Toulavý_Mnich_${randomId}`, 
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
                    alert('🔌 Chyba při spojení se Supabase: ' + error.message);
                    return;
                }

                if (!uzivatel || uzivatel.heslo !== formData.heslo) {
                    alert('❌ Neplatná přezdívka nebo heslo.');
                    return;
                }

                alert('🧪 Vítej zpět v laboratoři, alchymisto!');
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
                    alert('🔌 Chyba při ověřování: ' + checkError.message);
                    return;
                }

                if (existujici && existujici.length > 0) {
                    alert('❌ Tato přezdívka nebo e-mail už v laboratoři existuje.');
                    return;
                }

                // Vložení nového učedníka do Supabase tabulky uzivatele
                const { error: insertError } = await supabase
                    .from('uzivatele')
                    .insert([
                        {
                            prezdivka: cleanNick,
                            email: cleanEmail,
                            heslo: formData.heslo,
                            role: 'hrac'
                        }
                    ]);

                if (insertError) {
                    console.error('Chyba při registraci:', insertError);
                    alert('❌ Registrace se nezdařila: ' + insertError.message);
                    return;
                }

                alert('🧪 Přísaha složena, vítej v cechu! Nyní se můžeš přihlásit.');
                setIsLogin(true);
            }
        } catch (error) {
            console.error('Neočekávaná chyba:', error);
            alert('🔌 Nepodařilo se spojit se Supabase.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="auth-container">
            <div className="auth-box">
                <h2>{isLogin ? 'Vstup do laboratoře' : 'Registrace učedníka'}</h2>
                
                <form onSubmit={handleSubmit}>
                    <div className="input-group">
                        <label>Přezdívka:</label>
                        <input
                            type="text"
                            name="prezdivka"
                            value={formData.prezdivka}
                            onChange={handleChange}
                            required
                            disabled={loading}
                        />
                    </div>
                    
                    {/* E-mail se vyrenderuje pouze při registraci */}
                    {!isLogin && (
                        <div className="input-group">
                            <label>E-mail:</label>
                            <input
                                type="email"
                                name="email"
                                value={formData.email}
                                onChange={handleChange}
                                required
                                disabled={loading}
                            />
                        </div>
                    )}

                    <div className="input-group">
                        <label>Heslo:</label>
                        <input
                            type="password"
                            name="heslo"
                            value={formData.heslo}
                            onChange={handleChange}
                            required
                            disabled={loading}
                        />
                    </div>

                    <button type="submit" className="auth-button" disabled={loading}>
                        {loading 
                            ? 'Míchám lektvary...' 
                            : (isLogin ? 'Namíchat lektvar (Přihlásit)' : 'Složit přísahu (Registrovat)')}
                    </button>
                    
                    {/* Tlačítko pro hosta */}
                    <button 
                        type="button" 
                        className="guest-button" 
                        onClick={handleGuestLogin}
                        disabled={loading}
                    >
                        Proklouznout jako host
                    </button>
                </form>

                <p className="toggle-text" onClick={() => !loading && setIsLogin(!isLogin)}>
                    {isLogin 
                        ? 'Nemáš ještě svůj kotlík? Zaregistruj se.' 
                        : 'Už jsi plnohodnotný alchymista? Přihlas se.'}
                </p>
            </div>
        </div>
    );
}