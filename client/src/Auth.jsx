import { useState } from 'react';
import './Auth.css'; // Sem později přidáme temný alchymistický design

export default function Auth({ onLogin }) {
    // Stav pro přepínání mezi formuláři
    const [isLogin, setIsLogin] = useState(true);
    
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
        isGuest: true 
    });
    };

const handleSubmit = async (e) => {
    e.preventDefault();
    
    // Protože React běží na portu 5173 a server na 3001, musíme uvést celou adresu
    const baseUrl = 'http://localhost:3001';
    const endpoint = isLogin ? '/api/login' : '/api/register';
    
    try {
        const response = await fetch(baseUrl + endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(formData)
        });

        const data = await response.json();

        // Pokud server vrátil chybu (např. status 400 nebo 409)
        if (!response.ok) {
            alert('❌ Chyba: ' + data.error);
            return;
        }

        // Úspěch! (status 200 nebo 201)
        alert('🧪 ' + data.message);
        
        // Pokud to bylo přihlášení, pošleme data výš do App.jsx a pustíme hráče do Lobby
        if (isLogin) {
            onLogin({ prezdivka: formData.prezdivka, id: data.userId });
        } else {
            // Po úspěšné registraci automaticky přepneme na přihlašovací okno
            setIsLogin(true);
        }

    } catch (error) {
        console.error('Sítový error:', error);
        alert('🔌 Nepodařilo se spojit se serverem.');
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
                        />
                    </div>

                    <button type="submit" className="auth-button">
                    {isLogin ? 'Namíchat lektvar (Přihlásit)' : 'Složit přísahu (Registrovat)'}
                </button>
                
                {/* Nové tlačítko pro hosta */}
                <button 
                    type="button" 
                    className="guest-button" 
                    onClick={handleGuestLogin}
                >
                    Proklouznout jako host
                </button>
            </form>

            <p className="toggle-text" onClick={() => setIsLogin(!isLogin)}>
                {isLogin 
                    ? 'Nemáš ještě svůj kotlík? Zaregistruj se.' 
                    : 'Už jsi plnohodnotný alchymista? Přihlas se.'}
            </p>
            </div>
        </div>
    );
}